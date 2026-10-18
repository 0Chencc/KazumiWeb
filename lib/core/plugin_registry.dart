import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'package:kazumi_web/plugins/plugins.dart';
import 'package:kazumi_web/request/config/api_endpoints.dart';
import 'package:kazumi_web/request/core/dio_factory.dart';
import 'package:kazumi_web/services/logging/logger.dart';

/// 规则注册表：加载/保存本地规则，并从 KazumiRules 仓库安装。
///
/// 存储格式与桌面端 Kazumi 一致（`plugins/v2/plugins.json`，内容为规则
/// JSON 数组），装过 Kazumi 的用户可以直接把桌面端的规则文件拷过来用。
class PluginRegistry {
  PluginRegistry();

  final List<Plugin> plugins = [];
  File? _storeFile;

  Future<void> init(String dataDir) async {
    final dir = Directory(p.join(dataDir, 'plugins', 'v2'));
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    _storeFile = File(p.join(dir.path, 'plugins.json'));
    await _load();
  }

  Future<void> _load() async {
    plugins.clear();
    final file = _storeFile;
    if (file == null || !await file.exists()) {
      KazumiLogger().i('PluginRegistry: no local rules yet');
      return;
    }
    try {
      final raw = jsonDecode(await file.readAsString());
      if (raw is List) {
        for (final item in raw) {
          if (item is Map) {
            plugins.add(Plugin.fromJson(Map<String, dynamic>.from(item)));
          }
        }
      }
      KazumiLogger().i('PluginRegistry: loaded ${plugins.length} rules');
    } catch (e) {
      KazumiLogger().e('PluginRegistry: failed to load rules', error: e);
    }
  }

  Future<void> save() async {
    final file = _storeFile;
    if (file == null) return;
    final data = plugins.map((plugin) => plugin.toJson()).toList();
    await file.writeAsString(const JsonEncoder.withIndent('  ').convert(data));
  }

  Plugin? find(String name) {
    for (final plugin in plugins) {
      if (plugin.name == name) return plugin;
    }
    return null;
  }

  /// 规则仓库目录（index.json），返回原始条目列表。
  Future<List<Map<String, dynamic>>> fetchCatalog() async {
    final response = await DioFactory.rulesRepoDio
        .get<String>('${ApiEndpoints.pluginShop}index.json');
    final raw = jsonDecode(response.data ?? '[]');
    if (raw is! List) {
      throw const FormatException('rule catalog root must be a JSON array');
    }
    return [
      for (final item in raw)
        if (item is Map) Map<String, dynamic>.from(item)
    ];
  }

  /// 从规则仓库安装（或更新）一条规则。
  Future<Plugin> installFromShop(String name) async {
    final response = await DioFactory.rulesRepoDio
        .get<String>('${ApiEndpoints.pluginShop}$name.json');
    final raw = jsonDecode(response.data ?? '{}');
    if (raw is! Map) {
      throw FormatException('rule $name must be a JSON object');
    }
    final plugin = Plugin.fromJson(Map<String, dynamic>.from(raw));
    plugins.removeWhere((existing) => existing.name == plugin.name);
    plugins.add(plugin);
    await save();
    KazumiLogger().i('PluginRegistry: installed rule ${plugin.name}');
    return plugin;
  }

  Future<bool> remove(String name) async {
    final before = plugins.length;
    plugins.removeWhere((plugin) => plugin.name == name);
    if (plugins.length == before) return false;
    await save();
    return true;
  }

  /// 导入一条规则（JSON 对象，来源：用户粘贴或自定义 URL）。
  /// 同名规则覆盖。
  Future<Plugin> importRaw(Map<String, dynamic> json) async {
    final plugin = Plugin.fromJson(json);
    if (plugin.name.isEmpty) {
      throw const FormatException('规则缺少 name 字段');
    }
    plugins.removeWhere((existing) => existing.name == plugin.name);
    plugins.add(plugin);
    await save();
    KazumiLogger().i('PluginRegistry: imported rule ${plugin.name}');
    return plugin;
  }

  /// 从任意 URL 拉取并导入规则 JSON。
  Future<Plugin> importFromUrl(String url) async {
    final response = await DioFactory.rulesRepoDio.get<String>(url);
    final raw = jsonDecode(response.data ?? '{}');
    if (raw is! Map) {
      throw const FormatException('该地址返回的不是规则 JSON 对象');
    }
    return importRaw(Map<String, dynamic>.from(raw));
  }
}
