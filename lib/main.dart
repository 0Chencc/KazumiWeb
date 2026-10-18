import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:window_manager/window_manager.dart';

import 'package:kazumi_web/bangumi_service.dart';
import 'package:kazumi_web/core/kazumi_importer.dart';
import 'package:kazumi_web/core/tray_service.dart';
import 'package:kazumi_web/core/library_store.dart';
import 'package:kazumi_web/core/plugin_registry.dart';
import 'package:kazumi_web/core/source_resolver.dart';
import 'package:dio/dio.dart';

import 'package:kazumi_web/logger.dart';
import 'package:kazumi_web/request/core/dio_factory.dart';
import 'package:kazumi_web/server.dart';
import 'package:kazumi_web/services/storage/storage.dart';

late final AppState appState;

/// 无头模式：不显示窗口、不建托盘，纯服务进程。
/// 用于 Docker（xvfb 虚拟显示）、虚拟机、无人值守 Mac mini 等 server 化
/// 部署，见 docs/deployment.md。停止服务 = 结束进程。
bool headlessMode = false;

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  headlessMode = args.contains('--headless') ||
      Platform.environment['KAZUMI_WEB_HEADLESS'] == '1';

  await windowManager.ensureInitialized();
  if (!headlessMode) {
    await windowManager.waitUntilReadyToShow(
      const WindowOptions(
        title: 'KazumiWeb',
        size: Size(520, 700),
        // 高度下限要容得下"日志收起"后的紧凑窗口
        minimumSize: Size(440, 320),
        center: true,
      ),
      () async {
        await windowManager.show();
      },
    );
  }

  appState = AppState();
  runApp(const KazumiWebApp());
  if (headlessMode) {
    // Windows runner 在首帧后无条件 Show（flutter_window.cpp），
    // headless 下等首帧结束再压回去；xvfb 环境下本就不可见，无副作用。
    unawaited(
        WidgetsBinding.instance.endOfFrame.then((_) => windowManager.hide()));
  }
  await appState.bootstrap();
}

class AppState extends ChangeNotifier {
  PluginRegistry? registry;
  KazumiWebServer? server;
  LibraryStore? library;

  bool starting = true;
  String? fatalError;
  int? port;
  List<String> lanAddresses = const [];

  Timer? _desktopSyncTimer;
  String _desktopFingerprint = '';
  bool _syncing = false;

  /// 检测到的新版本 tag（如 'v0.3.0'），null 表示已是最新或未知。
  String? updateAvailable;
  String updateUrl = 'https://github.com/0Chencc/KazumiWeb/releases';

