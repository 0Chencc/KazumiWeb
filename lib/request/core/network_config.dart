import 'dart:io';

import 'package:dio/io.dart';
import 'package:kazumi_web/services/logging/logger.dart';
import 'package:kazumi_web/services/network/proxy_utils.dart';
import 'package:kazumi_web/services/storage/storage.dart';

// 与上游 Kazumi 的差异：去掉了 Windows 系统代理探测
// （SystemProxyService，依赖 win32/ffi）；未配置代理时直连。
// 其余与上游逐字一致。

class NetworkConfig {
  const NetworkConfig({
    this.connectTimeout = const Duration(seconds: 12),
    this.receiveTimeout = const Duration(seconds: 12),
    this.sendTimeout,
    this.proxyHost,
    this.proxyPort,
    this.allowBadCertificates = false,
    this.enableLog = true,
  });

  final Duration connectTimeout;
  final Duration receiveTimeout;
  final Duration? sendTimeout;
  final String? proxyHost;
  final int? proxyPort;
  final bool allowBadCertificates;
  final bool enableLog;

  bool get hasProxy => proxyHost != null && proxyPort != null;

  IOHttpClientAdapter createAdapter() {
    return IOHttpClientAdapter(
      createHttpClient: () {
        final client = HttpClient();
        // keep-alive 连接被资源站/中间设备半关闭后，复用会连锁失败
        // （实测：快速连打失败、隔 17s 全过）。缩短空闲存活期，代价
        // 只是少量连接复用，换取检索稳定性。
        client.idleTimeout = const Duration(seconds: 3);
        if (hasProxy) {
          client.findProxy = (_) => 'PROXY $proxyHost:$proxyPort';
        }
        if (allowBadCertificates) {
          client.badCertificateCallback = (cert, host, port) => true;
        }
        return client;
      },
    );
  }

  NetworkConfig copyWith({
    Duration? connectTimeout,
    Duration? receiveTimeout,
    Duration? sendTimeout,
    String? proxyHost,
    int? proxyPort,
    bool? clearProxy,
    bool? allowBadCertificates,
    bool? enableLog,
  }) {
    final shouldClearProxy = clearProxy ?? false;
    return NetworkConfig(
      connectTimeout: connectTimeout ?? this.connectTimeout,
      receiveTimeout: receiveTimeout ?? this.receiveTimeout,
      sendTimeout: sendTimeout ?? this.sendTimeout,
      proxyHost: shouldClearProxy ? null : proxyHost ?? this.proxyHost,
      proxyPort: shouldClearProxy ? null : proxyPort ?? this.proxyPort,
      allowBadCertificates: allowBadCertificates ?? this.allowBadCertificates,
      enableLog: enableLog ?? this.enableLog,
    );
  }

  static NetworkConfig fromSettings({
    Duration connectTimeout = const Duration(seconds: 12),
    Duration receiveTimeout = const Duration(seconds: 12),
    Duration? sendTimeout,
  }) {
    final bool proxyEnable = GStorage.getSetting(SettingsKeys.proxyEnable);
    if (!proxyEnable) {
      return NetworkConfig(
        connectTimeout: connectTimeout,
        receiveTimeout: receiveTimeout,
        sendTimeout: sendTimeout,
      );
    }

    final proxyUrl = GStorage.getSetting(SettingsKeys.proxyUrl);
    final parsed = ProxyUtils.parseProxyUrl(proxyUrl);
    if (parsed == null) {
      KazumiLogger().w('Proxy: 代理地址格式错误或为空');
      return NetworkConfig(
        connectTimeout: connectTimeout,
        receiveTimeout: receiveTimeout,
        sendTimeout: sendTimeout,
      );
    }

    return NetworkConfig(
      connectTimeout: connectTimeout,
      receiveTimeout: receiveTimeout,
      sendTimeout: sendTimeout,
      proxyHost: parsed.$1,
      proxyPort: parsed.$2,
      allowBadCertificates: true,
    );
  }
}
