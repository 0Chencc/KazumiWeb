"use strict";

const $app = document.getElementById("app");
const $navRail = document.getElementById("nav-rail");

// ====== Theme ======
// 把 ColorScheme + textTheme 写到一个独立 <style id="theme-tokens">，每次
// applyTheme 重写整段。这样可以同时为 light/dark/auto 三种 data-theme 状态
// 都准备好 CSS 变量，切换模式时浏览器无须再发请求。
function applyTheme(theme) {
  const root = document.documentElement;
  // 外观设置（我的 → 外观设置）优先于服务端下发的 themeMode
  const localMode = localStorage.getItem("webThemeMode");
  const mode = localMode || theme.themeMode || "system";
  root.dataset.theme = mode === "system" ? "auto" : mode;

  let style = document.getElementById("theme-tokens");
  if (!style) {
    style = document.createElement("style");
    style.id = "theme-tokens";
    document.head.append(style);
  }

  const lines = [];

  if (theme.schemes) {
    const lightVars = schemeToCssVars(theme.schemes.light);
    const darkVars = schemeToCssVars(theme.schemes.dark);
    if (lightVars) {
      lines.push(':root[data-theme="light"] {', lightVars, '}');
      lines.push(':root[data-theme="auto"] {', lightVars, '}');
    }
    if (darkVars) {
      lines.push(':root[data-theme="dark"] {', darkVars, '}');
      lines.push('@media (prefers-color-scheme: dark) {');
      lines.push('  :root[data-theme="auto"] {', darkVars, '  }');
      lines.push('}');
    }
    // 关掉 styles.css 里的兜底暗色方案，避免和宿主配色打架
    root.classList.add("has-theme");
  } else if (theme.primaryColor) {
    root.style.setProperty("--primary", theme.primaryColor);
    root.style.setProperty("--primary-container", hexToRgba(theme.primaryColor, 0.16));
  }

  if (theme.typography) {
    const typoLines = [':root {'];
    for (const [role, geom] of Object.entries(theme.typography)) {
      if (!geom) continue;
      const kebab = camelToKebab(role);
      if (geom.size != null) typoLines.push('  --' + kebab + '-size: ' + geom.size + 'px;');
      if (geom.weight != null) typoLines.push('  --' + kebab + '-weight: ' + geom.weight + ';');
      if (geom.letterSpacing != null) typoLines.push('  --' + kebab + '-letter-spacing: ' + geom.letterSpacing + 'px;');
      if (geom.height != null) typoLines.push('  --' + kebab + '-height: ' + geom.height + ';');
    }
    typoLines.push('}');
    lines.push(typoLines.join('\n'));
  }

  style.textContent = lines.join('\n');
}

function schemeToCssVars(scheme) {
  if (!scheme) return null;
  const out = [];
  for (const [k, v] of Object.entries(scheme)) {
    out.push('  --' + camelToKebab(k) + ': ' + v + ';');
  }
  return out.join('\n');
}

function camelToKebab(s) {
  return s.replace(/([A-Z])/g, '-$1').toLowerCase();
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return "rgba(" + ((n >> 16) & 0xff) + ", " + ((n >> 8) & 0xff) + ", " + (n & 0xff) + ", " + alpha + ")";
}

// 主题同步走"惰性刷新"：首次加载 + 页面回到可见时拉一次。
async function loadTheme() {
  try {
    applyTheme(await fetchJson("/api/theme"));
  } catch (_) {
    // 静默：默认 :root 配色仍可用
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadTheme();
});

// ====== Router ======
function parseRoute() {
  const raw = location.hash.slice(1) || "/home";
  const [path, query] = raw.split("?");
  const params = {};
  if (query) {
    for (const pair of query.split("&")) {
      if (!pair) continue;
      const [k, v] = pair.split("=").map(decodeURIComponent);
      params[k] = v ?? "";
    }
  }
  return { path, params };
}
function go(path, params) {
  const qs = params
    ? "?" + Object.entries(params).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&")
    : "";
  location.hash = "#" + path + qs;
}

// ====== DOM helpers ======
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "onclick") node.addEventListener("click", v);
    else if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (v === true) node.setAttribute(k, "");
    else if (v === false || v == null) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return node;
}

async function fetchJsonOnce(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && body.message) detail = body.message;
    } catch (_) {}
    const err = new Error("HTTP " + res.status + ": " + detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
// 网络瞬断或后端偶发 5xx 时静默重试一次（只对 GET），避免"首次加载失败只能刷新"。
// 4xx 是确定性错误，直接抛出。
async function fetchJson(url, init) {
  const isGet = !init || !init.method || init.method === "GET";
  try {
    return await fetchJsonOnce(url, init);
  } catch (e) {
    if (!isGet || (e.status && e.status < 500)) throw e;
    await new Promise((r) => setTimeout(r, 600));
    return fetchJsonOnce(url, init);
  }
}
const JSON_HEADERS = { "content-type": "application/json" };
function fetchJsonPost(url, body) {
  return fetchJsonOnce(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}
function fetchJsonPut(url, body) {
  return fetchJsonOnce(url, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
}
// 设备标识：区分同一服务下的不同浏览器/设备，历史列表按设备过滤
// （观看进度本身全局共享，跨设备续播不受影响）。
function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = "d-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem("deviceId", id);
  }
  return id;
}

// ====== Material Symbols (path 取自 Google Fonts material-icons) ======
const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
  home_outlined: '<svg viewBox="0 0 24 24"><path d="M12 5.69l5 4.5V18h-2v-6H9v6H7v-7.81l5-4.5M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/></svg>',
  timeline: '<svg viewBox="0 0 24 24"><path d="M23 8c0 1.1-.9 2-2 2-.18 0-.35-.02-.51-.07l-3.56 3.55c.05.16.07.34.07.52 0 1.1-.9 2-2 2s-2-.9-2-2c0-.18.02-.36.07-.52l-2.55-2.55c-.16.05-.34.07-.52.07s-.36-.02-.52-.07l-4.55 4.56c.05.16.07.33.07.51 0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2c.18 0 .35.02.51.07l4.56-4.55C6.02 9.36 6 9.18 6 9c0-1.1.9-2 2-2s2 .9 2 2c0 .18-.02.36-.07.52l2.55 2.55c.16-.05.34-.07.52-.07s.36.02.52.07l3.55-3.56C17.02 8.35 17 8.18 17 8c0-1.1.9-2 2-2s2 .9 2 2z"/></svg>',
  favorite: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  favorite_border: '<svg viewBox="0 0 24 24"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  search_off: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/><path d="M2.81 2.81 1.39 4.22 19.78 22.61l1.41-1.42z"/></svg>',
  arrow_back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>',
  arrow_forward: '<svg viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>',
  arrow_upward: '<svg viewBox="0 0 24 24"><path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>',
  play_arrow: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  play_circle: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>',
  skip_previous: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
  skip_next: '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
  tune: '<svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>',
  schedule: '<svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  fire: '<svg viewBox="0 0 24 24"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/></svg>',
  heart_broken: '<svg viewBox="0 0 24 24"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-3.97 12.4l-1.13 1.05-1.05-1.05L6.7 11.7l3-1.5-1.7-3.7 3.96 1.13.53-2.13L14 8l-1.65 1.65 2.36 2.36-2.18 3.39z"/></svg>',
  task_alt: '<svg viewBox="0 0 24 24"><path d="M22 5.18 10.59 16.6l-4.24-4.24 1.41-1.41 2.83 2.83 10-10L22 5.18zm-2.21 5.04c.13.57.21 1.17.21 1.78 0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8c1.58 0 3.04.46 4.28 1.25l1.44-1.44C16.1 2.67 14.13 2 12 2 6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10c0-1.19-.22-2.33-.6-3.39l-1.61 1.61z"/></svg>',
  live_tv: '<svg viewBox="0 0 24 24"><path d="M21 6h-7.59l3.29-3.29L16 2l-4 4-4-4-.71.71L10.59 6H3c-1.1 0-2 .89-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.11-.9-2-2-2zm0 14H3V8h18v12zM9 10v8l7-4z"/></svg>',
  check_circle: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
  open_in_browser: '<svg viewBox="0 0 24 24"><path d="M5 4h14c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2h-4v-2h4V8H5v10h4v2H5c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zm7 6l-4 4h3v6h2v-6h3l-4-4z"/></svg>',
  pending_actions: '<svg viewBox="0 0 24 24"><path d="M17 12c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm1.65 7.35L16.5 17.2V14h1v2.79l1.85 1.85-.7.71zM18 3h-3.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H6c-1.1 0-2 .9-2 2v15c0 1.1.9 2 2 2h6.11c-.59-.57-1.07-1.25-1.42-2H6V5h2v3h8V5h2v5.08c.71.1 1.38.31 2 .6V5c0-1.1-.9-2-2-2zm-6 2c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>',
  chevron_right: '<svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>',
  expand_more: '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  more_horiz: '<svg viewBox="0 0 24 24"><path d="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>',
  my_location: '<svg viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>',
  sort: '<svg viewBox="0 0 24 24"><path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/></svg>',
  grid_view: '<svg viewBox="0 0 24 24"><path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z"/></svg>',
  view_list: '<svg viewBox="0 0 24 24"><path d="M3 14h4v-4H3v4zm0 5h4v-4H3v4zM3 9h4V5H3v4zm5 5h13v-4H8v4zm0 5h13v-4H8v4zM8 5v4h13V5H8z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>',
  event_available: '<svg viewBox="0 0 24 24"><path d="M16.53 11.06L15.47 10l-4.88 4.88-2.12-2.12-1.06 1.06L10.59 17l5.94-5.94zM19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/></svg>',
  filter_alt_off: '<svg viewBox="0 0 24 24"><path d="M19.79 5.61C20.3 4.95 19.83 4 19 4H6.83l7.97 7.97 4.99-6.36zM2.81 2.81 1.39 4.22 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-2.17l5.78 5.78 1.41-1.41L2.81 2.81z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
  error_outline: '<svg viewBox="0 0 24 24"><path d="M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/></svg>',
  north_west: '<svg viewBox="0 0 24 24"><path d="M5 15h2V8.41L18.59 20 20 18.59 8.41 7H15V5H5v10z"/></svg>',
  delete_outline: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  info_outline: '<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>',
  subtitles: '<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  label: '<svg viewBox="0 0 24 24"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>',
  unfold_more: '<svg viewBox="0 0 24 24"><path d="M12 5.83L15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z"/></svg>',
  chat_bubble: '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>',
  people: '<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
  groups: '<svg viewBox="0 0 24 24"><path d="M12 12.75c1.63 0 3.07.39 4.24.9 1.08.48 1.76 1.56 1.76 2.73V18H6v-1.61c0-1.18.68-2.26 1.76-2.73 1.17-.52 2.61-.91 4.24-.91zM4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm1.13 1.1c-.37-.06-.74-.1-1.13-.1-.99 0-1.93.21-2.78.58C.48 14.9 0 15.62 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29zM20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm4 3.43c0-.81-.48-1.53-1.22-1.85-.85-.37-1.79-.58-2.78-.58-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24v-1.57zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z"/></svg>',
  extension: '<svg viewBox="0 0 24 24"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>',
  palette: '<svg viewBox="0 0 24 24"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>',
  delete_sweep: '<svg viewBox="0 0 24 24"><path d="M15 16h4v2h-4zm0-8h7v2h-7zm0 4h6v2h-6zM3 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V8H3v10zM14 5h-3l-1-1H6L5 5H2v2h12z"/></svg>',
  download_file: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
  picture_in_picture: '<svg viewBox="0 0 24 24"><path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/></svg>',
  add: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>',
  public: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  checklist: '<svg viewBox="0 0 24 24"><path d="M22 7h-9v2h9V7zm0 8h-9v2h9v-2zM5.54 11 2 7.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 11zm0 8L2 15.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 19z"/></svg>',
  content_paste: '<svg viewBox="0 0 24 24"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"/></svg>',
  cloud_off: '<svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46C10.21 6.23 11.08 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C23.16 18.16 24 16.68 24 15c0-2.64-2.05-4.78-4.65-4.96zM3 5.27l2.75 2.74C2.56 8.15 0 10.77 0 14c0 3.31 2.69 6 6 6h11.73l2 2L21 20.73 4.27 4 3 5.27zM7.73 10l8 8H6c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73z"/></svg>',
  content_copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
  account_tree: '<svg viewBox="0 0 24 24"><path d="M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z"/></svg>',
};
// 图标统一包在 span.icon 里，尺寸由 .icon svg 规则控制
function iconNode(name) {
  const span = el("span", { class: "icon", "aria-hidden": "true" });
  span.innerHTML = ICONS[name] || "";
  return span;
}
const iconSvg = iconNode;

// ====== M3E 形状：曲奇形 clip-path（MaterialShapes.cookieNSided 近似） ======
function cookieShape(lobes, depth) {
  const pts = [];
  const n = 96;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = 50 * (1 - depth + depth * (0.5 + 0.5 * Math.cos(lobes * t)));
    pts.push((50 + r * Math.cos(t)).toFixed(2) + "% " + (50 + r * Math.sin(t)).toFixed(2) + "%");
  }
  return "polygon(" + pts.join(",") + ")";
}
document.documentElement.style.setProperty("--cookie4", cookieShape(4, 0.14));
document.documentElement.style.setProperty("--cookie9", cookieShape(9, 0.1));

// ====== UI kit ======
function iconBtn(name, opts) {
  opts = opts || {};
  const b = el("button", {
    class: "icon-btn sl" + (opts.cls ? " " + opts.cls : ""),
    type: "button",
    "aria-label": opts.label || "",
    title: opts.label || null,
  });
  b.innerHTML = ICONS[name] || "";
  if (opts.dot) b.append(el("span", { class: "dot" }));
  if (opts.onclick) b.addEventListener("click", opts.onclick);
  return b;
}

// StateActionButton：variant = filled | tonal | text | surface
function button(label, opts) {
  opts = opts || {};
  const b = el("button", {
    class: "btn sl btn-" + (opts.variant || "tonal") + (opts.small ? " is-small" : "") + (opts.cls ? " " + opts.cls : ""),
    type: opts.type || "button",
  });
  if (opts.icon) b.append(iconNode(opts.icon));
  if (label) b.append(el("span", { class: "label" }, label));
  if (opts.trailingIcon) b.append(iconNode(opts.trailingIcon));
  if (opts.onclick) b.addEventListener("click", opts.onclick);
  return b;
}

function appBar(opts) {
  opts = opts || {};
  const bar = el("div", {
    class: "app-bar" + (opts.compact ? " is-compact" : "") + (opts.large ? " is-large" : "") + (opts.back ? " has-back" : ""),
  });
  if (opts.back) {
    bar.append(iconBtn("arrow_back", { label: "返回", onclick: () => history.back() }));
  }
  const title = el("div", { class: "app-bar-title" });
  if (opts.titleNode) title.append(opts.titleNode);
  else if (opts.title) title.append(document.createTextNode(opts.title));
  bar.append(title);
  const actions = el("div", { class: "app-bar-actions" });
  for (const a of opts.actions || []) if (a) actions.append(a);
  bar.append(actions);
  return bar;
}
// 推荐页 SliverAppBar：滚过顶部哨兵后折叠
function collapsible(bar) {
  const sentinel = el("div", { style: "height:1px;margin-top:-1px;" });
  bar.before(sentinel);
  const io = new IntersectionObserver(([e]) => {
    bar.classList.toggle("is-collapsed", !e.isIntersecting);
  }, { threshold: 0 });
  io.observe(sentinel);
}

function loadingNode(text, size) {
  return el("div", { class: "loading" },
    el("div", { class: "loader" + (size === "small" ? " is-small" : size === "medium" ? " is-medium" : "") }),
    text ? el("div", {}, text) : null);
}
function inlineLoading(text) {
  return el("div", { class: "loading is-inline" }, el("div", { class: "loader is-small" }), el("span", {}, text));
}

// GeneralEmptyState（empty_state_widget.dart）
function emptyState(opts) {
  const node = el("div", { class: "state" + (opts.compact ? " is-compact" : "") });
  const badge = el("div", { class: "state-badge" });
  badge.innerHTML = ICONS[opts.icon || "info_outline"];
  node.append(badge, el("div", { class: "state-title" }, opts.title));
  if (opts.message) node.append(el("div", { class: "state-msg" }, opts.message));
  if (opts.actions && opts.actions.length) node.append(el("div", { class: "state-actions" }, ...opts.actions));
  return node;
}
// GeneralErrorWidget（error_widget.dart）
function errorState(opts) {
  const node = el("div", { class: "state is-error" + (opts.compact ? " is-compact" : "") });
  const badge = el("div", { class: "state-badge" });
  badge.innerHTML = ICONS[opts.icon || "error_outline"];
  node.append(badge, el("div", { class: "state-title" }, opts.title || "出了点问题"));
  if (opts.message) node.append(el("div", { class: "state-msg" }, opts.message));
  const actions = [];
  if (opts.onRetry) actions.push(button("重试", { variant: "filled", icon: "refresh", onclick: opts.onRetry }));
  for (const a of opts.actions || []) actions.push(a);
  if (actions.length) node.append(el("div", { class: "state-actions" }, ...actions));
  return node;
}