  Future<void> bootstrap() async {
    try {
      final supportDir = await getApplicationSupportDirectory();
      final dataDir = supportDir.path;
      await GStorage.init(dataDir);

      final pluginRegistry = PluginRegistry();
      await pluginRegistry.init(dataDir);
      registry = pluginRegistry;

      final libraryStore = LibraryStore();
      await libraryStore.init(dataDir);
      library = libraryStore;

      // 桌面版 Kazumi 数据自动同步（规则/收藏/历史/网络设置）。
      // 必须在 BangumiService 构造前完成——镜像开关可能来自桌面版设置。
      _desktopFingerprint = KazumiImporter.dataFingerprint();
      final synced = await KazumiImporter(
        library: libraryStore,
        registry: pluginRegistry,
      ).autoSync();
      if (!synced.isEmpty) {
        logInfo('已同步桌面版 Kazumi 数据：'
            '${synced.rules > 0 ? '规则 ${synced.rules} 条、' : ''}'
            '追番 ${synced.collects} 条、历史 ${synced.histories} 条');
      }
      _startDesktopFollow();

      final webDir = await _locateWebDir();
      final webServer = KazumiWebServer(
        registry: pluginRegistry,
        resolver: SourceResolver(),
        library: libraryStore,
        bangumi: BangumiService(),
        webDir: webDir,
      );
      // 容器/服务化部署惯例：环境变量优先于持久化设置
      final envPort =
          int.tryParse(Platform.environment['KAZUMI_WEB_PORT'] ?? '');
      await webServer.start(
        port: envPort ?? GStorage.getSetting(SettingsKeys.serverPort),
      );
      server = webServer;
      port = webServer.port;
      // 首选 mDNS 主机名（Windows 10+ 系统自带响应，iOS/macOS 原生支持
      // .local 解析），手机不用记 IP；IP 地址保留作备选（部分安卓浏览器
      // 不支持 mDNS）。
      // macOS 的 localHostname 本身已带 .local
      final hostname = Platform.localHostname.toLowerCase();
      final mdnsHost =
          hostname.endsWith('.local') ? hostname : '$hostname.local';
      lanAddresses = [
        mdnsHost,
        ...await KazumiWebServer.enumerateLanIPv4(),
      ];

      logInfo('服务已就绪，本机访问 http://localhost:$port，局域网设备可访问：');
      for (final addr in lanAddresses) {
        logInfo('  http://$addr:$port');
      }

      if (headlessMode) {
        logInfo('无头模式：无窗口与托盘，停止服务请结束进程');
      } else {
        // 托盘常驻：关闭窗口后服务继续运行。无头环境（容器/xvfb）没有
        // 托盘守护进程，初始化会失败，直接跳过。
        unawaited(TrayService.instance.init(
          webUrlProvider: () =>
              port != null ? 'http://127.0.0.1:$port' : '',
        ));
      }
      if (pluginRegistry.plugins.isEmpty) {
        logWarn('尚未安装任何视频源规则，请先从规则仓库安装');
      }
    } catch (e, st) {
      fatalError = e.toString();
      logError('启动失败', e, st);
    } finally {
      starting = false;
      notifyListeners();
    }
    unawaited(_checkUpdate());
  }

  /// 检查 GitHub releases 是否有新版本。仓库尚无 release 或网络失败时静默。
  Future<void> _checkUpdate() async {
    try {
      final response = await DioFactory.rulesRepoDio.get<Map<String, dynamic>>(
        'https://api.github.com/repos/0Chencc/KazumiWeb/releases/latest',
        options: Options(responseType: ResponseType.json),
      );
      final tag = response.data?['tag_name'] as String?;
      final htmlUrl = response.data?['html_url'] as String?;
      if (tag == null) return;
      final latest = tag.replaceFirst(RegExp('^v'), '');
      if (latest != appVersion && _isNewer(latest, appVersion)) {
        updateAvailable = tag;
        if (htmlUrl != null) updateUrl = htmlUrl;
        logInfo('发现新版本 $tag（当前 v$appVersion）');
        notifyListeners();
      }
    } catch (_) {
      // 无 release / 网络不可达：静默
    }
  }

  static bool _isNewer(String a, String b) {
    List<int> parse(String v) =>
        v.split('.').map((s) => int.tryParse(s) ?? 0).toList();
    final pa = parse(a);
    final pb = parse(b);
    for (var i = 0; i < 3; i++) {
      final x = i < pa.length ? pa[i] : 0;
      final y = i < pb.length ? pb[i] : 0;
      if (x != y) return x > y;
    }
    return false;
  }

  /// 运行期跟随桌面版：每 60 秒比对数据文件指纹（mtime），有变化才做
  /// 增量同步。桌面版看完一集、改了镜像开关，web 端不用重启就能跟上——
  /// 这是"与桌面版共用数据"在 Hive 单进程约束下能做到的最近似形态。
  void _startDesktopFollow() {
    if (!KazumiImporter.desktopDataAvailable()) return;
    _desktopSyncTimer = Timer.periodic(const Duration(seconds: 60), (_) async {
      if (_syncing) return;
      final fingerprint = KazumiImporter.dataFingerprint();
      if (fingerprint == _desktopFingerprint) return;
      _desktopFingerprint = fingerprint;
      final lib = library;
      final reg = registry;
      if (lib == null || reg == null) return;
      _syncing = true;
      try {
        final synced =
            await KazumiImporter(library: lib, registry: reg).autoSync();
        if (!synced.isEmpty) {
          logInfo('桌面版数据有更新，已跟随：追番 ${synced.collects} 条、'
              '历史 ${synced.histories} 条'
              '${synced.settings > 0 ? '、设置 ${synced.settings} 项' : ''}');
        }
      } finally {
        _syncing = false;
      }
    });
  }

