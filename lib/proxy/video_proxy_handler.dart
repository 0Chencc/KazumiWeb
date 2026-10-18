import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shelf/shelf.dart';

import 'package:kazumi_web/proxy/m3u8_rewriter.dart';
import 'package:kazumi_web/proxy/proxy_session_store.dart';
import 'package:kazumi_web/logger.dart';
import 'package:kazumi_web/m3u8_ad_filter.dart';
import 'package:kazumi_web/m3u8_parser.dart';
import 'package:kazumi_web/services/network/proxy_utils.dart';
import 'package:kazumi_web/services/storage/storage.dart';

/// 处理 `/proxy/<token>` 与 `/proxy/<token>/<encodedSubUrl>` 的请求。
///
/// 设计：
/// - 浏览器请求 token 的根路径时，目标 URL 取 session.originalUrl
/// - 请求带子路径时，子路径是 base64url 编码的绝对 URL（由 m3u8 重写产出）
/// - 服务端用宿主的 HTTP client 拉取目标，注入 Referer/UA，透传 Range
/// - 若响应是 m3u8 文本，重写内部 URI 后再返回；否则原样转发
class VideoProxyHandler {
  VideoProxyHandler({required this.sessionStore, HttpClient? httpClient})
      : _httpClient = httpClient ?? HttpClient() {
    _httpClient.autoUncompress = false;
    _httpClient.connectionTimeout = const Duration(seconds: 15);
    // 与 NetworkConfig 一致：被中间设备半关闭的 keep-alive 连接复用后会
    // 中途断流（实测分片被截断到 4~20KB），缩短空闲存活期止损。
    _httpClient.idleTimeout = const Duration(seconds: 3);
    // findProxy 每次建连时调用，动态读设置——用户在 web 端切 proxyEnable
    // 后无需重建 handler 即生效，行为与 DioFactory 系一致。
    _httpClient.findProxy = (_) => _proxyDirective();
    _httpClient.badCertificateCallback =
        (cert, host, port) => _proxyDirective() != 'DIRECT';
  }

  static String _proxyDirective() {
    // findProxy 内抛出的异常会变成连接失败，设置不可用时按直连兜底。
    try {
      final bool enable = GStorage.getSetting(SettingsKeys.proxyEnable);
      if (!enable) return 'DIRECT';
      final parsed =
          ProxyUtils.parseProxyUrl(GStorage.getSetting(SettingsKeys.proxyUrl));
      if (parsed == null) return 'DIRECT';
      return 'PROXY ${parsed.$1}:${parsed.$2}';
    } catch (_) {
      return 'DIRECT';
    }
  }

  final ProxySessionStore sessionStore;
  final HttpClient _httpClient;

  /// 上游响应头必须在此时限内到达，防止被掐死的连接无限挂起
  /// （挂起的请求不进访问日志，是排查上的盲区）。
  static const Duration _headerTimeout = Duration(seconds: 20);

  /// 流式转发时，上游两个数据块之间的最大间隔。超过即判定断流。
  static const Duration _bodyStallTimeout = Duration(seconds: 15);

  /// 瞬时网络错误（握手 RST 等）的最大尝试次数，仅对 GET/HEAD 生效。
  static const int _maxAttempts = 3;

  /// `/proxy/<token>` 路径前缀，外部构造代理 URL 时用作根。
  static const String pathPrefix = '/proxy';

  static String buildRootUrl(String token) => '$pathPrefix/$token';

  static String buildSubUrl(String token, String absoluteTargetUrl) {
    final encoded = base64Url.encode(utf8.encode(absoluteTargetUrl));
    return '$pathPrefix/$token/$encoded';
  }