function splitList(rows, opts) {
  opts = opts || {};
  const list = el("div", { class: "split-list" + (opts.tight ? " is-tight" : "") + (opts.r20 ? " r20" : "") });
  for (const r of rows) if (r) list.append(r);
  return list;
}
function splitRow(children, opts) {
  opts = opts || {};
  const row = el("div", {
    class: "split-row" + (opts.onclick ? " is-clickable sl" : "") + (opts.cls ? " " + opts.cls : ""),
  }, ...(Array.isArray(children) ? children : [children]));
  if (opts.onclick) row.addEventListener("click", opts.onclick);
  return row;
}
// ContentSection：header + TonalCard 或 SplitListGroup
function section(opts) {
  const node = el("div", { class: "section" });
  if (opts.title) {
    node.append(el("div", { class: "section-header" },
      el("div", { class: "section-title" }, opts.title),
      opts.desc ? el("div", { class: "section-desc" }, opts.desc) : null));
  }
  if (opts.rows) node.append(splitList(opts.rows, opts));
  else if (opts.body) node.append(el("div", { class: "tonal-card" }, opts.body));
  if (opts.foot) node.append(el("div", { class: "section-foot" }, opts.foot));
  return node;
}
// SettingsTile / SettingsCategoryTile
function tile(opts) {
  const node = el(opts.onclick ? "button" : "div", { class: "tile" + (opts.onclick ? " sl" : ""), type: opts.onclick ? "button" : null });
  if (opts.badge) node.append(el("span", { class: "tile-badge", html: ICONS[opts.badge] }));
  else if (opts.icon) node.append(el("span", { class: "tile-leading", html: ICONS[opts.icon] }));
  node.append(el("div", { class: "tile-body" },
    el("div", { class: "tile-title" }, opts.title),
    opts.desc ? el("div", { class: "tile-desc" }, opts.desc) : null));
  if (opts.value) node.append(el("span", { class: "tile-value" }, opts.value));
  if (opts.trailing) node.append(el("span", { class: "tile-trailing" }, opts.trailing));
  else if (opts.chevron) node.append(el("span", { class: "tile-trailing", html: ICONS.chevron_right }));
  if (opts.onclick) node.addEventListener("click", opts.onclick);
  return node;
}
function switchNode(checked, onChange) {
  const sw = el("button", { class: "m3-switch", type: "button", role: "switch", "aria-checked": String(!!checked) });
  sw.addEventListener("click", () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  return sw;
}
function switchTile(opts) {
  const sw = switchNode(opts.checked, opts.onChange);
  const t = tile({ icon: opts.icon, title: opts.title, desc: opts.desc, trailing: sw });
  t.addEventListener("click", (ev) => { if (ev.target !== sw) sw.click(); });
  t.style.cursor = "pointer";
  return t;
}
// SettingsSliderTile：标签 + 值药丸 + slider
function sliderTile(opts) {
  const value = el("span", { class: "slider-value" }, opts.format(opts.value));
  const input = el("input", { type: "range", min: String(opts.min), max: String(opts.max), step: String(opts.step || 1) });
  input.value = String(opts.value);
  const sync = () => {
    const pct = ((input.value - opts.min) / (opts.max - opts.min)) * 100;
    input.style.setProperty("--pct", pct + "%");
    value.textContent = opts.format(Number(input.value));
  };
  sync();
  input.addEventListener("input", () => { sync(); opts.onInput(Number(input.value)); });
  return el("div", { class: "slider-tile" },
    el("div", { class: "slider-head" }, el("span", { class: "slider-label" }, opts.label), value),
    input);
}

// MaterialBottomSheet：handle + header(title/desc/close) + body
function openSheet(opts, builder) {
  opts = opts || {};
  const mask = el("div", { class: "sheet-mask" });
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
  sheet.append(el("div", { class: "sheet-handle" }));
  const close = () => {
    if (mask.classList.contains("is-closing")) return;
    mask.classList.add("is-closing");
    setTimeout(() => mask.remove(), 180);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  const heading = el("div", { class: "sheet-heading" });
  const titleNode = el("div", { class: "sheet-title" }, opts.title || "");
  const descNode = el("div", { class: "sheet-desc" }, opts.desc || "");
  if (!opts.desc) descNode.style.display = "none";
  heading.append(titleNode, descNode);
  if (opts.title) {
    const header = el("div", { class: "sheet-header" + (opts.compact ? " is-compact" : "") }, heading);
    header.append(iconBtn("close", { label: "关闭", onclick: close }));
    sheet.append(header);
  }
  const body = el("div", { class: "sheet-body" });
  sheet.append(body);
  mask.append(sheet);
  mask.addEventListener("click", (ev) => { if (ev.target === mask) close(); });
  document.body.append(mask);
  builder(body, close, {
    setDesc(text) { descNode.textContent = text; descNode.style.display = text ? "" : "none"; },
    setTitle(text) { titleNode.textContent = text; },
    sheet,
  });
  return close;
}

// KazumiMenu：items = [{label, icon, selected, danger, sub, onclick}] | "divider"
function openMenu(anchor, items, opts) {
  opts = opts || {};
  const menu = el("div", { class: "menu", role: "menu" });
  if (opts.title) menu.append(el("div", { class: "menu-title" }, opts.title));
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
  };
  for (const it of items) {
    if (it === "divider") { menu.append(el("div", { class: "menu-divider" })); continue; }
    const node = el("button", {
      class: "menu-item sl" + (it.selected ? " is-selected" : "") + (it.danger ? " is-danger" : ""),
      type: "button", role: "menuitem",
    });
    if (it.icon) node.append(iconSvg(it.icon));
    node.append(el("span", {}, it.label));
    if (it.sub) node.append(el("span", { class: "sub" }, it.sub));
    node.addEventListener("click", () => { close(); it.onclick && it.onclick(); });
    menu.append(node);
  }
  const onDown = (ev) => { if (!menu.contains(ev.target)) close(); };
  document.body.append(menu);
  // 定位：锚点下方，右对齐优先；越界则翻转
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  if (left < 8) left = Math.max(8, r.left);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  setTimeout(() => {
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
  }, 0);
  return close;
}

let toastTimer = null;
function toast(msg) {
  document.querySelectorAll(".toast").forEach((n) => n.remove());
  const node = el("div", { class: "toast", role: "status" }, msg);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3200);
}

// 滚到底自动加载；容器脱离 DOM 时自动解绑
function onScrollBottom(anchor, fn) {
  const onScroll = () => {
    const doc = document.documentElement;
    if (window.innerHeight + window.scrollY >= doc.scrollHeight - 240) fn();
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  const observer = new MutationObserver(() => {
    if (!anchor.isConnected) {
      window.removeEventListener("scroll", onScroll);
      observer.disconnect();
    }
  });
  observer.observe($app, { childList: true, subtree: true });
}

// 对齐客户端 bangumi_image_url_rewriter.dart 的「镜像」加速：lain.bgm.tv 与
// api.bgm.tv/v0/*/image 在国内常被 DNS 污染，客户端用 ECH 或 wsrv.nl 绕过；
// 浏览器做不了 ECH，这里统一走 wsrv.nl。
// Web 端本地偏好：图片是否走镜像（localStorage，默认开）
const APP_SETTINGS = { imageMirror: localStorage.getItem("webImageMirror") !== "0" };
function setImageMirror(v) {
  APP_SETTINGS.imageMirror = !!v;
  localStorage.setItem("webImageMirror", v ? "1" : "0");
}
function bangumiImageUrl(src) {
  if (!src || !APP_SETTINGS.imageMirror) return src || "";
  let u;
  try { u = new URL(src); } catch (_) { return src; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return src;
  const seg = u.pathname.split("/").filter(Boolean);
  const isApiImage = u.host === "api.bgm.tv" && seg.length === 4 && seg[0] === "v0" && seg[3] === "image"
    && ["subjects", "characters", "persons"].includes(seg[1]) && /^\d+$/.test(seg[2]);
  if (u.host !== "lain.bgm.tv" && !isApiImage) return src;
  const q = new URLSearchParams({ url: u.host + u.pathname + u.search });
  if (/\.gif$/i.test(u.pathname)) q.set("n", "-1");
  return "https://wsrv.nl/?" + q.toString();
}
function coverImg(src, cls, eager) {
  const img = el("img", { class: cls || "", loading: eager ? "eager" : "lazy", referrerpolicy: "no-referrer", alt: "" });
  if (src) img.src = bangumiImageUrl(src);
  return img;
}
function bestBangumiImage(images) {
  if (!images) return "";
  return images.large || images.common || images.medium || images.small || images.grid || "";
}
function ratingPill(score) {
  const pill = el("span", { class: "rating-pill" });
  if (score > 0) {
    pill.innerHTML = ICONS.star;
    pill.append(el("span", {}, score.toFixed(1)));
  } else {
    pill.append("暂无评分");
  }
  return pill;
}
function yearOf(airDate) {
  const m = /^(\d{4})/.exec(airDate || "");
  return m ? m[1] : "";
}
function isCompactWidth() { return window.innerWidth < 600; }
function isPortrait() { return window.matchMedia("(orientation: portrait)").matches; }

// 收藏状态枚举（对齐 lib/bean/widget/collect_button.dart）
// index=0 表示"未追"，调 PUT /api/collect?type=0 = 后端 deleteCollectible
const COLLECT_TYPES = [
  { value: 0, label: "未追", icon: "favorite_border" },
  { value: 1, label: "在看", icon: "favorite" },
  { value: 2, label: "想看", icon: "star" },
  { value: 3, label: "搁置", icon: "pending_actions" },
  { value: 4, label: "看过", icon: "done" },
  { value: 5, label: "抛弃", icon: "heart_broken" },
];
function collectTypeOf(value) {
  return COLLECT_TYPES.find((t) => t.value === value) || COLLECT_TYPES[0];
}
async function putCollect(bangumiId, type) {
  const body = await fetchJson("/api/collect", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bangumiId, type }),
  });
  return body.type || 0;
}
// 收藏状态菜单（CollectButton 的 MenuAnchor）
function openCollectMenu(anchor, current, onPick) {
  openMenu(anchor, COLLECT_TYPES.slice(1).map((t) => ({
    label: t.label, icon: t.icon, selected: t.value === current, onclick: () => onPick(t.value),
  })).concat(current ? ["divider", { label: "取消收藏", icon: "delete_outline", danger: true, onclick: () => onPick(0) }] : []));
}

// ====== NavigationRail / NavigationBar（menu.dart） ======
const NAV_TABS = [
  { key: "popular",  icon: "home",     iconOutlined: "home_outlined",   label: "推荐" },
  { key: "timeline", icon: "timeline", iconOutlined: "timeline",        label: "时间表" },
  { key: "collect",  icon: "favorite", iconOutlined: "favorite_border", label: "追番" },
  { key: "my",       icon: "settings", iconOutlined: "settings",        label: "我的" },
];
function renderNavRail(activeTab) {
  $navRail.innerHTML = "";
  const search = el("button", { class: "nav-search sl", "aria-label": "搜索", onclick: () => go("/search") });
  search.innerHTML = ICONS.search;
  $navRail.append(search);

  const main = el("div", { class: "nav-main" });
  for (const t of NAV_TABS) {
    const isActive = t.key === activeTab;
    const indicator = el("span", { class: "nav-indicator sl" }, iconNode(isActive ? t.icon : t.iconOutlined));
    main.append(el("button", {
      class: "nav-item" + (isActive ? " is-active" : ""),
      onclick: () => go("/home", { tab: t.key }),
    }, indicator, el("span", { class: "label" }, t.label)));
  }
  $navRail.append(main);
}
renderNavRail("popular");

// ====== Home dispatch ======
async function renderHome(params) {
  const tab = (params && params.tab) || "popular";
  $app.innerHTML = "";
  renderNavRail(tab);
  window.scrollTo(0, 0);
  if (tab === "timeline") renderTabTimeline($app);
  else if (tab === "collect") renderTabCollect($app);
  else if (tab === "my") renderTabMy($app);
  else renderTabPopular($app);
}

// ============================================================
// 推荐（popular_page.dart）
// ============================================================
const POPULAR_TAGS = ["日常", "原创", "校园", "搞笑", "奇幻", "百合", "恋爱", "悬疑", "热血", "后宫", "机战"];
const POPULAR_STATE = { tag: "", items: [], loading: false, exhausted: false, epoch: 0 };

function buildPosterCard(item) {
  return el("div", { class: "poster-card sl", onclick: () => go("/bangumi", { id: String(item.id) }) },
    coverImg(bestBangumiImage(item.images)),
    el("div", { class: "name" }, item.nameCn || item.name));
}

async function renderTabPopular(container) {
  // tab 重入：作废在途请求（epoch 失配即丢弃），并复位可能残留的 loading
  POPULAR_STATE.epoch++;
  POPULAR_STATE.loading = false;
  const titleBtn = el("button", { class: "title-btn sl", type: "button" },
    el("span", { class: "text" }, POPULAR_STATE.tag || "热门番组"), iconSvg("expand_more"));
  titleBtn.addEventListener("click", () => openTagPicker(container));
  const bar = appBar({
    large: true,
    titleNode: titleBtn,
    actions: [
      isPortrait() ? iconBtn("search", { label: "搜索", onclick: () => go("/search") }) : null,
      iconBtn("history", { label: "历史记录", onclick: () => go("/my/history") }),
    ],
  });
  const page = el("div", { class: "page" });
  const progress = el("div", { class: "progress-line" });
  progress.style.visibility = "hidden";
  const grid = el("div", { class: "poster-grid" });
  const status = el("div", {});
  page.append(progress, grid, status);
  container.append(bar, page);
  collapsible(bar);

  const topFab = el("button", { class: "fab sl is-hidden", "aria-label": "返回顶部" });
  topFab.innerHTML = ICONS.arrow_upward;
  topFab.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  page.append(topFab);
  const onScrollFab = () => topFab.classList.toggle("is-hidden", window.scrollY < 400);
  window.addEventListener("scroll", onScrollFab, { passive: true });
  const fabObs = new MutationObserver(() => {
    if (!topFab.isConnected) { window.removeEventListener("scroll", onScrollFab); fabObs.disconnect(); }
  });
  fabObs.observe($app, { childList: true });

  // 增量渲染：翻页只追加新卡片，不重建网格（重建会让正在点击的卡片失效）
  let rendered = 0;
  function renderItems() {
    status.innerHTML = "";
    progress.style.visibility = POPULAR_STATE.loading && POPULAR_STATE.items.length ? "visible" : "hidden";
    if (POPULAR_STATE.loading && !POPULAR_STATE.items.length) {
      status.append(loadingNode("正在加载番剧"));
      return;
    }
    if (!POPULAR_STATE.items.length) {
      status.append(emptyState({
        icon: "label",
        title: POPULAR_STATE.tag ? "没有这个标签的番剧" : "暂无趋势数据",
        actions: [button("重新加载", { icon: "refresh", onclick: () => loadMore(true) })],
      }));
      return;
    }
    for (; rendered < POPULAR_STATE.items.length; rendered++) grid.append(buildPosterCard(POPULAR_STATE.items[rendered]));
  }

  async function loadMore(reset) {
    if (POPULAR_STATE.loading) return;
    if (reset) {
      POPULAR_STATE.items = [];
      POPULAR_STATE.exhausted = false;
      grid.innerHTML = "";
      rendered = 0;
    }
    if (POPULAR_STATE.exhausted) return;
    POPULAR_STATE.loading = true;
    const myEpoch = POPULAR_STATE.epoch;
    renderItems();
    try {
      const url = POPULAR_STATE.tag
        ? "/api/popular?tag=" + encodeURIComponent(POPULAR_STATE.tag)
        : "/api/popular?offset=" + POPULAR_STATE.items.length;
      const data = await fetchJson(url);
      if (POPULAR_STATE.epoch !== myEpoch) return;
      const items = data.items || [];
      POPULAR_STATE.items = POPULAR_STATE.items.concat(items);
      // tag 模式后端是一次性返回（rank 随机），不再续翻
      if (POPULAR_STATE.tag || !items.length) POPULAR_STATE.exhausted = true;
    } catch (e) {
      if (POPULAR_STATE.epoch !== myEpoch) return;
      if (!POPULAR_STATE.items.length) {
        POPULAR_STATE.loading = false;
        grid.innerHTML = "";
        status.innerHTML = "";
        status.append(errorState({ title: "暂时无法加载番剧", message: e.message, onRetry: () => loadMore(true) }));
        return;
      }
    } finally {
      if (POPULAR_STATE.epoch === myEpoch) POPULAR_STATE.loading = false;
    }
    renderItems();
    // 首屏没填满就不会有 scroll 事件，主动再拉一页
    if (grid.isConnected && !POPULAR_STATE.exhausted &&
        document.documentElement.scrollHeight <= window.innerHeight + 240) {
      loadMore(false);
    }
  }

  onScrollBottom(grid, () => loadMore(false));
  await loadMore(true);
}

// 推荐页的 tag 选择（标题 dropdown）
function openTagPicker(container) {
  const all = [{ key: "", label: "热门番组" }].concat(POPULAR_TAGS.map((t) => ({ key: t, label: t })));
  openSheet({ title: "选择分类", compact: true }, (body, close) => {
    body.append(splitList(all.map((t) => splitRow(
      tile({ icon: t.key ? "label" : "fire", title: t.label, trailing: t.key === POPULAR_STATE.tag ? iconSvg("check_circle") : null }),
      {
        onclick: () => {
          close();
          if (t.key === POPULAR_STATE.tag) return;
          POPULAR_STATE.tag = t.key;
          container.innerHTML = "";
          renderTabPopular(container);
        },
      }))));
  });
}

// ============================================================
// 时间表（timeline_page.dart）
// ============================================================
const TIMELINE_STATE = {
  selectedDate: new Date(),
  seasonString: "",
  days: [[], [], [], [], [], [], []],
  activeWeekday: ((new Date().getDay() + 6) % 7) + 1, // 1..7 (一..日)
  sortType: parseInt(localStorage.getItem("timelineSortType") || "3", 10),
  filterAbandoned: localStorage.getItem("timelineFilterAbandoned") === "1",
  filterWatched: localStorage.getItem("timelineFilterWatched") === "1",
  filterOnlyWatching: localStorage.getItem("timelineFilterWatching") === "1",
  isLoading: false,
  isError: false,
  collectIds: { watching: new Set(), watched: new Set(), abandoned: new Set() },
};
const SEASON_LABELS = ["冬季", "春季", "夏季", "秋季"];
const SEASON_MONTHS = ["1 — 3 月", "4 — 6 月", "7 — 9 月", "10 — 12 月"];
function seasonQuarter(date) {
  const m = date.getMonth() + 1;
  return m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
}
function seasonOf(date) {
  return date.getFullYear() + "年" + SEASON_LABELS[seasonQuarter(date) - 1];
}
function seasonKey(date) { return date.getFullYear() + "-" + seasonQuarter(date); }
function isSameSeasonDate(d1, d2) { return seasonKey(d1) === seasonKey(d2); }
function sortTypeLabel(t) {
  if (t === 1) return "默认顺序";
  if (t === 2) return "评分优先";
  return "热度优先";
}
function sortDayList(list, sortType) {
  const arr = list.slice();
  if (sortType === 1) arr.sort((a, b) => a.id - b.id);
  else if (sortType === 2) arr.sort((a, b) => (b.ratingScore || 0) - (a.ratingScore || 0));
  else arr.sort((a, b) => (b.votes || 0) - (a.votes || 0));
  return arr;
}
function filterTimelineDay(list) {
  const s = TIMELINE_STATE;
  let arr = list;
  if (s.filterAbandoned) arr = arr.filter((it) => !s.collectIds.abandoned.has(it.id));
  if (s.filterWatched) arr = arr.filter((it) => !s.collectIds.watched.has(it.id));
  if (s.filterOnlyWatching) arr = arr.filter((it) => s.collectIds.watching.has(it.id));
  return arr;
}
function timelineFilterCount() {
  const s = TIMELINE_STATE;
  return [s.filterAbandoned, s.filterWatched, s.filterOnlyWatching].filter(Boolean).length;
}
async function loadCollectIdsForTimeline() {
  try {
    const data = await fetchJson("/api/collect/list");
    const watching = new Set(), watched = new Set(), abandoned = new Set();
    for (const it of data.items || []) {
      if (it.type === 1) watching.add(it.bangumiId);
      else if (it.type === 4) watched.add(it.bangumiId);
      else if (it.type === 5) abandoned.add(it.bangumiId);
    }
    TIMELINE_STATE.collectIds = { watching, watched, abandoned };
  } catch (_) {
    // 静默：收藏数据不可用不应阻塞时间表渲染
  }
}
async function fetchTimelineData(seasonParam) {
  TIMELINE_STATE.isLoading = true;
  TIMELINE_STATE.isError = false;
  try {
    const url = seasonParam ? "/api/timeline?season=" + encodeURIComponent(seasonParam) : "/api/timeline";
    const data = await fetchJson(url);
    const days = data.days || [];
    TIMELINE_STATE.days = days.length === 7 ? days : [[], [], [], [], [], [], []];
    TIMELINE_STATE.isError = TIMELINE_STATE.days.every((d) => !d.length);
  } catch (_) {
    TIMELINE_STATE.days = [[], [], [], [], [], [], []];
    TIMELINE_STATE.isError = true;
  } finally {
    TIMELINE_STATE.isLoading = false;
  }
}

