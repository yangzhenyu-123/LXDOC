#!/usr/bin/env python3
"""
pdf2htmlEX HTTP 转换服务（sidecar）

路由：
- POST /convert：请求体为原始 PDF 字节流，返回版式保真 HTML（pdf2htmlEX 生成）
- GET  /health：健康检查，返回 "ok"

设计要点：
- 仅依赖 Python 标准库（http.server / subprocess / tempfile），无需安装 Flask 等框架
- 每次请求将 PDF 写入临时文件，调用 pdf2htmlEX 生成 HTML，返回后清理临时目录
- 线程模型：ThreadingHTTPServer，支持并发（后端已按 docId#version 去重，实际并发有限）
- 安全：仅接受 POST /convert 与 GET /health；限制请求体 50MB；非 convert 路径返回 404
- 二进制入口：优先用镜像构建时预解压的 AppRun（无需 FUSE、无需每次解压），
  若不存在则回退到 AppImage --appimage-extract-and-run（每次调用解压，较慢但更鲁棒）
"""
import http.server
import os
import shutil
import socketserver
import subprocess
import tempfile

PORT = int(os.environ.get("PORT", "7000"))
# 预解压目录中的 AppRun（构建时由 --appimage-extract 生成）
APP_RUN = os.environ.get("PDF2HTML_BIN", "/opt/pdf2htmlex/AppRun")
APP_IMAGE = "/opt/pdf2htmlEX.AppImage"
# AppRun 直接链接到 pdf2htmlEX 二进制，没有 AppImage runtime 设置数据目录，
# 需显式指定 --data-dir 与 --poppler-data-dir，否则报 "Cannot open the manifest file"
DATA_DIR = "/opt/pdf2htmlex/usr/local/share/pdf2htmlEX"
POPPLER_DATA_DIR = "/opt/pdf2htmlex/usr/local/share/pdf2htmlEX/poppler"
MAX_BODY = 50 * 1024 * 1024  # 50MB
TIMEOUT = 120  # 单次转换超时（秒），与后端 runBinary 默认超时对齐


def resolve_bin():
    """返回 pdf2htmlEX 可执行命令（列表），优先 AppRun，回退 AppImage"""
    if os.path.exists(APP_RUN) and os.access(APP_RUN, os.X_OK):
        return [APP_RUN]
    return [APP_IMAGE, "--appimage-extract-and-run"]


def convert(pdf_path, out_path):
    """调用 pdf2htmlEX 将 pdf_path 转为 out_path（HTML）"""
    cmd = resolve_bin() + [
        "--zoom", "1.3",
        # 嵌入 css/font/image/javascript 到输出 HTML，产出单文件
        # 注意：pdf2htmlEX 0.18.8 的 --embed <string> 不支持 'h' 字符，
        # 故用单独的 --embed-* 选项代替 --embed cfij，兼容性更好
        "--embed-css", "1",
        "--embed-font", "1",
        "--embed-image", "1",
        "--embed-javascript", "1",
        # AppRun 无 AppImage runtime 环境，需显式指定数据目录
        "--data-dir", DATA_DIR,
        "--poppler-data-dir", POPPLER_DATA_DIR,
        pdf_path,
        out_path,
    ]
    subprocess.run(
        cmd,
        timeout=TIMEOUT,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # 静默默认访问日志，避免 stderr 噪音（错误已在响应中体现）
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, "ok")
        else:
            self._send(404, "not found")

    def do_POST(self):
        if self.path != "/convert":
            self._send(404, "not found")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, "invalid Content-Length")
            return
        if length <= 0 or length > MAX_BODY:
            self._send(413, "request body too large or empty")
            return
        body = self.rfile.read(length)
        tmpdir = tempfile.mkdtemp(prefix="p2h_")
        pdf_path = os.path.join(tmpdir, "in.pdf")
        out_path = os.path.join(tmpdir, "out.html")
        try:
            with open(pdf_path, "wb") as f:
                f.write(body)
            convert(pdf_path, out_path)
            if not os.path.exists(out_path):
                self._send(502, "pdf2htmlEX produced no output")
                return
            with open(out_path, "rb") as f:
                html = f.read()
            self._send(200, html, "text/html; charset=utf-8")
        except subprocess.TimeoutExpired:
            self._send(504, "pdf2htmlEX conversion timeout")
        except subprocess.CalledProcessError as e:
            err = (e.stderr or b"").decode("utf-8", "replace")[:500]
            self._send(502, f"pdf2htmlEX failed: {err}")
        except Exception as e:  # noqa: BLE001
            self._send(500, f"server error: {e}")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    server = ThreadingServer(("0.0.0.0", PORT), Handler)
    print(f"[pdf2html] listening on :{PORT}, bin={resolve_bin()}", flush=True)
    server.serve_forever()
