// 诊断工具：用与规则引擎相同的 dio 栈直接请求资源站，暴露被
// NetworkErrorMapper 吞掉的底层异常链。依赖真实网络，CI 跳过：
//   flutter test --exclude-tags network
@Tags(['network'])
library;

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:kazumi_web/request/core/dio_factory.dart';

Future<void> main() async {
  test('probe plugin sites via pluginDio', () async {
    for (final url in [
      'https://www.bbfun.cc/',
      'https://www.agedm.io/',
      'https://www.tvtfun.net/',
      'https://www.mayi520.org/',
    ]) {
      try {
        final r = await DioFactory.pluginDio.get<String>(url);
        // ignore: avoid_print
        print('$url -> HTTP ${r.statusCode} (${r.data?.length ?? 0} bytes)');
      } on DioException catch (e) {
        // ignore: avoid_print
        print('$url -> DioException ${e.type}');
        // ignore: avoid_print
        print('  error: ${e.error}');
        // ignore: avoid_print
        print('  message: ${e.message}');
      }
    }
  }, timeout: const Timeout(Duration(minutes: 3)));
}