async function renderTabTimeline(container) {
  if (!TIMELINE_STATE.seasonString) {
    TIMELINE_STATE.selectedDate = new Date();
    TIMELINE_STATE.seasonString = seasonOf(TIMELINE_STATE.selectedDate);
    TIMELINE_STATE.activeWeekday = ((new Date().getDay() + 6) % 7) + 1;
  }
  const narrowPortrait = isCompactWidth() && isPortrait();

  // AppBar：窄竖屏标题就是季节选择；否则"时间表" + 页内季节头
  const seasonTitleBtn = el("button", { class: "title-btn sl", type: "button", style: "font-size:16px;font-weight:700;" },
    el("span", { class: "text" }, TIMELINE_STATE.seasonString), iconSvg("expand_more"));
  seasonTitleBtn.addEventListener("click", () => openSeasonPicker(redraw));
  const optionsBtn = button(sortTypeLabel(TIMELINE_STATE.sortType), { icon: "tune", cls: "has-badge", onclick: () => openTimelineOptions(redraw) });
  const optionsIconBtn = iconBtn("tune", { label: "排序与筛选", onclick: () => openTimelineOptions(redraw) });
  const bar = appBar({
    titleNode: narrowPortrait ? seasonTitleBtn : document.createTextNode("时间表"),
    actions: [narrowPortrait ? optionsIconBtn : optionsBtn],
  });
  const page = el("div", { class: "page timeline" });
  container.append(bar, page);

  const seasonHead = el("div", {});
  const weekBar = el("div", { class: "week-bar" });
  const tabs = el("div", { class: "week-tabs" });
  weekBar.append(tabs);
  const grid = el("div", { class: "timeline-grid" });
  const status = el("div", {});
  page.append(seasonHead, weekBar, grid, status);

  const dayLabels = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const todayWeekday = ((new Date().getDay() + 6) % 7) + 1;

  function buildSeasonHead() {
    seasonHead.innerHTML = "";
    if (narrowPortrait) return;
    const expand = el("button", { class: "season-expand sl", type: "button", "aria-label": "切换季度" });
    expand.innerHTML = ICONS.expand_more;
    expand.addEventListener("click", () => openSeasonPicker(redraw));
    seasonHead.append(
      el("div", { class: "season-head" }, el("div", { class: "season-name" }, TIMELINE_STATE.seasonString), expand),
      el("div", { class: "season-sub" }, SEASON_MONTHS[seasonQuarter(TIMELINE_STATE.selectedDate) - 1] + " · 每周放送"));
  }
  function buildTabs() {
    tabs.innerHTML = "";
    const viewingCurrent = isSameSeasonDate(TIMELINE_STATE.selectedDate, new Date());
    for (let i = 1; i <= 7; i++) {
      const count = filterTimelineDay(TIMELINE_STATE.days[i - 1] || []).length;
      const label = viewingCurrent && i === todayWeekday ? "今天" : dayLabels[i];
      tabs.append(el("button", {
        class: "week-tab" + (i === TIMELINE_STATE.activeWeekday ? " is-active" : ""),
        type: "button",
        onclick: () => { TIMELINE_STATE.activeWeekday = i; redraw(); },
      }, el("span", {}, label), el("span", { class: "count" }, String(count))));
    }
  }
  function redrawGrid() {
    grid.innerHTML = "";
    status.innerHTML = "";
    if (TIMELINE_STATE.isLoading) { status.append(loadingNode("正在加载时间表")); return; }
    if (TIMELINE_STATE.isError) {
      status.append(errorState({ title: "暂时无法加载时间表", message: "请检查网络后重试", onRetry: () => reload(true) }));
      return;
    }
    const day = TIMELINE_STATE.days[TIMELINE_STATE.activeWeekday - 1] || [];
    const list = filterTimelineDay(sortDayList(day, TIMELINE_STATE.sortType));
    if (!list.length) {
      if (day.length && timelineFilterCount()) {
        status.append(emptyState({
          icon: "filter_alt_off", title: "没有符合筛选的番剧",
          actions: [button("清除筛选", { onclick: () => {
            TIMELINE_STATE.filterAbandoned = TIMELINE_STATE.filterWatched = TIMELINE_STATE.filterOnlyWatching = false;
            localStorage.setItem("timelineFilterAbandoned", "0");
            localStorage.setItem("timelineFilterWatched", "0");
            localStorage.setItem("timelineFilterWatching", "0");
            redraw();
          } })],
        }));
      } else {
        status.append(emptyState({ icon: "event_available", title: "这一天暂无放送" }));
      }
      return;
    }
    for (const item of list) grid.append(buildTimelineCard(item));
  }
  function redraw() {
    seasonTitleBtn.querySelector(".text").textContent = TIMELINE_STATE.seasonString;
    optionsBtn.querySelector(".label").textContent = sortTypeLabel(TIMELINE_STATE.sortType);
    const n = timelineFilterCount();
    const old = optionsBtn.querySelector(".badge");
    if (old) old.remove();
    if (n) optionsBtn.append(el("span", { class: "badge" }, String(n)));
    buildSeasonHead();
    buildTabs();
    redrawGrid();
  }
  async function reload(force) {
    const allEmpty = TIMELINE_STATE.days.every((d) => !d.length);
    if (!force && (!allEmpty || TIMELINE_STATE.isError)) return;
    TIMELINE_STATE.isLoading = true;
    TIMELINE_STATE.isError = false;
    redraw();
    const isCurrent = isSameSeasonDate(TIMELINE_STATE.selectedDate, new Date());
    await Promise.all([
      fetchTimelineData(isCurrent ? null : seasonKey(TIMELINE_STATE.selectedDate)),
      loadCollectIdsForTimeline(),
    ]);
    redraw();
  }

  redraw();
  await reload(false);
}

// BangumiTimelineCard：横向布局，封面 88 宽，评分药丸，在看书签
function buildTimelineCard(item) {
  const title = item.nameCn || item.name;
  const epMatch = /^\s*([1-9]\d*)\s*[话話集]/.exec(item.info || "");
  const tags = (item.tags || []).map((t) => (t.name || "").trim()).filter(Boolean);
  const metadata = [];
  if (epMatch) metadata.push(epMatch[1] + " 话");
  for (const t of tags) if (!metadata.includes(t)) metadata.push(t);
  let meta = metadata.slice(0, 3).join(" · ");
  if (!meta && item.name && item.name !== title) meta = item.name;

  const foot = el("div", { class: "tl-foot" }, ratingPill(item.ratingScore || 0));
  if (TIMELINE_STATE.collectIds.watching.has(item.id)) {
    const bm = el("span", { class: "bookmark", style: "display:inline-flex" });
    bm.innerHTML = ICONS.bookmark;
    foot.append(bm);
  }
  return el("div", { class: "tl-card sl", onclick: () => go("/bangumi", { id: String(item.id) }) },
    coverImg(bestBangumiImage(item.images), "cover"),
    el("div", { class: "tl-body" },
      el("div", { class: "tl-title" }, title),
      meta ? el("div", { class: "tl-meta" }, meta) : null,
      foot));
}

// 季节选择 sheet：按年分组的 ContentSection，每年 4 季
function openSeasonPicker(onChange) {
  openSheet({ title: "选择放送季" }, (body, close) => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentQuarter = seasonQuarter(now);
    const selYear = TIMELINE_STATE.selectedDate.getFullYear();
    const selQuarter = seasonQuarter(TIMELINE_STATE.selectedDate);
    for (let offset = 0; offset < 20; offset++) {
      const year = currentYear - offset;
      const grid = el("div", { class: "season-grid" });
      for (let q = 1; q <= 4; q++) {
        const available = year < currentYear || q <= currentQuarter;
        if (!available) continue;
        const isSel = year === selYear && q === selQuarter;
        grid.append(el("button", {
          class: "season-opt sl" + (isSel ? " is-selected" : ""), type: "button",
          onclick: async () => {
            close();
            if (isSel) return;
            const newDate = new Date(year, (q - 1) * 3, 1);
            TIMELINE_STATE.selectedDate = newDate;
            TIMELINE_STATE.seasonString = seasonOf(newDate);
            TIMELINE_STATE.days = [[], [], [], [], [], [], []];
            TIMELINE_STATE.isLoading = true;
            TIMELINE_STATE.isError = false;
            onChange && onChange();
            await fetchTimelineData(isSameSeasonDate(newDate, new Date()) ? null : seasonKey(newDate));
            onChange && onChange();
          },
        }, SEASON_LABELS[q - 1]));
      }
      body.append(section({ title: year + " 年", body: grid }));
    }
  });
}

// 排序与筛选 sheet：ChoiceChip 排序 + SwitchListTile 分组
function openTimelineOptions(onChange) {
  openSheet({ title: "排序与筛选", desc: "结果会立即应用到当前时间线" }, (body) => {
    const sortOptions = [
      { type: 3, label: "热度优先" },
      { type: 2, label: "评分优先" },
      { type: 1, label: "默认顺序" },
    ];
    const chips = el("div", { class: "chips" });
    const renderChips = () => {
      chips.innerHTML = "";
      for (const opt of sortOptions) {
        const sel = TIMELINE_STATE.sortType === opt.type;
        chips.append(el("button", {
          class: "chip sl" + (sel ? " is-selected" : ""), type: "button",
          onclick: () => {
            TIMELINE_STATE.sortType = opt.type;
            localStorage.setItem("timelineSortType", String(opt.type));
            renderChips();
            onChange && onChange();
          },
        }, sel ? iconSvg("done") : null, opt.label));
      }
    };
    renderChips();
    body.append(section({ title: "排序方式", body: chips }));

    const filters = [
      { key: "filterAbandoned", icon: "heart_broken", title: "隐藏已抛弃", desc: "不显示标记为抛弃的番剧", storeKey: "timelineFilterAbandoned" },
      { key: "filterWatched", icon: "task_alt", title: "隐藏已看过", desc: "不显示标记为看过的番剧", storeKey: "timelineFilterWatched" },
      { key: "filterOnlyWatching", icon: "live_tv", title: "只看在追", desc: "只显示正在追的番剧", storeKey: "timelineFilterWatching" },
    ];
    body.append(section({
      title: "显示范围",
      rows: filters.map((f) => splitRow(switchTile({
        icon: f.icon, title: f.title, desc: f.desc, checked: TIMELINE_STATE[f.key],
        onChange: (v) => {
          TIMELINE_STATE[f.key] = v;
          localStorage.setItem(f.storeKey, v ? "1" : "0");
          onChange && onChange();
        },
      }))),
    }));
  });
}

// ============================================================
// 追番（collect_page.dart / collect_library_*.dart）
// ============================================================
const COLLECT_TABS = [
  { type: 0, label: "全部" }, { type: 1, label: "在看" }, { type: 2, label: "想看" },
  { type: 4, label: "看过" }, { type: 3, label: "搁置" }, { type: 5, label: "抛弃" },
];
function collectLabel(type) { return collectTypeOf(type).label; }

async function renderTabCollect(container) {
  const bar = appBar({ title: "追番" });
  const page = el("div", { class: "page collect" });
  container.append(bar, page);

  let activeType = parseInt(localStorage.getItem("collectActiveType") || "1", 10);
  if (!COLLECT_TABS.some((t) => t.type === activeType)) activeType = 0;
  let layout = localStorage.getItem("collectLayout") || "list";
  let keyword = "";
  let items = null;
  let sortKey = "recentlyChanged";
  const titleOf = (c) => ((c.bangumi || {}).nameCn || (c.bangumi || {}).name || "").toLowerCase();
  const SORTS = {
    recentlyChanged: (a, b) => (b.time || 0) - (a.time || 0),
    title: (a, b) => titleOf(a).localeCompare(titleOf(b)),
    rating: (a, b) => ((b.bangumi || {}).ratingScore || 0) - ((a.bangumi || {}).ratingScore || 0),
    airDate: (a, b) => (Date.parse((b.bangumi || {}).airDate) || 0) - (Date.parse((a.bangumi || {}).airDate) || 0),
  };
  const SORT_LABELS = { recentlyChanged: "最近变更", title: "番剧名称", rating: "评分最高", airDate: "开播时间" };

  const tabsNode = el("div", { class: "cat-tabs", role: "tablist" });
  const countNode = el("div", { class: "collect-count" });
  const head = el("div", { class: "collect-head" }, tabsNode, countNode);

  const input = el("input", { type: "search", placeholder: "搜索收藏", autocomplete: "off" });
  input.addEventListener("input", () => { keyword = input.value.trim().toLowerCase(); renderBody(); });
  const searchBox = el("div", { class: "search-box" }, iconSvg("search"), input);
  const segList = el("button", { class: "seg-btn sl", type: "button", "aria-label": "列表视图", html: ICONS.view_list });
  const segGrid = el("button", { class: "seg-btn sl", type: "button", "aria-label": "卡片视图", html: ICONS.grid_view });
  const setLayout = (v) => {
    layout = v;
    localStorage.setItem("collectLayout", v);
    segGrid.classList.toggle("is-active", v === "grid");
    segList.classList.toggle("is-active", v === "list");
    renderBody();
  };
  segGrid.addEventListener("click", () => setLayout("grid"));
  segList.addEventListener("click", () => setLayout("list"));
  segGrid.classList.toggle("is-active", layout === "grid");
  segList.classList.toggle("is-active", layout === "list");
  const sortBtn = isCompactWidth()
    ? iconBtn("sort", { label: "排序" })
    : button(SORT_LABELS[sortKey], { variant: "text", icon: "sort", cls: "c-variant" });
  sortBtn.addEventListener("click", () => openMenu(sortBtn, Object.keys(SORTS).map((k) => ({
    label: SORT_LABELS[k], selected: k === sortKey,
    onclick: () => { sortKey = k; const l = sortBtn.querySelector(".label"); if (l) l.textContent = SORT_LABELS[k]; renderBody(); },
  }))));
  const controls = el("div", { class: "collect-controls" }, searchBox, sortBtn, el("div", { class: "seg-toggle" }, segGrid, segList));

  const bodyNode = el("div", {});
  page.append(head, controls, bodyNode);

  function visible() {
    let arr = activeType ? items.filter((c) => c.type === activeType) : items;
    if (keyword) {
      // 多个空白分隔的词都要命中（nameCn / name / alias 拼接后匹配）
      const words = keyword.split(/\s+/).filter(Boolean);
      arr = arr.filter((c) => {
        const b = c.bangumi || {};
        const hay = [b.nameCn, b.name].concat(b.alias || []).join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const tie = (a, b) => ((b.time || 0) - (a.time || 0)) || ((a.bangumiId || 0) - (b.bangumiId || 0));
    return arr.slice().sort((a, b) => SORTS[sortKey](a, b) || tie(a, b));
  }
  function renderTabs() {
    tabsNode.innerHTML = "";
    for (const t of COLLECT_TABS) {
      tabsNode.append(el("button", {
        class: "cat-tab" + (t.type === activeType ? " is-active" : ""), type: "button", role: "tab",
        onclick: () => {
          activeType = t.type;
          localStorage.setItem("collectActiveType", String(t.type));
          renderTabs();
          renderBody();
        },
      }, t.label));
    }
  }
  async function changeStatus(c, type) {
    try {
      const saved = await putCollect(c.bangumiId, type);
      if (saved) c.type = saved;
      else items = items.filter((x) => x !== c);
      renderBody();
      toast(saved ? "已标记为「" + collectLabel(saved) + "」" : "已取消收藏");
    } catch (e) {
      toast("保存失败：" + e.message);
    }
  }
  function metaText(c, parts) {
    return parts.filter(Boolean).join("  ·  ");
  }
  function buildListRow(c) {
    const b = c.bangumi || {};
    const statusBtn = button(collectLabel(c.type), { small: true, trailingIcon: "expand_more" });
    statusBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openCollectMenu(statusBtn, c.type, (type) => changeStatus(c, type));
    });
    const year = yearOf(b.airDate);
    return el("div", { class: "collect-row sl", onclick: () => go("/bangumi", { id: String(c.bangumiId) }) },
      coverImg(bestBangumiImage(b.images), "cover"),
      el("div", { class: "body" },
        el("div", { class: "title" }, b.nameCn || b.name),
        el("div", { class: "meta" }, metaText(c, [year ? year + " 年" : "", b.ratingScore > 0 ? b.ratingScore.toFixed(1) + " 分" : ""]) || "暂无评分"),
        el("div", { class: "foot" }, statusBtn)));
  }
  function buildPoster(c) {
    const b = c.bangumi || {};
    const more = iconBtn("more_horiz", { label: "更多" });
    more.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openCollectMenu(more, c.type, (type) => changeStatus(c, type));
    });
    const metaParts = [b.ratingScore > 0 ? b.ratingScore.toFixed(1) + " 分" : ""];
    if (!activeType) metaParts.push(collectLabel(c.type));
    return el("div", { class: "collect-card sl", onclick: () => go("/bangumi", { id: String(c.bangumiId) }) },
      coverImg(bestBangumiImage(b.images)),
      el("div", { class: "foot" },
        el("div", { class: "text" },
          el("div", { class: "title" }, b.nameCn || b.name),
          el("div", { class: "meta" }, metaParts.filter(Boolean).join(" · "))),
        more));
  }
  function renderBody() {
    bodyNode.innerHTML = "";
    if (!items) return;
    const list = visible();
    countNode.textContent = list.length + " 部";
    if (!list.length) {
      const emptyTitles = { 0: "还没有收藏的番剧", 1: "还没有在追的番剧", 2: "还没有想看的番剧", 4: "还没有看过的番剧", 3: "没有搁置的番剧", 5: "没有弃追的番剧" };
      bodyNode.append(emptyState({
        icon: keyword ? "search_off" : "live_tv",
        title: keyword ? (activeType ? "当前分类没有匹配的番剧" : "没有找到匹配的番剧") : emptyTitles[activeType],
        actions: keyword ? [] : [button("去推荐页看看", { icon: "home_outlined", onclick: () => go("/home", { tab: "popular" }) })],
      }));
      return;
    }
    const grid = el("div", { class: layout === "grid" ? "collect-grid" : "collect-list" });
    for (const c of list) grid.append(layout === "grid" ? buildPoster(c) : buildListRow(c));
    bodyNode.append(grid);
  }

  renderTabs();
  bodyNode.append(loadingNode("正在加载收藏"));
  try {
    const data = await fetchJson("/api/collect/list");
    items = (data.items || []).filter((c) => c.bangumi);
    renderBody();
  } catch (e) {
    bodyNode.innerHTML = "";
    bodyNode.append(errorState({ title: "暂时无法加载收藏", message: e.message, onRetry: () => { container.innerHTML = ""; renderTabCollect(container); } }));
  }
}

