// ====== Danmaku ======
class DanmakuLayer {
  constructor(video, container) {
    this.video = video;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "danmaku-canvas";
    container.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.items = [];
    this.cursor = 0;
    this.activeRolling = [];
    this.activeFixed = [];
    this.lanes = { rolling: [], top: [], bottom: [] };
    this.lineH = 28;
    this.lastVideoTime = 0;
    this.lastTickAt = 0;
    this.rafId = null;
    this.config = this.loadConfig();
    this.applyVisibility();

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.start();
  }

  loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem("danmakuConfig") || "{}");
      return {
        enabled: stored.enabled !== false,
        fontSize: stored.fontSize || 22,
        opacity: typeof stored.opacity === "number" ? stored.opacity : 0.8,
        speed: stored.speed || 10,
      };
    } catch (_) {
      return { enabled: true, fontSize: 22, opacity: 0.8, speed: 10 };
    }
  }

  saveConfig() {
    try {
      localStorage.setItem("danmakuConfig", JSON.stringify(this.config));
    } catch (_) {}
  }

  setConfig(patch) {
    Object.assign(this.config, patch);
    this.saveConfig();
    this.applyVisibility();
    this.recomputeLanes();
  }

  applyVisibility() {
    this.canvas.classList.toggle("is-hidden", !this.config.enabled);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.recomputeLanes();
  }

  recomputeLanes() {
    const lineH = this.config.fontSize + 6;
    this.lineH = lineH;
    const maxLanes = Math.max(1, Math.floor(this.cssHeight * 0.75 / lineH));
    const reset = (arr) => {
      const out = new Array(maxLanes).fill(0);
      for (let i = 0; i < Math.min(arr.length, maxLanes); i++) out[i] = arr[i];
      return out;
    };
    this.lanes.rolling = reset(this.lanes.rolling);
    this.lanes.top = reset(this.lanes.top);
    this.lanes.bottom = reset(this.lanes.bottom);
  }

  load(items) {
    this.items = (items || []).slice().sort((a, b) => a.time - b.time);
    this.cursor = 0;
    this.activeRolling = [];
    this.activeFixed = [];
    this.lanes.rolling = this.lanes.rolling.map(() => 0);
    this.lanes.top = this.lanes.top.map(() => 0);
    this.lanes.bottom = this.lanes.bottom.map(() => 0);
  }

  get count() { return this.items.length; }

  start() {
    if (this.rafId != null) return;
    const tick = (now) => {
      if (!this.lastTickAt) this.lastTickAt = now;
      const dt = Math.min(0.1, (now - this.lastTickAt) / 1000);
      this.lastTickAt = now;
      this.update(dt);
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  dispose() {
    this.stop();
    try { this.resizeObs.disconnect(); } catch (_) {}
    this.canvas.remove();
  }

  update(dt) {
    if (!this.config.enabled || !this.items.length || !this.video) return;
    const now = this.video.currentTime;
    if (Math.abs(now - this.lastVideoTime) > 1) {
      // seek
      let lo = 0, hi = this.items.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.items[mid].time < now) lo = mid + 1; else hi = mid;
      }
      this.cursor = lo;
      this.activeRolling = [];
      this.activeFixed = [];
    }
    this.lastVideoTime = now;
    if (this.video.paused) return;

    while (this.cursor < this.items.length && this.items[this.cursor].time <= now) {
      this.emit(this.items[this.cursor]);
      this.cursor++;
    }

    for (const d of this.activeRolling) d.x -= d.speed * dt;
    this.activeRolling = this.activeRolling.filter((d) => d.x + d.width > 0);
    this.activeFixed = this.activeFixed.filter((d) => now < d.endTime);
  }

  emit(item) {
    const W = this.cssWidth, H = this.cssHeight;
    this.ctx.font = this.config.fontSize + "px sans-serif";
    const width = this.ctx.measureText(item.message).width;
    const color = "#" + (item.color || 0xffffff).toString(16).padStart(6, "0");
    if (item.type === 1) {
      const duration = this.config.speed;
      const speed = (W + width) / duration;
      const now = this.video.currentTime;
      let laneIdx = -1;
      for (let i = 0; i < this.lanes.rolling.length; i++) {
        if (this.lanes.rolling[i] <= now) { laneIdx = i; break; }
      }
      if (laneIdx < 0) return;
      this.lanes.rolling[laneIdx] = now + width / speed + 0.3;
      this.activeRolling.push({
        message: item.message, x: W, y: laneIdx * this.lineH + this.config.fontSize,
        speed, width, color,
      });
    } else if (item.type === 4 || item.type === 5) {
      const top = item.type === 5;
      const lanes = top ? this.lanes.top : this.lanes.bottom;
      const now = this.video.currentTime;
      let laneIdx = -1;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i] <= now) { laneIdx = i; break; }
      }
      if (laneIdx < 0) return;
      const duration = 4;
      lanes[laneIdx] = now + duration;
      const y = top
        ? laneIdx * this.lineH + this.config.fontSize + 4
        : H - laneIdx * this.lineH - 8;
      this.activeFixed.push({
        message: item.message, x: Math.max(4, (W - width) / 2), y,
        width, color, endTime: now + duration,
      });
    }
  }

  render() {
    if (!this.config.enabled) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.globalAlpha = this.config.opacity;
    ctx.font = this.config.fontSize + "px sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 3;
    for (const d of this.activeRolling) {
      ctx.fillStyle = d.color;
      ctx.fillText(d.message, d.x, d.y);
    }
    for (const d of this.activeFixed) {
      ctx.fillStyle = d.color;
      ctx.fillText(d.message, d.x, d.y);
    }
  }
}

