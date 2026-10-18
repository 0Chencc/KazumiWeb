import 'dart:io';
import 'dart:async';

import 'package:kazumi_web/webview/video/impl/video_webview_windows_impl.dart';
import 'package:kazumi_web/webview/video/impl/video_webview_linux_impl.dart';
import 'package:kazumi_web/webview/video/impl/video_webview_apple_impl.dart';

// 与上游 Kazumi 的差异：只保留桌面平台（Windows/Linux/macOS）的实现
// 分支，移动端被裁剪。其余内容与上游保持一致，便于跟随上游同步。

abstract class VideoWebviewController<T> {
  // WebView controller.
  T? webviewController;

  // Retry count
  int count = 0;
  // Last watched position
  int offset = 0;
  bool isIframeLoaded = false;
  bool isVideoSourceLoaded = false;

  /// WebView initialization method.
  Future<void> init();

  final StreamController<bool> initEventController =
      StreamController<bool>.broadcast();

  // Stream to notify when the webview is initialized
  Stream<bool> get onInitialized => initEventController.stream;

  final StreamController<String> logEventController =
      StreamController<String>.broadcast();

  // Stream to subscribe to webview logs
  Stream<String> get onLog => logEventController.stream;

  final StreamController<bool> videoLoadingEventController =
      StreamController<bool>.broadcast();

  // Stream to notify when the video source is loaded
  Stream<bool> get onVideoLoading => videoLoadingEventController.stream;

  // Stream to notify video source URL when the video source is loaded
  // The first parameter is the video source URL and the second parameter is the video offset (start position)
  final StreamController<(String, int)> videoParserEventController =
      StreamController<(String, int)>.broadcast();

  Stream<(String, int)> get onVideoURLParser =>
      videoParserEventController.stream;

  void disposeEventControllers() {
    if (!initEventController.isClosed) {
      initEventController.close();
    }
    if (!logEventController.isClosed) {
      logEventController.close();
    }
    if (!videoLoadingEventController.isClosed) {
      videoLoadingEventController.close();
    }
    if (!videoParserEventController.isClosed) {
      videoParserEventController.close();
    }
  }

  /// WebView load URL method.
  Future<void> loadUrl(String url, bool useLegacyParser, {int offset = 0});

  /// WebView unload page method.
  Future<void> unloadPage();

  /// WebView dispose method.
  Future<void> dispose();
}

class VideoWebviewControllerFactory {
  static VideoWebviewController getController() {
    if (Platform.isWindows) {
      return VideoWebviewWindowsImpl();
    }
    if (Platform.isLinux) {
      return VideoWebviewLinuxImpl();
    }
    if (Platform.isMacOS) {
      return VideoWebviewAppleImpl();
    }
    throw UnsupportedError(
        'KazumiWeb: unsupported platform ${Platform.operatingSystem}');
  }
}
