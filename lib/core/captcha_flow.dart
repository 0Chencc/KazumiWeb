import 'dart:async';

import 'package:kazumi_web/plugins/anti_crawler_config.dart';
import 'package:kazumi_web/plugins/plugins.dart';
import 'package:kazumi_web/services/logging/logger.dart';
import 'package:kazumi_web/services/plugin/captcha_verification_service.dart';

/// 视频源人机验证的会话管理（web 化桌面版的验证码流程）。
///
/// 桌面版由弹窗 UI 驱动 [CaptchaVerificationService]；这里改为 API 驱动：
/// - 类型 2（自动点按钮）/ 类型 3（自定义脚本）：服务端全自动完成，
///   web 端无感知，直接返回 verified。
/// - 类型 1（图片验证码）：服务端 WebView 抓到验证码图片 URL 后返回给
///   web 端展示，用户输入验证码再经 [submit] 提交。
///
/// 同一时刻只允许一个验证会话（WebView 单实例语义），新会话替换旧会话。
/// 验证成功后 Cookie 由 [CaptchaVerificationService] 存入
/// PluginCookieManager，后续检索自动携带。
class CaptchaFlow {
  CaptchaVerificationService? _service;
  String? _activePlugin;

  bool get hasActiveSession => _service != null;

  static String _searchUrl(Plugin plugin, String keyword) {
    return plugin.searchURL
        .replaceAll('@keyword', Uri.encodeQueryComponent(keyword));
  }

  /// 启动验证会话。
  ///
  /// 返回 `{'status': 'verified'}`（自动类型已完成）或
  /// `{'status': 'captcha', 'image': <url>}`（等待用户输入验证码）。
  /// 超时抛 [TimeoutException]。
  Future<Map<String, dynamic>> start(Plugin plugin, String keyword) async {
    await _disposeSession();
    final service = CaptchaVerificationService();
    _service = service;
    _activePlugin = plugin.name;

    final url = _searchUrl(plugin, keyword);
    final config = plugin.antiCrawlerConfig;
    KazumiLogger().i(
        'CaptchaFlow: start type ${config.captchaType} for ${plugin.name}');

    switch (config.captchaType) {
      case CaptchaType.autoClickButton:
        return _runAutomated(
          () => service.loadForButtonClick(
            url: url,
            buttonXpath: config.captchaButton,
            pluginName: plugin.name,
            onVerified: _automatedDone,
          ),
        );
      case CaptchaType.customJavaScript:
        return _runAutomated(
          () => service.loadForCustomScript(
            url: url,
            script: config.captchaScript,
            pluginName: plugin.name,
            onVerified: _automatedDone,
          ),
        );
      default:
        // 类型 1：先订阅图片流再加载，避免竞态丢事件
        final imageFuture = service.onCaptchaImageUrl
            .firstWhere((src) => src != null && src.isNotEmpty);
        await service.loadForCaptcha(
          url,
          config.captchaImage,
          inputXpath: config.captchaInput,
        );
        final image = await imageFuture.timeout(const Duration(seconds: 25));
        return {'status': 'captcha', 'image': image};
    }
  }

  Completer<void>? _automatedCompleter;

  void _automatedDone() {
    final completer = _automatedCompleter;
    if (completer != null && !completer.isCompleted) {
      completer.complete();
    }
  }

  Future<Map<String, dynamic>> _runAutomated(
      Future<void> Function() load) async {
    final completer = Completer<void>();
    _automatedCompleter = completer;
    await load();
    await completer.future.timeout(const Duration(seconds: 30));
    await _disposeSession();
    return {'status': 'verified'};
  }

  /// 提交图片验证码。返回是否在超时窗口内确认验证通过；
  /// 未通过时会话保留，允许用户重新输入。
  Future<bool> submit(Plugin plugin, String code) async {
    final service = _service;
    if (service == null || _activePlugin != plugin.name) {
      throw StateError('没有进行中的验证会话，请重新发起');
    }
    final done = Completer<void>();
    await service.submitCaptcha(
      captchaCode: code,
      inputXpath: plugin.antiCrawlerConfig.captchaInput,
      buttonXpath: plugin.antiCrawlerConfig.captchaButton,
      pluginName: plugin.name,
      onVerified: () {
        if (!done.isCompleted) done.complete();
      },
    );
    try {
      await done.future.timeout(const Duration(seconds: 10));
      await _disposeSession();
      return true;
    } on TimeoutException {
      return false;
    }
  }

  /// 取消会话。与桌面版一致：取消也会尝试保存已有 Cookie
  /// （某些站点在页面加载时即发放通行 Cookie）。
  Future<void> cancel() async {
    final service = _service;
    final pluginName = _activePlugin;
    if (service != null && pluginName != null) {
      try {
        await service.saveAndUnload(pluginName);
      } catch (e) {
        KazumiLogger().w('CaptchaFlow: cancel save failed', error: e);
      }
    }
    await _disposeSession();
  }

  Future<void> _disposeSession() async {
    _automatedCompleter = null;
    _service?.dispose();
    _service = null;
    _activePlugin = null;
  }
}