let activeDanmaku = null;
function disposeDanmaku() {
  if (activeDanmaku) {
    try { activeDanmaku.dispose(); } catch (_) {}
    activeDanmaku = null;
  }
}

// ====== Progress reporting ======
let activeProgressTimer = null;
function disposeProgressReporter() {
  if (activeProgressTimer != null) {
    clearInterval(activeProgressTimer);
    activeProgressTimer = null;
  }
}
async function reportProgress(payload) {
  try {
    await fetch("/api/history/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    // 进度上报失败不打扰用户
  }
}

// 当前播放页持有的 hls.js 实例，跳出页面时销毁
let activeHls = null;
function disposeHls() {
  if (activeHls) {
    try { activeHls.destroy(); } catch (_) {}
    activeHls = null;
  }
}

// 懒加载 hls.js（只在需要时）
let hlsLoaderPromise = null;
function ensureHlsLoaded() {
  if (typeof Hls !== "undefined") return Promise.resolve();
  if (hlsLoaderPromise) return hlsLoaderPromise;
  hlsLoaderPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/assets/hls.min.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("hls.js 加载失败"));
    document.head.append(s);
  });
  return hlsLoaderPromise;
}

function nativeHlsSupported(video) {
  return !!(
    video.canPlayType("application/vnd.apple.mpegurl") ||
    video.canPlayType("application/x-mpegURL") ||
    video.canPlayType("audio/mpegurl")
  );
}

async function attachStream(video, data, onError) {
  const streamType = data.streamType || "unknown";
  const looksLikeHls = streamType === "hls" || /\.m3u8/i.test(data.originalUrl || "");

  if (looksLikeHls && !nativeHlsSupported(video)) {
    try {
      await ensureHlsLoaded();
    } catch (e) {
      onError("加载 hls.js 失败：" + e.message);
      return;
    }
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
    });
    activeHls = hls;
    hls.on(Hls.Events.ERROR, (_, info) => {
      if (info.fatal) {
        switch (info.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            onError("HLS 错误：" + (info.details || info.type));
            disposeHls();
        }
      }
    });
    hls.loadSource(data.playUrl);
    hls.attachMedia(video);
  } else {
    video.src = data.playUrl;
  }
}


