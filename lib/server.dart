import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart' hide Router;
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:shelf_router/shelf_router.dart';

import 'package:kazumi_web/bangumi_service.dart';
import 'package:kazumi_web/core/bangumi_account_sync.dart';
import 'package:kazumi_web/core/captcha_flow.dart';
import 'package:kazumi_web/core/library_store.dart';
import 'package:kazumi_web/core/plugin_registry.dart';
import 'package:kazumi_web/core/source_resolver.dart';
import 'package:kazumi_web/core/theme_export.dart';
import 'package:kazumi_web/logger.dart';
import 'package:kazumi_web/modules/danmaku/danmaku_module.dart';
import 'package:kazumi_web/modules/roads/road_module.dart';
import 'package:kazumi_web/modules/search/plugin_search_module.dart';
import 'package:kazumi_web/plugins/plugins.dart';
import 'package:dio/dio.dart' show DioException;

import 'package:kazumi_web/proxy/proxy_session_store.dart';
import 'package:kazumi_web/request/core/dio_factory.dart';
import 'package:kazumi_web/request/core/network_exception.dart';
import 'package:kazumi_web/proxy/video_proxy_handler.dart';
import 'package:kazumi_web/request/apis/danmaku_api.dart';
import 'package:kazumi_web/services/plugin/rule_engine_models.dart';
import 'package:kazumi_web/services/storage/storage.dart';
import 'package:kazumi_web/services/video_source/video_source_service.dart';
import 'package:kazumi_web/utils/http_headers.dart';

/// LAN Web 服务（独立版）。
///
/// 与 sidecar 时代的区别：不再依赖 Kazumi Host API——规则检索、WebView
/// 视频源解析、弹幕聚合全部在本进程完成；观看历史与收藏自持。
/// 对浏览器暴露的 /api/* 契约与旧实现完全一致，Web UI 零改动。
/// 应用版本（与 pubspec.yaml 保持一致，web 端"关于"页展示用）。
const String appVersion = '0.2.0';

class KazumiWebServer {
  KazumiWebServer({
    required this.registry,
    required this.resolver,
    required this.library,
    required this.bangumi,
    required this.webDir,
  }) : _sessionStore = ProxySessionStore() {
    _proxyHandler = VideoProxyHandler(sessionStore: _sessionStore);
  }

  final PluginRegistry registry;
  final SourceResolver resolver;
  final LibraryStore library;
  final BangumiService bangumi;
  final Directory webDir;
  final ProxySessionStore _sessionStore;
  late final VideoProxyHandler _proxyHandler;

  HttpServer? _httpServer;

  int? get port => _httpServer?.port;

  Future<void> start({int port = 8333}) async {
    final handler = const Pipeline()
        .addMiddleware(_accessLog())
        .addMiddleware(_errorGuard())
        .addHandler(_buildRouter().call);
    _httpServer =
        await shelf_io.serve(handler, InternetAddress.anyIPv4, port);
    logInfo('KazumiWebServer: listening on port ${_httpServer!.port}');
  }

  Future<void> stop() async {
    final server = _httpServer;
    _httpServer = null;
    if (server != null) {
      await server.close(force: true);
    }
    _sessionStore.clear();
    _proxyHandler.close();
    await resolver.dispose();
    bangumi.close();
  }