// ============================================================
// 搜索（search_page.dart / search_filter_sheet.dart / search_parser.dart）
// 关键词 + 条件（题材 / 放送时间 / 评分排名 / 星期）由服务端拼成 bgm.tv 请求；
// 排序在服务端；"隐藏看过/抛弃"只在客户端过滤。
// ============================================================
const SEARCH_DEFAULT_TAGS = ["日常", "原创", "校园", "搞笑", "奇幻", "百合", "恋爱", "悬疑", "热血", "后宫", "机战", "轻改", "偶像", "治愈", "异世界"];
const SEARCH_SORTS = { heat: "热度", rank: "排名", score: "评分", match: "匹配" };
const SEARCH_SORT_MENU = { heat: "按热度排序", rank: "按排名排序", score: "按评分排序", match: "按匹配排序" };
const WEEKDAY_NAMES = "一二三四五六日";
function defaultSearchFilter(keyword) {
  return { keyword: keyword || "", tags: [], sort: "heat", season: "", dateRange: null, rankRange: null, scoreRange: null, weekdays: [] };
}
function cloneFilter(f) { return JSON.parse(JSON.stringify(f)); }
const rangeValid = (r) => !!r && (r.min != null || r.max != null);
function fmtDate(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function seasonOptions() {
  const now = new Date();
  const out = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 19; y--) {
    for (let q = 4; q >= 1; q--) {
      if (now > new Date(y, (q - 1) * 3, 1)) out.push({ value: y + "Q" + q, label: y + " " + SEASON_LABELS[q - 1] });
    }
  }
  return out;
}
// 季度 → 日期窗口：向前偏移一个月覆盖提前开播的番（SearchParser.seasonToDateRange）
function seasonToDateRange(season) {
  const m = /^(\d{4})Q([1-4])$/i.exec(season || "");
  if (!m) return null;
  const y = +m[1], start0 = (+m[2] - 1) * 3;
  return { start: fmtDate(new Date(y, start0 - 1, 1)), end: fmtDate(new Date(y, start0 + 2, 1)) };
}
function effectiveDateRange(f) {
  if (f.dateRange && f.dateRange.start && f.dateRange.end) return f.dateRange;
  return f.season ? seasonToDateRange(f.season) : null;
}
function hasAdvancedFilters(f) {
  return !!(f.tags.length || f.sort !== "heat" || f.season || f.dateRange || rangeValid(f.rankRange) || rangeValid(f.scoreRange) || f.weekdays.length);
}
function rangeToken(r, isDouble) {
  const fv = (v) => v == null ? "" : isDouble ? Number(v).toFixed(1).replace(/\.0$/, "") : String(v);
  return fv(r.min) + ".." + fv(r.max);
}
function filterSummary(f) {
  const parts = [...f.tags];
  if (f.season) parts.push(f.season);
  else if (f.dateRange) parts.push(f.dateRange.start + " 至 " + f.dateRange.end);
  if (rangeValid(f.scoreRange)) parts.push("评分 " + rangeToken(f.scoreRange, true));
  if (rangeValid(f.rankRange)) parts.push("排名 " + rangeToken(f.rankRange));
  if (f.weekdays.length) parts.push("周" + f.weekdays.map((d) => WEEKDAY_NAMES[d - 1]).join("、"));
  return parts.join(" · ");
}
function searchQueryUrl(f, offset) {
  const q = new URLSearchParams();
  q.set("keyword", f.keyword || "");
  q.set("offset", String(offset));
  q.set("sort", f.sort || "heat");
  for (const t of f.tags) q.append("tag", t);
  const dr = effectiveDateRange(f);
  if (dr) q.set("airDate", dr.start + ".." + dr.end);
  if (rangeValid(f.rankRange)) q.set("rank", rangeToken(f.rankRange));
  if (rangeValid(f.scoreRange)) q.set("score", rangeToken(f.scoreRange, true));
  if (f.weekdays.length) q.set("weekday", f.weekdays.join(","));
  return "/api/bangumi/search?" + q.toString();
}

const SEARCH_PAGE_SIZE = 20;
const SEARCH_STATE = {
  filter: defaultSearchFilter(""),
  submitted: null,     // 已提交的筛选；null = 未搜索
  items: [], offset: 0, hasMore: false, loading: false, error: "", generation: 0,
  hideWatched: localStorage.getItem("searchHideWatched") === "1",
  hideAbandoned: localStorage.getItem("searchHideAbandoned") === "1",
  watchedIds: new Set(),
  abandonedIds: new Set(),
};
function filterSearchResults(items) {
  let arr = items;
  if (SEARCH_STATE.hideWatched) arr = arr.filter((it) => !SEARCH_STATE.watchedIds.has(it.id));
  if (SEARCH_STATE.hideAbandoned) arr = arr.filter((it) => !SEARCH_STATE.abandonedIds.has(it.id));
  return arr;
}
function loadSearchHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem("searchHistory") || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
function saveSearchHistory(arr) {
  try { localStorage.setItem("searchHistory", JSON.stringify(arr)); } catch (_) {}
}
function pushSearchHistory(keyword) {
  const kw = (keyword || "").trim();
  if (!kw) return;
  let arr = loadSearchHistory().filter((x) => x !== kw);
  arr.unshift(kw);
  if (arr.length > 10) arr.length = 10;
  saveSearchHistory(arr);
}
async function loadCollectIdsForSearch() {
  try {
    const data = await fetchJson("/api/collect/list");
    const watched = new Set(), abandoned = new Set();
    for (const it of data.items || []) {
      if (it.type === 4) watched.add(it.bangumiId);
      else if (it.type === 5) abandoned.add(it.bangumiId);
    }
    SEARCH_STATE.watchedIds = watched;
    SEARCH_STATE.abandonedIds = abandoned;
  } catch (_) {}
}

function buildResultCard(item) {
  const meta = el("div", { class: "meta" });
  if (item.ratingScore > 0) {
    const score = el("span", { class: "score" });
    score.innerHTML = ICONS.star;
    score.append(el("span", {}, item.ratingScore.toFixed(1)));
    meta.append(score);
  }
  const year = yearOf(item.airDate);
  if (year) meta.append(el("span", { class: "year" }, year));
  return el("div", { class: "result-card sl", onclick: () => go("/bangumi", { id: String(item.id) }) },
    coverImg(bestBangumiImage(item.images)),
    el("div", { class: "title" }, item.nameCn || item.name),
    meta);
}

async function renderSearch(params) {
  $app.innerHTML = "";
  renderNavRail("");
  window.scrollTo(0, 0);
  const bar = appBar({ title: "番剧搜索", back: true, compact: true });
  const page = el("div", { class: "page search" });
  $app.append(bar, page);

  const input = el("input", { type: "search", placeholder: "搜索番剧名称", autocomplete: "off", autocorrect: "off", spellcheck: "false" });
  const clearBtn = iconBtn("close", { label: "清空搜索", onclick: () => {
    input.value = "";
    SEARCH_STATE.filter = defaultSearchFilter("");
    SEARCH_STATE.submitted = null;
    SEARCH_STATE.items = [];
    syncClear();
    renderIdle();
    input.focus();
  } });
  const syncClear = () => { clearBtn.style.visibility = input.value || SEARCH_STATE.submitted ? "visible" : "hidden"; };
  input.addEventListener("input", syncClear);
  const form = el("form", { class: "search-box is-high is-tall" },
    iconBtn("search", { label: "搜索", onclick: () => form.requestSubmit() }), input, clearBtn);
  const top = el("div", { class: "search-top" }, form);
  const bodyNode = el("div", {});
  page.append(top, bodyNode);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const kw = input.value.trim();
    const f = cloneFilter(SEARCH_STATE.submitted || SEARCH_STATE.filter);
    f.keyword = kw;
    if (!kw && !hasAdvancedFilters(f)) return;
    applyFilters(f);
  });

  function openFilters() {
    openSearchFilterSheet(cloneFilter(SEARCH_STATE.submitted || SEARCH_STATE.filter), (draft) => {
      draft.keyword = input.value.trim();
      if (!draft.keyword && !hasAdvancedFilters(draft)) {
        SEARCH_STATE.filter = draft;
        if (SEARCH_STATE.submitted) renderResults(); else renderIdle();
        return;
      }
      applyFilters(draft);
    });
  }

  // ---- 搜索前：按条件查找 + 最近搜索 ----
  function renderIdle() {
    page.classList.remove("has-results");
    bodyNode.innerHTML = "";
    bodyNode.append(splitRow(tile({ icon: "tune", title: "按条件查找", desc: "题材、放送时间与评分", chevron: true, onclick: openFilters }), { cls: "filter-entry" }));
    const arr = loadSearchHistory();
    if (!arr.length) return;
    const head = el("div", { class: "recent-head" }, el("span", {}, "最近搜索"),
      el("div", { class: "btns" }, button("清空", { variant: "text", small: true, onclick: () => { saveSearchHistory([]); renderIdle(); } })));
    const list = el("div", { class: "recent-list" });
    for (const kw of arr) {
      const fill = iconBtn("north_west", { label: "填入", cls: "remove", onclick: (ev) => { ev.stopPropagation(); input.value = kw; syncClear(); input.focus(); } });
      list.append(el("button", { class: "recent-item sl", type: "button", onclick: () => { input.value = kw; form.requestSubmit(); } },
        iconSvg("history"), el("span", { class: "text" }, kw), fill));
    }
    bodyNode.append(head, list);
  }

  // ---- 搜索后：结果头 + 摘要 + 网格 + 分页 ----
  let grid = null, footer = null, rendered = 0;
  function renderResults() {
    const S = SEARCH_STATE;
    const f = S.submitted;
    page.classList.add("has-results");
    bodyNode.innerHTML = "";
    rendered = 0;
    const shown = filterSearchResults(S.items);
    const hidden = S.items.length - shown.length;
    const sortBtn = button(SEARCH_SORTS[f.sort] || "热度", { variant: "text", small: true, trailingIcon: "expand_more" });
    sortBtn.addEventListener("click", () => openMenu(sortBtn, Object.keys(SEARCH_SORTS).map((k) => ({
      label: SEARCH_SORT_MENU[k], selected: k === f.sort, onclick: () => applyFilters(Object.assign(cloneFilter(f), { sort: k })),
    }))));
    const filterBtn = iconBtn("tune", { label: "筛选番剧", dot: hasAdvancedFilters(f) || S.hideWatched || S.hideAbandoned, onclick: openFilters });
    const summary = filterSummary(f);
    bodyNode.append(
      el("div", { class: "results-head" }, el("div", { class: "results-title" }, "搜索结果"), el("div", { class: "ctrls" }, sortBtn, filterBtn)),
      el("div", { class: "results-sub" }, S.loading && !S.items.length ? "正在搜索…" : shown.length + " 部番剧" + (hidden > 0 ? " · 隐藏 " + hidden + " 部" : "")),
      summary ? el("div", { class: "results-summary" }, summary) : null);
    if (S.loading && !S.items.length) { bodyNode.append(loadingNode("正在搜索番剧", "medium")); return; }
    if (S.error && !S.items.length) {
      bodyNode.append(errorState({ title: "搜索失败", message: S.error, onRetry: () => loadPage(true) }));
      return;
    }
    if (!S.items.length) { bodyNode.append(emptyState({ icon: "search_off", title: "没有找到番剧" })); return; }
    if (!shown.length) {
      bodyNode.append(emptyState({
        icon: "filter_alt_off", title: "这些番剧被筛选隐藏了",
        actions: [button("显示全部", { onclick: () => {
          S.hideWatched = S.hideAbandoned = false;
          localStorage.setItem("searchHideWatched", "0");
          localStorage.setItem("searchHideAbandoned", "0");
          renderResults();
        } })],
      }));
      return;
    }
    grid = el("div", { class: "results-grid" });
    for (const item of shown) grid.append(buildResultCard(item));
    rendered = S.items.length;
    footer = el("div", { class: "results-more" });
    bodyNode.append(grid, footer);
    renderFooter();
  }
  function renderFooter() {
    if (!footer) return;
    const S = SEARCH_STATE;
    footer.innerHTML = "";
    if (S.loading) footer.append(el("div", { class: "loader is-medium" }));
    else if (S.error) footer.append(button("重试", { variant: "text", icon: "refresh", onclick: () => loadPage(false) }));
    else if (S.hasMore) footer.append(button("加载更多", { variant: "text", onclick: () => loadPage(false) }));
    else footer.append(document.createTextNode("已经看到全部结果"));
  }
  function appendNew() {
    const S = SEARCH_STATE;
    if (!grid) { renderResults(); return; }
    const sub = bodyNode.querySelector(".results-sub");
    const shown = filterSearchResults(S.items);
    if (sub) sub.textContent = shown.length + " 部番剧" + (S.items.length - shown.length > 0 ? " · 隐藏 " + (S.items.length - shown.length) + " 部" : "");
    for (; rendered < S.items.length; rendered++) {
      const it = S.items[rendered];
      if (filterSearchResults([it]).length) grid.append(buildResultCard(it));
    }
    renderFooter();
  }

  // 分页：offset 按原始条数推进；去重后本页没有新条目时自动续拉，最多 3 页
  async function loadPage(reset) {
    const S = SEARCH_STATE;
    if (S.loading) return;
    if (reset) { S.items = []; S.offset = 0; S.hasMore = true; grid = null; }
    if (!S.hasMore) return;
    S.loading = true; S.error = "";
    const gen = S.generation;
    if (reset) renderResults(); else renderFooter();
    try {
      for (let pages = 0; pages < 3; pages++) {
        const data = await fetchJson(searchQueryUrl(S.submitted, S.offset));
        if (S.generation !== gen) return;
        const raw = data.items || [];
        const rawCount = typeof data.rawCount === "number" ? data.rawCount : raw.length;
        const known = new Set(S.items.map((x) => x.id));
        const fresh = raw.filter((x) => !known.has(x.id));
        S.items = S.items.concat(fresh);
        S.offset += rawCount;
        S.hasMore = rawCount === SEARCH_PAGE_SIZE;
        if (fresh.length || !S.hasMore) break;
      }
    } catch (e) {
      if (S.generation !== gen) return;
      S.error = e.message;
    } finally {
      if (S.generation === gen) S.loading = false;
    }
    if (reset || !grid) renderResults(); else appendNew();
  }
  function applyFilters(f) {
    const S = SEARCH_STATE;
    S.filter = f;
    S.submitted = cloneFilter(f);
    S.generation++;
    S.loading = false;
    input.value = f.keyword || "";
    syncClear();
    if (f.keyword) pushSearchHistory(f.keyword);
    loadPage(true);
  }
  onScrollBottom(bodyNode, () => { if (SEARCH_STATE.submitted && grid) loadPage(false); });
  loadCollectIdsForSearch().then(() => { if (SEARCH_STATE.submitted && !SEARCH_STATE.loading) renderResults(); });

  if (params && params.q) {
    const f = defaultSearchFilter(params.q);
    applyFilters(f);
  } else if (params && params.tag) {
    const f = defaultSearchFilter("");
    f.tags = [params.tag];
    applyFilters(f);
  } else if (SEARCH_STATE.submitted) {
    input.value = SEARCH_STATE.submitted.keyword || "";
    syncClear();
    renderResults();
  } else {
    syncClear();
    renderIdle();
    setTimeout(() => { try { input.focus(); } catch (_) {} }, 50);
  }
}

// 筛选 sheet（search_filter_sheet.dart）：排序 / 题材 / 放送时间 / 评分排名 / 收藏状态
function openSearchFilterSheet(initial, onApply) {
  const draft = cloneFilter(initial);
  let hideWatched = SEARCH_STATE.hideWatched, hideAbandoned = SEARCH_STATE.hideAbandoned;
  openSheet({ title: "筛选番剧" }, (body, close) => {
    const content = el("div", {});
    body.append(content);
    function render() {
      content.innerHTML = "";
      // 排序
      const sortChips = el("div", { class: "chips" });
      for (const k of Object.keys(SEARCH_SORTS)) {
        sortChips.append(filterChip(SEARCH_SORT_MENU[k], draft.sort === k, () => { draft.sort = k; render(); }));
      }
      content.append(section({ title: "排序方式", body: sortChips }));

      // 题材标签
      const tagChips = el("div", { class: "chips" });
      for (const t of [...new Set([...SEARCH_DEFAULT_TAGS, ...draft.tags])]) {
        const on = draft.tags.includes(t);
        tagChips.append(filterChip(t, on, () => { draft.tags = on ? draft.tags.filter((x) => x !== t) : draft.tags.concat(t); render(); }));
      }
      const tagInput = el("input", { class: "text-field", type: "text", placeholder: "自定义标签", autocomplete: "off" });
      const addTag = () => {
        const v = tagInput.value.trim();
        if (!v || draft.tags.includes(v)) return;
        draft.tags = draft.tags.concat(v);
        render();
      };
      tagInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addTag(); } });
      content.append(section({
        title: "题材标签", desc: draft.tags.length ? draft.tags.join("、") : "不限题材",
        body: el("div", {}, tagChips, el("div", { class: "field-row" }, tagInput, iconBtn("add", { label: "添加标签", cls: "is-tonal", onclick: addTag }))),
      }));

      // 放送时间
      const seasonSel = el("select", { class: "btn btn-surface season-select" });
      seasonSel.append(el("option", { value: "" }, "不限季度"));
      const opts = seasonOptions();
      if (draft.season && !opts.some((o) => o.value === draft.season)) opts.unshift({ value: draft.season, label: draft.season });
      for (const o of opts) {
        const opt = el("option", { value: o.value }, o.label);
        if (o.value === draft.season) opt.setAttribute("selected", "");
        seasonSel.append(opt);
      }
      seasonSel.addEventListener("change", () => { draft.season = seasonSel.value; draft.dateRange = null; render(); });
      const dr = draft.dateRange || { start: "", end: "" };
      const startIn = el("input", { class: "text-field", type: "date", value: dr.start });
      const endIn = el("input", { class: "text-field", type: "date", value: dr.end });
      const onDate = () => {
        if (startIn.value && endIn.value) { draft.dateRange = { start: startIn.value, end: endIn.value }; draft.season = ""; render(); }
      };
      startIn.addEventListener("change", onDate);
      endIn.addEventListener("change", onDate);
      const weekChips = el("div", { class: "chips" });
      for (let d = 1; d <= 7; d++) {
        const on = draft.weekdays.includes(d);
        weekChips.append(filterChip("周" + WEEKDAY_NAMES[d - 1], on, () => {
          draft.weekdays = (on ? draft.weekdays.filter((x) => x !== d) : draft.weekdays.concat(d)).sort((a, b) => a - b);
          render();
        }));
      }
      const dateDesc = (draft.season || (draft.dateRange ? draft.dateRange.start + " 至 " + draft.dateRange.end : "不限日期")) +
        (draft.weekdays.length ? " · 已选 " + draft.weekdays.length + " 天" : "");
      content.append(section({
        title: "放送时间", desc: dateDesc,
        body: el("div", {},
          el("div", { class: "field-row" }, seasonSel,
            draft.season || draft.dateRange ? button("清除日期", { variant: "text", small: true, onclick: () => { draft.season = ""; draft.dateRange = null; render(); } }) : null),
          el("div", { class: "field-label" }, "自定义日期"),
          el("div", { class: "field-row" }, startIn, el("span", { class: "c-variant" }, "至"), endIn),
          el("div", { class: "field-label" }, "放送星期"),
          weekChips),
      }));

      // 评分与排名
      const scoreOn = rangeValid(draft.scoreRange), rankOn = rangeValid(draft.rankRange);
      const rows = [
        splitRow(switchTile({ title: "限定评分", checked: scoreOn, onChange: (v) => { draft.scoreRange = v ? { min: 7, max: 10 } : null; render(); } })),
      ];
      if (scoreOn) {
        rows.push(splitRow(sliderTile({ label: "最低评分", min: 0, max: 10, step: 0.5, value: draft.scoreRange.min ?? 0, format: (v) => v.toFixed(1),
          onInput: (v) => { draft.scoreRange.min = Math.min(v, draft.scoreRange.max ?? 10); } })));
        rows.push(splitRow(sliderTile({ label: "最高评分", min: 0, max: 10, step: 0.5, value: draft.scoreRange.max ?? 10, format: (v) => v.toFixed(1),
          onInput: (v) => { draft.scoreRange.max = Math.max(v, draft.scoreRange.min ?? 0); } })));
      }
      rows.push(splitRow(switchTile({ title: "限定排名", checked: rankOn, onChange: (v) => { draft.rankRange = v ? { min: 1, max: 5000 } : null; render(); } })));
      if (rankOn) {
        rows.push(splitRow(sliderTile({ label: "最前排名", min: 1, max: 10000, step: 1, value: draft.rankRange.min ?? 1, format: (v) => "#" + v,
          onInput: (v) => { draft.rankRange.min = Math.min(v, draft.rankRange.max ?? 10000); } })));
        rows.push(splitRow(sliderTile({ label: "最后排名", min: 1, max: 10000, step: 1, value: draft.rankRange.max ?? 10000, format: (v) => "#" + v,
          onInput: (v) => { draft.rankRange.max = Math.max(v, draft.rankRange.min ?? 1); } })));
      }
      const srDesc = [scoreOn ? "评分 " + rangeToken(draft.scoreRange, true) : "", rankOn ? "排名 " + rangeToken(draft.rankRange) : ""].filter(Boolean).join(" · ") || "不限";
      content.append(section({ title: "评分与排名", desc: srDesc, rows }));

      // 收藏状态（仅客户端）
      content.append(section({
        title: "收藏状态", desc: [hideWatched ? "隐藏已看" : "", hideAbandoned ? "隐藏已弃" : ""].filter(Boolean).join(" · ") || "显示全部",
        rows: [
          splitRow(switchTile({ icon: "task_alt", title: "隐藏看过的番剧", checked: hideWatched, onChange: (v) => { hideWatched = v; } })),
          splitRow(switchTile({ icon: "heart_broken", title: "隐藏抛弃的番剧", checked: hideAbandoned, onChange: (v) => { hideAbandoned = v; } })),
        ],
      }));

      content.append(el("div", { class: "sheet-actions filter-actions" },
        button("重置", { variant: "text", onclick: () => {
          Object.assign(draft, defaultSearchFilter(draft.keyword));
          hideWatched = hideAbandoned = false;
          render();
        } }),
        button("查看结果", { variant: "filled", cls: "is-tall", onclick: () => {
          SEARCH_STATE.hideWatched = hideWatched;
          SEARCH_STATE.hideAbandoned = hideAbandoned;
          localStorage.setItem("searchHideWatched", hideWatched ? "1" : "0");
          localStorage.setItem("searchHideAbandoned", hideAbandoned ? "1" : "0");
          close();
          onApply(draft);
        } })));
    }
    render();
  });
}