// ====== 视频元素资源释放 ======
// iOS Safari 的视频解码管线不随 DOM 移除而释放，且同时存在的管线有
// 硬上限（1~3 个）——不显式释放旧 video，切集后新视频会"一次 206 即死"。
// 标准释放手法：pause → 摘除 src → load()。
let activeVideoEl = null;
function disposeActiveVideo() {
  const v = activeVideoEl;
  activeVideoEl = null;
  if (!v) return;
  try {
    v.pause();
    v.removeAttribute("src");
    while (v.firstChild) v.removeChild(v.firstChild);
    v.load();
  } catch (_) {}
}

// ====== 键盘快捷键（桌面浏览器） ======
// Space 播放/暂停 · ←/→ ±5s · ↑/↓ 音量 · F 全屏 · M 静音 · P 画中画
let _playerKeyHandler = null;
function disposePlayerKeys() {
  if (_playerKeyHandler) {
    document.removeEventListener("keydown", _playerKeyHandler);
    _playerKeyHandler = null;
  }
}
function bindPlayerKeys(video) {
  disposePlayerKeys();
  _playerKeyHandler = (ev) => {
    const tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    switch (ev.key) {
      case " ":
        ev.preventDefault();
        if (video.paused) video.play();
        else video.pause();
        break;
      case "ArrowLeft":
        ev.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
        break;
      case "ArrowRight":
        ev.preventDefault();
        video.currentTime = video.currentTime + 5;
        break;
      case "ArrowUp":
        ev.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        break;
      case "ArrowDown":
        ev.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        break;
      case "f":
      case "F":
        if (document.fullscreenElement) document.exitFullscreen();
        else if (video.requestFullscreen) video.requestFullscreen();
        break;
      case "m":
      case "M":
        video.muted = !video.muted;
        break;
      case "p":
      case "P":
        togglePictureInPicture(video);
        break;
    }
  };
  document.addEventListener("keydown", _playerKeyHandler);
}