  Router _buildRouter() {
    final router = Router();

    // ====== 静态资源 ======
    router.get('/', (Request r) => _serveFile('index.html'));
    router.get('/assets/<file>', (Request r, String file) => _serveFile(file));
    router.get('/favicon.ico', (Request r) => Response(204));
    router.get('/healthz', (Request r) => Response.ok('ok'));
    router.get(
        '/api/about',
        (Request r) => _json({
              'version': appVersion,
              'repository': 'https://github.com/0Chencc/KazumiWeb',
            }));

    // ====== 规则能力（本地规则引擎） ======
    router.get('/api/plugins', _handlePlugins);
    router.get('/api/search', _handleSearch);
    router.get('/api/episodes', _handleEpisodes);
    router.get('/api/resolve', _handleResolve);
    router.get('/api/danmaku', _handleDanmaku);
    router.get('/api/danmaku/search', _handleDanmakuSearch);
    router.get('/api/danmaku/episodes', _handleDanmakuEpisodes);
    router.get('/api/danmaku/episode', _handleDanmakuByEpisode);
    router.get('/api/theme', _handleTheme);

    // ====== 规则管理 ======
    router.get('/api/rules/catalog', _handleRulesCatalog);
    router.post('/api/rules/install', _handleRulesInstall);
    router.post('/api/rules/import', _handleRulesImport);
    router.delete('/api/rules/<name>', _handleRulesRemove);

    // ====== 设置 ======
    router.get('/api/settings', _handleGetSettings);
    router.put('/api/settings', _handlePutSettings);

    // ====== 人机验证（视频源反爬） ======
    router.post('/api/captcha/start', _handleCaptchaStart);
    router.post('/api/captcha/submit', _handleCaptchaSubmit);
    router.post('/api/captcha/cancel', _handleCaptchaCancel);

    // ====== 历史与收藏（本地存储） ======
    router.get('/api/history', _handleGetHistory);
    router.get('/api/history/list', _handleListHistory);
    router.post('/api/history/progress', _handleUpdateProgress);
    router.delete('/api/history/all', _handleClearHistories);
    router.delete('/api/history', _handleDeleteHistory);
    router.get('/api/collect', _handleGetCollect);
    router.get('/api/collect/list', _handleListCollect);
    router.put('/api/collect', _handlePutCollect);
    router.delete('/api/collect', _handleDeleteCollect);

    // ====== Bangumi 公开数据：直连 ======
    router.get('/api/popular', _handlePopular);
    router.get('/api/timeline', _handleTimeline);
    router.get('/api/bangumi/search', _handleBangumiSearch);
    router.get('/api/bangumi/<id|[0-9]+>', _handleBangumiDetail);
    router.get('/api/bangumi/<id|[0-9]+>/characters',
        (Request r, String id) => _bangumiCall(() =>
            bangumi.characters(int.parse(id))));
    router.get(
        '/api/bangumi/<id|[0-9]+>/comments',
        (Request r, String id) => _bangumiCall(
              () => bangumi.comments(int.parse(id),
                  offset: int.tryParse(
                          r.url.queryParameters['offset'] ?? '0') ??
                      0),
              softError: '吐槽获取失败，请稍后重试',
            ));
    router.get('/api/bangumi/<id|[0-9]+>/staff',
        (Request r, String id) => _bangumiCall(() => bangumi.staff(int.parse(id))));
    router.get('/api/bangumi/<id|[0-9]+>/relations',
        (Request r, String id) => _bangumiCall(() => bangumi.relations(int.parse(id))));
    router.get('/api/bangumi/character/<id|[0-9]+>',
        (Request r, String id) => _bangumiCall(() => bangumi.character(int.parse(id))));
    router.get('/api/bangumi/<id|[0-9]+>/episodes',
        (Request r, String id) => _bangumiCall(() => bangumi.episodes(int.parse(id))));
    router.get(
        '/api/bangumi/<id|[0-9]+>/episode-comments',
        (Request r, String id) => _bangumiCall(
              () {
                final episode =
                    int.tryParse(r.url.queryParameters['episode'] ?? '');
                if (episode == null || episode < 1) {
                  throw ArgumentError('episode query is required (>=1)');
                }
                return bangumi.episodeComments(int.parse(id), episode);
              },
              softError: '评论获取失败，请稍后重试',
            ));

    // ====== 视频代理 ======
    router.all('/proxy/<token>', (Request request, String token) {
      return _proxyHandler.handle(request, token);
    });
    router.all('/proxy/<token>/<subPath>',
        (Request request, String token, String subPath) {
      return _proxyHandler.handle(request, token, subPath);
    });

    return router;
  }

  // ====== 规则能力 ======

  Response _handlePlugins(Request request) {
    final list = registry.plugins
        .map((p) => {
              'name': p.name,
              'version': p.version,
              'baseUrl': p.baseUrl,
              'useNativePlayer': p.useNativePlayer,
              'useLegacyParser': p.useLegacyParser,
              'muliSources': p.muliSources,
            })
        .toList();
    return _json(list);
  }

  Future<Response> _handleSearch(Request request) async {
    final keyword = request.url.queryParameters['keyword']?.trim() ?? '';
    final pluginName = request.url.queryParameters['plugin']?.trim() ?? '';
    if (keyword.isEmpty) {
      return _jsonError(400, 'keyword_required', 'keyword is required');
    }
    if (pluginName.isEmpty) {
      return _jsonError(400, 'plugin_required', 'plugin is required');
    }
    final plugin = registry.find(pluginName);
    if (plugin == null) {
      return _jsonError(404, 'plugin_not_found', 'plugin $pluginName not found');
    }

    try {
      // 网络瞬时抖动（TLS RST 等）下单次检索失败率高且立即重试成功率
      // 高（实测）；SearchErrorException 重试一次再定论。验证码与
      // 无结果是确定性结果，不重试。
      PluginSearchResponse response;
      try {
        response = await plugin.queryBangumi(keyword, shouldRethrow: true);
      } on SearchErrorException {
        await Future.delayed(const Duration(milliseconds: 400));
        response = await plugin.queryBangumi(keyword, shouldRethrow: true);
      }
      return _json({
        'pluginName': response.pluginName,
        'items': response.data
            .map((item) => {
                  'name': item.name,
                  'src': item.src,
                  'fullUrl': plugin.buildFullUrl(item.src),
                })
            .toList(),
      });
    } on CaptchaRequiredException catch (e) {
      return _jsonError(423, 'captcha_required', e.toString());
    } on NoResultException {
      return _json({'pluginName': plugin.name, 'items': const []});
    } on SearchErrorException catch (e) {
      // NetworkErrorMapper 的分类会吞掉底层异常；这里展开 cause 链，
      // 网络层根因（HandshakeException/代理错误等）才能进日志。
      final cause = e.cause;
      final raw = cause is NetworkException ? cause.rawError : null;
      final inner = raw is DioException ? raw.error : raw;
      logWarn(
          'search failed for ${plugin.name}: $cause'
          '${inner != null ? ' | raw: $inner' : ''}');
      return _jsonError(502, 'search_failed', e.toString());
    } catch (e, st) {
      logError('search unexpected error', e, st);
      return _jsonError(500, 'internal_error', e.toString());
    }
  }