  @override
  void dispose() {
    _desktopSyncTimer?.cancel();
    super.dispose();
  }

  /// Web UI 静态目录：优先可执行文件旁的 web/（发行布局），
  /// macOS 在 .app 的 Contents/Resources/web/（Xcode 构建阶段复制），
  /// 开发期回退到项目根的 web/。
  Future<Directory> _locateWebDir() async {
    final exeDir = File(Platform.resolvedExecutable).parent.path;
    final candidates = [
      Directory(p.join(exeDir, 'web')),
      Directory(p.join(exeDir, '..', 'Resources', 'web')),
      Directory(p.join(Directory.current.path, 'web')),
    ];
    for (final dir in candidates) {
      if (await dir.exists()) return dir;
    }
    throw StateError('未找到 web 静态目录（应位于可执行文件旁的 web/）');
  }
}

class KazumiWebApp extends StatelessWidget {
  const KazumiWebApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KazumiWeb',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.green, useMaterial3: true),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.green,
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      home: const StatusPage(),
    );
  }
}

class StatusPage extends StatefulWidget {
  const StatusPage({super.key});

  @override
  State<StatusPage> createState() => _StatusPageState();
}

class _StatusPageState extends State<StatusPage> with WindowListener {
  int _selectedAddr = 0;
  bool _logExpanded = true;

  /// 日志收起前的窗口高度，展开时恢复。
  double? _expandedWindowHeight;

