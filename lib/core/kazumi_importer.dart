import 'dart:convert';
import 'dart:io';

import 'package:hive_ce/hive.dart';
import 'package:path/path.dart' as p;

import 'package:kazumi_web/core/library_store.dart';
import 'package:kazumi_web/core/plugin_registry.dart';
import 'package:kazumi_web/modules/bangumi/bangumi_item.dart';
import 'package:kazumi_web/modules/bangumi/bangumi_tag.dart';
import 'package:kazumi_web/modules/collect/collect_module.dart';
import 'package:kazumi_web/modules/history/history_module.dart';
import 'package:kazumi_web/plugins/plugins.dart';
import 'package:kazumi_web/services/logging/logger.dart';
import 'package:kazumi_web/services/storage/storage.dart';

class KazumiImportResult {
  const KazumiImportResult({
    this.collects = 0,
    this.histories = 0,
    this.rules = 0,
    this.settings = 0,
  });

  final int collects;
  final int histories;
  final int rules;
  final int settings;

  bool get isEmpty =>
      collects == 0 && histories == 0 && rules == 0 && settings == 0;
}

/// 桌面版 Kazumi 数据的自动同步（只读，启动时静默执行）。
///
/// 同步内容与策略：
/// - 收藏 / 观看历史（Hive box）：增量导入——只取时间戳晚于水位线
///   [SettingsKeys.desktopImportWatermark] 的条目，web 端删除的内容
///   不会在下次启动时"复活"，桌面版新看的进度会自动跟进。
/// - 视频源规则（plugins/v2/plugins.json）：仅首次同步时整体导入，
///   之后规则由 KazumiWeb 自行管理。
/// - 网络设置（setting.hive：代理、bangumi 镜像）：仅本地未配置的键
///   采用桌面版的值。
///
/// Hive box 不支持跨进程共享，所以把 `.hive` 文件拷到临时目录再读——
/// 桌面版正在运行也不受影响。模型与适配器逐字拷贝自上游（typeId 一致）。
class KazumiImporter {
  KazumiImporter({required this.library, required this.registry});

  final LibraryStore library;
  final PluginRegistry registry;

  static bool _adaptersRegistered = false;

  /// 桌面版 Kazumi 的数据目录候选（按发现顺序）。
  static List<String> _kazumiDataDirs() {
    final appData = Platform.environment['APPDATA'];
    if (appData == null) return const [];
    return [
      p.join(appData, 'com.example', 'kazumi'),
      p.join(appData, 'com.predidit', 'kazumi'),
    ];
  }

  static Directory? _findDataDir() {
    for (final dir in _kazumiDataDirs()) {
      if (Directory(p.join(dir, 'hive')).existsSync()) {
        return Directory(dir);
      }
    }
    return null;
  }

  /// 是否能在本机找到桌面版 Kazumi 的数据。
  static bool desktopDataAvailable() => _findDataDir() != null;

  /// 桌面版数据文件的变更指纹（mtime 组合）。周期同步用它做廉价的
  /// "有没有变化"判断，避免每轮都拷文件开 box。
  static String dataFingerprint() {
    final dataDir = _findDataDir();
    if (dataDir == null) return '';
    final parts = <String>[];
    for (final name in ['collectibles', 'histories', 'setting']) {
      final file = File(p.join(dataDir.path, 'hive', '$name.hive'));
      if (file.existsSync()) {
        parts.add('$name:${file.lastModifiedSync().millisecondsSinceEpoch}');
      }
    }
    return parts.join('|');
  }

  /// 启动时调用：桌面版数据存在则自动同步，任何失败只记日志不阻塞启动。
  Future<KazumiImportResult> autoSync() async {
    final dataDir = _findDataDir();
    if (dataDir == null) return const KazumiImportResult();
    try {
      final result = await _sync(dataDir);
      if (!result.isEmpty) {
        KazumiLogger().i(
            'KazumiImporter: synced ${result.collects} collects, '
            '${result.histories} histories, ${result.rules} rules, '
            '${result.settings} settings from desktop Kazumi');
      }
      return result;
    } catch (e, st) {
      KazumiLogger()
          .w('KazumiImporter: desktop sync failed', error: e, stackTrace: st);
      return const KazumiImportResult();
    }
  }

  Future<KazumiImportResult> _sync(Directory dataDir) async {
    final watermark = GStorage.getSetting(SettingsKeys.desktopImportWatermark);
    final firstSync = watermark == 0;
    final syncStartedAt = DateTime.now().millisecondsSinceEpoch;

    final rules = firstSync ? await _importRules(dataDir) : 0;

    final temp = await Directory.systemTemp.createTemp('kazumi_import_');
    var collects = 0;
    var histories = 0;
    var settings = 0;
    try {
      final boxNames = <String>[];
      for (final name in ['collectibles', 'histories', 'setting']) {
        final src = File(p.join(dataDir.path, 'hive', '$name.hive'));
        if (!await src.exists()) continue;
        await src.copy(p.join(temp.path, '$name.hive'));
        boxNames.add(name);
      }
      if (boxNames.isNotEmpty) {
        Hive.init(temp.path);
        if (!_adaptersRegistered) {
          Hive.registerAdapter(BangumiItemAdapter());
          Hive.registerAdapter(BangumiTagAdapter());
          Hive.registerAdapter(CollectedBangumiAdapter());
          Hive.registerAdapter(HistoryAdapter());
          Hive.registerAdapter(ProgressAdapter());
          _adaptersRegistered = true;
        }
        if (boxNames.contains('collectibles')) {
          collects = await _importCollects(watermark);
        }
        if (boxNames.contains('histories')) {
          histories = await _importHistories(watermark);
        }
        if (boxNames.contains('setting')) {
          settings = await _importSettings();
        }
        await library.flush();
      }
    } finally {
      try {
        await temp.delete(recursive: true);
      } catch (_) {}
    }

    await GStorage.putSetting(
        SettingsKeys.desktopImportWatermark, syncStartedAt);
    return KazumiImportResult(
      collects: collects,
      histories: histories,
      rules: rules,
      settings: settings,
    );
  }