// ====== 画中画 ======
// 标准 API（Chrome/Edge）与 WebKit presentation mode（iOS/macOS Safari）
function pipSupported(video) {
  return (
    (document.pictureInPictureEnabled && !video.disablePictureInPicture) ||
    typeof video.webkitSetPresentationMode === "function"
  );
}
async function togglePictureInPicture(video) {
  try {
    if (typeof video.webkitSetPresentationMode === "function" &&
        !document.pictureInPictureEnabled) {
      const mode = video.webkitPresentationMode;
      video.webkitSetPresentationMode(mode === "picture-in-picture" ? "inline" : "picture-in-picture");
      return;
    }
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (_) {
    // 部分浏览器要求用户手势内调用；静默失败即可
  }
}

// ============================================================
// 播放页：视频 + 控件行 + 弹幕设置（SettingsSliderTile 风格）
// ============================================================
async function renderPlayer(params) {
  disposeActiveVideo();
  disposeHls();
  disposeDanmaku();
  disposeProgressReporter();
  disposePlayerKeys();
  const { plugin, episodeUrl, title, bid, episode, road, src } = params;
  const epNum = parseInt(episode || "1", 10);
  const roadNum = parseInt(road || "0", 10);
  $app.innerHTML = "";
  renderNavRail("");
  window.scrollTo(0, 0);

  const page = el("div", { class: "page" });
  $app.append(appBar({ title: title || "播放", back: true, compact: true }), page);
  const status = loadingNode("正在解析视频源，可能需要几秒…");
  page.append(status);

  let data;
  try {
    data = await fetchJson("/api/resolve?plugin=" + encodeURIComponent(plugin) + "&episodeUrl=" + encodeURIComponent(episodeUrl));
  } catch (e) {
    status.remove();
    page.append(errorState({ title: "解析失败", message: e.message, onRetry: () => renderPlayer(params) }));
    return;
  }
  status.remove();

  // 布局：竖屏 / 窄屏时面板在视频下方；横屏宽屏时作为右侧侧栏（video_page_layout.dart）
  const main = el("div", { class: "player-main" });
  const panel = el("div", { class: "player-panel" });
  page.append(el("div", { class: "player-layout" }, main, panel));
  const seriesTitle = (title || "").split(" · ").slice(0, -1).join(" · ") || title || "";

  const video = el("video", { controls: true, playsinline: true, "webkit-playsinline": true, preload: "metadata" });
  const playerWrap = el("div", { class: "player-wrap" }, video);
  main.append(playerWrap);

  const errorNode = el("div", { class: "player-error" });
  errorNode.style.display = "none";
  main.append(errorNode);
  const showError = (msg) => { errorNode.textContent = msg; errorNode.style.display = "block"; };

  await attachStream(video, data, showError);
  activeVideoEl = video;

  // ====== 控件行：上一集 / 下一集 / 倍速 / 画面比例 / 重新解析 ======
  const prevBtn = button("上一集", { icon: "skip_previous" });
  const nextBtn = button("下一集", { icon: "skip_next" });
  prevBtn.disabled = true;
  nextBtn.disabled = true;

  // 播放偏好（倍速 / 画面比例）记在 localStorage，下次进播放页沿用
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem("playerPrefs") || "{}") || {}; } catch (_) {}
  const savePrefs = (patch) => { Object.assign(prefs, patch); try { localStorage.setItem("playerPrefs", JSON.stringify(prefs)); } catch (_) {} };
  const rateSelect = el("select", { class: "btn btn-tonal", "aria-label": "倍速" });
  const initialRate = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].includes(prefs.rate) ? prefs.rate : 1.0;
  for (const r of [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]) {
    const opt = el("option", { value: String(r) }, r === 1.0 ? "倍速 1x" : "倍速 " + r + "x");
    if (r === initialRate) opt.setAttribute("selected", "");
    rateSelect.append(opt);
  }
  const applyRate = () => {
    const r = parseFloat(rateSelect.value);
    if (!Number.isNaN(r)) { video.playbackRate = r; savePrefs({ rate: r }); }
  };
  rateSelect.addEventListener("change", applyRate);
  if (initialRate !== 1.0) video.addEventListener("loadedmetadata", () => { video.playbackRate = initialRate; }, { once: true });

  const fitSelect = el("select", { class: "btn btn-tonal", "aria-label": "画面比例" });
  const initialFit = ["contain", "cover", "fill"].includes(prefs.fit) ? prefs.fit : "contain";
  for (const f of [{ v: "contain", label: "画面 适应" }, { v: "cover", label: "画面 填充" }, { v: "fill", label: "画面 拉伸" }]) {
    const opt = el("option", { value: f.v }, f.label);
    if (f.v === initialFit) opt.setAttribute("selected", "");
    fitSelect.append(opt);
  }
  video.style.objectFit = initialFit;
  fitSelect.addEventListener("change", () => { video.style.objectFit = fitSelect.value; savePrefs({ fit: fitSelect.value }); });

  const reload = button("重新解析", { variant: "text", icon: "refresh", onclick: () => renderPlayer(params) });
  const controls = el("div", { class: "player-controls" }, prevBtn, nextBtn, rateSelect, fitSelect, reload);
  if (pipSupported(video)) {
    controls.append(button("画中画", { variant: "text", icon: "picture_in_picture", onclick: () => togglePictureInPicture(video) }));
  }
  main.append(controls);
  bindPlayerKeys(video);

  // 选集（roads + 上次观看）只拉一次：上一集/下一集 和 选集面板共用
  const playCtx = { plugin, src, title: seriesTitle, bid };
  const roadsPromise = plugin && src ? loadRoadsAndHistory(plugin, src, bid).catch(() => null) : Promise.resolve(null);
  roadsPromise.then((info) => {
    const currentRoad = info && info.roads[roadNum];
    if (!currentRoad || !Array.isArray(currentRoad.episodes)) return;
    const eps = currentRoad.episodes;
    const idx = epNum - 1;
    const goEp = (newIdx) => {
      if (newIdx < 0 || newIdx >= eps.length) return;
      go("/play", playEpisodeParams(playCtx, eps[newIdx], newIdx, roadNum));
    };
    if (idx > 0) { prevBtn.disabled = false; prevBtn.addEventListener("click", () => goEp(idx - 1)); }
    if (idx < eps.length - 1) { nextBtn.disabled = false; nextBtn.addEventListener("click", () => goEp(idx + 1)); }
  });

  const typeLabel = data.streamType === "hls"
    ? "HLS" + (nativeHlsSupported(video) ? "（原生）" : "（hls.js）")
    : data.streamType === "mp4" ? "MP4" : "直链";
  main.append(el("div", { class: "player-meta" }, "规则 " + data.pluginName + " · " + typeLabel + " · " + data.originalUrl));

  video.addEventListener("error", () => {
    showError("播放器报告错误。可能是源失效或浏览器不支持该格式。");
  });

  // ====== 弹幕：SettingsSection（开关 + 三个 slider tile） ======
  const danmaku = new DanmakuLayer(video, playerWrap);
  activeDanmaku = danmaku;

  const sourceTile = tile({ icon: "unfold_more", title: "弹幕源", desc: "自动匹配", chevron: true, onclick: () => {
    openDanmakuSourceSheet({ keyword: seriesTitle, onPick: async (pick) => {
      danmakuDesc.textContent = "正在加载弹幕…";
      try {
        const dm = await fetchJson("/api/danmaku/episode?episodeId=" + encodeURIComponent(pick.episodeId));
        danmaku.load(dm.items || []);
        danmakuDesc.textContent = "共 " + danmaku.count + " 条";
        sourceTile.querySelector(".tile-desc").textContent = pick.animeTitle + " · " + (pick.episodeTitle || "");
        toast("已切换弹幕源，共 " + danmaku.count + " 条");
      } catch (e) {
        danmakuDesc.textContent = "弹幕加载失败";
        toast("弹幕加载失败：" + e.message);
      }
    } });
  } });
  const danmakuSection = section({
    title: "弹幕",
    desc: "加载中…",
    rows: [
      splitRow(sourceTile),
      splitRow(switchTile({ icon: "subtitles", title: "显示弹幕", checked: danmaku.config.enabled, onChange: (v) => danmaku.setConfig({ enabled: v }) })),
      splitRow(sliderTile({ label: "字号", min: 14, max: 36, step: 1, value: danmaku.config.fontSize,
        format: (v) => v + " px", onInput: (v) => danmaku.setConfig({ fontSize: v }) })),
      splitRow(sliderTile({ label: "不透明度", min: 20, max: 100, step: 5, value: Math.round(danmaku.config.opacity * 100),
        format: (v) => v + "%", onInput: (v) => danmaku.setConfig({ opacity: v / 100 }) })),
      splitRow(sliderTile({ label: "滚动时长", min: 5, max: 20, step: 1, value: danmaku.config.speed,
        format: (v) => v + " 秒", onInput: (v) => danmaku.setConfig({ speed: v }) })),
    ],
  });
  const danmakuDesc = danmakuSection.querySelector(".section-desc");

  // ====== 面板：选集 | 评论 | 弹幕（player_content_tabs.dart） ======
  const panelTabs = el("div", { class: "tabs no-divider", role: "tablist" });
  const panelBody = el("div", { class: "player-panel-body" });
  panel.append(panelTabs, panelBody);
  let panelTab = "episodes";
  const panelNodes = {};
  async function renderPanel() {
    panelBody.innerHTML = "";
    for (const k of Object.keys(panelNodes)) panelNodes[k].classList.toggle("is-active", k === panelTab);
    if (panelTab === "danmaku") { panelBody.append(danmakuSection); return; }
    if (panelTab === "comments") { panelBody.append(episodeCommentsPanel(bid, epNum)); return; }
    panelBody.append(loadingNode("", "medium"));
    const info = await roadsPromise;
    if (panelTab !== "episodes") return;
    panelBody.innerHTML = "";
    if (!info || !info.roads.length) { panelBody.append(emptyState({ icon: "live_tv", title: "没有可用的播放列表", compact: true })); return; }
    panelBody.append(episodePanel({
      plugin, src, title: seriesTitle, bid, roads: info.roads, lastWatched: info.lastWatched,
      activeRoadIdx: roadNum, currentRoad: roadNum, currentEpisode: epNum,
    }));
  }
  for (const t of [{ key: "episodes", label: "选集" }, { key: "comments", label: "评论" }, { key: "danmaku", label: "弹幕" }]) {
    const node = el("button", { class: "tab sl" + (t.key === panelTab ? " is-active" : ""), type: "button", role: "tab" }, t.label);
    node.addEventListener("click", () => { panelTab = t.key; renderPanel(); });
    panelNodes[t.key] = node;
    panelTabs.append(node);
  }
  renderPanel();

  if (bid && episode) {
    try {
      const dm = await fetchJson("/api/danmaku?bangumiId=" + encodeURIComponent(bid) + "&episode=" + encodeURIComponent(episode));
      danmaku.load(dm.items || []);
      danmakuDesc.textContent = "共 " + danmaku.count + " 条";
      if (!danmaku.count) sourceTile.querySelector(".tile-desc").textContent = "自动匹配未找到弹幕，可手动选择";
    } catch (e) {
      danmakuDesc.textContent = "弹幕加载失败";
    }
  } else {
    danmakuDesc.textContent = "需从番剧详情页打开才能加载弹幕";
    sourceTile.querySelector(".tile-desc").textContent = "可手动选择弹幕源";
  }

  // ====== 进度同步 ======
  if (bid && episode && plugin) {
    try {
      const h = await fetchJson("/api/history?bangumiId=" + encodeURIComponent(bid) + "&pluginName=" + encodeURIComponent(plugin));
      const prog = h.history && h.history.progresses && h.history.progresses[String(epNum)];
      if (prog && prog.progressMs > 5000) {
        const seekTo = prog.progressMs / 1000;
        const doSeek = () => {
          if (Math.abs((video.currentTime || 0) - seekTo) > 2) {
            try { video.currentTime = seekTo; } catch (_) {}
          }
        };
        if (video.readyState >= 1) doSeek();
        else video.addEventListener("loadedmetadata", doSeek, { once: true });
        toast("已从 " + formatPosition(prog.progressMs) + " 继续播放");
      }
    } catch (_) {}

    const epName = (title || "").split(" · ").pop() || "";
    const send = () => {
      const t = video.currentTime || 0;
      if (t < 5) return;
      reportProgress({
        bangumiId: parseInt(bid, 10),
        pluginName: plugin,
        episode: epNum,
        road: roadNum,
        progressMs: Math.floor(t * 1000),
        // KazumiWeb 契约：lastSrc = 本集地址（历史直达续播），src = 详情页地址（恢复上一集/下一集）
        lastSrc: episodeUrl,
        episodeName: epName,
        deviceId: getDeviceId(),
        src: src || "",
      });
    };
    activeProgressTimer = setInterval(send, 5000);
    video.addEventListener("pause", send);
    window.addEventListener("pagehide", send, { once: true });
  }
}

