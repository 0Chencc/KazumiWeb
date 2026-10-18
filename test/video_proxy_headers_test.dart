// 回归：上游返回含非 ASCII 字节的 content-disposition（天翼云家庭云
// 视频床的真实行为，"第12集.mp4" 的 UTF-8 字节按 Latin-1 进入头值）时，
// 代理响应必须能正常写出——曾经该头被原样转发，shelf_io 写出时抛
// FormatException，响应永远不上线，浏览器无限挂起。
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shelf/shelf.dart' as shelf;
import 'package:shelf/shelf_io.dart' as shelf_io;

import 'package:kazumi_web/proxy/proxy_session_store.dart';
import 'package:kazumi_web/proxy/video_proxy_handler.dart';

Future<void> main() async {
  late ServerSocket upstream;
  late HttpServer proxyServer;
  late ProxySessionStore store;
  late VideoProxyHandler handler;
  late String token;

  setUp(() async {
    // 桩上游：裸 socket 吐原始 HTTP 字节——dart:io 写头严格但读头宽松，
    // 带毒的 content-disposition 只能从线上字节进来（与真实视频床一致）。
    upstream = await ServerSocket.bind('127.0.0.1', 0);
    upstream.listen((socket) async {
      await socket.firstWhere(
          (chunk) => utf8.decode(chunk, allowMalformed: true).contains('\r\n\r\n'));
      socket.add(latin1.encode('HTTP/1.1 206 Partial Content\r\n'
          'content-type: video/mp4\r\n'
          'content-range: bytes 0-1/1000\r\n'
          'content-length: 2\r\n'));
      socket.add(utf8.encode('content-disposition: attachment;'
          'filename="第12集.mp4";'
          'filename*=UTF-8\'\'%E7%AC%AC12%E9%9B%86.mp4\r\n'));
      socket.add(latin1.encode('\r\nAB'));
      await socket.flush();
      await socket.close();
    });

    store = ProxySessionStore();
    token = store.register(ProxySession(
      originalUrl: 'http://127.0.0.1:${upstream.port}/video.mp4',
      referer: '',
      userAgent: 'test-agent',
      pluginName: 'test',
      createdAt: DateTime.now(),
    ));

    handler = VideoProxyHandler(sessionStore: store);
    proxyServer = await shelf_io.serve(
      (shelf.Request request) => handler.handle(request, token),
      '127.0.0.1',
      0,
    );
  });

  tearDown(() async {
    handler.close();
    await proxyServer.close(force: true);
    await upstream.close();
  });

  test('toxic content-disposition is dropped and response reaches the wire',
      () async {
    final client = HttpClient();
    addTearDown(() => client.close(force: true));

    final req = await client
        .get('127.0.0.1', proxyServer.port, '/')
        .timeout(const Duration(seconds: 5));
    req.headers.set('range', 'bytes=0-1');
    // 修复前：响应永远不写出，这里会超时
    final res = await req.close().timeout(const Duration(seconds: 5));

    expect(res.statusCode, HttpStatus.partialContent);
    expect(res.headers.value('content-disposition'), isNull);
    // Accept-Ranges 补头逻辑（iOS 拒播防护）仍然生效
    expect(res.headers.value('accept-ranges'), 'bytes');

    final bytes = await res
        .fold<int>(0, (n, c) => n + c.length)
        .timeout(const Duration(seconds: 5));
    expect(bytes, 2);
  });
}