  Future<Response> handle(Request request, String token,
      [String? subPath]) async {
    final session = sessionStore.lookup(token);
    if (session == null) {
      return Response(
        410,
        body: 'session expired or unknown',
        headers: {'content-type': 'text/plain; charset=utf-8'},
      );
    }

    final String targetUrl;
    if (subPath == null || subPath.isEmpty) {
      targetUrl = session.originalUrl;
    } else {
      final decoded = _tryDecodeSubPath(subPath);
      if (decoded == null) {
        return Response(400, body: 'invalid sub url');
      }
      targetUrl = decoded;
    }

    Uri targetUri;
    try {
      targetUri = Uri.parse(targetUrl);
    } catch (_) {
      return Response(400, body: 'invalid target url');
    }

    try {
      return await _proxy(
        request: request,
        targetUri: targetUri,
        session: session,
        token: token,
      );
    } on TimeoutException {
      return Response(504, body: 'upstream timeout');
    } catch (e, st) {
      logError('VideoProxyHandler: proxy failed for $targetUri', e, st);
      return Response.internalServerError(body: 'proxy error: $e');
    }
  }

  Future<Response> _proxy({
    required Request request,
    required Uri targetUri,
    required ProxySession session,
    required String token,
  }) async {
    // 运营商级干扰会间歇性 RST 视频床的 TLS 握手（实测同一分片
    // 第一次握手被掐、紧接着重试即成功）。GET/HEAD 幂等，安全重试。
    final method = request.method.toUpperCase();
    final canRetry = method == 'GET' || method == 'HEAD';

    HttpClientResponse? upstreamResponse;
    for (var attempt = 1;; attempt++) {
      try {
        final upstreamRequest =
            await _httpClient.openUrl(request.method, targetUri);

        if (session.userAgent.isNotEmpty) {
          upstreamRequest.headers
              .set(HttpHeaders.userAgentHeader, session.userAgent);
        }
        if (session.referer.isNotEmpty) {
          upstreamRequest.headers.set('referer', session.referer);
        }
        // 透传 Range，让浏览器 video 元素拖动条工作
        final range = request.headers['range'];
        if (range != null && range.isNotEmpty) {
          upstreamRequest.headers.set('range', range);
        }
        upstreamRequest.headers.set('accept', '*/*');

        upstreamRequest.followRedirects = true;
        upstreamRequest.maxRedirects = 5;

        upstreamResponse = await upstreamRequest.close().timeout(_headerTimeout);
        break;
      } catch (e) {
        final transient = e is HandshakeException ||
            e is SocketException ||
            e is TimeoutException ||
            e is HttpException;
        if (!canRetry || !transient || attempt >= _maxAttempts) rethrow;
        logWarn(
            'VideoProxyHandler: transient failure for ${targetUri.host}, retrying ($attempt/$_maxAttempts) ($e)');
        await Future.delayed(Duration(milliseconds: 300 * attempt));
      }
    }

    final contentType =
        upstreamResponse.headers.contentType?.mimeType.toLowerCase() ?? '';
    final isM3u8 = contentType.contains('mpegurl') ||
        contentType.contains('m3u8') ||
        targetUri.path.toLowerCase().endsWith('.m3u8');

    if (isM3u8) {
      return _rewriteM3u8Response(
        upstreamResponse: upstreamResponse,
        targetUri: targetUri,
        token: token,
      );
    }

    return _streamingResponse(upstreamResponse, targetUri);
  }