  Future<Response> _handleEpisodes(Request request) async {
    final pluginName = request.url.queryParameters['plugin']?.trim() ?? '';
    final src = request.url.queryParameters['src']?.trim() ?? '';
    if (pluginName.isEmpty) {
      return _jsonError(400, 'plugin_required', 'plugin is required');
    }
    if (src.isEmpty) {
      return _jsonError(400, 'src_required', 'src is required');
    }
    final plugin = registry.find(pluginName);
    if (plugin == null) {
      return _jsonError(404, 'plugin_not_found', 'plugin $pluginName not found');
    }

    try {
      // 与检索同理：瞬时网络失败重试一次
      List<Road> roads;
      try {
        roads = await plugin.queryChapterRoads(src);
      } on ChapterErrorException {
        await Future.delayed(const Duration(milliseconds: 400));
        roads = await plugin.queryChapterRoads(src);
      }
      return _json({
        'pluginName': plugin.name,
        'roads': roads
            .map((road) => {
                  'name': road.name,
                  'episodes': List<Map<String, String>>.generate(
                    road.data.length,
                    (i) => {
                      'name': i < road.identifier.length
                          ? road.identifier[i]
                          : '第${i + 1}集',
                      'src': road.data[i],
                    },
                  ),
                })
            .toList(),
      });
    } on ChapterErrorException catch (e) {
      // 重试后仍失败：网络/站点层错误按 502 返回（之前误落通用
      // 分支成了 500）。同样展开 cause 链方便定位根因。
      final cause = e.cause;
      final raw = cause is NetworkException ? cause.rawError : null;
      final inner = raw is DioException ? raw.error : raw;
      logWarn(
          'episodes failed for ${plugin.name}: $cause'
          '${inner != null ? ' | raw: $inner' : ''}');
      return _jsonError(502, 'chapter_failed', e.toString());
    } catch (e, st) {
      logError('episodes unexpected error', e, st);
      return _jsonError(500, 'internal_error', e.toString());
    }
  }

  Future<Response> _handleResolve(Request request) async {
    final pluginName = request.url.queryParameters['plugin']?.trim() ?? '';
    final episodeUrl = request.url.queryParameters['episodeUrl']?.trim() ?? '';
    if (pluginName.isEmpty) {
      return _jsonError(400, 'plugin_required', 'plugin is required');
    }
    if (episodeUrl.isEmpty) {
      return _jsonError(400, 'episode_url_required', 'episodeUrl is required');
    }
    final plugin = registry.find(pluginName);
    if (plugin == null) {
      return _jsonError(404, 'plugin_not_found', 'plugin $pluginName not found');
    }

    final fullEpisodeUrl = plugin.buildFullUrl(episodeUrl);
    try {
      final source = await resolver.resolve(
        plugin: plugin,
        episodeUrl: fullEpisodeUrl,
      );
      final session = ProxySession(
        originalUrl: source.url,
        referer: plugin.referer,
        userAgent:
            plugin.userAgent.isEmpty ? getRandomUA() : plugin.userAgent,
        pluginName: plugin.name,
        createdAt: DateTime.now(),
      );
      final token = _sessionStore.register(session);
      return _json({
        'token': token,
        'playUrl': VideoProxyHandler.buildRootUrl(token),
        'originalUrl': session.originalUrl,
        'pluginName': session.pluginName,
        'streamType': _detectStreamType(source.url),
      });
    } on VideoSourceTimeoutException catch (e) {
      return _jsonError(504, 'resolve_timeout', e.toString());
    } on VideoSourceCancelledException catch (e) {
      return _jsonError(499, 'resolve_cancelled', e.toString());
    } on VideoSourceNotFoundException catch (e) {
      return _jsonError(404, 'video_source_not_found', e.toString());
    } catch (e, st) {
      logError('resolve unexpected error', e, st);
      return _jsonError(500, 'resolve_failed', e.toString());
    }
  }