  /// 日志区以上的固定内容（用于收起时测量窗口应缩到的高度）。
  final GlobalKey _fixedContentKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    appState.addListener(_onStateChanged);
    windowManager.addListener(this);
  }

  @override
  void dispose() {
    appState.removeListener(_onStateChanged);
    windowManager.removeListener(this);
    super.dispose();
  }

  /// 点关闭按钮 → 隐藏到托盘，服务不中断（托盘菜单可退出）。
  @override
  void onWindowClose() {
    TrayService.instance.hideToTray();
  }

  void _onStateChanged() {
    if (mounted) setState(() {});
  }

  String? get _currentUrl {
    final state = appState;
    if (state.port == null || state.lanAddresses.isEmpty) return null;
    final idx = _selectedAddr.clamp(0, state.lanAddresses.length - 1);
    return 'http://${state.lanAddresses[idx]}:${state.port}';
  }

  Future<void> _copyUrl(String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已复制访问地址'), duration: Duration(seconds: 2)),
    );
  }

  Future<void> _openUrl(String url) async {
    final ok = await launchUrl(Uri.parse(url));
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('无法打开浏览器')),
      );
    }
  }

  Future<void> _copyLogs() async {
    final lines = logLines.value;
    if (lines.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: lines.join('\n')));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已复制日志'), duration: Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final state = appState;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _buildHeader(scheme, state),
              const SizedBox(height: 16),
              if (state.starting)
                const Expanded(
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (state.fatalError != null)
                Expanded(child: _buildFatalError(scheme, state))
              else
                // 收起态用可滚动容器兜底：窗口调整与 UI 状态在快速
                // 切换时可能瞬间失配（或用户手动把窗口拖小），固定
                // 内容永远不应触发 RenderFlex 溢出。
                Expanded(
                  child: _logExpanded
                      ? Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            _buildFixedContent(scheme, state),
                            const SizedBox(height: 6),
                            Expanded(child: _buildLogPanel(scheme)),
                          ],
                        )
                      : SingleChildScrollView(
                          child: _buildFixedContent(scheme, state),
                        ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildFixedContent(ColorScheme scheme, AppState state) {
    return Column(
      key: _fixedContentKey,
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _buildAccessCard(scheme, state),
        const SizedBox(height: 12),
        _buildRulesRow(scheme, state),
        const SizedBox(height: 12),
        _buildLogHeader(scheme),
      ],
    );
  }

  Widget _buildHeader(ColorScheme scheme, AppState state) {
    final running = !state.starting && state.fatalError == null;
    return Row(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: Image.asset(
            'assets/images/logo.png',
            width: 48,
            height: 48,
            filterQuality: FilterQuality.medium,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    running
                        ? Icons.check_circle_rounded
                        : state.starting
                            ? Icons.hourglass_top_rounded
                            : Icons.error_rounded,
                    size: 18,
                    color: running
                        ? scheme.primary
                        : state.starting
                            ? scheme.onSurfaceVariant
                            : scheme.error,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    running
                        ? '服务运行中'
                        : state.starting
                            ? '正在启动…'
                            : '启动失败',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ],
              ),
              if (running && state.port != null)
                Text(
                  '端口 ${state.port} · 局域网可访问',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                ),
            ],
          ),
        ),
        // 本机访问：localhost 不走局域网，不进二维码，放头部一键打开
        if (running && state.port != null)
          FilledButton.tonalIcon(
            onPressed: () => _openUrl('http://localhost:${state.port}'),
            icon: const Icon(Icons.open_in_new_rounded, size: 16),
            label: Text('localhost:${state.port}'),
          ),
      ],
    );
  }

  Widget _buildFatalError(ColorScheme scheme, AppState state) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, size: 48, color: scheme.error),
          const SizedBox(height: 12),
          Text(state.fatalError!, textAlign: TextAlign.center),
        ],
      ),
    );
  }

  /// 访问卡片：二维码 + 地址切换 + 复制/打开。
  Widget _buildAccessCard(ColorScheme scheme, AppState state) {
    final url = _currentUrl;
    return Card.filled(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: url == null
            ? const Padding(
                padding: EdgeInsets.all(8),
                child: Text('未发现局域网地址，请检查网络连接'),
              )
            : Column(
                children: [
                  if (state.lanAddresses.length > 1) ...[
                    Wrap(
                      spacing: 8,
                      alignment: WrapAlignment.center,
                      children: [
                        for (var i = 0; i < state.lanAddresses.length; i++)
                          ChoiceChip(
                            label: Text(state.lanAddresses[i]),
                            selected: i == _selectedAddr,
                            onSelected: (_) {
                              setState(() => _selectedAddr = i);
                            },
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                  ],
                  // 二维码始终用白底，深色主题下扫码对比度才够
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: QrImageView(
                      data: url,
                      version: QrVersions.auto,
                      size: 168,
                      padding: EdgeInsets.zero,
                      backgroundColor: Colors.white,
                      eyeStyle: const QrEyeStyle(
                        eyeShape: QrEyeShape.circle,
                        color: Color(0xFF1B1B1B),
                      ),
                      dataModuleStyle: const QrDataModuleStyle(
                        dataModuleShape: QrDataModuleShape.circle,
                        color: Color(0xFF1B1B1B),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    '手机扫码直接访问',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Flexible(
                        child: InkWell(
                          borderRadius: BorderRadius.circular(8),
                          onTap: () => _openUrl(url),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 8, vertical: 4),
                            child: Text(
                              url,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: scheme.primary,
                                decoration: TextDecoration.underline,
                                decorationColor: scheme.primary,
                              ),
                            ),
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: '复制地址',
                        icon: const Icon(Icons.copy_rounded, size: 18),
                        onPressed: () => _copyUrl(url),
                      ),
                      IconButton(
                        tooltip: '在浏览器中打开',
                        icon: const Icon(Icons.open_in_new_rounded, size: 18),
                        onPressed: () => _openUrl(url),
                      ),
                    ],
                  ),
                ],
              ),
      ),
    );
  }

  // 规则的安装与更新在 web 端（我的 → 规则管理）完成，这里只展示状态。
  Widget _buildRulesRow(ColorScheme scheme, AppState state) {
    final count = state.registry?.plugins.length ?? 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.extension_rounded,
                size: 18, color: scheme.onSurfaceVariant),
            const SizedBox(width: 6),
            Text(count == 0
                ? '尚未安装规则（可在 web 端「我的 → 规则管理」安装）'
                : '视频源规则：$count 条'),
          ],
        ),
        if (state.updateAvailable != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: InkWell(
              borderRadius: BorderRadius.circular(6),
              onTap: () => launchUrl(Uri.parse(state.updateUrl)),
              child: Row(
                children: [
                  Icon(Icons.new_releases_rounded,
                      size: 18, color: scheme.tertiary),
                  const SizedBox(width: 6),
                  Text(
                    '新版本 ${state.updateAvailable} 可用，点击查看',
                    style: TextStyle(color: scheme.tertiary),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildLogHeader(ColorScheme scheme) {
    return Row(
      children: [
        Text('日志', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(width: 4),
        IconButton(
          tooltip: '复制日志',
          visualDensity: VisualDensity.compact,
          icon: const Icon(Icons.copy_rounded, size: 16),
          onPressed: _copyLogs,
        ),
        const Spacer(),
        IconButton(
          tooltip: _logExpanded ? '收起日志' : '展开日志',
          visualDensity: VisualDensity.compact,
          icon: Icon(
            _logExpanded
                ? Icons.keyboard_arrow_down_rounded
                : Icons.keyboard_arrow_up_rounded,
            size: 20,
          ),
          onPressed: _toggleLog,
        ),
      ],
    );
  }

  bool _togglingLog = false;

  /// 收起/展开日志时同步调整窗口高度：收起后窗口贴合剩余内容，
  /// 不留大片空白；展开时恢复收起前的高度。
  /// 重入互斥：切换含多个异步步骤（测量、调整窗口），快速连点会让
  /// 两次切换的窗口尺寸与 UI 状态交错失配，进行中的点击直接忽略。
  Future<void> _toggleLog() async {
    if (_togglingLog) return;
    _togglingLog = true;
    try {
      await _doToggleLog();
    } finally {
      _togglingLog = false;
    }
  }

  Future<void> _doToggleLog() async {
    if (_logExpanded) {
      final outer = await windowManager.getSize();
      _expandedWindowHeight = outer.height;
      setState(() => _logExpanded = false);
      // 等重布局完成后按实际内容测量目标高度
      await WidgetsBinding.instance.endOfFrame;
      if (!mounted) return;
      final box =
          _fixedContentKey.currentContext?.findRenderObject() as RenderBox?;
      if (box == null) return;
      final contentBottom =
          box.localToGlobal(Offset(0, box.size.height)).dy + 16;
      final innerHeight = MediaQuery.of(context).size.height;
      final chrome = outer.height - innerHeight;
      // 向上取整 + 2px 余量：非整数 DPI（如 125%）下逻辑↔物理换算的
      // 小数截断会让窗口略小于内容，触发 RenderFlex 溢出（~0.4px）。
      final target = (contentBottom + chrome).ceilToDouble() + 2;
      await windowManager.setSize(Size(outer.width, target));
    } else {
      // 先撑大窗口再切布局：收起态窗口恰好贴合固定内容，若先切回
      // 展开布局，多出的间距与日志面板会在窗口变大前溢出一帧。
      final outer = await windowManager.getSize();
      final target = _expandedWindowHeight ?? 700;
      if (outer.height < target) {
        await windowManager.setSize(Size(outer.width, target));
        await WidgetsBinding.instance.endOfFrame;
      }
      if (!mounted) return;
      setState(() => _logExpanded = true);
    }
  }

  Widget _buildLogPanel(ColorScheme scheme) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(12),
      ),
      child: ValueListenableBuilder<List<String>>(
        valueListenable: logLines,
        builder: (context, lines, _) {
          // SelectionArea：支持拖选复制单条/片段；整体复制走标题栏按钮
          return SelectionArea(
            child: ListView.builder(
              reverse: true,
              padding: const EdgeInsets.all(10),
              itemCount: lines.length,
              itemBuilder: (context, index) {
                final line = lines[lines.length - 1 - index];
                return Text(
                  line,
                  style: const TextStyle(
                    fontSize: 12,
                    fontFamily: 'monospace',
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
