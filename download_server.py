"""
Bilal Downloader - Local Download Server
Runs on port 9876 and receives download requests from the extension.
Uses yt-dlp to download YouTube videos and other supported sites.
"""

import sys
sys.dont_write_bytecode = True  # Prevent __pycache__ creation (causes Chrome extension errors)

import json
import os
import subprocess
import threading
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote

# Download directory
DOWNLOAD_DIR = os.path.join(os.path.expanduser("~"), "Downloads")
PORT = 9876


def find_ytdlp():
    """Search for yt-dlp in all possible paths"""
    import shutil

    # 1: In the same directory
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yt-dlp.exe")
    if os.path.exists(local):
        return [local]

    # 2: In system PATH
    path = shutil.which("yt-dlp")
    if path:
        return [path]

    # 3: In various Python Scripts directories
    scripts_dirs = [
        os.path.join(sys.prefix, "Scripts"),
        os.path.join(sys.base_prefix, "Scripts"),
        os.path.join(os.path.expanduser("~"), "AppData", "Local", "Programs", "Python", "Scripts"),
        os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Python", "Scripts"),
        os.path.join(os.path.expanduser("~"), "AppData", "Local", "Packages"),  # MS Store Python
    ]
    # Add all Python* Scripts directories
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
    """Get yt-dlp command (searches each time to make sure it's found)"""
    global _ytdlp_cache
    if _ytdlp_cache is not None:
        return _ytdlp_cache
    _ytdlp_cache = find_ytdlp()
    return _ytdlp_cache


_ytdlp_cache = find_ytdlp()


class DownloadHandler(BaseHTTPRequestHandler):
    """Download request handler"""

    def log_message(self, format, *args):
        """Compact logging"""
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
        """Check server status"""
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
        """Handle download requests"""
        if self.path not in ("/download", "/playlist-info"):
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

        # Search for yt-dlp (retries each time)
        global _ytdlp_cache
        ytdlp_cmd = get_ytdlp_cmd()
        if not ytdlp_cmd:
            # Retry search (may have been installed after server started)
            _ytdlp_cache = None
            ytdlp_cmd = get_ytdlp_cmd()
        if not ytdlp_cmd:
            self._send_json(500, {
                "error": "yt-dlp not found! Install it with: pip install yt-dlp",
                "install_cmd": "pip install yt-dlp"
            })
            return

        # ===== Playlist info =====
        if self.path == "/playlist-info":
            self._handle_playlist_info(url, ytdlp_cmd)
            return

        # Download options
        quality = body.get("quality", "best")  # best, 720, 480, 360, audio
        site = body.get("site", "")
        title = body.get("title", "")
        is_playlist = body.get("playlist", False)  # Whether to download full playlist
        playlist_items = body.get("playlist_items", "")  # e.g. "1-5" or "" for all

        # Build yt-dlp command (ytdlp_cmd may be ["yt-dlp.exe"] or ["python", "-m", "yt_dlp"])
        cmd = list(ytdlp_cmd)

        # Quality selection
        if quality == "audio":
            cmd += ["-f", "bestaudio", "-x", "--audio-format", "mp3"]
        elif quality == "best":
            cmd += ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"]
        elif quality in ("720", "480", "360"):
            cmd += ["-f", f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<={quality}][ext=mp4]/best"]
        else:
            cmd += ["-f", "best[ext=mp4]/best"]

        # Save path
        if is_playlist:
            # Subdirectory named after playlist + numbered videos
            cmd += ["-o", os.path.join(DOWNLOAD_DIR, "%(playlist_title)s", "%(playlist_index)03d - %(title)s.%(ext)s")]
            cmd += ["--yes-playlist"]
            if playlist_items:
                cmd += ["--playlist-items", playlist_items]
        else:
            cmd += ["-o", os.path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s")]
            cmd += ["--no-playlist"]

        # Additional options
        cmd += [
            "--no-check-certificates",
            "--merge-output-format", "mp4",  # Merge into MP4
            "--embed-thumbnail",       # Embed thumbnail
            "--add-metadata",          # Add metadata
            "--js-runtimes", "node",     # Use Node.js for YouTube decryption
        ]

        # Add URL
        cmd.append(url)

        mode_text = "playlist" if is_playlist else "single video"
        print(f"\n[Download] Starting download ({mode_text}): {url}")
        print(f"[Download] Quality: {quality}")
        if is_playlist and playlist_items:
            print(f"[Download] Videos: {playlist_items}")
        print(f"[Download] Command: {' '.join(cmd)}")

        # Run download in a separate thread
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
                    print(f"[Download] ✅ Download completed successfully!")
                else:
                    print(f"[Download] ❌ Download failed (code: {process.returncode})")
            except Exception as e:
                print(f"[Download] ❌ Error: {e}")

        thread = threading.Thread(target=run_download, daemon=True)
        thread.start()

        self._send_json(200, {
            "success": True,
            "message": "Download started! Check the server window for progress",
            "download_dir": DOWNLOAD_DIR,
            "playlist": is_playlist
        })

    def _handle_playlist_info(self, url, ytdlp_cmd):
        """Fetch playlist info (video count, title, etc.)"""
        cmd = list(ytdlp_cmd) + [
            "--flat-playlist",
            "--dump-json",
            "--no-check-certificates",
            "--js-runtimes", "node",
            "--yes-playlist",
            url
        ]
        print(f"\n[Playlist Info] Fetching info: {url}")

        try:
            process = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )

            if process.returncode != 0:
                err_msg = process.stderr.strip() if process.stderr else "Unknown error"
                print(f"[Playlist Info] ❌ Failed: {err_msg}")
                self._send_json(500, {"error": f"Failed to fetch playlist info: {err_msg}"})
                return

            # Each line is a JSON object for one video
            lines = [l.strip() for l in process.stdout.strip().split("\n") if l.strip()]
            videos = []
            playlist_title = ""
            for line in lines:
                try:
                    entry = json.loads(line)
                    video_info = {
                        "title": entry.get("title", "Untitled"),
                        "url": entry.get("url", ""),
                        "duration": entry.get("duration"),
                        "id": entry.get("id", ""),
                    }
                    videos.append(video_info)
                    if not playlist_title:
                        playlist_title = entry.get("playlist_title", "")
                except json.JSONDecodeError:
                    continue

            print(f"[Playlist Info] ✅ Found {len(videos)} videos in '{playlist_title}'")
            self._send_json(200, {
                "success": True,
                "playlist_title": playlist_title,
                "count": len(videos),
                "videos": videos[:200],  # Max 200 videos in info response
            })

        except subprocess.TimeoutExpired:
            print("[Playlist Info] ❌ Timed out")
            self._send_json(500, {"error": "Timed out! The playlist is too large"})
        except Exception as e:
            print(f"[Playlist Info] ❌ Error: {e}")
            self._send_json(500, {"error": str(e)})


def main():
    print("=" * 50)
    print("  Bilal Downloader - Download Server")
    print("=" * 50)
    print(f"  Port: {PORT}")
    print(f"  Download directory: {DOWNLOAD_DIR}")

    if _ytdlp_cache:
        print(f"  yt-dlp: ✅ {_ytdlp_cache}")
    else:
        print("  yt-dlp: ❌ Not found!")
        print("  Install it with: pip install yt-dlp")
        print("  (Server will search again when a download is requested)")
        print()

    print("=" * 50)
    print("  Server is running... Do not close this window")
    print("=" * 50)
    print()

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    server = HTTPServer(("127.0.0.1", PORT), DownloadHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Server] Server stopped")
        server.server_close()


if __name__ == "__main__":
    main()