  Future<Response> _handleDanmaku(Request request) async {
    final bangumiId =
        int.tryParse(request.url.queryParameters['bangumiId'] ?? '');
    final episode =
        int.tryParse(request.url.queryParameters['episode'] ?? '');
    if (bangumiId == null || episode == null) {
      return _jsonError(
          400, 'invalid_params', 'bangumiId and episode are required');
    }
    try {
      final dandanId =
          await DanmakuApi.getDanDanBangumiIDByBgmBangumiID(bangumiId);
      if (dandanId == 0) {
        return _json({
          'bangumiId': bangumiId,
          'episode': episode,
          'items': const <Map<String, dynamic>>[],
          'reason': 'dandan_bangumi_not_found',
        });
      }
      final list = await DanmakuApi.getDanDanmaku(dandanId, episode);
      return _json({
        'bangumiId': bangumiId,
        'episode': episode,
        'dandanBangumiId': dandanId,
        'items': list.map(_danmakuToJson).toList(),
      });
    } catch (e, st) {
      logError('danmaku fetch failed', e, st);
      return _jsonError(502, 'danmaku_failed', e.toString());
    }
  }

  // ====== 弹幕源切换（对齐上游 danmaku_source_sheet：搜索番剧 → 选分集） ======
  Future<Response> _handleDanmakuSearch(Request request) async {
    final keyword = request.url.queryParameters['keyword']?.trim() ?? '';
    if (keyword.isEmpty) {
      return _jsonError(400, 'invalid_params', 'keyword is required');
    }
    try {
      final res = await DanmakuApi.getDanmakuSearchResponse(keyword);
      return _json({
        'items': res.animes
            .map((a) => {
                  'animeId': a.animeId,
                  'animeTitle': a.animeTitle,
                  'typeDescription': a.typeDescription,
                  'episodeCount': a.episodeCount,
                })
            .toList(),
      });
    } catch (e, st) {
      logError('danmaku search failed', e, st);
      return _jsonError(502, 'danmaku_failed', '弹幕源检索失败，请稍后重试');
    }
  }

  Future<Response> _handleDanmakuEpisodes(Request request) async {
    final animeId = int.tryParse(request.url.queryParameters['animeId'] ?? '');
    if (animeId == null) {
      return _jsonError(400, 'invalid_params', 'animeId is required');
    }
    try {
      final res = await DanmakuApi.getDanDanEpisodesByDanDanBangumiID(animeId);
      return _json({
        'animeId': res.bangumiId,
        'items': res.episodes
            .map((e) => {'episodeId': e.episodeId, 'episodeTitle': e.episodeTitle})
            .toList(),
      });
    } catch (e, st) {
      logError('danmaku episodes failed', e, st);
      return _jsonError(502, 'danmaku_failed', '获取分集失败，请稍后重试');
    }
  }

  Future<Response> _handleDanmakuByEpisode(Request request) async {
    final episodeId =
        int.tryParse(request.url.queryParameters['episodeId'] ?? '');
    if (episodeId == null) {
      return _jsonError(400, 'invalid_params', 'episodeId is required');
    }
    try {
      final list = await DanmakuApi.getDanDanmakuByEpisodeID(episodeId);
      return _json({
        'episodeId': episodeId,
        'items': list.map(_danmakuToJson).toList(),
      });
    } catch (e, st) {
      logError('danmaku by episode failed', e, st);
      return _jsonError(502, 'danmaku_failed', '弹幕加载失败，请稍后重试');
    }
  }

  Response _handleTheme(Request request) {
    const seed = Colors.green;
    final light = buildScheme(
      seed: seed,
      brightness: Brightness.light,
      oledEnhance: false,
    );
    final dark = buildScheme(
      seed: seed,
      brightness: Brightness.dark,
      oledEnhance: false,
    );
    return _json({
      'version': 2,
      'themeMode': 'system',
      'primaryColor': '#4CAF50',
      'useDynamicColor': false,
      'oledEnhance': false,
      'schemes': {
        'light': exportColorTokens(light),
        'dark': exportColorTokens(dark),
      },
      'typography': exportTypographyTokens(),
    });
  }

  // ====== 规则管理 ======

  Future<Response> _handleRulesCatalog(Request request) async {
    try {
      final catalog = await registry.fetchCatalog();
      final installed = {for (final p in registry.plugins) p.name: p.version};
      for (final item in catalog) {
        final name = item['name'];
        item['installed'] = installed.containsKey(name);
        item['installedVersion'] = installed[name];
      }
      return _json({'items': catalog});
    } catch (e) {
      logWarn('rules catalog fetch failed', e);
      return _jsonError(502, 'catalog_failed', '规则仓库暂时不可用，请稍后重试');
    }
  }

