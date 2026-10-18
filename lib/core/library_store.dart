import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:synchronized/synchronized.dart';

import 'package:kazumi_web/services/logging/logger.dart';

/// 观看历史与收藏的本地存储（单 JSON 文件）。
///
/// KazumiWeb 独立运行，web 端的观看进度不与桌面 Kazumi 互通——
/// 存储的记录形状与旧 LAN server 的 API 响应保持一致，web UI 零改动。
class LibraryStore {
  LibraryStore();

  final Lock _writeLock = Lock();
  File? _file;

  /// key: `<pluginName>::<bangumiId>`
  final Map<String, Map<String, dynamic>> _histories = {};

  /// key: `<bangumiId>`
  final Map<String, Map<String, dynamic>> _collects = {};

  Future<void> init(String dataDir) async {
    final file = File(p.join(dataDir, 'library.json'));
    _file = file;
    if (!await file.exists()) return;
    try {
      final raw = jsonDecode(await file.readAsString());
      if (raw is Map<String, dynamic>) {
        final histories = raw['histories'];
        if (histories is Map) {
          histories.forEach((key, value) {
            if (value is Map) {
              _histories[key.toString()] = Map<String, dynamic>.from(value);
            }
          });
        }
        final collects = raw['collects'];
        if (collects is Map) {
          collects.forEach((key, value) {
            if (value is Map) {
              _collects[key.toString()] = Map<String, dynamic>.from(value);
            }
          });
        }
      }
    } catch (e) {
      KazumiLogger().e('LibraryStore: failed to load, starting empty', error: e);
    }
  }

  Future<void> _save() {
    return _writeLock.synchronized(() async {
      final file = _file;
      if (file == null) return;
      await file.writeAsString(jsonEncode({
        'histories': _histories,
        'collects': _collects,
      }));
    });
  }

  // ====== History ======

  static String _historyKey(String pluginName, int bangumiId) =>
      '$pluginName::$bangumiId';

  Map<String, dynamic>? getHistory(String pluginName, int bangumiId) {
    return _histories[_historyKey(pluginName, bangumiId)];
  }

  /// [device] 非空时只返回该设备看过的条目；无 devices 字段的条目
  /// （桌面版导入或旧数据）对所有设备可见。观看进度本身全局共享，
  /// 跨设备续播不受影响——这里只过滤"历史列表"的展示。
  List<Map<String, dynamic>> listHistories({String? device}) {
    var list = _histories.values.toList();
    if (device != null && device.isNotEmpty) {
      list = list.where((entry) {
        final devices = entry['devices'];
        if (devices is! Map) return true;
        return devices.containsKey(device);
      }).toList();
    }
    list.sort((a, b) =>
        ((b['lastWatchTime'] ?? 0) as num).compareTo((a['lastWatchTime'] ?? 0) as num));
    return list;
  }

  Future<Map<String, dynamic>> updateProgress({
    required int bangumiId,
    required String pluginName,
    required int episode,
    required int road,
    required int progressMs,
    required String lastSrc,
    required String episodeName,
    required Map<String, dynamic> bangumi,
    String? deviceId,
    String src = '',
  }) async {
    final key = _historyKey(pluginName, bangumiId);
    final entry = _histories[key] ??
        {
          'bangumiId': bangumiId,
          'pluginName': pluginName,
          'progresses': <String, dynamic>{},
        };
    entry['lastWatchEpisode'] = episode;
    entry['lastWatchEpisodeName'] = episodeName;
    entry['lastWatchTime'] = DateTime.now().millisecondsSinceEpoch;
    if (lastSrc.isNotEmpty) {
      entry['lastSrc'] = lastSrc;
    }
    // 详情页地址（检索结果 src）：历史直达续播时恢复上一集/下一集能力。
    // 从历史直达进入播放器时前端不带 src，此时上报为空，不覆盖已有值。
    if (src.isNotEmpty) {
      entry['src'] = src;
    }
    entry['bangumi'] = bangumi;
    final progresses = entry['progresses'] as Map<String, dynamic>;
    progresses['$episode'] = {
      'episode': episode,
      'road': road,
      'progressMs': progressMs,
    };
    if (deviceId != null && deviceId.isNotEmpty) {
      final devices = entry['devices'];
      final map = devices is Map
          ? Map<String, dynamic>.from(devices)
          : <String, dynamic>{};
      map[deviceId] = DateTime.now().millisecondsSinceEpoch;
      entry['devices'] = map;
    }
    _histories[key] = entry;
    await _save();
    return entry;
  }

  Future<bool> deleteHistory(String pluginName, int bangumiId) async {
    final removed = _histories.remove(_historyKey(pluginName, bangumiId));
    if (removed == null) return false;
    await _save();
    return true;
  }

  Future<void> clearHistories() async {
    if (_histories.isEmpty) return;
    _histories.clear();
    await _save();
  }

  // ====== Collect ======

  Map<String, dynamic>? getCollect(int bangumiId) => _collects['$bangumiId'];

  List<Map<String, dynamic>> listCollects({int? type}) {
    var list = _collects.values.toList();
    if (type != null) {
      list = list.where((c) => c['type'] == type).toList();
    }
    list.sort(
        (a, b) => ((b['time'] ?? 0) as num).compareTo((a['time'] ?? 0) as num));
    return list;
  }

  Future<void> putCollect({
    required int bangumiId,
    required int type,
    required Map<String, dynamic> bangumi,
  }) async {
    _collects['$bangumiId'] = {
      'bangumiId': bangumiId,
      'type': type,
      'time': DateTime.now().millisecondsSinceEpoch,
      'bangumi': bangumi,
    };
    await _save();
  }

  Future<void> deleteCollect(int bangumiId) async {
    if (_collects.remove('$bangumiId') != null) {
      await _save();
    }
  }

  // ====== 批量导入（桌面版 Kazumi 数据） ======
  //
  // merge* 只更新内存，不逐条落盘；导入方最后调 [flush] 一次写入。
  // 冲突策略：同一条目以时间戳较新的一方为准。

  /// 返回是否实际写入（本地已有更新数据时跳过）。
  Future<bool> mergeCollect({
    required int bangumiId,
    required int type,
    required int timeMs,
    required Map<String, dynamic> bangumi,
  }) async {
    final existing = _collects['$bangumiId'];
    if (existing != null && ((existing['time'] ?? 0) as num) >= timeMs) {
      return false;
    }
    _collects['$bangumiId'] = {
      'bangumiId': bangumiId,
      'type': type,
      'time': timeMs,
      'bangumi': bangumi,
    };
    return true;
  }

  /// 返回是否实际写入（本地已有更新数据时跳过）。
  Future<bool> mergeHistory({
    required int bangumiId,
    required String pluginName,
    required Map<String, dynamic> entry,
  }) async {
    final key = _historyKey(pluginName, bangumiId);
    final existing = _histories[key];
    final incomingTime = (entry['lastWatchTime'] ?? 0) as num;
    if (existing != null &&
        ((existing['lastWatchTime'] ?? 0) as num) >= incomingTime) {
      return false;
    }
    _histories[key] = entry;
    return true;
  }

  Future<void> flush() => _save();
}
