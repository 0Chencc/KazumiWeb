import 'dart:io';

import 'package:launch_at_startup/launch_at_startup.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path/path.dart' as p;
import 'package:tray_manager/tray_manager.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:window_manager/window_manager.dart';

import 'package:kazumi_web/services/logging/logger.dart';
import 'package:kazumi_web/services/storage/storage.dart';

/// 系统托盘常驻与开机自启。
///
/// 关闭窗口时隐藏到托盘（服务继续运行），托盘菜单提供：
/// 显示窗口 / 在浏览器打开 / 开机自启开关 / 退出。
class TrayService with TrayListener {
  TrayService._();

  static final TrayService instance = TrayService._();

  String Function()? _webUrlProvider;
  bool _initialized = false;

  Future<void> init({required String Function() webUrlProvider}) async {
    if (_initialized) return;
    _initialized = true;
    _webUrlProvider = webUrlProvider;

    final packageInfo = await PackageInfo.fromPlatform();
    launchAtStartup.setup(
      appName: 'KazumiWeb',
      appPath: Platform.resolvedExecutable,
      packageName: packageInfo.packageName,
    );

    trayManager.addListener(this);
    await trayManager.setIcon(_iconPath());
    await trayManager.setToolTip('KazumiWeb');
    await _rebuildMenu();

    // 关闭按钮 → 隐藏到托盘而非退出
    await windowManager.setPreventClose(true);
    KazumiLogger().i('TrayService: initialized');
  }

  static String _iconPath() {
    if (Platform.isWindows) {
      // runner 资源里的 ico 随构建产物分发
      return p.join(
        File(Platform.resolvedExecutable).parent.path,
        'data',
        'flutter_assets',
        'assets',
        'images',
        'tray_icon.ico',
      );
    }
    return p.join(
      File(Platform.resolvedExecutable).parent.path,
      'data',
      'flutter_assets',
      'assets',
      'images',
      'logo.png',
    );
  }

  Future<void> _rebuildMenu() async {
    final autoStart = await launchAtStartup.isEnabled();
    await trayManager.setContextMenu(Menu(items: [
      MenuItem(key: 'show', label: '显示窗口'),
      MenuItem(key: 'open-web', label: '在浏览器打开'),
      MenuItem.separator(),
      MenuItem.checkbox(
        key: 'autostart',
        label: '开机自启',
        checked: autoStart,
      ),
      MenuItem.separator(),
      MenuItem(key: 'exit', label: '退出'),
    ]));
  }

  @override
  void onTrayIconMouseDown() {
    _showWindow();
  }

  @override
  void onTrayIconRightMouseDown() {
    trayManager.popUpContextMenu();
  }

  @override
  Future<void> onTrayMenuItemClick(MenuItem menuItem) async {
    switch (menuItem.key) {
      case 'show':
        await _showWindow();
        break;
      case 'open-web':
        final url = _webUrlProvider?.call();
        if (url != null && url.isNotEmpty) {
          await launchUrl(Uri.parse(url));
        }
        break;
      case 'autostart':
        final enabled = await launchAtStartup.isEnabled();
        if (enabled) {
          await launchAtStartup.disable();
        } else {
          await launchAtStartup.enable();
        }
        await GStorage.putSetting(SettingsKeys.launchAtStartup, !enabled);
        await _rebuildMenu();
        break;
      case 'exit':
        await trayManager.destroy();
        await windowManager.setPreventClose(false);
        await windowManager.close();
        exit(0);
    }
  }

  Future<void> _showWindow() async {
    await windowManager.show();
    await windowManager.focus();
  }

  Future<void> hideToTray() async {
    await windowManager.hide();
  }
}
