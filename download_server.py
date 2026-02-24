"""
Bilal Downloader - سيرفر التحميل المحلي
يعمل على المنفذ 9876 ويستقبل طلبات التحميل من الإضافة
يستخدم yt-dlp لتحميل فيديوهات YouTube والمواقع الأخرى
"""

import sys
sys.dont_write_bytecode = True  # منع إنشاء __pycache__ (يسبب خطأ لإضافة Chrome)

import json
import os
import subprocess
import threading
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote

# مجلد التحميل
DOWNLOAD_DIR = os.path.join(os.path.expanduser("~"), "Downloads")
PORT = 9876


def find_ytdlp():
    """البحث عن yt-dlp في كل المسارات الممكنة"""
    import shutil

    # 1: في نفس المجلد
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yt-dlp.exe")
    if os.path.exists(local):
        return [local]

    # 2: في PATH
    path = shutil.which("yt-dlp")
    if path:
        return [path]

    # 3: في مجلدات Python Scripts المختلفة
    scripts_dirs = [
        os.path.join(sys.prefix, "Scripts"),
        os.path.join(sys.base_prefix, "Scripts"),
        os.path.join(os.path.expanduser("~"), "AppData", "Local", "Programs", "Python", "Scripts"),
        os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Python", "Scripts"),
        os.path.join(os.path.expanduser("~"), "AppData", "Local", "Packages"),  # MS Store Python
    ]
    # إضافة كل مجلدات Python* Scripts
    local_programs = os.path.join(os.path.expanduser("~"), "AppData", "Local", "Programs", "Python")
    if os.path.isdir(local_programs):
        for d in os.listdir(local_programs):
            scripts_dirs.append(os.path.join(local_programs, d, "Scripts"))
    roaming_python = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Python")
    if os.path.isdir(roaming_python):
        for d in os.listdir(roaming_python):
            scripts_dirs.append(os.path.join(roaming_python, d, "Scripts"))

    for scripts_dir in scripts_dirs:
        candidate = os.path.join(scripts_dir, "yt-dlp.exe")
        if os.path.exists(candidate):
            return [candidate]

    # 4: Fallback — python -m yt_dlp
    try:
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp", "--version"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        pass

    return None


def get_ytdlp_cmd():
    """جلب أمر yt-dlp (يبحث كل مرة للتأكد)"""
    global _ytdlp_cache
    if _ytdlp_cache is not None:
        return _ytdlp_cache
    _ytdlp_cache = find_ytdlp()
    return _ytdlp_cache


_ytdlp_cache = find_ytdlp()


class DownloadHandler(BaseHTTPRequestHandler):
    """معالج طلبات التحميل"""

    def log_message(self, format, *args):
        """تسجيل مختصر"""
        print(f"[Server] {args[0]}")

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        """فحص حالة السيرفر"""
        if self.path == "/status":
            ytdlp = get_ytdlp_cmd()
            self._send_json(200, {
                "running": True,
                "ytdlp": ytdlp is not None,
                "ytdlp_path": str(ytdlp) if ytdlp else "not found",
                "download_dir": DOWNLOAD_DIR
            })
        elif self.path == "/ping":
            self._send_json(200, {"pong": True})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        """معالجة طلبات التحميل"""
        if self.path != "/download":
            self._send_json(404, {"error": "not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
        except Exception as e:
            self._send_json(400, {"error": f"Invalid request: {e}"})
            return

        url = body.get("url", "").strip()
        if not url:
            self._send_json(400, {"error": "URL is required"})
            return

        # البحث عن yt-dlp (يعيد المحاولة كل مرة)
        global _ytdlp_cache
        ytdlp_cmd = get_ytdlp_cmd()
        if not ytdlp_cmd:
            # إعادة البحث (لعله تم التثبيت بعد تشغيل السيرفر)
            _ytdlp_cache = None
            ytdlp_cmd = get_ytdlp_cmd()
        if not ytdlp_cmd:
            self._send_json(500, {
                "error": "yt-dlp غير موجود! ثبته بالأمر: pip install yt-dlp",
                "install_cmd": "pip install yt-dlp"
            })
            return

        # خيارات التحميل
        quality = body.get("quality", "best")  # best, 720, 480, 360, audio
        site = body.get("site", "")
        title = body.get("title", "")

        # بناء أمر yt-dlp (ytdlp_cmd قد يكون ["yt-dlp.exe"] أو ["python", "-m", "yt_dlp"])
        cmd = list(ytdlp_cmd)

        # اختيار الجودة
        if quality == "audio":
            cmd += ["-f", "bestaudio", "-x", "--audio-format", "mp3"]
        elif quality == "best":
            cmd += ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"]
        elif quality in ("720", "480", "360"):
            cmd += ["-f", f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<={quality}][ext=mp4]/best"]
        else:
            cmd += ["-f", "best[ext=mp4]/best"]

        # مسار الحفظ
        cmd += ["-o", os.path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s")]

        # خيارات إضافية
        cmd += [
            "--no-playlist",           # فيديو واحد فقط
            "--no-check-certificates",
            "--merge-output-format", "mp4",  # دمج في MP4
            "--embed-thumbnail",       # إضافة الصورة المصغرة
            "--add-metadata",          # إضافة البيانات الوصفية
            "--js-runtimes", "node",     # استخدام Node.js لفك تشفير YouTube
        ]

        # إضافة الرابط
        cmd.append(url)

        print(f"\n[Download] بدء تحميل: {url}")
        print(f"[Download] الجودة: {quality}")
        print(f"[Download] الأمر: {' '.join(cmd)}")

        # تشغيل التحميل في thread منفصل
        def run_download():
            try:
                process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
                )
                for line in process.stdout:
                    line = line.strip()
                    if line:
                        print(f"  [yt-dlp] {line}")
                process.wait()
                if process.returncode == 0:
                    print(f"[Download] ✅ تم التحميل بنجاح!")
                else:
                    print(f"[Download] ❌ فشل التحميل (code: {process.returncode})")
            except Exception as e:
                print(f"[Download] ❌ خطأ: {e}")

        thread = threading.Thread(target=run_download, daemon=True)
        thread.start()

        self._send_json(200, {
            "success": True,
            "message": "بدأ التحميل! تابع في نافذة السيرفر",
            "download_dir": DOWNLOAD_DIR
        })


def main():
    print("=" * 50)
    print("  Bilal Downloader - سيرفر التحميل")
    print("=" * 50)
    print(f"  المنفذ: {PORT}")
    print(f"  مجلد التحميل: {DOWNLOAD_DIR}")

    if _ytdlp_cache:
        print(f"  yt-dlp: ✅ {_ytdlp_cache}")
    else:
        print("  yt-dlp: ❌ غير موجود!")
        print("  ثبته بالأمر: pip install yt-dlp")
        print("  (السيرفر سيبحث مرة ثانية عند التحميل)")
        print()

    print("=" * 50)
    print("  السيرفر يعمل... لا تقفل هذي النافذة")
    print("=" * 50)
    print()

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    server = HTTPServer(("127.0.0.1", PORT), DownloadHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Server] تم إيقاف السيرفر")
        server.server_close()


if __name__ == "__main__":
    main()
