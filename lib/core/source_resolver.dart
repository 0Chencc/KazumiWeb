import 'dart:async';

import 'package:synchronized/synchronized.dart';

import 'package:kazumi_web/plugins/plugins.dart';
import 'package:kazumi_web/services/logging/logger.dart';
import 'package:kazumi_web/services/video_source/video_source_service.dart';
import 'package:kazumi_web/services/video_source/webview_video_source_service.dart';

/// WebView 视频源解析的串行化封装。
///
/// [WebViewVideoSourceService] 同实例不能并发（内部用 `_resolveId` 互踢），
/// 所以用一个 [Lock] 把所有来自 web 端的 resolve 调用排队执行。
class SourceResolver {
  SourceResolver();

  final Lock _lock = Lock();
  WebViewVideoSourceService? _provider;

  Future<VideoSource> resolve({
    required Plugin plugin,
    required String episodeUrl,
    Duration timeout = const Duration(seconds: 20),
  }) {
    return _lock.synchronized(() async {
      _provider ??= WebViewVideoSourceService();
      try {
        final source = await _provider!.resolve(
          episodeUrl,
          useLegacyParser: plugin.useLegacyParser,
          timeout: timeout,
        );
        KazumiLogger()
            .i('SourceResolver: resolved ${plugin.name} -> ${source.url}');
        return source;
      } catch (e) {
        KazumiLogger()
            .w('SourceResolver: resolve failed for ${plugin.name}', error: e);
        rethrow;
      }
    });
  }

  Future<void> dispose() async {
    await _lock.synchronized(() async {
      _provider?.dispose();
      _provider = null;
    });
  }
}
