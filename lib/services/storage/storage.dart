import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// 上游 Kazumi `services/storage/storage.dart`（Hive 版）的最小替身。
///
/// 拷贝自上游的模块（dio_factory / network_config / webview impl）通过
/// `GStorage.getSetting(SettingsKeys.xxx)` 读设置；保持同路径、同调用形态，
/// 上游文件改 import 前缀后无需任何修改。后端用单个 JSON 文件而非 Hive，
/// companion 自己的设置也统一放在这里。
class SettingKey<T> {
  const SettingKey(this.name, this.defaultValue);

  final String name;
  final T defaultValue;
}

class SettingsKeys {
  // 与上游同名的键（被拷贝模块引用）
  static const proxyEnable = SettingKey<bool>('proxyEnable', false);
  static const proxyUrl = SettingKey<String>('proxyUrl', '');
  static const enableBangumiProxy =
      SettingKey<bool>('enableBangumiProxy', false);
  static const enableGitProxy = SettingKey<bool>('enableGitProxy', false);
  static const bangumiSyncEnable = SettingKey<bool>('bangumiSyncEnable', false);
  static const bangumiAccessToken =
      SettingKey<String>('bangumiAccessToken', '');

  // companion 自己的设置
  static const serverPort = SettingKey<int>('serverPort', 8333);
  static const launchAtStartup = SettingKey<bool>('launchAtStartup', false);

  /// 桌面版数据自动同步的水位线（上次导入时刻，epoch ms）。
  /// 只导入桌面版时间戳更新的条目，web 端的删除不会被"复活"。
  static const desktopImportWatermark =
      SettingKey<int>('desktopImportWatermark', 0);

  SettingsKeys._();
}

class GStorage {
  static Map<String, dynamic> _data = {};
  static File? _file;

  /// [dir] 为数据目录；设置持久化在 `<dir>/settings.json`。
  static Future<void> init(String dir) async {
    final file = File(p.join(dir, 'settings.json'));
    _file = file;
    if (await file.exists()) {
      try {
        final raw = jsonDecode(await file.readAsString());
        if (raw is Map<String, dynamic>) {
          _data = raw;
        }
      } catch (_) {
        // 配置损坏时按空配置启动，不阻塞服务。
        _data = {};
      }
    }
  }

  static T getSetting<T>(SettingKey<T> key) {
    final stored = _data[key.name];
    if (stored is T) {
      return stored;
    }
    return key.defaultValue;
  }

  /// 该键是否被显式设置过（用于"仅本地未配置时采用外部值"的场景）。
  static bool hasSetting(SettingKey<Object?> key) {
    return _data.containsKey(key.name);
  }

  static Future<void> putSetting<T>(SettingKey<T> key, T value) async {
    _data[key.name] = value;
    final file = _file;
    if (file != null) {
      await file.writeAsString(jsonEncode(_data));
    }
  }

  // ====== 桌面版设置跟随 ======
  //
  // 网络类设置默认"跟随桌面版 Kazumi"（每次同步采用桌面版当前值）。
  // 用户在 web 端显式修改过的键记入 override 名单，此后不再被跟随覆盖。

  static const String _overridesKey = '_userOverrides';

  static bool isUserOverridden(SettingKey<Object?> key) {
    final raw = _data[_overridesKey];
    return raw is List && raw.contains(key.name);
  }

  /// 用户显式设置：写入值并停止跟随桌面版。
  static Future<void> putSettingUser<T>(SettingKey<T> key, T value) async {
    final raw = _data[_overridesKey];
    final overrides = raw is List ? List<dynamic>.from(raw) : <dynamic>[];
    if (!overrides.contains(key.name)) {
      overrides.add(key.name);
    }
    _data[_overridesKey] = overrides;
    await putSetting(key, value);
  }
}
