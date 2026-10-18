# KazumiWeb 容器化部署（Linux + xvfb 虚拟显示）
#
# Flutter 桌面与 webkitgtk WebView（视频源解析的硬依赖）都需要显示环境，
# 容器内用 xvfb 提供虚拟 X display——这是 Flutter 桌面应用容器化的标准解法。
#
#   docker build -t kazumi-web .
#   docker run -d --network host -v kazumi-data:/data kazumi-web
#
# 详见 docs/deployment.md（含 --network host 与端口映射的取舍）。

# ---- 构建阶段：Flutter SDK + Linux 桌面工具链 ----
FROM ghcr.io/cirruslabs/flutter:3.44.0 AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      clang cmake ninja-build pkg-config \
      libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY pubspec.yaml pubspec.lock ./
RUN flutter pub get
COPY . .

# 弹幕（dandanplay）与 Bangumi 镜像检索凭证，缺省时对应功能不可用、其余不受影响：
#   docker build --build-arg DANDANAPI_APPID=... --build-arg DANDANAPI_KEY=... .
ARG DANDANAPI_APPID=
ARG DANDANAPI_KEY=
ARG KAZUMI_APPID=
ARG KAZUMI_KEY=
RUN flutter config --enable-linux-desktop \
    && flutter build linux --release \
         --dart-define=DANDANAPI_APPID="${DANDANAPI_APPID}" \
         --dart-define=DANDANAPI_KEY="${DANDANAPI_KEY}" \
         --dart-define=KAZUMI_APPID="${KAZUMI_APPID}" \
         --dart-define=KAZUMI_KEY="${KAZUMI_KEY}" \
    && mv build/linux/*/release/bundle /bundle

# ---- 运行阶段：最小运行时 + xvfb ----
# 必须与构建镜像同发行版（cirruslabs/flutter 基于 Ubuntu 24.04），否则 glib 等 ABI 不匹配
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 \
      xvfb xauth tini \
      fonts-noto-cjk \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /bundle/ /app/
# web/ 静态资源需在可执行文件旁（发行布局约定）
COPY --from=build /src/web/ /app/web/

# XDG_DATA_HOME 决定 getApplicationSupportDirectory 的落点 → 挂卷持久化
ENV KAZUMI_WEB_HEADLESS=1 \
    KAZUMI_WEB_PORT=8333 \
    XDG_DATA_HOME=/data

VOLUME /data
EXPOSE 8333

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fs "http://127.0.0.1:${KAZUMI_WEB_PORT}/api/about" || exit 1

# xvfb-run -a：自动挑选空闲 display，虚拟屏幕供 Flutter/webkitgtk 渲染
# tini 作 PID 1：xvfb-run 当 PID 1 时收不到 Xvfb 的就绪信号会永久挂起
ENTRYPOINT ["tini", "--", "xvfb-run", "-a", "-s", "-screen 0 1280x720x24", "/app/kazumi_web"]