// ============================================================
// 规则检索（Host API /api/search；423=captcha，502=search_failed）
// ============================================================
async function pluginSearchSingle(pluginName, keyword) {
  // 网络瞬时抖动下 5xx/网络错误重试一次（服务端已自带一次重试，两层叠加
  // 覆盖更长的抖动窗口）；423 验证码是确定性结果不重试。
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch("/api/search?plugin=" + encodeURIComponent(pluginName) + "&keyword=" + encodeURIComponent(keyword));
    } catch (e) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
      const err = new Error("网络错误");
      err.code = "error";
      throw err;
    }
    if (res.status >= 500 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    break;
  }
  if (res.status === 423) {
    const err = new Error("captcha required");
    err.code = "captcha";
    throw err;
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { const body = await res.json(); if (body && body.message) detail = body.message; } catch (_) {}
    const err = new Error(detail);
    err.code = "error";
    throw err;
  }
  const data = await res.json();
  return data.items || [];
}

// ============================================================
// 详情（info_page.dart / bangumi_info_card.dart / info_tabview.dart）
// ============================================================
// 保存封面：经镜像拉取为 blob 触发下载；跨域不可读时退回新标签页打开
async function saveCover(cover, title, id) {
  if (!cover) { toast("暂无封面"); return; }
  const safe = (title || "封面").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  try {
    const res = await fetch(bangumiImageUrl(cover));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const a = el("a", { href: URL.createObjectURL(blob), download: safe + "-" + id + "." + ext });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("封面已保存");
  } catch (_) {
    window.open(bangumiImageUrl(cover), "_blank", "noopener");
  }
}
function starsNode(score) {
  const wrap = el("span", { class: "stars", "aria-hidden": "true" });
  const filled = Math.round(score / 2);
  for (let i = 0; i < 5; i++) {
    const s = iconSvg("star");
    if (i >= filled) s.classList.add("is-empty");
    wrap.append(s);
  }
  return wrap;
}

async function renderBangumiDetail(params) {
  const id = parseInt(params.id, 10);
  if (!id) { go("/home"); return; }
  $app.innerHTML = "";
  renderNavRail("");
  window.scrollTo(0, 0);
  const page = el("div", { class: "page" });
  $app.append(page);
  page.append(el("div", { style: "height:56px" }), loadingNode("正在加载番剧详情"));

  let bangumi;
  try {
    bangumi = await fetchJson("/api/bangumi/" + id);
  } catch (e) {
    page.innerHTML = "";
    page.append(appBar({ back: true, compact: true }), errorState({
      title: "暂时无法加载番剧", message: e.message, onRetry: () => renderBangumiDetail(params),
    }));
    return;
  }
  page.innerHTML = "";

  // Hero：SliverAppBar.medium 的模糊封面背景 + BangumiInfoCardV
  const cover = bestBangumiImage(bangumi.images);
  const hero = el("div", { class: "hero" });
  if (cover) hero.append(coverImg(cover, "hero-bg", true));
  hero.append(el("div", { class: "hero-leading" }, iconBtn("arrow_back", { label: "返回", cls: "is-overlay", onclick: () => history.back() })));
  const moreBtn = iconBtn("more_horiz", { label: "更多操作", cls: "is-overlay" });
  moreBtn.addEventListener("click", () => openMenu(moreBtn, [
    { label: "保存封面", onclick: () => saveCover(cover, bangumi.nameCn || bangumi.name, id) },
    { label: "复制标题", onclick: async () => {
      const t = bangumi.nameCn || bangumi.name;
      if (!t) return;
      try { await navigator.clipboard.writeText(t); toast("标题已复制"); } catch (_) { toast("复制失败，请重试"); }
    } },
    { label: "外部打开", onclick: () => window.open("https://bangumi.tv/subject/" + id, "_blank", "noopener") },
  ]));
  hero.append(el("div", { class: "hero-trailing" }, moreBtn));

  const heroInfoCol = el("div", { class: "hero-info" });
  if (bangumi.airDate) {
    heroInfoCol.append(el("div", { class: "hero-info-group" },
      el("div", { class: "hero-info-label" }, "放送开始:"), el("div", { class: "hero-info-value" }, bangumi.airDate)));
  }
  if (bangumi.ratingScore > 0) {
    const ratingValue = el("div", { class: "hero-info-value hero-info-rating" },
      el("span", { class: "score" }, bangumi.ratingScore.toFixed(1)), starsNode(bangumi.ratingScore));
    heroInfoCol.append(el("div", { class: "hero-info-group" },
      el("div", { class: "hero-info-label" }, (bangumi.votes > 0 ? bangumi.votes : 0) + " 人评分:"), ratingValue));
  }
  if (bangumi.rank > 0) {
    heroInfoCol.append(el("div", { class: "hero-info-group" },
      el("div", { class: "hero-info-label" }, "Bangumi Ranked:"), el("div", { class: "hero-info-value" }, "#" + bangumi.rank)));
  }

  // CollectButton：FilledButton.icon 120×40，图标/文案跟随状态
  let currentCollectType = 0;
  const collectBtn = button("未追", { variant: "filled", small: true, icon: "favorite_border", cls: "collect-btn" });
  function refreshCollectBtn(type) {
    const def = collectTypeOf(type);
    collectBtn.querySelector(".icon").innerHTML = ICONS[def.icon];
    collectBtn.querySelector(".label").textContent = def.label;
  }
  fetchJson("/api/collect?bangumiId=" + id).then((data) => {
    currentCollectType = data.type || 0;
    refreshCollectBtn(currentCollectType);
  }).catch(() => {});
  collectBtn.addEventListener("click", () => openCollectMenu(collectBtn, currentCollectType, async (type) => {
    if (type === currentCollectType) return;
    try {
      currentCollectType = await putCollect(id, type);
      refreshCollectBtn(currentCollectType);
      toast(currentCollectType ? "已标记为「" + collectLabel(currentCollectType) + "」" : "已取消收藏");
    } catch (e) {
      toast("保存失败：" + e.message);
    }
  }));

  hero.append(el("div", { class: "hero-inner" },
    el("div", { class: "hero-title" }, bangumi.nameCn || bangumi.name),
    el("div", { class: "hero-row" },
      coverImg(cover, "hero-cover", true),
      el("div", { class: "hero-meta" }, heroInfoCol, collectBtn))));
  page.append(hero);

  // Tabs（info_page.dart：概览 / 吐槽 / 角色 / 制作人员）
  const tabBar = el("div", { class: "tabs is-centered no-divider detail-tabs", role: "tablist" });
  const tabBody = el("div", {});
  const tabs = [
    { key: "summary", label: "概览" },
    { key: "tucao", label: "吐槽" },
    { key: "characters", label: "角色" },
    { key: "relations", label: "关联" },
    { key: "staff", label: "制作人员" },
  ];
  const tabNodes = {};
  let activeTab = "summary";
  const switchTab = (key) => {
    activeTab = key;
    for (const k of Object.keys(tabNodes)) tabNodes[k].classList.toggle("is-active", k === key);
    renderTabBody(key);
  };
  for (const t of tabs) {
    const node = el("button", { class: "tab sl" + (t.key === activeTab ? " is-active" : ""), type: "button", role: "tab" }, t.label);
    node.addEventListener("click", () => switchTab(t.key));
    tabNodes[t.key] = node;
    tabBar.append(node);
  }
  page.append(tabBar, tabBody);

  function renderTabBody(key) {
    tabBody.innerHTML = "";
    if (key === "summary") renderSummary();
    else if (key === "tucao") renderTucao();
    else if (key === "characters") renderPersons("/characters", "characters", "暂无角色信息", "角色列表加载失败");
    else if (key === "relations") renderRelations();
    else if (key === "staff") renderPersons("/staff", "items", "暂无制作人员信息", "制作人员加载失败");
  }

  // ---- 概览：简介 + 标签 + 别名 ----
  function renderSummary() {
    if (bangumi.summary) {
      tabBody.append(el("div", { class: "h-section" }, "简介"));
      const card = el("div", { class: "summary-card collapsed" }, bangumi.summary);
      const toggle = button("展开", { variant: "text", small: true, cls: "summary-toggle" });
      toggle.addEventListener("click", () => {
        const collapsed = card.classList.toggle("collapsed");
        toggle.querySelector(".label").textContent = collapsed ? "展开" : "收起";
      });
      tabBody.append(card, toggle);
    } else {
      tabBody.append(emptyState({ icon: "info_outline", title: "暂无简介", compact: true }));
    }
    if (Array.isArray(bangumi.tags) && bangumi.tags.length) {
      tabBody.append(el("div", { class: "h-section" }, "标签"));
      const chips = el("div", { class: "chips" });
      let fullTag = false;
      const renderChips = () => {
        chips.innerHTML = "";
        const showAll = fullTag || bangumi.tags.length < 13;
        const total = showAll ? bangumi.tags.length : 12;
        for (let i = 0; i < total; i++) {
          const t = bangumi.tags[i];
          chips.append(el("button", { class: "chip sl", type: "button", onclick: () => go("/search", { tag: t.name }) },
            el("span", {}, t.name), el("span", { class: "count" }, String(t.count))));
        }
        if (!showAll) {
          chips.append(el("button", { class: "chip sl", type: "button", onclick: () => { fullTag = true; renderChips(); } },
            el("span", { class: "count" }, "更多 +")));
        }
      };
      renderChips();
      tabBody.append(chips);
    }
    if (Array.isArray(bangumi.alias) && bangumi.alias.length) {
      tabBody.append(el("div", { class: "h-section" }, "别名"));
      tabBody.append(el("div", { class: "chips" }, ...bangumi.alias.map((a) => el("span", { class: "chip is-static" }, a))));
    }
  }

  // ---- 吐槽：分页加载（滚到底续翻） ----
  function renderTucao() {
    const list = splitList([], { tight: true });
    const status = el("div", {}, loadingNode("正在加载吐槽", "medium"));
    tabBody.append(list, status);
    let offset = 0, total = -1, exhausted = false, loading = false, hadAny = false;

    const loadMore = async () => {
      if (loading || exhausted) return;
      loading = true;
      try {
        const data = await fetchJson("/api/bangumi/" + id + "/comments?offset=" + offset);
        status.innerHTML = "";
        const items = data.items || [];
        if (!hadAny && !items.length) {
          status.append(emptyState({ icon: "chat_bubble", title: "暂无吐槽", compact: true }));
          exhausted = true;
          return;
        }
        if (items.length) hadAny = true;
        for (const c of items) {
          const head = el("div", { class: "comment-head" },
            coverImg(c.user && c.user.avatar),
            el("span", { class: "username" }, (c.user && (c.user.nickname || c.user.username)) || "用户"));
          if (c.rate > 0) {
            const rate = el("span", { class: "rate" });
            rate.innerHTML = ICONS.star;
            rate.append(el("span", {}, String(c.rate)));
            head.append(rate);
          }
          list.append(splitRow(el("div", { class: "comment-row" }, head, el("div", { class: "comment-body" }, c.comment))));
        }
        offset += items.length;
        if (typeof data.total === "number") total = data.total;
        if (!items.length || (total >= 0 && offset >= total)) exhausted = true;
      } catch (e) {
        status.innerHTML = "";
        if (!hadAny) {
          // 镜像模式下吐槽接口常返 401；软状态 + 重试
          status.append(errorState({ title: "评论加载失败", message: "请检查网络连接后重试。", compact: true, onRetry: () => renderTabBody("tucao") }));
          exhausted = true;
        }
      } finally {
        loading = false;
      }
    };
    onScrollBottom(list, () => { if (activeTab === "tucao") loadMore(); });
    loadMore();
  }

  // ---- 角色 / 制作人员：统一的人物行（b6779400）；角色行点开资料 sheet ----
  async function renderPersons(path, key, emptyTitle, errorTitle) {
    tabBody.append(loadingNode("", "medium"));
    try {
      const data = await fetchJson("/api/bangumi/" + id + path);
      tabBody.innerHTML = "";
      const list = data[key] || [];
      if (!list.length) { tabBody.append(emptyState({ icon: key === "characters" ? "people" : "groups", title: emptyTitle, compact: true })); return; }
      tabBody.append(splitList(list.map((p) => {
        const isChar = key === "characters";
        const sub = isChar
          ? (p.actors && p.actors.length ? p.actors.map((a) => a.name).join(" / ") : "")
          : (p.positions || []).map((x) => x.type).filter(Boolean).join(" / ");
        const row = el("div", { class: "person-row" },
          coverImg(p.image, "avatar"),
          el("div", { class: "body" },
            el("div", { class: "name" }, p.nameCN || p.nameCn || p.name),
            sub ? el("div", { class: "sub" }, sub) : null),
          p.relation ? el("span", { class: "relation" }, p.relation) : null);
        return splitRow(row, isChar && p.id ? { onclick: () => openCharacterSheet(p) } : {});
      }), { tight: true }));
    } catch (e) {
      tabBody.innerHTML = "";
      tabBody.append(errorState({ title: errorTitle, message: "请检查网络连接后重试。", compact: true, onRetry: () => renderTabBody(activeTab) }));
    }
  }

  // ---- 关联：_RelatedBangumiCardH 横向卡片网格 ----
  async function renderRelations() {
    tabBody.append(loadingNode("", "medium"));
    try {
      const data = await fetchJson("/api/bangumi/" + id + "/relations");
      tabBody.innerHTML = "";
      const list = data.items || [];
      if (!list.length) { tabBody.append(emptyState({ icon: "account_tree", title: "暂无关联条目", compact: true })); return; }
      const grid = el("div", { class: "relation-grid" });
      for (const r of list) {
        const b = r.bangumi || {};
        grid.append(el("div", { class: "relation-card sl", onclick: () => go("/bangumi", { id: String(b.id) }) },
          coverImg(bestBangumiImage(b.images)),
          el("div", { class: "body" },
            el("div", { class: "title" }, b.nameCn || b.name),
            el("div", { class: "relation" }, r.relation || "关联"))));
      }
      tabBody.append(grid);
    } catch (e) {
      tabBody.innerHTML = "";
      tabBody.append(errorState({ title: "关联条目加载失败", message: "请检查网络连接后重试。", compact: true, onRetry: () => renderTabBody("relations") }));
    }
  }

  renderTabBody("summary");

  // FAB: 开始观看
  const fab = el("button", { class: "fab sl is-extended", "aria-label": "开始观看" });
  fab.append(iconSvg("play_arrow"), document.createTextNode("开始观看"));
  fab.addEventListener("click", () => openSourcePicker(bangumi));
  page.append(fab);
}

// 角色资料 sheet（character_info_view.dart：头像 + 资料卡 + 基本资料 + 人物简介）
function openCharacterSheet(ch) {
  openSheet({ title: ch.name, compact: true }, async (body) => {
    body.append(loadingNode("", "medium"));
    let c;
    try {
      c = await fetchJson("/api/bangumi/character/" + ch.id);
    } catch (e) {
      body.innerHTML = "";
      body.append(errorState({ title: "角色资料加载失败", message: "请检查网络连接后重试。", compact: true }));
      return;
    }
    body.innerHTML = "";
    const cnName = (c.infobox || []).find((f) => f.key === "简体中文名");
    const actors = (ch.actors || []).map((a) => a.name).join(" / ");
    const profile = el("div", { class: "tonal-card char-profile" },
      el("span", { class: "relation-pill" }, ch.relation || "角色"),
      el("div", { class: "char-name" }, cnName ? cnName.value : c.name),
      cnName ? el("div", { class: "char-orig" }, c.name) : null,
      actors ? el("div", { class: "char-cv" }, "声优 · " + actors) : null);
    const top = el("div", { class: "char-top" });
    if (c.image) top.append(coverImg(c.image, "char-portrait", true));
    top.append(profile);
    body.append(top);

    const fields = (c.infobox || []).filter((f) => f.key !== "引用来源" && f.key !== "简体中文名");
    if (fields.length) {
      body.append(section({
        title: "基本资料",
        body: el("div", { class: "char-fields" }, ...fields.map((f) =>
          el("div", { class: "char-field" }, el("div", { class: "k" }, f.key), el("div", { class: "v" }, f.value)))),
      }));
    }
    if (c.summary) {
      body.append(section({ title: "人物简介", body: el("div", { class: "char-summary" }, c.summary) }));
    }
    if (!fields.length && !c.summary) {
      body.append(emptyState({ icon: "info_outline", title: "暂无人物资料", compact: true }));
    }
  });
}