// 离开播放页时销毁 hls.js + 弹幕 + 进度上报
window.addEventListener("hashchange", () => {
  const { path } = parseRoute();
  if (path !== "/play") {
    disposeHls();
    disposeDanmaku();
    disposeProgressReporter();
  }
});

// ============================================================
// 弹幕源切换（danmaku_source_sheet.dart）：选择弹幕源 → 选择番剧 → 选择分集
// ============================================================
function danmakuSearchHistory() {
  try { const a = JSON.parse(localStorage.getItem("danmakuSearchHistory") || "[]"); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
function pushDanmakuSearchHistory(kw) {
  const arr = danmakuSearchHistory().filter((x) => x !== kw);
  arr.unshift(kw);
  try { localStorage.setItem("danmakuSearchHistory", JSON.stringify(arr.slice(0, 5))); } catch (_) {}
}
// opts: { keyword, onPick({ episodeId, animeTitle, episodeTitle }) }
function openDanmakuSourceSheet(opts) {
  let step = 0;           // 0 搜索 1 番剧 2 分集
  let keyword = opts.keyword || "";
  let animes = [];
  let anime = null;
  let episodes = [];
  openSheet({ title: "选择弹幕源", compact: true }, (body, close, ctl) => {
    const backBtn = iconBtn("arrow_back", { label: "返回" });
    backBtn.style.display = "none";
    ctl.sheet.querySelector(".sheet-header").prepend(backBtn);
    backBtn.addEventListener("click", () => { step = Math.max(0, step - 1); render(); });
    const progress = el("div", { class: "step-bar" }, el("span", {}), el("span", {}), el("span", {}));
    const content = el("div", {});
    body.append(progress, content);

    function setHeader() {
      ctl.setTitle(["选择弹幕源", "选择番剧", "选择分集"][step]);
      ctl.setDesc(step === 0 ? "" : step === 1 ? keyword : (anime ? anime.animeTitle : ""));
      backBtn.style.display = step > 0 ? "" : "none";
      [...progress.children].forEach((seg, i) => {
        seg.className = i < step ? "is-done" : i === step ? "is-current" : "";
      });
    }
    async function doSearch(kw) {
      keyword = kw;
      pushDanmakuSearchHistory(kw);
      step = 1;
      render();
      content.innerHTML = "";
      content.append(loadingNode("正在检索弹幕源", "medium"));
      try {
        const data = await fetchJson("/api/danmaku/search?keyword=" + encodeURIComponent(kw));
        animes = data.items || [];
      } catch (e) {
        content.innerHTML = "";
        content.append(errorState({ title: "弹幕源检索失败", message: e.message, compact: true, onRetry: () => doSearch(kw),
          actions: [button("返回搜索", { onclick: () => { step = 0; render(); } })] }));
        return;
      }
      if (step === 1) render();
    }
    async function pickAnime(a) {
      anime = a;
      step = 2;
      render();
      content.innerHTML = "";
      content.append(loadingNode("正在获取分集", "medium"));
      try {
        const data = await fetchJson("/api/danmaku/episodes?animeId=" + encodeURIComponent(a.animeId));
        episodes = data.items || [];
      } catch (e) {
        content.innerHTML = "";
        content.append(errorState({ title: "获取分集失败", message: e.message, compact: true, onRetry: () => pickAnime(a),
          actions: [button("返回番剧", { onclick: () => { step = 1; render(); } })] }));
        return;
      }
      if (step === 2) render();
    }

    function renderSearch() {
      const input = el("input", { class: "text-field", type: "search", placeholder: "番剧名称", autocomplete: "off" });
      input.value = keyword;
      const submit = () => { const v = input.value.trim(); if (v) doSearch(v); };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submit(); } });
      content.append(el("div", { class: "field-row", style: "margin-top:0" }, iconSvg("search"), input));
      const recent = danmakuSearchHistory();
      if (recent.length) {
        content.append(el("div", { class: "field-label" }, "最近搜索"),
          el("div", { class: "chips", style: "margin-top:8px" }, ...recent.map((kw) =>
            el("button", { class: "chip sl", type: "button", onclick: () => doSearch(kw) }, iconSvg("history"), kw))));
      }
      content.append(el("div", { class: "sheet-actions", style: "padding:20px 0 0" },
        button("取消", { variant: "text", onclick: close }),
        button("搜索", { variant: "filled", icon: "search", onclick: submit })));
      setTimeout(() => { try { input.focus(); } catch (_) {} }, 30);
    }
    function renderAnimes() {
      if (!animes.length) {
        content.append(emptyState({ icon: "search_off", title: "没有找到匹配的番剧", compact: true, actions: [button("返回搜索", { onclick: () => { step = 0; render(); } })] }));
        return;
      }
      content.append(splitList(animes.map((a) => splitRow(
        tile({ title: a.animeTitle, desc: a.typeDescription || (a.episodeCount ? a.episodeCount + " 集" : ""), chevron: true }),
        { onclick: () => pickAnime(a) })), { tight: true }));
    }
    function renderEpisodes() {
      if (!episodes.length) {
        content.append(emptyState({ icon: "subtitles", title: "这部番剧没有分集弹幕", compact: true, actions: [button("返回番剧", { onclick: () => { step = 1; render(); } })] }));
        return;
      }
      let filter = "";
      let range = null;   // [start, end] 1-based inclusive
      const total = episodes.length;
      const listNode = el("div", {});
      const countNode = el("div", { class: "t-label-large c-variant", style: "padding:12px 4px 4px" });
      const rows = () => {
        let list = episodes.map((e, i) => ({ e, n: i + 1 }));
        if (range) list = list.filter((x) => x.n >= range[0] && x.n <= range[1]);
        if (filter) list = list.filter((x) => (x.e.episodeTitle || "").toLowerCase().includes(filter) || String(x.n) === filter);
        return list;
      };
      const renderList = () => {
        listNode.innerHTML = "";
        const list = rows();
        countNode.textContent = list.length === total ? "共 " + total + " 集" : "显示 " + list.length + " 集，共 " + total + " 集";
        if (!list.length) { listNode.append(emptyState({ icon: "search_off", title: "没有匹配的分集", compact: true })); return; }
        listNode.append(splitList(list.map(({ e, n }) => splitRow(
          el("div", { class: "ep-row dm-ep-row" }, el("div", { class: "body" }, el("div", { class: "name" }, e.episodeTitle || ("第 " + n + " 话"))), iconSvg("chevron_right")),
          { onclick: () => { close(); opts.onPick({ episodeId: e.episodeId, animeTitle: anime.animeTitle, episodeTitle: e.episodeTitle }); } })), { tight: true, r20: true }));
      };
      if (total > 25) {
        const f = el("input", { class: "text-field", type: "search", placeholder: "标题或集号", autocomplete: "off" });
        f.addEventListener("input", () => { filter = f.value.trim().toLowerCase(); renderList(); });
        const toolbar = el("div", { class: "field-row", style: "margin-top:0" }, f);
        if (total > 100) {
          const jump = el("input", { class: "text-field dm-jump", type: "number", placeholder: "集号", min: "1", max: String(total) });
          jump.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter") return;
            const n = parseInt(jump.value, 10);
            if (!n || n < 1 || n > total) { toast("集号范围：1–" + total); return; }
            close();
            const e = episodes[n - 1];
            opts.onPick({ episodeId: e.episodeId, animeTitle: anime.animeTitle, episodeTitle: e.episodeTitle });
          });
          toolbar.append(jump);
          const chips = el("div", { class: "chips", style: "margin-top:8px" });
          const ranges = [null];
          for (let s = 1; s <= total; s += 100) ranges.push([s, Math.min(s + 99, total)]);
          const renderChips = () => {
            chips.innerHTML = "";
            for (const r of ranges) {
              const sel = (r === null && range === null) || (r && range && r[0] === range[0]);
              chips.append(filterChip(r ? r[0] + "-" + r[1] : "全部", sel, () => { range = r; renderChips(); renderList(); }));
            }
          };
          renderChips();
          content.append(toolbar, chips);
        } else {
          content.append(toolbar);
        }
      }
      content.append(countNode, listNode);
      renderList();
    }
    function render() {
      setHeader();
      content.innerHTML = "";
      if (step === 0) renderSearch();
      else if (step === 1) renderAnimes();
      else renderEpisodes();
    }
    render();
  });
}
