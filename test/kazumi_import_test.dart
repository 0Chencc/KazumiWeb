// 验证 KazumiImporter 对桌面版 Kazumi 数据的自动同步。
// 依赖本机存在桌面版数据目录；没有时跳过（CI 环境安全）。
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:kazumi_web/core/kazumi_importer.dart';
import 'package:kazumi_web/core/library_store.dart';
import 'package:kazumi_web/core/plugin_registry.dart';
import 'package:kazumi_web/services/storage/storage.dart';

Future<void> main() async {
  test('auto-syncs desktop Kazumi data with watermark semantics', () async {
    if (!KazumiImporter.desktopDataAvailable()) {
      markTestSkipped('no desktop Kazumi data on this machine');
      return;
    }
    final outDir = await Directory.systemTemp.createTemp('import_probe_');
    addTearDown(() => outDir.delete(recursive: true));

    await GStorage.init(outDir.path);
    final library = LibraryStore();
    await library.init(outDir.path);
    final registry = PluginRegistry();
    await registry.init(outDir.path);

    // 首次同步：水位线为 0，全量导入（含规则）
    final first = await KazumiImporter(library: library, registry: registry)
        .autoSync();
    // ignore: avoid_print
    print('first sync: ${first.collects} collects, ${first.histories} '
        'histories, ${first.rules} rules, ${first.settings} settings');
    expect(first.collects + first.histories, greaterThan(0));
    expect(first.rules, greaterThan(0),
        reason: 'desktop has installed rules; first sync imports them');

    for (final c in library.listCollects().take(3)) {
      final b = c['bangumi'] as Map<String, dynamic>;
      // ignore: avoid_print
      print('  collect [type ${c['type']}] ${b['nameCn'] ?? b['name']}');
    }

    // 二次同步：水位线之后无新数据，应为空操作（含规则不重复导入）
    final second = await KazumiImporter(library: library, registry: registry)
        .autoSync();
    expect(second.collects, 0);
    expect(second.histories, 0);
    expect(second.rules, 0);

    // 水位线已推进
    expect(GStorage.getSetting(SettingsKeys.desktopImportWatermark),
        greaterThan(0));
  });
}