// ============================================================
// 播放来源 sheet（source_sheet_view.dart：分组折叠 + 预览模式 + SplitList 结果行）
// ============================================================
async function openSourcePicker(bangumi) {
  openSheet({ title: "播放来源", desc: "正在加载规则…" }, async (body, close, ctl) => {
    let plugins = [];
    try {
      plugins = await fetchJson("/api/plugins");
    } catch (e) {
      ctl.setDesc("");
      body.append(errorState({ title: "加载规则失败", message: e.message, compact: true, onRetry: () => { close(); openSourcePicker(bangumi); } }));
      return;
    }
    if (!plugins.length) {
      ctl.setDesc("");
      body.append(emptyState({ icon: "info_outline", title: "当前没有可用规则", compact: true }));
      return;
    }

    const defaultKeyword = bangumi.nameCn || bangumi.name;
    // state[name] = { status: pending|success|noResult|captcha|error, items, error, keyword, open, preview }
    const state = {};
    const groups = {};
    for (const p of plugins) state[p.name] = { status: "pending", items: null, keyword: defaultKeyword, open: false, preview: true };
    let autoOpened = false;

    function updateDesc() {
      const all = Object.values(state);
      const pending = all.filter((s) => s.status === "pending").length;
      const results = all.reduce((n, s) => n + (s.items ? s.items.length : 0), 0);
      ctl.setDesc(pending
        ? "检索中 " + (all.length - pending) + "/" + all.length + " · " + results + " 个结果"
        : all.length + " 个来源 · " + results + " 个结果");
    }
    function statusText(s) {
      if (s.status === "pending") return "检索中…";
      if (s.status === "success") return s.items.length + " 个结果";
      if (s.status === "noResult") return "无结果";
      if (s.status === "captcha") return "需要验证";
      return "检索失败";
    }
    function pick(pluginName, item) {
      localStorage.setItem("lastPlugin", pluginName);
      close();
      startPlayback({ plugin: pluginName, src: item.src, title: bangumi.nameCn || bangumi.name, bid: String(bangumi.id) });
    }
    function buildBody(name) {
      const s = state[name];
      if (s.status === "pending") return inlineLoading("正在检索…");
      if (s.status === "captcha" || s.status === "error") {
        const isErr = s.status === "error";
        const inline = el("div", { class: "src-inline" + (isErr ? " is-error" : "") }, iconSvg("error_outline"),
          el("div", { class: "text" },
            el("div", { class: "t" }, isErr ? "检索失败" : "需要人工验证"),
            el("div", { class: "h" }, isErr ? (s.error || "未知错误") : "站点触发了人机验证，完成后会自动重新检索"),
            el("div", { class: "acts" },
              isErr
                ? button("重试", { small: true, icon: "refresh", onclick: () => runOne(name, s.keyword, true) })
                : button("进行验证", { small: true, icon: "done", onclick: () => startCaptchaFlow(name, s.keyword, () => runOne(name, s.keyword, true)) }))));
        return splitList([splitRow(inline)]);
      }
      if (!s.items || !s.items.length) {
        return splitList([splitRow(emptyState({
          icon: "search_off", title: "没有找到匹配结果", compact: true,
          actions: [
            button("修改检索词", { small: true, icon: "edit", onclick: () => openManualSearch(s.keyword, (kw) => runOne(name, kw, true)) }),
            button("使用别名", { variant: "text", small: true, onclick: () => openAliasPicker(bangumi, (a) => runOne(name, a, true)) }),
          ],
        }))]);
      }
      const rows = (s.preview ? s.items.slice(0, 1) : s.items).map((item) => splitRow(
        el("div", { class: "src-row" }, el("span", { class: "name" }, item.name), el("span", { class: "play", style: "display:inline-flex", html: ICONS.play_arrow })),
        { onclick: () => pick(name, item) }));
      if (s.items.length > 1) {
        const more = el("div", { class: "src-more" }, iconSvg(s.preview ? "expand_more" : "unfold_more"),
          el("span", {}, s.preview ? "展开全部 " + s.items.length + " 个结果" : "收起全部条目"));
        rows.push(splitRow(more, { onclick: () => { s.preview = !s.preview; renderGroup(name); } }));
      }
      return splitList(rows);
    }
    function renderGroup(name) {
      const s = state[name];
      const g = groups[name];
      g.classList.toggle("is-open", s.open);
      g.querySelector(".src-status").textContent = statusText(s);
      g.querySelector(".src-status").classList.toggle("is-error", s.status === "error");
      const inner = g.querySelector(".src-body > div");
      inner.innerHTML = "";
      if (s.open) inner.append(buildBody(name));
    }
    function buildGroup(p) {
      const s = state[p.name];
      const more = iconBtn("more_horiz", { label: "更多" });
      more.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openMenu(more, [
          { label: "修改此来源的检索词", icon: "edit", onclick: () => openManualSearch(s.keyword, (kw) => runOne(p.name, kw, true)) },
          { label: "使用别名检索此来源", icon: "label", onclick: () => openAliasPicker(bangumi, (a) => runOne(p.name, a, true)) },
          { label: "重新检索此来源", icon: "refresh", onclick: () => runOne(p.name, s.keyword, true) },
        ]);
      });
      const chev = iconSvg("expand_more");
      chev.classList.add("src-chev");
      const head = el("button", { class: "src-head sl", type: "button" },
        el("span", { class: "src-name" }, p.name), el("span", { class: "src-status" }, statusText(s)), chev);
      head.addEventListener("click", () => { s.open = !s.open; renderGroup(p.name); });
      const headRow = el("div", { style: "display:flex;align-items:center;gap:4px" }, head, more);
      head.style.flex = "1";
      head.style.minWidth = "0";
      const g = el("div", { class: "src-group" }, headRow, el("div", { class: "src-body" }, el("div", {})));
      groups[p.name] = g;
      return g;
    }
    // 手动触发（改词/别名/重试）时展开该来源；初次并发检索保持折叠，
    // 由第一个拿到结果的来源自动展开为预览（对齐 source_sheet_view.dart）。
    async function runOne(name, kw, opened) {
      const s = state[name];
      Object.assign(s, { status: "pending", items: null, error: "", keyword: kw });
      if (opened) s.open = true;
      renderGroup(name);
      updateDesc();
      try {
        const items = await pluginSearchSingle(name, kw);
        s.status = items.length ? "success" : "noResult";
        s.items = items;
      } catch (e) {
        s.status = e.code === "captcha" ? "captcha" : "error";
        s.error = e.message;
      }
      if (s.status === "success" && !autoOpened) { autoOpened = true; s.open = true; s.preview = true; }
      renderGroup(name);
      updateDesc();
    }

    // 上次用过的规则排在最前
    const lastPlugin = localStorage.getItem("lastPlugin");
    const ordered = plugins.slice().sort((a, b) => (a.name === lastPlugin ? -1 : b.name === lastPlugin ? 1 : 0));
    for (const p of ordered) body.append(buildGroup(p));
    for (const p of ordered) runOne(p.name, defaultKeyword, false);
  });
}

// 别名检索：列出 bangumi.alias
function openAliasPicker(bangumi, onPick) {
  const aliases = Array.isArray(bangumi.alias) ? bangumi.alias : [];
  openSheet({ title: "使用别名检索", compact: true }, (body, close) => {
    if (!aliases.length) {
      body.append(emptyState({ icon: "label", title: "这部番剧没有别名", compact: true, actions: [button("知道了", { onclick: close })] }));
      return;
    }
    body.append(splitList(aliases.map((a) => splitRow(tile({ icon: "label", title: a, chevron: true }), { onclick: () => { close(); onPick(a); } }))));
  });
}

// 修改检索词
function openManualSearch(initial, onPick) {
  openSheet({ title: "修改检索词", compact: true }, (body, close) => {
    const input = el("input", { type: "search", placeholder: "输入关键词", autocomplete: "off", autocorrect: "off", spellcheck: "false" });
    input.value = initial || "";
    const form = el("form", { class: "search-box is-high" }, iconSvg("search"), input);
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      close();
      onPick(v);
    };
    form.addEventListener("submit", (ev) => { ev.preventDefault(); submit(); });
    body.append(form, el("div", { class: "sheet-actions", style: "border:none;padding:16px 0 0" },
      button("取消", { variant: "text", onclick: close }), button("检索", { variant: "filled", icon: "search", onclick: submit })));
    setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} }, 30);
  });
}

// ============================================================
// 选集（episode_selection_panel.dart）+ 评论（player_content_tabs）
// ============================================================
// ============================================================
// 选集面板 / 分集评论面板（episode_selection_panel.dart）
// 选集页与播放页共用：播放页在视频下方（竖屏）或右侧侧栏（横屏）直接换集。
// ============================================================
async function loadRoadsAndHistory(plugin, src, bid) {
  const historyReq = bid
    ? fetchJson("/api/history?bangumiId=" + encodeURIComponent(bid) + "&pluginName=" + encodeURIComponent(plugin)).catch(() => null)
    : Promise.resolve(null);
  const [data, hist] = await Promise.all([
    fetchJson("/api/episodes?plugin=" + encodeURIComponent(plugin) + "&src=" + encodeURIComponent(src)),
    historyReq,
  ]);
  const roads = data.roads || [];
  let lastWatched = null;
  const h = hist && hist.history;
  if (h && h.lastWatchEpisode > 0) {
    const prog = (h.progresses || {})[String(h.lastWatchEpisode)];
    lastWatched = { episode: h.lastWatchEpisode, road: prog ? prog.road || 0 : 0, progressMs: prog ? prog.progressMs : 0 };
  }
  return { roads, lastWatched };
}
function playEpisodeParams(ctx, ep, epIdx, roadIdx) {
  const pp = {
    plugin: ctx.plugin, episodeUrl: ep.src,
    title: (ctx.title ? ctx.title + " · " : "") + ep.name,
    episode: String(epIdx + 1), road: String(roadIdx), src: ctx.src,
  };
  if (ctx.bid) pp.bid = ctx.bid;
  return pp;
}
// 选好来源后直接进播放：上次看到的集优先，否则第一条线路第一集（对齐桌面端）
async function startPlayback(ctx) {
  toast("正在获取选集…");
  let info;
  try {
    info = await loadRoadsAndHistory(ctx.plugin, ctx.src, ctx.bid);
  } catch (e) {
    toast("获取选集失败：" + e.message);
    go("/episodes", { plugin: ctx.plugin, src: ctx.src, title: ctx.title, bid: ctx.bid });
    return;
  }
  const lw = info.lastWatched;
  let roadIdx = lw && info.roads[lw.road] ? lw.road : 0;
  const eps = (info.roads[roadIdx] || {}).episodes || [];
  let epIdx = lw && roadIdx === lw.road && eps[lw.episode - 1] ? lw.episode - 1 : 0;
  if (!eps[epIdx]) {
    toast("没有可用的播放列表");
    go("/episodes", { plugin: ctx.plugin, src: ctx.src, title: ctx.title, bid: ctx.bid });
    return;
  }
  go("/play", playEpisodeParams(ctx, eps[epIdx], epIdx, roadIdx));
}

// ctx: { plugin, src, title, bid, roads, lastWatched, activeRoadIdx, currentRoad, currentEpisode }
// currentRoad/currentEpisode = 播放页正在播放的集（1-based）；选集页传 null
function episodePanel(ctx) {
  const root = el("div", { class: "ep-panel" });
  const roads = ctx.roads;
  let activeRoadIdx = roads[ctx.activeRoadIdx] ? ctx.activeRoadIdx : 0;
  const roadName = (i) => roads[i].name || "播放列表 " + (i + 1);

  function render() {
    root.innerHTML = "";
    const eps = (roads[activeRoadIdx] || {}).episodes || [];
    const routeBtn = el("button", { class: "route-btn sl", type: "button" },
      el("div", { class: "body" }, el("div", { class: "label" }, "播放线路"), el("div", { class: "name" }, roadName(activeRoadIdx))),
      iconSvg("expand_more"));
    if (roads.length < 2) routeBtn.querySelector(".icon").style.visibility = "hidden";
    routeBtn.addEventListener("click", () => {
      if (roads.length < 2) return;
      routeBtn.classList.add("is-open");
      openSheet({ title: "选择播放线路", compact: true }, (body, close) => {
        body.append(splitList(roads.map((r, i) => {
          const sel = i === activeRoadIdx;
          const row = splitRow(tile({ title: roadName(i), desc: (r.episodes ? r.episodes.length : 0) + " 集", trailing: sel ? iconSvg("check_circle") : null }),
            { onclick: () => { close(); activeRoadIdx = i; render(); } });
          if (sel) { row.style.background = "var(--secondary-container)"; row.style.color = "var(--on-secondary-container)"; row.style.borderRadius = "20px"; }
          return row;
        }), { tight: true, r20: true }));
        const obs = new MutationObserver(() => { if (!document.body.contains(body)) { routeBtn.classList.remove("is-open"); obs.disconnect(); } });
        obs.observe(document.body, { childList: true });
      });
    });

    const playing = ctx.currentEpisode && ctx.currentRoad === activeRoadIdx ? ctx.currentEpisode - 1 : -1;
    const lw = ctx.lastWatched;
    const lastIdx = lw && lw.road === activeRoadIdx ? lw.episode - 1 : -1;
    const currentIdx = playing >= 0 ? playing : lastIdx;
    const list = splitList(eps.map((ep, i) => {
      const isCur = i === currentIdx;
      let sub = "";
      if (i === playing) sub = "正在播放";
      else if (i === lastIdx) sub = lw.progressMs > 0 ? "上次看到 " + formatPosition(lw.progressMs) : "上次观看";
      return splitRow(el("div", { class: "ep-row" + (isCur ? " is-current" : "") },
        el("div", { class: "body" }, el("div", { class: "name" }, ep.name), sub ? el("div", { class: "sub" }, sub) : null),
        isCur ? iconSvg("play_arrow") : null),
        { onclick: () => { if (i !== playing) go("/play", playEpisodeParams(ctx, ep, i, activeRoadIdx)); } });
    }), { tight: true, r20: true });
    const locate = button("定位当前集", { variant: "text", small: true, icon: "my_location", onclick: () => {
      const cur = list.querySelector(".ep-row.is-current");
      if (cur) cur.scrollIntoView({ behavior: "smooth", block: "center" });
      else toast("还没有观看记录");
    } });
    root.append(routeBtn,
      el("div", { class: "ep-toolbar" }, el("span", { class: "ep-count" }, "全部剧集 · " + eps.length + " 集"), locate),
      list);
  }
  render();
  return root;
}

// 分集评论：默认当前集，可切换分集、正倒序
function episodeCommentsPanel(bid, initialEpisode) {
  const root = el("div", { class: "ep-comments" });
  if (!bid) { root.append(emptyState({ icon: "subtitles", title: "缺少番剧 ID，无法加载评论", compact: true })); return root; }
  let activeEpisode = initialEpisode || 1;
  let ascending = false;
  let cachedList = [];
  const epInfoTop = el("div", { class: "ep-comments-current-top" }, "第 " + activeEpisode + " 集");
  const epInfoSub = el("div", { class: "ep-comments-current-sub" });
  const switchBtn = button("切换分集", { variant: "text", small: true, icon: "unfold_more", onclick: () => openEpisodePicker() });
  const sortBtn = button("倒序", { variant: "text", small: true, icon: "sort" });
  sortBtn.addEventListener("click", () => {
    ascending = !ascending;
    sortBtn.querySelector(".label").textContent = ascending ? "正序" : "倒序";
    renderList();
  });
  const list = el("div", {});
  root.append(el("div", { class: "ep-comments-header" }, el("div", { class: "ep-comments-current" }, epInfoTop, epInfoSub), switchBtn, sortBtn), list);

  function renderList() {
    list.innerHTML = "";
    if (!cachedList.length) { list.append(emptyState({ icon: "subtitles", title: "这一集还没有评论", compact: true })); return; }
    const sorted = cachedList.slice().sort((a, b) => ascending ? (a.createdAt || 0) - (b.createdAt || 0) : (b.createdAt || 0) - (a.createdAt || 0));
    list.append(splitList(sorted.map(buildEpisodeCommentRow), { tight: true }));
  }
  function load() {
    epInfoTop.textContent = "第 " + activeEpisode + " 集";
    epInfoSub.textContent = "";
    list.innerHTML = "";
    list.append(loadingNode("", "medium"));
    fetchJson("/api/bangumi/" + bid + "/episode-comments?episode=" + activeEpisode).then((data) => {
      cachedList = data.items || [];
      if (data.episode) epInfoSub.textContent = data.episode.readType + "." + data.episode.episode + " " + (data.episode.nameCn || data.episode.name || "");
      renderList();
    }).catch(() => {
      list.innerHTML = "";
      list.append(errorState({ title: "评论获取失败", message: "请稍后重试", compact: true, onRetry: load }));
    });
  }
  function openEpisodePicker() {
    openSheet({ title: "选择分集", compact: true }, (body, close) => {
      body.append(loadingNode("", "medium"));
      fetchJson("/api/bangumi/" + bid + "/episodes").then((data) => {
        body.innerHTML = "";
        const items = data.items || [];
        if (!items.length) { body.append(emptyState({ icon: "subtitles", title: "未找到分集列表", compact: true })); return; }
        body.append(splitList(items.map((it, idx) => {
          const isCur = idx + 1 === activeEpisode;
          return splitRow(el("div", { class: "ep-row" + (isCur ? " is-current" : "") },
            el("div", { class: "body" }, el("div", { class: "name" }, it.readType + "." + it.episode + " " + (it.nameCn || it.name || "")))),
            { onclick: () => { activeEpisode = idx + 1; close(); load(); } });
        }), { tight: true, r20: true }));
      }).catch((e) => {
        body.innerHTML = "";
        body.append(errorState({ title: "加载失败", message: e.message, compact: true }));
      });
    });
  }
  load();
  return root;
}

// 选集页（历史"重新选集"、直接进播放失败时的回退入口）
async function renderEpisodes(params) {
  const { plugin, src, title, bid } = params;
  $app.innerHTML = "";
  renderNavRail("");
  window.scrollTo(0, 0);
  const bar = appBar({ title: title || "选择集数", back: true, compact: true });
  const page = el("div", { class: "page" });
  $app.append(bar, page);

  const tabBar = el("div", { class: "tabs no-divider", role: "tablist" });
  const tabBody = el("div", {});
  const tabNodes = {};
  let activeTab = "episodes";
  let info = null, loading = true, error = null;
  for (const t of [{ key: "episodes", label: "选集" }, { key: "comments", label: "评论" }]) {
    const node = el("button", { class: "tab sl" + (t.key === activeTab ? " is-active" : ""), type: "button", role: "tab" }, t.label);
    node.addEventListener("click", () => {
      activeTab = t.key;
      for (const k of Object.keys(tabNodes)) tabNodes[k].classList.toggle("is-active", k === activeTab);
      renderTabBody();
    });
    tabNodes[t.key] = node;
    tabBar.append(node);
  }
  page.append(el("div", { class: "t-body-small c-variant", style: "padding:0 0 4px 16px" }, "规则 · " + plugin), tabBar, tabBody);

  function renderTabBody() {
    tabBody.innerHTML = "";
    if (activeTab === "comments") { tabBody.append(episodeCommentsPanel(bid, info && info.lastWatched ? info.lastWatched.episode : 1)); return; }
    if (loading) { tabBody.append(loadingNode("正在加载选集")); return; }
    if (error) { tabBody.append(errorState({ title: "加载选集失败", message: error, onRetry: () => renderEpisodes(params) })); return; }
    if (!info.roads.length) { tabBody.append(emptyState({ icon: "live_tv", title: "没有可用的播放列表" })); return; }
    tabBody.append(episodePanel({
      plugin, src, title, bid, roads: info.roads, lastWatched: info.lastWatched,
      activeRoadIdx: info.lastWatched ? info.lastWatched.road : 0, currentRoad: null, currentEpisode: null,
    }));
  }
  renderTabBody();
  try {
    info = await loadRoadsAndHistory(plugin, src, bid);
  } catch (e) {
    error = e.message;
  }
  loading = false;
  if (activeTab === "episodes") renderTabBody();
}

function buildEpisodeCommentRow(c) {
  const head = el("div", { class: "comment-head" },
    coverImg(c.user && c.user.avatar),
    el("span", { class: "username" }, (c.user && (c.user.nickname || c.user.username)) || "用户"));
  if (c.createdAt) head.append(el("span", { class: "time" }, new Date(c.createdAt * 1000).toLocaleString()));
  return splitRow(el("div", { class: "comment-row" }, head, el("div", { class: "comment-body" }, c.content || "")));
}

