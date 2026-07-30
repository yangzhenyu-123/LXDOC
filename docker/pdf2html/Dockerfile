# LXDOC pdf2htmlEX sidecar 镜像
#
# 职责：接收原始 PDF 字节流（POST /convert），返回版式保真 HTML（pdf2htmlEX 生成）
# 部署：作为独立服务，后端 PdfToolsService 通过 PDF2HTML_URL 以 HTTP 调用
#
# 二进制来源：pdf2htmlEX 官方 AppImage（GitHub Release v0.18.8.rc1，Ubuntu focal 构建）
# - AppImage 自包含大部分依赖，仅需系统提供 glibc / fontconfig / 字体
# - 构建时预解压（--appimage-extract）到 /opt/pdf2htmlex，运行时直接调 AppRun，
#   避免 FUSE 依赖与每次调用重复解压（~1-2s）
# - 注：该 AppImage 仅为 x86_64；arm64 部署需自行构建或换源
#
# 基础镜像：debian:bookworm-slim（glibc 2.36，向后兼容 focal 构建的 AppImage）
FROM debian:bookworm-slim

# 系统依赖：
# - ca-certificates / wget：下载 AppImage
# - fontconfig / libfreetype6：pdf2htmlEX 渲染依赖
# - fonts-noto-cjk：中文字体，避免中文 PDF 显示方块
# - python3：运行 stdlib HTTP server（无需 pip 包）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
        fontconfig \
        libfreetype6 \
        fonts-noto-cjk \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# 下载 pdf2htmlEX AppImage（固定版本，保证可复现）
# 可通过 --build-arg PDF2HTML_APPIMAGE_URL 覆盖（如内网镜像源）
ARG PDF2HTML_APPIMAGE_URL=https://github.com/pdf2htmlEX/pdf2htmlEX/releases/download/v0.18.8.rc1/pdf2htmlEX-0.18.8.rc1-master-20200630-Ubuntu-focal-x86_64.AppImage
RUN wget -q -O /opt/pdf2htmlEX.AppImage "${PDF2HTML_APPIMAGE_URL}" \
    && chmod +x /opt/pdf2htmlEX.AppImage \
    # 预解压 AppImage 到 /opt/pdf2htmlex，运行时直接调 AppRun（无需 FUSE）
    && cd /opt && ./pdf2htmlEX.AppImage --appimage-extract \
    && mv squashfs-root pdf2htmlex \
    # 冒烟测试：确认 AppRun 可执行（--version 输出版本号即可）
    && /opt/pdf2htmlex/AppRun --version

COPY server.py /opt/server.py

ENV PYTHONUNBUFFERED=1
ENV PORT=7000

EXPOSE 7000

# 健康检查：探 /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:7000/health',timeout=3).status==200 else 1)"

CMD ["python3", "/opt/server.py"]