  Future<Response> _rewriteM3u8Response({
    required HttpClientResponse upstreamResponse,
    required Uri targetUri,
    required String token,
  }) async {
    final bodyBytes = await _readAll(upstreamResponse);
    final bodyText = utf8.decode(bodyBytes, allowMalformed: true);

    // Media playlist 走"解析 + 广告过滤 + 重写"路径，浏览器拿到的是 clean m3u8。
    // Master playlist 不含 segment，没有可过滤的内容，用旧 rewriter 直接改写
    // variants URI。
    final String rewritten;
    if (M3u8Parser.detectType(bodyText) == M3u8Type.media) {
      rewritten = _buildFilteredMediaPlaylist(
        bodyText: bodyText,
        baseUri: targetUri,
        token: token,
      );
    } else {
      final rewriter = M3u8Rewriter(
        baseUrl: targetUri,
        subUriBuilder: (absUrl) => buildSubUrl(token, absUrl),
      );
      rewritten = rewriter.rewrite(bodyText);
    }

    return Response.ok(
      rewritten,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'cache-control': 'no-store',
      },
    );
  }

  /// 用 [M3u8AdFilter] 去广告，再把每条 segment / EXT-X-KEY 的 URI 改写成
  /// 通过本服务代理的 `/proxy/<token>/<base64>` 形式。
  ///
  /// 安全降级：当源 m3u8 不含 #EXT-X-DISCONTINUITY 时 filterAds 直接返回原列表。
  /// 偶发解析异常时降级为旧的逐行 rewrite，至少能播。
  String _buildFilteredMediaPlaylist({
    required String bodyText,
    required Uri baseUri,
    required String token,
  }) {
    try {
      final playlist =
          M3u8Parser.parseMediaPlaylist(bodyText, baseUri.toString());
      final originalCount = playlist.segments.length;
      final filtered = M3u8AdFilter.filterAds(playlist.segments);
      final removed = originalCount - filtered.length;
      if (removed > 0) {
        logInfo(
            'VideoProxyHandler: filtered $removed ad segment(s) from $baseUri');
      }

      final targetDuration = playlist.targetDuration > 0
          ? playlist.targetDuration
          : M3u8AdFilter.calculateTargetDuration(filtered);

      final sb = StringBuffer();
      sb.writeln('#EXTM3U');
      sb.writeln('#EXT-X-VERSION:3');
      sb.writeln('#EXT-X-TARGETDURATION:${targetDuration.ceil()}');
      sb.writeln('#EXT-X-MEDIA-SEQUENCE:0');
      if (playlist.isVod) {
        sb.writeln('#EXT-X-PLAYLIST-TYPE:VOD');
      }

      int lastDiscontinuityGroup =
          filtered.isNotEmpty ? filtered.first.discontinuityGroup : 0;
      M3u8Key? lastKey;
      // 强制首段也写一次 #EXT-X-KEY，避免遗漏；用一个哨兵触发首次差异检测。
      var firstSegment = true;

      for (int i = 0; i < filtered.length; i++) {
        final seg = filtered[i];

        if (i > 0 && seg.discontinuityGroup != lastDiscontinuityGroup) {
          sb.writeln('#EXT-X-DISCONTINUITY');
          lastDiscontinuityGroup = seg.discontinuityGroup;
        }

        if (firstSegment || seg.key != lastKey) {
          if (seg.key == null) {
            // 仅当上一段有 key 时显式声明 NONE 关闭加密
            if (lastKey != null) {
              sb.writeln('#EXT-X-KEY:METHOD=NONE');
            }
          } else {
            final proxiedKeyUri = buildSubUrl(token, seg.key!.uri);
            final keySb = StringBuffer(
                '#EXT-X-KEY:METHOD=${seg.key!.method},URI="$proxiedKeyUri"');
            if (seg.key!.iv != null) {
              keySb.write(',IV=${seg.key!.iv}');
            }
            sb.writeln(keySb.toString());
          }
          lastKey = seg.key;
          firstSegment = false;
        }

        sb.writeln('#EXTINF:${seg.duration.toStringAsFixed(6)},');
        sb.writeln(buildSubUrl(token, seg.uri));
      }

      if (playlist.isVod) {
        sb.writeln('#EXT-X-ENDLIST');
      }
      return sb.toString();
    } catch (e, st) {
      logError(
          'VideoProxyHandler: media playlist filter failed, fallback to passthrough rewrite',
          e,
          st);
      final rewriter = M3u8Rewriter(
        baseUrl: baseUri,
        subUriBuilder: (absUrl) => buildSubUrl(token, absUrl),
      );
      return rewriter.rewrite(bodyText);
    }
  }

  Response _streamingResponse(HttpClientResponse upstreamResponse, Uri targetUri) {
    final headers = <String, String>{};
    upstreamResponse.headers.forEach((name, values) {
      // 跳过 hop-by-hop 头与可能干扰 shelf 的头
      final lower = name.toLowerCase();
      if (_hopByHopHeaders.contains(lower)) return;
      if (lower == 'content-encoding') return;
      // attachment 语义对内联播放有害（提示浏览器下载而非播放），且部分
      // 视频床（天翼云家庭云）在值里塞原始 UTF-8 文件名——非 ASCII 头值
      // 会让 shelf_io 写响应时抛 FormatException，此时 handler 已返回、
      // 访问日志已记成功，但响应永远不上线，浏览器无限挂起。
      if (lower == 'content-disposition') return;
      final value = values.join(', ');
      if (!_isSafeHeaderValue(value)) {
        logWarn(
            'VideoProxyHandler: dropping non-ASCII header "$lower" from upstream');
        return;
      }
      headers[lower] = value;
    });
    headers.putIfAbsent('cache-control', () => 'no-store');
    // 上游（部分视频床）不回 Accept-Ranges，但 iOS Safari/AVPlayer 以此
    // 判断服务器是否支持分段拉取，缺失可能直接拒播。206 或带
    // Content-Range 的响应显式补上。
    if (upstreamResponse.statusCode == HttpStatus.partialContent ||
        headers.containsKey('content-range')) {
      headers.putIfAbsent('accept-ranges', () => 'bytes');
    }

    // 断流防护 + 截断观测：
    // - 上游停止发数据超过 _bodyStallTimeout 就主动断开，避免浏览器的
    //   请求无限挂起（挂起请求不进访问日志）
    // - 转发字节数 < Content-Length 说明连接被中途掐断（运营商干扰的
    //   另一种表现），记 WARN 供排查；保留 Content-Length 头让客户端
    //   也能感知到截断并自行重试
    final expected = upstreamResponse.contentLength;
    var relayed = 0;
    final body = upstreamResponse.timeout(_bodyStallTimeout, onTimeout: (sink) {
      logWarn(
          'VideoProxyHandler: upstream stalled for ${targetUri.host} after $relayed bytes, aborting relay');
      sink.close();
    }).map((chunk) {
      relayed += chunk.length;
      return chunk;
    }).transform(StreamTransformer<List<int>, List<int>>.fromHandlers(
      handleDone: (sink) {
        if (expected > 0 && relayed < expected) {
          logWarn(
              'VideoProxyHandler: truncated relay for ${targetUri.host}: $relayed/$expected bytes');
        }
        sink.close();
      },
    ));

    return Response(
      upstreamResponse.statusCode,
      body: body,
      headers: headers,
    );
  }

  /// dart:io 只接受可打印 ASCII（外加 TAB）作为响应头值，其余字符在
  /// shelf_io 写出阶段抛 FormatException 且无法被 handler 捕获。
  static bool _isSafeHeaderValue(String value) {
    for (final c in value.codeUnits) {
      if (c == 0x09) continue;
      if (c < 0x20 || c > 0x7E) return false;
    }
    return true;
  }

  Future<Uint8List> _readAll(HttpClientResponse response) async {
    final chunks = <List<int>>[];
    // m3u8 拉取同样受断流防护：块间隔超时按 TimeoutException 走 504。
    final guarded = response.timeout(_bodyStallTimeout, onTimeout: (sink) {
      sink.addError(TimeoutException('upstream stalled', _bodyStallTimeout));
      sink.close();
    });
    await for (final chunk in guarded) {
      chunks.add(chunk);
    }
    final total = chunks.fold<int>(0, (sum, c) => sum + c.length);
    final bytes = Uint8List(total);
    var offset = 0;
    for (final chunk in chunks) {
      bytes.setRange(offset, offset + chunk.length, chunk);
      offset += chunk.length;
    }
    return bytes;
  }

  String? _tryDecodeSubPath(String subPath) {
    try {
      final decoded = utf8.decode(base64Url.decode(subPath));
      // 简单校验是 http(s) URL
      final uri = Uri.parse(decoded);
      if (!uri.hasScheme || (uri.scheme != 'http' && uri.scheme != 'https')) {
        return null;
      }
      return decoded;
    } catch (_) {
      return null;
    }
  }

  void close() {
    _httpClient.close(force: true);
  }

  static const Set<String> _hopByHopHeaders = {
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  };
}
