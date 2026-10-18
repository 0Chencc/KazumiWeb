import 'package:dio/dio.dart';

import 'package:kazumi_web/modules/collect/collect_type.dart';
import 'package:kazumi_web/modules/collect/collect_type_mapper.dart';
import 'package:kazumi_web/request/config/api_endpoints.dart';
import 'package:kazumi_web/request/core/dio_factory.dart';
import 'package:kazumi_web/services/logging/logger.dart';
import 'package:kazumi_web/services/storage/storage.dart';

/// Bangumi 账号联动（推送方向）。
///
/// 桌面版 Kazumi 的 Bangumi 同步是双向的；KazumiWeb 只需补"推送"半边：
/// - 拉取方向（bgm.tv → 本地收藏）由桌面版完成后写入 Hive，再经我们的
///   桌面数据跟随同步自然到达 web 端，无需重复实现。
/// - 推送方向：web 端修改追番状态时，把变更上报到用户的 bgm.tv 账号。
///
/// AccessToken 与同步开关跟随桌面版设置（setting.hive），用户无需在
/// web 端重新登录。推送失败只记日志——本地收藏永远先行生效。
class BangumiAccountSync {
  BangumiAccountSync._();

  static bool get enabled {
    return GStorage.getSetting(SettingsKeys.bangumiSyncEnable) &&
        GStorage.getSetting(SettingsKeys.bangumiAccessToken).isNotEmpty;
  }

  /// 推送收藏状态变更；[localType] 为本地 CollectType 值（0=取消收藏，
  /// bgm.tv 无对应操作，跳过）。fire-and-forget 语义，失败不抛。
  static Future<void> pushCollect(int subjectId, int localType) async {
    if (!enabled) return;
    final bangumiType =
        CollectType.fromValue(localType).toBangumiCollectionType();
    if (bangumiType == null) return;
    final token = GStorage.getSetting(SettingsKeys.bangumiAccessToken);
    try {
      await DioFactory.apiDio.post(
        ApiEndpoints.formatUrl(
          ApiEndpoints.bangumiAuthAPIMirrorDomain +
              ApiEndpoints.bangumiSetCollection,
          [subjectId],
        ),
        data: {'type': bangumiType.value},
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      KazumiLogger()
          .i('BangumiAccountSync: pushed subject $subjectId -> $bangumiType');
    } catch (e) {
      KazumiLogger()
          .w('BangumiAccountSync: push failed for $subjectId', error: e);
    }
  }
}
