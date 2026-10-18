/// 极简日志：stdout + 内存环形缓冲（供状态窗口展示）。
/// 拷贝自宿主的模块走 KazumiLogger（独立落盘），两者互不影响。
library;

import 'package:flutter/foundation.dart';

const int _bufferCapacity = 200;

/// 最近日志行，UI 通过 [logLines] 监听刷新。
final ValueNotifier<List<String>> logLines = ValueNotifier(const []);

final List<String> _buffer = [];

void _append(String line) {
  // ignore: avoid_print
  print(line);
  _buffer.add(line);
  if (_buffer.length > _bufferCapacity) {
    _buffer.removeRange(0, _buffer.length - _bufferCapacity);
  }
  logLines.value = List.unmodifiable(_buffer);
}

String _now() {
  final t = DateTime.now();
  String pad(int v) => v.toString().padLeft(2, '0');
  return '${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}';
}

void logInfo(String message) {
  _append('[${_now()}] $message');
}

void logWarn(String message, [Object? error]) {
  _append('[${_now()}] WARN $message${error != null ? ' ($error)' : ''}');
}

void logError(String message, [Object? error, StackTrace? st]) {
  _append('[${_now()}] ERROR $message${error != null ? ' ($error)' : ''}');
  if (st != null) {
    // ignore: avoid_print
    print(st);
  }
}