  Future<int> _importCollects(int watermark) async {
    final box = await Hive.openBox<CollectedBangumi>('collectibles');
    var imported = 0;
    for (final c in box.values) {
      final timeMs = c.time.millisecondsSinceEpoch;
      if (timeMs <= watermark) continue;
      final merged = await library.mergeCollect(
        bangumiId: c.bangumiItem.id,
        type: c.type,
        timeMs: timeMs,
        bangumi: _bangumiItemToJson(c.bangumiItem),
      );
      if (merged) imported++;
    }
    await box.close();
    return imported;
  }

  Future<int> _importHistories(int watermark) async {
    final box = await Hive.openBox<History>('histories');
    var imported = 0;
    for (final h in box.values) {
      if (HistoryEntryKind.normalize(h.entryKind) != HistoryEntryKind.online) {
        continue; // 离线缓存的观看记录对 web 端没有意义
      }
      final timeMs = h.lastWatchTime.millisecondsSinceEpoch;
      if (timeMs <= watermark) continue;
      final progresses = <String, dynamic>{};
      h.progresses.forEach((ep, progress) {
        progresses['$ep'] = {
          'episode': progress.episode,
          'road': progress.road,
          'progressMs': progress.progress.inMilliseconds,
        };
      });
      final merged = await library.mergeHistory(
        bangumiId: h.bangumiItem.id,
        pluginName: h.adapterName,
        entry: {
          'bangumiId': h.bangumiItem.id,
          'pluginName': h.adapterName,
          'lastWatchEpisode': h.lastWatchEpisode,
          'lastWatchEpisodeName': h.lastWatchEpisodeName,
          'lastWatchTime': timeMs,
          'lastSrc': h.lastSrc,
          'progresses': progresses,
          'bangumi': _bangumiItemToJson(h.bangumiItem),
        },
      );
      if (merged) imported++;
    }
    await box.close();
    return imported;
  }

  /// 桌面版的网络相关设置：持续跟随（每次同步采用桌面版当前值），
  /// 但用户在 web 端显式改过的键（override）不再跟随。
  Future<int> _importSettings() async {
    final box = await Hive.openBox<dynamic>('setting');
    var imported = 0;
    for (final key in const <SettingKey<Object?>>[
      SettingsKeys.proxyEnable,
      SettingsKeys.proxyUrl,
      SettingsKeys.enableBangumiProxy,
      SettingsKeys.enableGitProxy,
      // Bangumi 账号联动跟随桌面版：token 与开关（推送方向用）
      SettingsKeys.bangumiSyncEnable,
      SettingsKeys.bangumiAccessToken,
    ]) {
      if (GStorage.isUserOverridden(key)) continue;
      final value = box.get(key.name);
      if (value == null) continue;
      if (GStorage.getSetting(key) == value) continue;
      await GStorage.putSetting(key, value as Object?);
      imported++;
    }
    await box.close();
    return imported;
  }

  /// 桌面版已安装的规则（plugins/v2/plugins.json，纯 JSON 非 Hive）。
  /// 本地不存在的规则才导入。
  Future<int> _importRules(Directory dataDir) async {
    final file = File(p.join(dataDir.path, 'plugins', 'v2', 'plugins.json'));
    if (!await file.exists()) return 0;
    var imported = 0;
    try {
      final raw = jsonDecode(await file.readAsString());
      if (raw is! List) return 0;
      for (final item in raw) {
        if (item is! Map) continue;
        final plugin = Plugin.fromJson(Map<String, dynamic>.from(item));
        if (registry.find(plugin.name) != null) continue;
        registry.plugins.add(plugin);
        imported++;
      }
      if (imported > 0) {
        await registry.save();
      }
    } catch (e) {
      KazumiLogger().w('KazumiImporter: rule import failed', error: e);
    }
    return imported;
  }

  static Map<String, dynamic> _bangumiItemToJson(BangumiItem b) => {
        'id': b.id,
        'type': b.type,
        'name': b.name,
        'nameCn': b.nameCn,
        'summary': b.summary,
        'airDate': b.airDate,
        'airWeekday': b.airWeekday,
        'rank': b.rank,
        'ratingScore': b.ratingScore,
        'votes': b.votes,
        'votesCount': b.votesCount,
        'images': b.images,
        'info': b.info,
        'tags': b.tags.map((t) => {'name': t.name, 'count': t.count}).toList(),
        'alias': b.alias,
      };
}