// ============================================================
// 我的（my_space_view.dart 紧凑布局 × KazumiWeb 能力：历史 / 规则 / 网络 / 外观 / 关于）
// ============================================================
const THEME_MODE_LABELS = { system: "跟随系统", light: "浅色", dark: "深色" };
function currentThemeMode() { return localStorage.getItem("webThemeMode") || "system"; }

async function renderTabMy(container) {
  const bar = appBar({ title: "我的" });
  const page = el("div", { class: "page my" });
  container.append(bar, page);
  // 对齐 my_space_view.dart：内容宽 ≥ 840 用宽屏布局，否则紧凑布局
  const wide = window.innerWidth >= 960;

  // ---- 观看足迹（当前设备的历史） ----
  const bangumiNum = el("div", { class: "stat-num" }, "—");
  const epNum = el("div", { class: "stat-num" }, "—");
  const statsIcon = el("span", { class: "stats-icon" });
  statsIcon.innerHTML = ICONS.history;
  const stats = el("div", { class: "stats-card" + (wide ? " is-wide" : "") },
    el("div", { class: "stats-head" }, statsIcon, el("span", {}, "观看足迹")),
    el("div", { class: "stats-row" },
      el("div", { class: "stat" }, bangumiNum, el("div", { class: "stat-label" }, "看过番剧")),
      el("div", { class: "stat-divider" }),
      el("div", { class: "stat" }, epNum, el("div", { class: "stat-label" }, "观看集数"))));

  // ---- 入口 tile ----
  const historyCap = el("div", { class: "cap" }, "查看观看记录");
  const myTile = (icon, title, cap, cls, onclick) => el("button", { class: "my-tile" + (cls ? " " + cls : ""), type: "button", onclick },
    el("div", { class: "top" }, iconSvg(icon), iconSvg("arrow_forward")),
    el("div", { class: "title" }, title), cap);
  const historyTile = myTile("history", "历史记录", historyCap, "", () => go("/my/history"));
  const rulesTile = myTile("extension", "规则管理", el("div", { class: "cap" }, "管理番剧资源规则"), "is-tertiary", () => go("/my/rules"));

  // ---- 网络：三个服务端开关（PUT /api/settings，即时生效）+ 本地图片镜像 ----
  const serverSwitches = {};
  const netSwitch = (key, icon, title, desc) => {
    const t = switchTile({
      icon, title, desc, checked: false,
      onChange: async (v) => {
        try {
          await fetchJsonPut("/api/settings", { [key]: v });
          toast("已" + (v ? "开启" : "关闭") + "「" + title + "」");
        } catch (e) {
          t.querySelector(".m3-switch").setAttribute("aria-checked", String(!v));
          toast("保存失败：" + e.message);
        }
      },
    });
    serverSwitches[key] = t;
    return t;
  };
  const network = section({
    title: "网络",
    rows: [
      splitRow(netSwitch("enableBangumiProxy", "open_in_browser", "Bangumi 镜像", "通过镜像服务器获取番剧数据（跟随桌面版，改动后独立生效）")),
      splitRow(netSwitch("enableGitProxy", "extension", "规则仓库镜像", "通过镜像地址拉取规则仓库")),
      splitRow(netSwitch("proxyEnable", "tune", "HTTP 代理", "视频源检索经本机代理访问（直连资源站不稳定时开启）")),
      splitRow(switchTile({
        icon: "label", title: "图片镜像", desc: "封面与头像经 wsrv.nl 转发，绕过 lain.bgm.tv 的 DNS 污染（仅本浏览器）",
        checked: APP_SETTINGS.imageMirror,
        onChange: (v) => { setImageMirror(v); toast(v ? "新加载的图片将走镜像" : "新加载的图片将直连 bgm.tv"); },
      })),
    ],
  });

  // ---- 外观 / 关于 ----
  const themeTile = tile({ badge: "palette", title: "外观设置", desc: THEME_MODE_LABELS[currentThemeMode()], chevron: true,
    onclick: () => openThemeModePicker(() => { themeTile.querySelector(".tile-desc").textContent = THEME_MODE_LABELS[currentThemeMode()]; }) });
  const aboutTile = tile({ badge: "info_outline", title: "关于", desc: "关于本项目", chevron: true, onclick: openAboutSheet });

  if (wide) {
    // 宽屏：个人中心标题 + 统计卡；大规则 tile + 两个小 tile；偏好面板 + 外观/关于
    const heroShape = el("span", { class: "my-hero-shape" });
    const bigTile = el("button", { class: "my-tile-big sl", type: "button", onclick: () => go("/my/rules") },
      el("div", { class: "text" },
        el("div", { class: "title" }, "规则管理"),
        el("div", { class: "cap" }, "管理番剧资源规则"),
        el("span", { class: "arrow" }, iconSvg("arrow_forward"))),
      el("span", { class: "shape" }, iconSvg("extension")));
    const searchTile = myTile("search", "番剧搜索", el("div", { class: "cap" }, "按名称查找番剧"), "is-tertiary", () => go("/search"));
    page.append(
      el("div", { class: "my-hero" }, el("div", { class: "my-hero-title" }, heroShape, el("span", {}, "个人中心")), stats),
      el("div", { class: "my-row" }, bigTile, historyTile, searchTile),
      el("div", { class: "my-row2" },
        el("div", { class: "my-panel" }, network),
        el("div", { class: "my-col" }, splitRow(themeTile), splitRow(aboutTile))));
  } else {
    page.append(stats, el("div", { class: "my-tiles" }, historyTile, rulesTile), network,
      section({ title: "应用与外观", rows: [splitRow(themeTile)] }),
      section({ title: "其他", rows: [splitRow(aboutTile)] }));
  }

  // 异步：服务端开关当前值 + 观看统计
  fetchJson("/api/settings").then((s) => {
    for (const [key, t] of Object.entries(serverSwitches)) {
      t.querySelector(".m3-switch").setAttribute("aria-checked", String(!!s[key]));
    }
  }).catch(() => {});
  try {
    const data = await fetchJson("/api/history/list?device=" + encodeURIComponent(getDeviceId()));
    const bangumiIds = new Set();
    const episodes = new Set();
    for (const h of data.items || []) {
      const keys = Object.keys(h.progresses || {});
      if (!keys.length) continue;
      bangumiIds.add(h.bangumiId);
      for (const k of keys) episodes.add(h.bangumiId + ":" + k);
    }
    bangumiNum.textContent = String(bangumiIds.size);
    epNum.textContent = String(episodes.size);
    if (!bangumiIds.size) historyCap.textContent = "暂无观看记录";
  } catch (_) {
    bangumiNum.textContent = "0";
    epNum.textContent = "0";
  }
}

// 深色模式三选（localStorage webThemeMode 覆盖服务端 themeMode）
function openThemeModePicker(onChange) {
  openSheet({ title: "深色模式", compact: true }, (body, close) => {
    const current = currentThemeMode();
    body.append(splitList(["system", "light", "dark"].map((mode) => splitRow(
      tile({ icon: "palette", title: THEME_MODE_LABELS[mode], trailing: mode === current ? iconSvg("check_circle") : null }),
      {
        onclick: () => {
          localStorage.setItem("webThemeMode", mode);
          document.documentElement.dataset.theme = mode === "system" ? "auto" : mode;
          close();
          onChange && onChange();
        },
      }))));
  });
}

function openAboutSheet() {
  openSheet({ title: "关于" }, async (body) => {
    let version = "";
    let repo = "https://github.com/0Chencc/KazumiWeb";
    try {
      const info = await fetchJson("/api/about");
      version = info.version || "";
      if (info.repository) repo = info.repository;
    } catch (_) {}
    body.append(el("div", { class: "tonal-card about-card" },
      el("div", { class: "about-title" }, "KazumiWeb" + (version ? " · v" + version : "")),
      el("div", { class: "about-sub" }, "Kazumi 的局域网 Web 服务，与桌面版共享规则生态"),
      el("a", { class: "about-link", href: repo, target: "_blank", rel: "noreferrer" }, repo)));
  });
}

// ============================================================
// 历史记录（history_page.dart 外观 × KazumiWeb 设备维度历史 / 直达续播 / 清空）
// ============================================================
function formatPosition(ms) {
  const total = Math.floor((ms || 0) / 1000);
  if (total <= 0) return "";
  const s = String(total % 60).padStart(2, "0");
  const m = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const h = Math.floor(total / 3600);
  return h > 0 ? h + ":" + m + ":" + s : Math.floor(total / 60) + ":" + s;
}
function historyDateLabel(date) {
  const now = new Date();
  const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const n0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((n0 - d0) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (date.getFullYear() === now.getFullYear()) return (date.getMonth() + 1) + "月" + date.getDate() + "日";
  return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日";
}
function timeHm(date) {
  return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}
// 直达续播：lastSrc = 上次播放的选集地址；src（详情页地址）给播放器的上一集/下一集。
// 旧数据缺 lastSrc 时回退详情页；缺 src 时直达播放仍可用，只是切集按钮不可点。
function resumeHistory(h) {
  const b = h.bangumi || {};
  if (!h.lastSrc) { go("/bangumi", { id: String(h.bangumiId) }); return; }
  const epName = h.lastWatchEpisodeName || ("第 " + h.lastWatchEpisode + " 集");
  const prog = (h.progresses || {})[String(h.lastWatchEpisode)];
  const pp = {
    plugin: h.pluginName, episodeUrl: h.lastSrc,
    title: (b.nameCn || b.name) + " · " + epName,
    episode: String(h.lastWatchEpisode), road: String((prog && prog.road) || 0),
    bid: String(h.bangumiId),
  };
  if (h.src) pp.src = h.src;
  go("/play", pp);
}

async function renderMyHistory() {
  $app.innerHTML = "";
  renderNavRail("my");
  window.scrollTo(0, 0);
  // 编辑模式（history_page.dart）：进入后每条变成删除按钮，标题栏换成 完成 + 清空
  let editing = false;
  const clearBtn = iconBtn("delete_sweep", { label: "清空历史", cls: "is-tonal" });
  const editBtn = iconBtn("edit", { label: "编辑记录", cls: "is-tonal", onclick: () => { editing = true; renderBar(); renderList(); } });
  const doneBtn = button("完成", { onclick: () => { editing = false; renderBar(); renderList(); } });
  let bar = el("div", {});
  const page = el("div", { class: "page history" });
  $app.append(bar, page);
  function renderBar() {
    const next = appBar({ title: "历史记录", back: true, actions: editing ? [doneBtn, clearBtn] : [editBtn] });
    bar.replaceWith(next);
    bar = next;
  }
  renderBar();

  let items = null;
  let keyword = "";
  const input = el("input", { type: "search", placeholder: "搜索番剧、别名或来源", autocomplete: "off" });
  input.addEventListener("input", () => { keyword = input.value.trim().toLowerCase(); renderList(); });
  const searchField = el("div", { class: "hist-search" }, iconSvg("search"), input);
  const summary = el("div", { class: "hist-summary" });
  const listNode = el("div", {});
  page.append(searchField, summary, listNode);

  clearBtn.addEventListener("click", () => openSheet({ title: "清空历史记录", desc: "确认要清除所有历史记录吗？此操作不可撤销。", compact: true }, (body, close) => {
    body.append(el("div", { class: "sheet-actions", style: "border:none;padding:8px 0 0" },
      button("取消", { variant: "text", onclick: close }),
      button("清空", { variant: "filled", cls: "btn-danger", icon: "delete_sweep", onclick: async () => {
        close();
        try {
          await fetch("/api/history/all", { method: "DELETE" });
          items = [];
          renderList();
          toast("已清空历史记录");
        } catch (e) { toast("清空失败：" + e.message); }
      } })));
  }));

  function visible() {
    if (!keyword) return items;
    return items.filter((h) => {
      const b = h.bangumi || {};
      return [b.nameCn, b.name, h.pluginName].concat(b.alias || []).some((s) => (s || "").toLowerCase().includes(keyword));
    });
  }
  async function remove(h) {
    try {
      const res = await fetch("/api/history?bangumiId=" + encodeURIComponent(h.bangumiId) + "&pluginName=" + encodeURIComponent(h.pluginName), { method: "DELETE" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      items = items.filter((x) => x !== h);
      renderList();
      toast("已删除记录");
    } catch (e) { toast("删除失败：" + e.message); }
  }
  function buildTile(h) {
    const b = h.bangumi || {};
    const title = b.nameCn || b.name;
    const epName = h.lastWatchEpisodeName || ("第 " + h.lastWatchEpisode + " 话");
    const prog = (h.progresses || {})[String(h.lastWatchEpisode)];
    const pos = prog ? formatPosition(prog.progressMs) : "";
    const when = new Date(h.lastWatchTime);
    const openDetail = () => go("/bangumi", { id: String(h.bangumiId) });
    const more = iconBtn("more_horiz", { label: "更多" });
    more.addEventListener("click", () => openMenu(more, [
      { label: "番剧详情", icon: "info_outline", onclick: openDetail },
      h.src ? { label: "重新选集", icon: "unfold_more", onclick: () => go("/episodes", { plugin: h.pluginName, src: h.src, title, bid: String(h.bangumiId) }) } : null,
      "divider",
      { label: "删除记录", icon: "delete_outline", danger: true, onclick: () => remove(h) },
    ].filter(Boolean)));
    return splitRow(el("div", { class: "hist-tile" },
      coverImg(bestBangumiImage(b.images), "cover"),
      el("div", { class: "body", onclick: () => resumeHistory(h) },
        el("div", { class: "title" }, title),
        el("div", { class: "ep" }, epName),
        pos ? el("div", { class: "pos" }, "看到 " + pos) : null,
        el("div", { class: "src" }, ["在线", h.pluginName, timeHm(when)].join(" · "))),
      el("div", { class: "actions" }, ...(editing
        ? [iconBtn("delete_outline", { label: "删除记录", cls: "is-error", onclick: () => remove(h) })]
        : [iconBtn("play_arrow", { label: "继续观看", cls: "is-primary", onclick: () => resumeHistory(h) }), more]))));
  }
  function renderList() {
    listNode.innerHTML = "";
    if (!items) return;
    const list = visible().slice().sort((a, b) => (b.lastWatchTime || 0) - (a.lastWatchTime || 0));
    summary.textContent = list.length ? "共 " + list.length + " 条记录 · 最近观看优先 · 仅本设备" : "";
    if (!list.length) {
      listNode.append(emptyState({
        icon: keyword ? "search_off" : "history",
        title: keyword ? "没有匹配的记录" : "还没有观看记录",
        actions: keyword ? [] : [button("去推荐页看看", { icon: "home_outlined", onclick: () => go("/home", { tab: "popular" }) })],
      }));
      return;
    }
    const groups = [];
    for (const h of list) {
      const label = historyDateLabel(new Date(h.lastWatchTime));
      const g = groups[groups.length - 1];
      if (g && g.label === label) g.items.push(h);
      else groups.push({ label, items: [h] });
    }
    for (const g of groups) {
      listNode.append(
        el("div", { class: "hist-group-head" }, el("div", { class: "title" }, g.label), el("div", { class: "count" }, g.items.length + " 条")),
        splitList(g.items.map(buildTile), { tight: true }));
    }
  }

  listNode.append(loadingNode("正在加载历史记录"));
  try {
    const data = await fetchJson("/api/history/list?device=" + encodeURIComponent(getDeviceId()));
    items = (data.items || []).filter((h) => h.bangumi);
    renderList();
  } catch (e) {
    listNode.innerHTML = "";
    listNode.append(errorState({ title: "暂时无法加载历史记录", message: e.message, onRetry: renderMyHistory }));
  }
}

// ============================================================
// 规则管理（plugin_view_page.dart）/ 规则仓库（plugin_catalog_view.dart）
// 上游是两个独立页面：/my/rules 已安装，/my/rules?tab=shop 仓库
// ============================================================
function ruleIntro(opts) {
  return el("div", { class: "rule-intro" },
    el("div", { class: "head" }, el("div", { class: "title" }, opts.title), iconSvg(opts.icon)),
    el("div", { class: "desc" }, opts.desc),
    opts.actions && opts.actions.length ? el("div", { class: "actions" }, ...opts.actions) : null);
}
function ruleSearch(placeholder, onInput) {
  const input = el("input", { type: "search", placeholder, autocomplete: "off" });
  const clear = iconBtn("close", { label: "清除搜索", onclick: () => { input.value = ""; sync(); onInput(""); } });
  const sync = () => { clear.style.visibility = input.value ? "visible" : "hidden"; };
  input.addEventListener("input", () => { sync(); onInput(input.value.trim().toLowerCase()); });
  sync();
  return el("div", { class: "rule-search" }, iconSvg("search"), input, clear);
}
function ruleTag(text, cls) { return el("span", { class: "rule-tag " + cls }, text); }
function filterChip(label, selected, onclick) {
  return el("button", { class: "chip sl" + (selected ? " is-selected" : ""), type: "button", onclick }, selected ? iconSvg("done") : null, label);
}
// RuleCard：独立圆角 28 容器，48px 图标块，标题 / 副标题 / 徽章 / caption，右侧操作区
function ruleCard(opts) {
  const icon = el("span", { class: "rule-icon" + (opts.installed ? " is-installed" : "") + (opts.selected ? " is-selected" : "") },
    iconSvg(opts.selected ? "done" : "extension"));
  const card = el("div", { class: "rule-card" + (opts.selected ? " is-selected" : "") + (opts.onclick ? " sl" : "") },
    icon,
    el("div", { class: "text" },
      el("div", { class: "title" }, opts.title),
      opts.subtitle ? el("div", { class: "sub" }, opts.subtitle) : null,
      opts.tags && opts.tags.length ? el("div", { class: "tags" }, ...opts.tags) : null,
      opts.caption ? el("div", { class: "cap" }, opts.caption) : null),
    opts.trailing && opts.trailing.length ? el("div", { class: "trailing" }, ...opts.trailing) : null);
  if (opts.onclick) card.addEventListener("click", opts.onclick);
  return card;
}
function hostOf(url) {
  try { return new URL(url).host || url; } catch (_) { return url || ""; }
}
async function installRule(name) {
  return fetchJsonPost("/api/rules/install", { name });
}

// ---- 规则管理：已安装 ----
async function renderMyRules(initialTab) {
  if (initialTab === "shop") return renderRuleShop();
  $app.innerHTML = "";
  renderNavRail("my");
  window.scrollTo(0, 0);
  const page = el("div", { class: "page narrow rules" });
  let barNode = el("div", {});
  $app.append(barNode, page);

  let plugins = null;
  let shopVersions = null;      // null = 仓库目录不可用
  let keyword = "";
  let onlyUpdatable = false;
  let selecting = false;
  const selected = new Set();
  const updating = new Set();
  let updatingAll = false;

  const isUpdatable = (p) => !!(shopVersions && shopVersions[p.name] && shopVersions[p.name] !== p.version);
  const visible = () => (plugins || []).filter((p) =>
    (!onlyUpdatable || isUpdatable(p)) &&
    (!keyword || (p.name || "").toLowerCase().includes(keyword) || (p.baseUrl || "").toLowerCase().includes(keyword)));

  function renderBar() {
    const bar = selecting
      ? el("div", { class: "app-bar is-compact has-back" },
          iconBtn("close", { label: "退出多选", onclick: () => { selecting = false; selected.clear(); renderBar(); renderFilters(); renderList(); } }),
          el("div", { class: "app-bar-title" }, "已选择 " + selected.size + " 条"),
          el("div", { class: "app-bar-actions" }, (() => {
            const b = iconBtn("delete_outline", { label: "删除所选规则", onclick: () => confirmDelete([...selected]) });
            b.disabled = !selected.size;
            return b;
          })()))
      : appBar({ title: "规则管理", back: true, compact: true, actions: [
          iconBtn("checklist", { label: "批量选择", onclick: () => { selecting = true; renderBar(); renderFilters(); renderList(); } }),
        ] });
    barNode.replaceWith(bar);
    barNode = bar;
  }

  const intro = ruleIntro({
    title: "我的规则", icon: "extension",
    desc: "管理你的番剧来源。点按规则查看操作，可批量选择删除。",
    actions: [
      button("添加规则", { variant: "filled", icon: "add", onclick: () => openAddRuleSheet(load) }),
      button("规则仓库", { icon: "public", onclick: () => go("/my/rules", { tab: "shop" }) }),
    ],
  });
  const search = ruleSearch("搜索名称或站点", (v) => { keyword = v; renderList(); });
  const filters = el("div", { class: "rule-filters" });
  const note = el("div", { class: "rule-note" });
  const listNode = el("div", { class: "rule-list" });
  page.append(intro, search, filters, note, listNode);

  function renderFilters() {
    filters.innerHTML = "";
    if (!plugins) return;
    const n = plugins.length, u = plugins.filter(isUpdatable).length;
    filters.append(
      filterChip("全部 " + n, !onlyUpdatable, () => { onlyUpdatable = false; renderFilters(); renderList(); }),
      filterChip("可更新 " + u, onlyUpdatable, () => { onlyUpdatable = true; renderFilters(); renderList(); }));
    const all = button(updatingAll ? "正在更新" : "更新全部", { variant: "text", small: true, icon: "sync", onclick: updateAll });
    all.disabled = updatingAll;
    filters.append(all);
    if (selecting) {
      const vis = visible();
      const allSelected = vis.length && vis.every((p) => selected.has(p.name));
      filters.append(button(allSelected ? "取消全选" : "全选当前列表", { variant: "text", small: true, onclick: () => {
        if (allSelected) vis.forEach((p) => selected.delete(p.name));
        else vis.forEach((p) => selected.add(p.name));
        renderBar(); renderFilters(); renderList();
      } }));
    }
    note.textContent = shopVersions === null ? "暂时无法检查更新，已安装的规则仍可使用。" : "";
  }

  function renderList() {
    listNode.innerHTML = "";
    if (!plugins) return;
    if (!plugins.length) {
      listNode.append(emptyState({ icon: "extension", title: "还没有安装规则", actions: [button("规则仓库", { icon: "public", onclick: () => go("/my/rules", { tab: "shop" }) })] }));
      return;
    }
    const list = visible();
    if (!list.length) {
      listNode.append(emptyState({
        icon: "search_off", title: onlyUpdatable && !keyword ? "没有可更新的规则" : "没有符合条件的规则",
        actions: [button("显示全部规则", { onclick: () => { onlyUpdatable = false; keyword = ""; search.querySelector("input").value = ""; renderFilters(); renderList(); } })],
      }));
      return;
    }
    for (const p of list) {
      const tags = [ruleTag(p.version || "?", "tag-version")];
      if (isUpdatable(p)) tags.push(ruleTag("可更新", "tag-update"));
      let trailing;
      if (updating.has(p.name)) trailing = [el("span", { class: "loader is-small", style: "margin:12px" })];
      else if (!selecting) {
        const more = iconBtn("more_horiz", { label: p.name + " 的更多操作" });
        more.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openMenu(more, [
            { label: "检查更新", onclick: () => checkUpdate(p) },
            "divider",
            { label: "删除规则", danger: true, onclick: () => confirmDelete([p.name]) },
          ]);
        });
        trailing = [more];
      }
      listNode.append(ruleCard({
        title: p.name, subtitle: hostOf(p.baseUrl), tags, trailing,
        selected: selecting && selected.has(p.name),
        onclick: selecting ? () => { selected.has(p.name) ? selected.delete(p.name) : selected.add(p.name); renderBar(); renderFilters(); renderList(); } : null,
      }));
    }
  }

  async function checkUpdate(p) {
    if (shopVersions === null) { toast("暂时无法检查更新"); return; }
    const remote = shopVersions[p.name];
    if (!remote) { toast("规则仓库中没有当前规则"); return; }
    if (remote === p.version) { toast("规则已是最新"); return; }
    updating.add(p.name); renderList();
    try { await installRule(p.name); toast("更新成功"); }
    catch (e) { toast("更新规则失败：" + e.message); }
    updating.delete(p.name);
    await load();
  }
  async function updateAll() {
    const targets = (plugins || []).filter(isUpdatable);
    if (!targets.length) { toast("没有可更新的规则"); return; }
    updatingAll = true; renderFilters();
    toast("更新中");
    let ok = 0, fail = 0;
    for (const p of targets) {
      updating.add(p.name); renderList();
      try { await installRule(p.name); ok++; } catch (_) { fail++; }
      updating.delete(p.name);
    }
    updatingAll = false;
    toast(fail ? "更新完成：成功 " + ok + " 条，失败 " + fail + " 条" : "更新成功 " + ok + " 条");
    await load();
  }
  function confirmDelete(names) {
    if (!names.length) return;
    const shown = names.slice(0, 5).join("、") + (names.length > 5 ? " 等" : "");
    openSheet({ title: names.length === 1 ? "删除这条规则？" : "删除 " + names.length + " 条规则？", compact: true }, (body, close) => {
      body.append(
        el("div", { class: "t-title-medium", style: "font-weight:500" }, shown),
        el("div", { class: "t-body-medium c-variant", style: "margin-top:8px" }, "删除后将不再使用这些来源搜索番剧。你可以稍后重新导入规则。"),
        el("div", { class: "sheet-actions", style: "border:none;padding:24px 0 0" },
          button("保留", { variant: "text", onclick: close }),
          button("删除", { variant: "filled", cls: "btn-danger", icon: "delete_outline", onclick: async () => {
            close();
            let fail = 0;
            for (const n of names) {
              try {
                const res = await fetch("/api/rules/" + encodeURIComponent(n), { method: "DELETE" });
                if (!res.ok) fail++;
              } catch (_) { fail++; }
            }
            selecting = false; selected.clear();
            toast(fail ? "删除失败 " + fail + " 条" : "已删除 " + names.length + " 条规则");
            renderBar();
            await load();
          } })));
    });
  }

  async function load() {
    if (!plugins) listNode.append(loadingNode("", "medium"));
    try {
      plugins = await fetchJson("/api/plugins");
    } catch (e) {
      listNode.innerHTML = "";
      listNode.append(errorState({ title: "规则列表加载失败", message: e.message, compact: true, onRetry: load }));
      return;
    }
    try {
      const data = await fetchJson("/api/rules/catalog");
      shopVersions = {};
      for (const it of data.items || []) shopVersions[it.name] = it.version;
    } catch (_) { shopVersions = null; }
    renderFilters(); renderList();
  }
  renderBar();
  await load();
}

// ---- 添加规则：浏览仓库 / 剪贴板导入 / 文件导入 ----
function openAddRuleSheet(onImported) {
  openSheet({ title: "添加规则", desc: "选择一种方式，添加新的番剧来源。", compact: true }, (body, close) => {
    const option = (icon, title, desc, cls, onclick) => el("button", { class: "add-option sl " + cls, type: "button", onclick },
      iconSvg(icon), el("div", { class: "text" }, el("div", { class: "t" }, title), el("div", { class: "d" }, desc)), iconSvg("arrow_forward"));
    const file = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      close();
      importRulesText(await f.text(), onImported);
    });
    body.append(
      option("public", "浏览规则仓库", "发现并安装社区规则", "is-primary", () => { close(); go("/my/rules", { tab: "shop" }); }),
      option("content_paste", "从剪贴板导入", "粘贴规则链接或 JSON", "", async () => {
        let text = "";
        try { text = await navigator.clipboard.readText(); } catch (_) {}
        close();
        if (text && text.trim()) importRulesText(text, onImported);
        else openRuleImportSheet(onImported);
      }),
      option("download_file", "从文件导入", "读取本地 JSON 规则文件", "", () => file.click()),
      file);
  });
}
// 识别 URL / 单条 JSON / JSON 数组，逐条 POST /api/rules/import
async function importRulesText(raw, onImported) {
  const text = (raw || "").trim();
  if (!text) return false;
  const payloads = [];
  if (/^https?:\/\/\S+$/i.test(text)) payloads.push({ url: text });
  else {
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { toast("没有识别到规则，请粘贴规则链接或 JSON。"); return false; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item && typeof item === "object") payloads.push({ json: item });
    }
  }
  if (!payloads.length) { toast("没有识别到规则，请粘贴规则链接或 JSON。"); return false; }
  toast("正在导入");
  let ok = 0, fail = 0;
  for (const p of payloads) {
    try { await fetchJsonPost("/api/rules/import", p); ok++; } catch (_) { fail++; }
  }
  toast("已导入 " + ok + " 条规则" + (fail ? "，失败 " + fail + " 条" : ""));
  if (ok && onImported) onImported();
  return ok > 0;
}
function openRuleImportSheet(onImported) {
  openSheet({ title: "导入规则", desc: "支持规则链接、单条 JSON 或 JSON 数组。同名规则会被替换。" }, (body, close) => {
    const textarea = el("textarea", { class: "text-field", rows: "6", placeholder: "在这里粘贴规则链接或 JSON" });
    const importBtn = button("导入规则", { variant: "filled", icon: "download_file" });
    importBtn.addEventListener("click", async () => {
      importBtn.disabled = true;
      importBtn.querySelector(".label").textContent = "正在导入";
      const ok = await importRulesText(textarea.value, onImported);
      if (ok) close();
      else { importBtn.disabled = false; importBtn.querySelector(".label").textContent = "导入规则"; }
    });
    body.append(textarea, el("div", { class: "sheet-actions", style: "border:none;padding:16px 0 0" }, button("取消", { variant: "text", onclick: close }), importBtn));
    setTimeout(() => { try { textarea.focus(); } catch (_) {} }, 30);
  });
}