  Future<Response> _handleRulesInstall(Request request) async {
    Map<String, dynamic>? json;
    try {
      json = jsonDecode(await request.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return _jsonError(400, 'invalid_body', 'body must be json');
    }
    final name = (json['name'] as String?)?.trim() ?? '';
    if (name.isEmpty) {
      return _jsonError(400, 'invalid_params', 'name is required');
    }
    try {
      final plugin = await registry.installFromShop(name);
      return _json({'ok': true, 'name': plugin.name, 'version': plugin.version});
    } catch (e) {
      logWarn('rule install failed: $name', e);
      return _jsonError(502, 'install_failed', '规则 $name 安装失败：$e');
    }
  }

  /// 手动导入规则：body 为 {json: <规则对象>} 或 {url: <规则 JSON 地址>}。
  Future<Response> _handleRulesImport(Request request) async {
    Map<String, dynamic>? json;
    try {
      json = jsonDecode(await request.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return _jsonError(400, 'invalid_body', 'body must be json');
    }
    try {
      final rawRule = json['json'];
      final url = (json['url'] as String?)?.trim() ?? '';
      if (rawRule is Map) {
        final plugin =
            await registry.importRaw(Map<String, dynamic>.from(rawRule));
        return _json(
            {'ok': true, 'name': plugin.name, 'version': plugin.version});
      }
      if (url.isNotEmpty) {
        final plugin = await registry.importFromUrl(url);
        return _json(
            {'ok': true, 'name': plugin.name, 'version': plugin.version});
      }
      return _jsonError(400, 'invalid_params', 'json or url is required');
    } on FormatException catch (e) {
      return _jsonError(400, 'invalid_rule', e.message);
    } catch (e) {
      logWarn('rule import failed', e);
      return _jsonError(502, 'import_failed', '规则导入失败：$e');
    }
  }

  Future<Response> _handleRulesRemove(Request request, String name) async {
    final removed = await registry.remove(Uri.decodeComponent(name));
    if (!removed) {
      return _jsonError(404, 'rule_not_found', 'rule not found');
    }
    return _json({'ok': true});
  }

  // ====== 历史与收藏 ======

  Response _handleGetHistory(Request request) {
    final bangumiId =
        int.tryParse(request.url.queryParameters['bangumiId'] ?? '');
    final pluginName =
        request.url.queryParameters['pluginName']?.trim() ?? '';
    if (bangumiId == null || pluginName.isEmpty) {
      return _jsonError(
          400, 'invalid_params', 'bangumiId and pluginName are required');
    }
    return _json({'history': library.getHistory(pluginName, bangumiId)});
  }

  Response _handleListHistory(Request request) {
    final device = request.url.queryParameters['device']?.trim();
    return _json({'items': library.listHistories(device: device)});
  }

  Future<Response> _handleUpdateProgress(Request request) async {
    Map<String, dynamic>? json;
    try {
      json = jsonDecode(await request.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return _jsonError(400, 'invalid_body', 'body must be json');
    }
    final bangumiId = (json['bangumiId'] as num?)?.toInt();
    final pluginName = (json['pluginName'] as String?)?.trim();
    final episode = (json['episode'] as num?)?.toInt();
    final road = (json['road'] as num?)?.toInt() ?? 0;
    final progressMs = (json['progressMs'] as num?)?.toInt();
    final lastSrc = (json['lastSrc'] as String?) ?? '';
    final episodeName = (json['episodeName'] as String?) ?? '';
    if (bangumiId == null ||
        pluginName == null ||
        pluginName.isEmpty ||
        episode == null ||
        progressMs == null) {
      return _jsonError(400, 'invalid_params',
          'bangumiId, pluginName, episode, progressMs are required');
    }

    final bangumiJson = await _resolveBangumiJson(bangumiId, pluginName);
    if (bangumiJson == null) {
      return _jsonError(404, 'bangumi_not_found', 'bangumi not found');
    }
    await library.updateProgress(
      bangumiId: bangumiId,
      pluginName: pluginName,
      episode: episode,
      road: road,
      progressMs: progressMs,
      lastSrc: lastSrc,
      episodeName: episodeName,
      bangumi: bangumiJson,
      deviceId: (json['deviceId'] as String?)?.trim(),
      src: (json['src'] as String?) ?? '',
    );
    return _json({'ok': true});
  }

  Future<Response> _handleDeleteHistory(Request request) async {
    final bangumiId =
        int.tryParse(request.url.queryParameters['bangumiId'] ?? '');
    final pluginName =
        request.url.queryParameters['pluginName']?.trim() ?? '';
    if (bangumiId == null || pluginName.isEmpty) {
      return _jsonError(
          400, 'invalid_params', 'bangumiId and pluginName are required');
    }
    await library.deleteHistory(pluginName, bangumiId);
    return _json({'ok': true});
  }

  Future<Response> _handleClearHistories(Request request) async {
    await library.clearHistories();
    return _json({'ok': true});
  }

  // ====== 人机验证 ======

  final CaptchaFlow _captchaFlow = CaptchaFlow();

  Future<Response> _handleCaptchaStart(Request request) async {
    Map<String, dynamic>? json;
    try {
      json = jsonDecode(await request.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return _jsonError(400, 'invalid_body', 'body must be json');
    }
    final pluginName = (json['plugin'] as String?)?.trim() ?? '';
    final keyword = (json['keyword'] as String?)?.trim() ?? '';
    if (pluginName.isEmpty || keyword.isEmpty) {
      return _jsonError(
          400, 'invalid_params', 'plugin and keyword are required');
    }
    final plugin = registry.find(pluginName);
    if (plugin == null) {
      return _jsonError(404, 'plugin_not_found', 'plugin $pluginName not found');
    }
    if (!plugin.antiCrawlerConfig.enabled) {
      return _jsonError(400, 'not_supported', '该规则未配置人机验证');
    }
    try {
      return _json(await _captchaFlow.start(plugin, keyword));
    } on TimeoutException {
      await _captchaFlow.cancel();
      return _jsonError(504, 'captcha_timeout', '验证页加载超时，请稍后重试');
    } catch (e, st) {
      logError('captcha start failed', e, st);
      await _captchaFlow.cancel();
      return _jsonError(500, 'captcha_failed', e.toString());
    }
  }

  Future<Response> _handleCaptchaSubmit(Request request) async {
    Map<String, dynamic>? json;
    try {
      json = jsonDecode(await request.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return _jsonError(400, 'invalid_body', 'body must be json');
    }
    final pluginName = (json['plugin'] as String?)?.trim() ?? '';
    final code = (json['code'] as String?)?.trim() ?? '';
    if (pluginName.isEmpty || code.isEmpty) {
      return _jsonError(400, 'invalid_params', 'plugin and code are required');
    }
    final plugin = registry.find(pluginName);
    if (plugin == null) {
      return _jsonError(404, 'plugin_not_found', 'plugin $pluginName not found');
    }
    try {
      final verified = await _captchaFlow.submit(plugin, code);
      return _json({'ok': verified});
    } on StateError catch (e) {
      return _jsonError(409, 'no_session', e.message);
    } catch (e, st) {
      logError('captcha submit failed', e, st);
      return _jsonError(500, 'captcha_failed', e.toString());
    }
  }

  Future<Response> _handleCaptchaCancel(Request request) async {
    await _captchaFlow.cancel();
    return _json({'ok': true});
  }

  // ====== 设置 ======
  //
  // web 端可调的设置白名单。值默认跟随桌面版 Kazumi（若存在），
  // 用户在 web 端显式修改后停止跟随（见 GStorage.putSettingUser）。
  static const Map<String, SettingKey<bool>> _webSettings = {
    'enableBangumiProxy': SettingsKeys.enableBangumiProxy,
    'enableGitProxy': SettingsKeys.enableGitProxy,
    // HTTP 代理开关：部分网络对 Dart 的 TLS 指纹做选择性 RST（直连
    // 挂、同域 .NET 客户端正常），经本机代理即可绕过。代理地址跟随
    // 桌面版设置（proxyUrl）。
    'proxyEnable': SettingsKeys.proxyEnable,
  };

  Response _handleGetSettings(Request request) {
    return _json({
      for (final entry in _webSettings.entries)
        entry.key: GStorage.getSetting(entry.value),
    });
  }

  Future<Response> _handlePutSettings(Request request) async {
    Map<String, dynamic>? json;
    try {
      json = jsonDecode(await request.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return _jsonError(400, 'invalid_body', 'body must be json');
    }
    var changed = 0;
    for (final entry in _webSettings.entries) {
      final value = json[entry.key];
      if (value is bool) {
        await GStorage.putSettingUser(entry.value, value);
        changed++;
      }
    }
    if (changed == 0) {
      return _jsonError(400, 'invalid_params', 'no recognized settings');
    }
    // dio 单例的代理配置在创建时固化；设置变更后重建让其立即生效
    DioFactory.reset();
    return _handleGetSettings(request);
  }

  Response _handleGetCollect(Request request) {
    final bangumiId =
        int.tryParse(request.url.queryParameters['bangumiId'] ?? '');
    if (bangumiId == null) {
      return _jsonError(400, 'invalid_params', 'bangumiId is required');
    }
    final entry = library.getCollect(bangumiId);
    return _json({
      'bangumiId': bangumiId,
      'type': entry?['type'] ?? 0,
      'time': entry?['time'],
    });
  }

  Response _handleListCollect(Request request) {
    final filterType = int.tryParse(request.url.queryParameters['type'] ?? '');
    return _json({'items': library.listCollects(type: filterType)});
  }

  Future<Response> _handlePutCollect(Request request) async {
    Map<String, dynamic>? json;
    try {
      json = jsonDecode(await request.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return _jsonError(400, 'invalid_body', 'body must be json');
    }
    final bangumiId = (json['bangumiId'] as num?)?.toInt();
    final type = (json['type'] as num?)?.toInt();
    if (bangumiId == null || type == null) {
      return _jsonError(
          400, 'invalid_params', 'bangumiId and type are required');
    }
    if (type == 0) {
      await library.deleteCollect(bangumiId);
      return _json({'ok': true, 'type': 0});
    }
    final bangumiJson = await _resolveBangumiJson(bangumiId, null);
    if (bangumiJson == null) {
      return _jsonError(404, 'bangumi_not_found', 'bangumi not found');
    }
    await library.putCollect(
        bangumiId: bangumiId, type: type, bangumi: bangumiJson);
    // Bangumi 账号联动：本地收藏先行生效，推送失败只记日志
    unawaited(BangumiAccountSync.pushCollect(bangumiId, type));
    return _json({'ok': true, 'type': type});
  }

  Future<Response> _handleDeleteCollect(Request request) async {
    final bangumiId =
        int.tryParse(request.url.queryParameters['bangumiId'] ?? '');
    if (bangumiId == null) {
      return _jsonError(400, 'invalid_params', 'bangumiId is required');
    }
    await library.deleteCollect(bangumiId);
    return _json({'ok': true});
  }

  /// 找一份可用的 BangumiItem json：本地历史/收藏里有就复用，否则从
  /// bgm.tv 现拉详情（写历史/收藏需要完整条目供列表页展示）。
  Future<Map<String, dynamic>?> _resolveBangumiJson(
      int bangumiId, String? pluginName) async {
    if (pluginName != null && pluginName.isNotEmpty) {
      final existing = library.getHistory(pluginName, bangumiId);
      final item = existing?['bangumi'];
      if (item is Map<String, dynamic>) return item;
    }
    final collected = library.getCollect(bangumiId);
    final collectedItem = collected?['bangumi'];
    if (collectedItem is Map<String, dynamic>) return collectedItem;
    try {
      return await bangumi.detail(bangumiId);
    } catch (e) {
      logWarn('resolve bangumi $bangumiId failed', e);
      return null;
    }
  }

  // ====== Bangumi handlers ======

  Future<Response> _handlePopular(Request request) async {
    final tag = request.url.queryParameters['tag']?.trim() ?? '';
    final offset =
        int.tryParse(request.url.queryParameters['offset'] ?? '0') ?? 0;
    final limit =
        int.tryParse(request.url.queryParameters['limit'] ?? '24') ?? 24;
    return _bangumiCall(
        () => bangumi.popular(tag: tag, offset: offset, limit: limit));
  }

  Future<Response> _handleTimeline(Request request) async {
    final season = request.url.queryParameters['season']?.trim() ?? '';
    if (season.isNotEmpty) {
      final parts = season.split('-');
      final year = parts.length == 2 ? int.tryParse(parts[0]) : null;
      final quarter = parts.length == 2 ? int.tryParse(parts[1]) : null;
      if (year == null || quarter == null || quarter < 1 || quarter > 4) {
        return _jsonError(400, 'invalid_season', 'season must be YYYY-Q');
      }
    }
    return _bangumiCall(() => bangumi.timeline(season: season));
  }

  /// GET /api/bangumi/search?keyword=&offset=&sort=&tag=A&tag=B
  ///   &airDate=YYYY-MM-DD..YYYY-MM-DD&rank=1..5000&score=7..10&weekday=1,6
  /// 关键词与条件至少给一个。
  Future<Response> _handleBangumiSearch(Request request) async {
    final q = request.url.queryParameters;
    final all = request.url.queryParametersAll;
    final keyword = q['keyword']?.trim() ?? '';
    const sorts = {'heat', 'rank', 'score', 'match'};
    final sort = sorts.contains(q['sort']) ? q['sort']! : 'heat';
    final tags = (all['tag'] ?? const [])
        .map((t) => t.trim())
        .where((t) => t.isNotEmpty)
        .toList();
    List<String>? range(String? v) {
      if (v == null || !v.contains('..')) return null;
      final parts = v.split('..');
      return parts.length == 2 ? parts : null;
    }
    List<num?>? numRange(String? v) {
      final parts = range(v);
      if (parts == null) return null;
      final r = [num.tryParse(parts[0]), num.tryParse(parts[1])];
      return r[0] == null && r[1] == null ? null : r;
    }
    final airDate = range(q['airDate']);
    final dateOk = airDate == null ||
        airDate.every((d) => RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(d));
    if (!dateOk) {
      return _jsonError(400, 'invalid_params', 'airDate must be YYYY-MM-DD..YYYY-MM-DD');
    }
    final rank = numRange(q['rank']);
    final score = numRange(q['score']);
    final weekdays = (q['weekday'] ?? '')
        .split(',')
        .map((w) => int.tryParse(w.trim()))
        .whereType<int>()
        .where((w) => w >= 1 && w <= 7)
        .toList();
    final hasFilter = tags.isNotEmpty ||
        airDate != null ||
        rank != null ||
        score != null ||
        weekdays.isNotEmpty;
    if (keyword.isEmpty && !hasFilter) {
      return _jsonError(400, 'keyword_required', 'keyword or filters are required');
    }
    final offset = int.tryParse(q['offset'] ?? '0') ?? 0;
    return _bangumiCall(() => bangumi.search(keyword,
        offset: offset,
        sort: sort,
        tags: tags,
        airDate: airDate,
        rank: rank,
        score: score,
        weekdays: weekdays));
  }

  Future<Response> _handleBangumiDetail(Request request, String id) async {
    // 详情是硬依赖冷拉取：对瞬时抖动重试几次，与旧实现语义一致
    final bangumiId = int.parse(id);
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        return _json(await bangumi.detail(bangumiId));
      } catch (e) {
        if (attempt == 2) {
          logWarn('KazumiWebServer: detail $bangumiId failed after retries', e);
          return _jsonError(
              502, 'bangumi_unavailable', '上游暂时不可用，请稍后重试');
        }
        await Future.delayed(const Duration(milliseconds: 400));
      }
    }
    throw StateError('unreachable');
  }

  Future<Response> _bangumiCall(
    Future<Map<String, dynamic>> Function() task, {
    String? softError,
  }) async {
    try {
      return _json(await task());
    } on ArgumentError catch (e) {
      return _jsonError(400, 'invalid_params', e.message.toString());
    } catch (e) {
      logWarn('KazumiWebServer: bangumi call failed', e);
      return _jsonError(
          502, 'bangumi_failed', softError ?? '获取失败，请稍后重试');
    }
  }

  // ====== 静态文件 ======

  static const Map<String, String> _contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.ttf': 'font/ttf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/manifest+json',
  };

  /// 随应用迭代的自有前端资源：不做强缓存，每次协商拉取（LAN 下
  /// 全量重传也只有百 KB 级）。此前的 7 天强缓存会让用户在版本更新后
  /// 拿不到新的 JS/CSS。第三方库与字体几乎不变，保留长缓存。
  static const Set<String> _ownAssets = {
    'index.html',
    'app.js',
    'player.js',
    'styles.css',
    'manifest.json',
  };

  Future<Response> _serveFile(String name) async {
    // 只允许纯文件名，杜绝路径穿越
    if (name.contains('/') || name.contains('\\') || name.contains('..')) {
      return Response.notFound('not found');
    }
    final file = File('${webDir.path}${Platform.pathSeparator}$name');
    if (!await file.exists()) {
      return Response.notFound('not found');
    }
    final dot = name.lastIndexOf('.');
    final ext = dot >= 0 ? name.substring(dot) : '';
    return Response.ok(
      file.openRead(),
      headers: {
        'content-type': _contentTypes[ext] ?? 'application/octet-stream',
        'cache-control': _ownAssets.contains(name)
            ? 'no-cache'
            : 'public, max-age=604800',
      },
    );
  }

  // ====== helpers ======

  static Map<String, dynamic> _danmakuToJson(DanmakuEntry d) {
    final colorValue = ((d.color.r * 255).toInt() << 16) |
        ((d.color.g * 255).toInt() << 8) |
        (d.color.b * 255).toInt();
    return {
      'time': d.time,
      'type': d.type,
      'color': colorValue,
      'source': d.source,
      'message': d.message,
    };
  }

  static String _detectStreamType(String url) {
    final lower = url.toLowerCase();
    if (lower.contains('.m3u8')) return 'hls';
    if (lower.contains('.mp4') ||
        lower.contains('.m4v') ||
        lower.contains('.mov')) {
      return 'mp4';
    }
    return 'unknown';
  }

  Response _json(Object? body, {int status = 200}) {
    return Response(
      status,
      body: jsonEncode(body),
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }

  Response _jsonError(int status, String code, String message) {
    return _json({'error': code, 'message': message}, status: status);
  }

  Middleware _accessLog() {
    return (Handler inner) {
      return (Request request) async {
        final sw = Stopwatch()..start();
        final response = await inner(request);
        sw.stop();
        logInfo(
            '${request.method} ${request.requestedUri.path} -> ${response.statusCode} (${sw.elapsedMilliseconds}ms)');
        return response;
      };
    };
  }

  Middleware _errorGuard() {
    return (Handler inner) {
      return (Request request) async {
        try {
          return await inner(request);
        } catch (e, st) {
          logError(
              'unhandled error on ${request.method} ${request.requestedUri.path}',
              e,
              st);
          return _jsonError(500, 'unhandled', e.toString());
        }
      };
    };
  }

  /// 枚举本机非回环 IPv4，启动时展示给用户。
  static Future<List<String>> enumerateLanIPv4() async {
    final result = <String>[];
    try {
      final interfaces = await NetworkInterface.list(
        includeLoopback: false,
        type: InternetAddressType.IPv4,
      );
      for (final iface in interfaces) {
        for (final addr in iface.addresses) {
          result.add(addr.address);
        }
      }
    } catch (e) {
      logWarn('enumerate interfaces failed', e);
    }
    return result;
  }
}
