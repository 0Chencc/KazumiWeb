import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:kazumi_web/logger.dart';
import 'package:kazumi_web/services/storage/storage.dart';

/// Bangumi 公开数据服务：sidecar 直连 bgm.tv（或 Kazumi 镜像后端），
/// 不经过宿主 Host API——这些不是宿主独有能力。
///
/// 输出形状与旧 LAN server 的 /api/* 响应完全一致，web UI 零改动。
/// 镜像模式（`useMirror`）复刻宿主 dio 拦截器的行为：api.bgm.tv 与
/// next.bgm.tv 的请求改发到 api.kazumi.fyi 同路径；popular 与季节时间表
/// 走镜像专用端点。
class BangumiService {
  BangumiService() : _client = HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 10);
    // 与 network_config 同理：缩短 keep-alive 空闲期，避免复用被
    // 对端半关闭的死连接（表现为间歇性 HandshakeException）。
    _client.idleTimeout = const Duration(seconds: 3);
  }

  /// 每次请求时读取设置，web 端切换镜像开关后即时生效，无需重启服务。
  bool get useMirror => GStorage.getSetting(SettingsKeys.enableBangumiProxy);

  final HttpClient _client;
  final Random _random = Random();

  static const _mirrorDomain = 'https://api.kazumi.fyi';
  static const _userAgent =
      'KazumiWeb/0.1.0 (https://github.com/Predidit/Kazumi)';

  // 高层端点始终以官方域构造 URL；镜像替换与失败回退在请求层统一处理
  // （见 _requestJson）。镜像后端只中继部分端点（如 /p1/subjects），对
  // 未支持的端点（如 /v0/search）返回 401，此时回退官方直连。
  String get _v0Base => 'https://api.bgm.tv';
  String get _nextBase => 'https://next.bgm.tv';

  void close() {
    _client.close(force: true);
  }

  // ====== 高层端点（返回旧 /api/* 形状） ======

  /// GET /api/popular → {items: [...]}
  Future<Map<String, dynamic>> popular({
    String tag = '',
    int offset = 0,
    int limit = 24,
  }) async {
    if (useMirror) {
      final query = <String, String>{
        if (tag.isNotEmpty) 'tag': tag,
        'limit': '$limit',
        'offset': '$offset',
      };
      final data = await _getJson(
          '$_mirrorDomain/kazumi/v1/popular/subjects'
          '?${Uri(queryParameters: query).query}');
      final list = data is List ? data : (data['data'] as List? ?? []);
      return {'items': _mapItems(list)};
    }
    if (tag.isEmpty) {
      final data = await _getJson(
          '$_nextBase/p1/trending/subjects?type=2&limit=$limit&offset=$offset');
      final list = (data['data'] as List? ?? [])
          .map((e) => e is Map ? e['subject'] : null)
          .where((e) => e != null)
          .toList();
      return {'items': _mapItems(list)};
    }
    // tag 模式对齐宿主 getBangumiList：随机 rank 起点 + tag 过滤
    final rank = _random.nextInt(8000) + 1;
    final body = jsonEncode({
      'keyword': '',
      'sort': 'rank',
      'filter': {
        'type': [2],
        'tag': [tag],
        'rank': ['>$rank', '<=99999'],
        'nsfw': false,
      },
    });
    final data = await _postJson(
        '$_v0Base/v0/search/subjects?limit=$limit&offset=0', body);
    return {'items': _mapItems(data['data'] as List? ?? [])};
  }

  /// GET /api/timeline[?season=YYYY-Q] → {days: [[...] x7], season?}
  Future<Map<String, dynamic>> timeline({String season = ''}) async {
    if (season.isEmpty) {
      final data = await _getJson('$_nextBase/p1/calendar');
      final days = <List<Map<String, dynamic>>>[];
      for (var i = 1; i <= 7; i++) {
        final dayList = (data['$i'] as List? ?? [])
            .map((e) => e is Map ? e['subject'] : null)
            .where((e) => e != null)
            .toList();
        days.add(_mapItems(dayList));
      }
      return {'days': days};
    }

    final parts = season.split('-');
    final year = int.parse(parts[0]);
    final quarter = int.parse(parts[1]);
    final seasonIndex = quarter - 1;
    var startMonth = seasonIndex * 3;
    var startYear = year;
    if (startMonth == 0) {
      startMonth = 12;
      startYear -= 1;
    }
    final start = DateTime(startYear, startMonth, 1);
    final end = DateTime(year, (seasonIndex + 1) * 3, 1);

    if (useMirror) {
      final query = Uri(queryParameters: {
        'start': start.toString(),
        'end': end.toString(),
      }).query;
      final data =
          await _getJson('$_mirrorDomain/kazumi/v1/calendar/season?$query');
      final days = <List<Map<String, dynamic>>>[];
      for (var i = 1; i <= 7; i++) {
        final dayList = (data['$i'] as List? ?? [])
            .map((e) => e is Map ? e['subject'] : null)
            .where((e) => e != null)
            .toList();
        days.add(_mapItems(dayList));
      }
      return {'season': season, 'days': days};
    }

    // 官方：4 轮 × 20 条 rank 搜索，按 airWeekday 分桶
    final days = List.generate(7, (_) => <Map<String, dynamic>>[]);
    for (var round = 0; round < 4; round++) {
      final body = jsonEncode({
        'keyword': '',
        'sort': 'rank',
        'filter': {
          'type': [2],
          'tag': ['日本'],
          'air_date': ['>=$start', '<$end'],
          'rank': ['>0', '<=99999'],
          'nsfw': true,
        },
      });
      final data = await _postJson(
          '$_v0Base/v0/search/subjects?limit=20&offset=${round * 20}', body);
      for (final raw in data['data'] as List? ?? []) {
        if (raw is! Map) continue;
        final item = _mapItem(raw);
        final weekday = item['airWeekday'] as int;
        if (weekday >= 1 && weekday <= 7) {
          days[weekday - 1].add(item);
        }
      }
    }
    return {'season': season, 'days': days};
  }

  /// GET /api/bangumi/search → {items}
  /// POST /v0/search/subjects（对齐上游 BangumiApi.buildBangumiSearchParams）。
  /// [keyword] 可为空（只按条件查找）；[tags] 为 AND；[airDate] 为
  /// `[start, end)`；[rank]/[score] 为闭区间；[weekdays] 1..7。
  Future<Map<String, dynamic>> search(
    String keyword, {
    int offset = 0,
    String sort = 'heat',
    List<String> tags = const [],
    List<String>? airDate,
    List<num?>? rank,
    List<num?>? score,
    List<int> weekdays = const [],
  }) async {
    List<String> numFilter(num? min, num? max, String Function(num) f) => [
          if (min != null) '>=${f(min)}',
          if (max != null) '<=${f(max)}',
        ];
    final hasRank = rank != null && (rank[0] != null || rank[1] != null);
    final filter = <String, dynamic>{
      'type': [2],
      'tag': tags,
      'rank': hasRank
          ? numFilter(rank[0], rank[1], (v) => '${v.round()}')
          : (sort == 'rank' ? ['>0', '<=99999'] : ['>=0', '<=99999']),
      'nsfw': false,
    };
    if (airDate != null && airDate.length == 2) {
      filter['air_date'] = ['>=${airDate[0]}', '<${airDate[1]}'];
    }
    if (score != null && (score[0] != null || score[1] != null)) {
      filter['rating'] =
          numFilter(score[0], score[1], (v) => v.toStringAsFixed(1));
    }
    if (weekdays.isNotEmpty) {
      filter['air_weekday'] = weekdays.toSet().toList()..sort();
    }
    final body = jsonEncode({'keyword': keyword, 'sort': sort, 'filter': filter});
    final data = await _postJson(
        '$_v0Base/v0/search/subjects?limit=20&offset=$offset', body);
    final raw = data['data'] as List? ?? [];
    return {'items': _mapItems(raw), 'rawCount': raw.length};
  }

  /// GET `/api/bangumi/<id>` → BangumiItemJson
  Future<Map<String, dynamic>> detail(int id) async {
    final data = await _getJson('$_nextBase/p1/subjects/$id');
    return _mapItem(data);
  }

  /// GET `/api/bangumi/<id>`/characters → {characters}
  Future<Map<String, dynamic>> characters(int id) async {
    final data = await _getJson('$_v0Base/v0/subjects/$id/characters',
        expectList: true) as List;
    const relationOrder = {'主角': 1, '配角': 2, '客串': 3};
    final mapped = data.whereType<Map>().map((c) {
      final images = c['images'] as Map? ?? {};
      final actors = (c['actors'] as List? ?? []).whereType<Map>().map((a) {
        final aImages = a['images'] as Map? ?? {};
        return {
          'id': a['id'],
          'name': a['name'] ?? '',
          'image': aImages['medium'] ?? '',
        };
      }).toList();
      return {
        'id': c['id'],
        'name': c['name'] ?? '',
        'relation': c['relation'] ?? '',
        'image': (images['large'] ?? images['medium'] ?? '') as String,
        'actors': actors,
      };
    }).toList();
    mapped.sort((a, b) => (relationOrder[a['relation']] ?? 4)
        .compareTo(relationOrder[b['relation']] ?? 4));
    return {'characters': mapped};
  }

  /// GET `/api/bangumi/<id>`/relations → {items: [{relation, bangumi}]}
  /// 只保留动画条目（type == 2），对齐上游 bangumi_relation.dart 的过滤。
  Future<Map<String, dynamic>> relations(int id) async {
    final data = await _getJson('$_v0Base/v0/subjects/$id/subjects',
        expectList: true) as List;
    final items = data
        .whereType<Map>()
        .where((r) => (r['type'] as num?)?.toInt() == 2)
        .map((r) => {
              'relation': (r['relation'] ?? '').toString().trim().isEmpty
                  ? '关联'
                  : r['relation'],
              'bangumi': _mapItem(r),
            })
        .toList();
    return {'items': items};
  }

  /// GET `/api/bangumi/character/<id>` → 角色资料（infobox 拍平成 key/value）
  Future<Map<String, dynamic>> character(int id) async {
    final data = await _getJson('$_v0Base/v0/characters/$id') as Map;
    final images = data['images'] as Map? ?? {};
    final infobox = (data['infobox'] as List? ?? []).whereType<Map>().map((f) {
      final v = f['value'];
      final text = v is List
          ? v.whereType<Map>().map((e) => e['v'] ?? '').join(' / ')
          : (v ?? '').toString();
      return {'key': (f['key'] ?? '').toString(), 'value': text};
    }).where((f) => f['value']!.isNotEmpty).toList();
    return {
      'id': data['id'],
      'name': data['name'] ?? '',
      'summary': data['summary'] ?? '',
      'image': (images['large'] ?? images['medium'] ?? '') as String,
      'infobox': infobox,
    };
  }

  /// GET `/api/bangumi/<id>`/comments?offset → {total, items}
  Future<Map<String, dynamic>> comments(int id, {int offset = 0}) async {
    final data =
        await _getJson('$_nextBase/p1/subjects/$id/comments?limit=20&offset=$offset');
    final items = (data['data'] as List? ?? []).whereType<Map>().map((c) {
      final user = c['user'] as Map? ?? {};
      final avatar = user['avatar'] as Map? ?? {};
      return {
        'user': {
          'username': user['username'] ?? '',
          'nickname': user['nickname'] ?? '',
          'avatar': avatar['medium'] ?? '',
        },
        'rate': c['rate'] ?? 0,
        'comment': c['comment'] ?? '',
        'updatedAt': c['updatedAt'] ?? 0,
      };
    }).toList();
    return {'total': data['total'] ?? items.length, 'items': items};
  }

  /// GET `/api/bangumi/<id>`/staff → {total, items}
  Future<Map<String, dynamic>> staff(int id) async {
    final data = await _getJson('$_nextBase/p1/subjects/$id/staffs/persons');
    final items = (data['data'] as List? ?? []).whereType<Map>().map((s) {
      final staff = s['staff'] as Map? ?? s;
      final images = staff['images'] as Map? ?? {};
      final positions =
          (s['positions'] as List? ?? []).whereType<Map>().map((p) {
        final type = p['type'] as Map? ?? {};
        final cn = (type['cn'] ?? '') as String;
        final en = (type['en'] ?? '') as String;
        return {
          'type': cn.isNotEmpty ? cn : en,
          'summary': p['summary'] ?? '',
        };
      }).toList();
      return {
        'id': staff['id'],
        'name': staff['name'] ?? '',
        'nameCN': staff['nameCN'] ?? '',
        'image': (images['medium'] ?? images['large'] ?? '') as String,
        'positions': positions,
      };
    }).toList();
    return {'total': data['total'] ?? items.length, 'items': items};
  }

  /// GET `/api/bangumi/<id>`/episodes → {items}
  Future<Map<String, dynamic>> episodes(int id) async {
    final items = <Map<String, dynamic>>[];
    var offset = 0;
    int? total;
    do {
      final data = await _getJson(
          '$_v0Base/v0/episodes?subject_id=$id&offset=$offset&limit=100');
      total ??= (data['total'] as num?)?.toInt();
      final page = data['data'] as List? ?? [];
      if (page.isEmpty) break;
      for (final raw in page.whereType<Map>()) {
        items.add(_mapEpisode(raw));
      }
      offset += page.length;
    } while (total == null || offset < total);
    return {'items': items};
  }

  /// GET `/api/bangumi/<id>`/episode-comments?episode → {episode, items}
  Future<Map<String, dynamic>> episodeComments(int id, int episode) async {
    final epData = await _getJson(
        '$_v0Base/v0/episodes?subject_id=$id&offset=${episode - 1}&limit=1');
    final page = epData['data'] as List? ?? [];
    if (page.isEmpty || page.first is! Map) {
      return {'episode': null, 'items': const []};
    }
    final epInfo = _mapEpisode(page.first as Map);
    final epId = epInfo['id'];
    final data = await _getJson('$_nextBase/p1/episodes/$epId/comments');
    final items = (data as List? ?? []).whereType<Map>().map((c) {
      final user = c['user'] as Map? ?? {};
      final avatar = user['avatar'] as Map? ?? {};
      return {
        'user': {
          'username': user['username'] ?? '',
          'nickname': user['nickname'] ?? '',
          'avatar': avatar['medium'] ?? '',
        },
        'content': c['content'] ?? '',
        'createdAt': c['createdAt'] ?? 0,
        'replies': (c['replies'] as List? ?? []).whereType<Map>().map((r) {
          final rUser = r['user'] as Map? ?? {};
          final rAvatar = rUser['avatar'] as Map? ?? {};
          return {
            'user': {
              'username': rUser['username'] ?? '',
              'nickname': rUser['nickname'] ?? '',
              'avatar': rAvatar['medium'] ?? '',
            },
            'content': r['content'] ?? '',
            'createdAt': r['createdAt'] ?? 0,
          };
        }).toList(),
      };
    }).toList();
    return {'episode': epInfo, 'items': items};
  }

  // ====== 映射（bgm 原始 JSON → 旧 /api/* 的 BangumiItemJson 形状） ======

  List<Map<String, dynamic>> _mapItems(List raw) {
    return raw
        .whereType<Map>()
        .map(_mapItem)
        .toList();
  }

  Map<String, dynamic> _mapItem(Map raw) {
    final rating = raw['rating'] as Map? ?? {};
    final images = raw['images'] as Map? ??
        {'large': raw['image'] ?? '', 'common': '', 'medium': '', 'small': '', 'grid': ''};
    final airDate = _resolveAirDate(raw);
    return {
      'id': raw['id'],
      'type': raw['type'] ?? 2,
      'name': raw['name'] ?? '',
      'nameCn': _resolveNameCn(raw),
      'summary': raw['summary'] ?? '',
      'airDate': airDate,
      'airWeekday': _weekdayOf(airDate),
      'rank': rating['rank'] ?? 0,
      'ratingScore':
          double.parse(((rating['score'] ?? 0.0) as num).toDouble().toStringAsFixed(1)),
      'votes': rating['total'] ?? 0,
      'votesCount': _resolveVotesCount(rating),
      'images': images,
      'info': raw['info'] ?? '',
      'tags': (raw['tags'] as List? ?? [])
          .whereType<Map>()
          .map((t) => {'name': t['name'] ?? '', 'count': t['count'] ?? 0})
          .toList(),
      'alias': _resolveAliases(raw),
    };
  }

  Map<String, dynamic> _mapEpisode(Map raw) {
    final type = (raw['type'] as num?)?.toInt() ?? 0;
    const typeNames = {0: 'ep', 1: 'sp', 2: 'op', 3: 'ed'};
    return {
      'id': raw['id'] ?? 0,
      'episode': raw['sort'] ?? 0,
      'type': type,
      'name': raw['name'] ?? '',
      'nameCn': raw['name_cn'] ?? raw['nameCN'] ?? '',
      'readType': typeNames[type] ?? '',
    };
  }

  String _resolveNameCn(Map raw) {
    final nameCn = (raw['name_cn'] ?? '') as String;
    if (nameCn.isNotEmpty) return nameCn;
    final nameCN = (raw['nameCN'] ?? '') as String;
    if (nameCN.isNotEmpty) return nameCN;
    return (raw['name'] ?? '') as String;
  }

  String _resolveAirDate(Map raw) {
    final top = (raw['date'] ?? '').toString().trim();
    if (top.isNotEmpty) return top;
    final airtime = raw['airtime'];
    if (airtime is Map) {
      final nested = (airtime['date'] ?? '').toString().trim();
      if (nested.isNotEmpty) return nested;
    }
    return '';
  }

  int _weekdayOf(String airDate) {
    try {
      return DateTime.parse(airDate).weekday;
    } catch (_) {
      return 0;
    }
  }

  List<int> _resolveVotesCount(Map rating) {
    final count = rating['count'];
    if (count is Map) {
      return List<int>.generate(
          10, (i) => (count['${i + 1}'] as num?)?.toInt() ?? 0);
    }
    if (count is List) {
      return count.map((e) => (e as num).toInt()).toList();
    }
    return [];
  }

  List<String> _resolveAliases(Map raw) {
    // infobox 里的"别名"项；/p1 与 /v0 的 infobox 形状略有差异，宽松解析。
    final infobox = raw['infobox'];
    if (infobox is! List) return [];
    for (final entry in infobox.whereType<Map>()) {
      if (entry['key'] != '别名') continue;
      final value = entry['value'];
      if (value is String) return [value];
      if (value is List) {
        return value
            .whereType<Map>()
            .map((v) => (v['v'] ?? '').toString())
            .where((s) => s.isNotEmpty)
            .toList();
      }
    }
    return [];
  }

  // ====== HTTP ======

  Future<dynamic> _getJson(String url, {bool expectList = false}) =>
      _requestJson('GET', url, null);

  Future<Map<String, dynamic>> _postJson(String url, String body) async =>
      await _requestJson('POST', url, body) as Map<String, dynamic>;

  /// 镜像优先 + 官方回退：
  /// - useMirror 且 URL 属于官方域时，先把 host 换成镜像域请求；
  ///   失败（镜像不中继该端点时返回 401/404，或网络异常）则回退官方直连
  /// - 镜像专用端点（/kazumi/v1/*）与非官方域 URL 不做替换，直接请求
  /// 成功响应缓存：[_cacheTtl] 内同一请求直接命中，不打上游——热门/
  /// 时间表每次切页都重拉上游是首屏慢的主因。过期后仍留作
  /// last-known-good：网络层重试全部耗尽时回吐上次成功数据，间歇抖动的
  /// 网络下首页/时间表永远有内容可展示，代价只是短暂的数据陈旧。
  /// key 含 method + body，tag 模式的随机 rank 天然不命中（保持每次随机）。
  /// 上限防无界增长（Map 保持插入序，删最旧）。
  static const int _cacheLimit = 100;
  static const Duration _cacheTtl = Duration(minutes: 5);
  final Map<String, ({DateTime at, dynamic data})> _cache = {};

  Future<dynamic> _requestJson(String method, String url, String? body) async {
    final key = '$method $url ${body ?? ''}';
    final hit = _cache[key];
    if (hit != null && DateTime.now().difference(hit.at) < _cacheTtl) {
      return hit.data;
    }
    try {
      final result = await _requestJsonUncached(method, url, body);
      _cache.remove(key);
      _cache[key] = (at: DateTime.now(), data: result);
      if (_cache.length > _cacheLimit) {
        _cache.remove(_cache.keys.first);
      }
      return result;
    } catch (e) {
      if (hit != null) {
        logWarn('BangumiService: serving last-known-good for $key', e);
        return hit.data;
      }
      rethrow;
    }
  }

  Future<dynamic> _requestJsonUncached(
      String method, String url, String? body) async {
    if (useMirror) {
      final mirrored = _mirrorize(url);
      if (mirrored != url) {
        try {
          return await _rawRequest(method, mirrored, body);
        } catch (e) {
          logWarn(
              'BangumiService: mirror failed for $mirrored, falling back to official',
              e);
        }
      }
    }
    return _rawRequest(method, url, body);
  }

  String _mirrorize(String url) {
    final uri = Uri.parse(url);
    if (uri.host == 'api.bgm.tv' || uri.host == 'next.bgm.tv') {
      return uri
          .replace(host: Uri.parse(_mirrorDomain).host)
          .toString();
    }
    return url;
  }

  /// 瞬时连接层错误（TLS 握手被 RST、socket 中断）在实测中重试成功率
  /// 极高（网络对镜像域的直连质量存在间歇抖动），就地快速重试两次；
  /// HTTP 状态码错误是确定性结果，不重试。
  Future<dynamic> _rawRequest(String method, String url, String? body) async {
    Object? lastError;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // 递增间隔：RST 抖动常持续数百毫秒，拉开间隔提高穿越窗口概率
        await Future.delayed(Duration(milliseconds: 400 * attempt));
      }
      try {
        return await _rawRequestOnce(method, url, body);
      } on HandshakeException catch (e) {
        lastError = e;
      } on SocketException catch (e) {
        lastError = e;
      }
      logWarn(
          'BangumiService: transient failure for $url, retrying '
          '(${attempt + 1}/3)',
          lastError);
    }
    throw lastError!;
  }

  Future<dynamic> _rawRequestOnce(
      String method, String url, String? body) async {
    final request = await _client.openUrl(method, Uri.parse(url));
    request.headers.set(HttpHeaders.userAgentHeader, _userAgent);
    request.headers.set(HttpHeaders.acceptHeader, 'application/json');
    if (body != null) {
      request.headers.contentType =
          ContentType('application', 'json', charset: 'utf-8');
      request.write(body);
    }
    final response = await request.close();
    final text = await utf8.decodeStream(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      logWarn('BangumiService: $method $url -> ${response.statusCode}');
      throw HttpException('HTTP ${response.statusCode}', uri: Uri.parse(url));
    }
    return jsonDecode(text);
  }
}