// ---- 规则仓库 ----
async function renderRuleShop() {
  $app.innerHTML = "";
  renderNavRail("my");
  window.scrollTo(0, 0);
  const bar = appBar({ title: "规则仓库", back: true, compact: true });
  const page = el("div", { class: "page narrow rules" });
  $app.append(bar, page);

  let items = null;           // 上次成功获取的目录
  let loading = false;
  let lastError = "";
  let keyword = "";
  let filter = "all";         // all | installed | updatable
  let sortByName = false;
  let busy = new Set();
  let gitProxy = null;

  const statusOf = (it) => !it.installed ? "install" : (it.version && it.installedVersion !== it.version ? "update" : "installed");
  const visible = () => (items || []).filter((it) =>
    (filter === "all" || (filter === "installed" ? it.installed : statusOf(it) === "update")) &&
    (!keyword || (it.name || "").toLowerCase().includes(keyword) || (it.author || "").toLowerCase().includes(keyword)))
    .sort(sortByName
      ? (a, b) => (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase())
      : (a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));

  page.append(ruleIntro({ title: "发现更多来源", icon: "public", desc: "浏览社区规则，为你的番剧搜索添加更多选择。" }));
  const search = ruleSearch("搜索规则或作者", (v) => { keyword = v; renderList(); });
  const filters = el("div", { class: "rule-filters" });
  const sortBtn = button("最近更新", { variant: "text", icon: "sort", cls: "c-variant" });
  sortBtn.addEventListener("click", () => openMenu(sortBtn, [
    { label: "按更新时间排序", selected: !sortByName, onclick: () => { sortByName = false; sortBtn.querySelector(".label").textContent = "最近更新"; renderList(); } },
    { label: "按名称排序", selected: sortByName, onclick: () => { sortByName = true; sortBtn.querySelector(".label").textContent = "名称排序"; renderList(); } },
  ]));
  const refreshBtn = iconBtn("refresh", { label: "刷新规则列表", cls: "is-tonal", onclick: () => load(true) });
  const progress = el("div", { class: "progress-line", style: "visibility:hidden;margin:8px 0" });
  const note = el("div", { class: "rule-note" });
  const listNode = el("div", { class: "rule-list" });
  page.append(search, filters, el("div", { class: "rule-sort-row" }, sortBtn, el("span", { style: "flex:1" }), refreshBtn), progress, note, listNode);

  function renderFilters() {
    filters.innerHTML = "";
    if (!items) return;
    const n = items.length, i = items.filter((it) => it.installed).length, u = items.filter((it) => statusOf(it) === "update").length;
    for (const [key, label] of [["all", "全部 " + n], ["installed", "已安装 " + i], ["updatable", "可更新 " + u]]) {
      filters.append(filterChip(label, filter === key, () => { filter = key; renderFilters(); renderList(); }));
    }
  }
  function actionOf(it) {
    const st = statusOf(it);
    if (st === "installed" && !busy.has(it.name)) {
      return el("span", { class: "rule-installed-text" }, iconSvg("done"), el("span", {}, "已安装"));
    }
    const working = busy.has(it.name);
    const b = button(working ? (st === "update" ? "更新中" : "安装中") : (st === "update" ? "更新" : "安装"),
      { icon: st === "update" ? "sync" : "add", cls: "rule-action" });
    b.disabled = working;
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      busy.add(it.name); renderList();
      toast(st === "update" ? "更新中" : "导入中");
      try {
        await installRule(it.name);
        it.installed = true; it.installedVersion = it.version;
        toast(st === "update" ? "更新成功" : "导入成功");
      } catch (e) { toast((st === "update" ? "更新规则失败：" : "导入规则失败：") + e.message); }
      busy.delete(it.name);
      renderFilters(); renderList();
    });
    return b;
  }
  function renderList() {
    listNode.innerHTML = "";
    if (!items) return;
    if (!items.length) { listNode.append(emptyState({ icon: "extension", title: "仓库暂无规则" })); return; }
    const list = visible();
    if (!list.length) { listNode.append(emptyState({ icon: "search_off", title: "没有符合条件的规则" })); return; }
    for (const it of list) {
      const tags = [ruleTag(it.version || "?", "tag-version")];
      if (it.antiCrawlerEnabled) tags.push(ruleTag("含验证支持", "tag-captcha"));
      listNode.append(ruleCard({
        title: it.name, subtitle: it.author ? "作者 · " + it.author : "", tags,
        caption: it.lastUpdate > 0 ? "更新于 " + new Date(it.lastUpdate).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-") : "",
        installed: statusOf(it) === "installed", trailing: [actionOf(it)],
      }));
    }
  }
  async function load(force) {
    if (loading) return;
    loading = true; lastError = "";
    refreshBtn.disabled = true;
    if (items) progress.style.visibility = "visible";
    else { listNode.innerHTML = ""; listNode.append(loadingNode("", "medium")); }
    try {
      const data = await fetchJson("/api/rules/catalog");
      items = data.items || [];
      note.textContent = "";
    } catch (e) {
      lastError = e.message;
      if (items) note.textContent = "刷新失败，正在显示上次获取的规则。";
    }
    loading = false;
    refreshBtn.disabled = false;
    progress.style.visibility = "hidden";
    if (!items) {
      listNode.innerHTML = "";
      const mirrorBtn = button(gitProxy ? "关闭规则镜像" : "启用规则镜像", { icon: "tune", onclick: async () => {
        try { await fetchJsonPut("/api/settings", { enableGitProxy: !gitProxy }); gitProxy = !gitProxy; load(true); }
        catch (e) { toast("设置失败：" + e.message); }
      } });
      listNode.append(errorState({ icon: "cloud_off", title: "无法访问规则仓库", message: "请检查网络连接，或切换规则仓库镜像后重试。", onRetry: () => load(true), actions: [mirrorBtn] }));
      return;
    }
    renderFilters(); renderList();
  }
  fetchJson("/api/settings").then((s) => { gitProxy = !!s.enableGitProxy; }).catch(() => {});
  await load(false);
}

// ============================================================
// 人机验证（web 化桌面端 source_sheet 的验证码流程）
// 自动类型由服务端 WebView 静默完成；图片验证码透传给浏览器输入。
// 成功后延迟 3 秒重试检索（对齐桌面端，避免验证通过后立刻触发限频）。
// ============================================================
function startCaptchaFlow(pluginName, keyword, onDone) {
  openSheet({ title: "人机验证", desc: pluginName, compact: true }, (body, close) => {
    body.append(loadingNode("正在加载验证页，请稍候…", "medium"));
    function finishSoon() {
      body.innerHTML = "";
      body.append(loadingNode("验证成功，正在重新检索…", "medium"));
      setTimeout(() => { close(); onDone(); }, 3000);
    }
    function showError(msg) {
      body.innerHTML = "";
      body.append(errorState({ title: "验证启动失败", message: msg, compact: true, actions: [button("关闭", { onclick: close })] }));
    }
    (async () => {
      let data;
      try {
        data = await fetchJsonPost("/api/captcha/start", { plugin: pluginName, keyword });
      } catch (e) { showError(e.message); return; }
      if (data.status === "verified") { finishSoon(); return; }
      body.innerHTML = "";
      const input = el("input", { class: "text-field", type: "text", placeholder: "输入图中的验证码", autocomplete: "off" });
      const hint = el("div", { class: "field-hint" }, "");
      const submitBtn = button("提交", { variant: "filled", icon: "done" });
      submitBtn.addEventListener("click", async () => {
        const code = input.value.trim();
        if (!code) return;
        submitBtn.disabled = true;
        try {
          const r = await fetchJsonPost("/api/captcha/submit", { plugin: pluginName, code });
          if (r.ok) { finishSoon(); return; }
          hint.textContent = "未检测到验证通过，验证码可能有误，请重试";
        } catch (e) { hint.textContent = "提交失败：" + e.message; }
        submitBtn.disabled = false;
      });
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submitBtn.click(); });
      // 对齐桌面端：取消也会保存页面已发放的 Cookie 并重试一次检索
      const cancelBtn = button("取消", { variant: "text", onclick: async () => {
        try { await fetchJsonPost("/api/captcha/cancel", {}); } catch (_) {}
        close();
        onDone();
      } });
      body.append(
        el("img", { class: "captcha-image", src: data.image, referrerpolicy: "no-referrer", alt: "验证码" }),
        input, hint,
        el("div", { class: "sheet-actions", style: "border:none;padding:16px 0 0" }, cancelBtn, submitBtn));
      setTimeout(() => { try { input.focus(); } catch (_) {} }, 30);
    })();
  });
}

// ====== Dispatch ======
function dispatch() {
  // 路由切换时收掉挂在 body 上的 sheet / menu（浏览器后退不会经过它们的 close）
  document.querySelectorAll(".sheet-mask, .menu, .toast").forEach((n) => n.remove());
  // 离开播放页时释放播放器资源（player.js）：键盘监听 + 视频解码管线
  if (typeof disposePlayerKeys === "function") disposePlayerKeys();
  if (typeof disposeActiveVideo === "function") disposeActiveVideo();
  const { path, params } = parseRoute();
  if (path === "/home" || path === "/") return renderHome(params);
  if (path === "/search") return renderSearch(params);
  if (path === "/my/history") return renderMyHistory();
  if (path === "/my/rules") return renderMyRules(params && params.tab);
  if (path === "/bangumi") return renderBangumiDetail(params);
  if (path === "/episodes") return renderEpisodes(params);
  if (path === "/play") return renderPlayer(params);
  go("/home");
}

window.addEventListener("hashchange", dispatch);

// 启动顺序：先拉主题与设置（视觉不闪、镜像开关就位），再 dispatch
loadTheme().finally(dispatch);
