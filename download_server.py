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
import socket
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote

# Download directory
DOWNLOAD_DIR = os.path.join(os.path.expanduser("~"), "Downloads")
PORT = 9876
NOT_FOUND = "not found"
YTDLP_INSTALL_CMD = "pip install yt-dlp"


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

MAX_NETWORK_WAIT = 300  # Max seconds to wait for network (5 min)
NETWORK_CHECK_INTERVAL = 10  # Seconds between connectivity checks
FAILED_ITEM_RETRY_DELAY = 15  # Seconds to wait before retrying failed items
MAX_RETRY_ROUNDS = 3  # Max retry rounds for failed playlist items


def get_quality_args(quality):
    """Build yt-dlp quality selection arguments."""
    if quality == "audio":
        return ["-f", "bestaudio", "-x", "--audio-format", "mp3"]
    if quality == "best":
        return ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"]
    if quality in ("720", "480", "360"):
        return ["-f", f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<={quality}][ext=mp4]/best"]
    return ["-f", "best[ext=mp4]/best"]


def get_output_args(is_playlist, playlist_items):
    """Build yt-dlp output path and playlist mode arguments."""
    if is_playlist:
        args = [
            "-o", os.path.join(DOWNLOAD_DIR, "%(playlist_title)s", "%(playlist_index)03d - %(title)s.%(ext)s"),
            "--yes-playlist",
        ]
        if playlist_items:
            args += ["--playlist-items", playlist_items]
        return args
    return [
        "-o", os.path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s"),
        "--no-playlist",
    ]


def get_common_ytdlp_args():
    """Build common yt-dlp arguments used for both regular and retry downloads."""
    return [
        "--no-check-certificates",
        "--merge-output-format", "mp4",
        "--embed-thumbnail",
        "--add-metadata",
        "--js-runtimes", "node",
        "--retries", "10",
        "--fragment-retries", "10",
        "--retry-sleep", "exp=1:2:60",
    ]


def build_download_command(ytdlp_cmd, url, quality, is_playlist, playlist_items):
    """Build full yt-dlp command for a download request."""
    cmd = list(ytdlp_cmd)
    cmd += get_quality_args(quality)
    cmd += get_output_args(is_playlist, playlist_items)
    cmd += get_common_ytdlp_args()
    cmd.append(url)
    return cmd


def build_retry_command(ytdlp_cmd, vid_url, quality):
    """Build yt-dlp command for retrying a single playlist item."""
    retry_cmd = list(ytdlp_cmd)
    retry_cmd += get_quality_args(quality)
    retry_cmd += [
        "-o", os.path.join(DOWNLOAD_DIR, "%(playlist_title)s", "%(playlist_index)03d - %(title)s.%(ext)s"),
        "--no-playlist",
    ]
    retry_cmd += get_common_ytdlp_args()
    retry_cmd.append(vid_url)
    return retry_cmd


def run_download_job(cmd, ytdlp_cmd, quality, is_playlist):
    """Run yt-dlp download command and retry failed playlist items on network errors."""
    try:
        failed_ids = []
        network_error_pattern = re.compile(
            r'ERROR:.*?(\w{11}):.*?(getaddrinfo failed|Network is unreachable|Connection refused|timed out|Connection reset|URLError)',
            re.IGNORECASE
        )

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
                match = network_error_pattern.search(line)
                if match:
                    video_id = match.group(1)
                    if video_id not in failed_ids:
                        failed_ids.append(video_id)
        process.wait()

        if process.returncode == 0:
            print("[Download] ✅ Download completed successfully!")
        else:
            print(f"[Download] ❌ Download failed (code: {process.returncode})")

        if failed_ids and is_playlist:
            print(f"\n[Retry] {len(failed_ids)} video(s) failed due to network errors: {failed_ids}")
            retry_round = 0
            while failed_ids and retry_round < MAX_RETRY_ROUNDS:
                retry_round += 1
                print(f"\n[Retry] === Round {retry_round}/{MAX_RETRY_ROUNDS} ===")
                print(f"[Retry] Waiting {FAILED_ITEM_RETRY_DELAY}s before retrying...")
                time.sleep(FAILED_ITEM_RETRY_DELAY)

                if not check_network():
                    print("[Retry] ⚠️ No internet connection detected")
                    if not wait_for_network():
                        print("[Retry] ❌ Giving up - no internet")
                        break

                still_failed = []
                for vid_id in failed_ids:
                    vid_url = f"https://www.youtube.com/watch?v={vid_id}"
                    print(f"\n[Retry] Retrying: {vid_url}")

                    retry_cmd = build_retry_command(ytdlp_cmd, vid_url, quality)
                    retry_proc = subprocess.Popen(
                        retry_cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
                    )
                    retry_had_error = False
                    for rline in retry_proc.stdout:
                        rline = rline.strip()
                        if rline:
                            print(f"  [yt-dlp] {rline}")
                            if network_error_pattern.search(rline):
                                retry_had_error = True
                    retry_proc.wait()

                    if retry_proc.returncode == 0:
                        print(f"[Retry] ✅ {vid_id} downloaded successfully!")
                    else:
                        print(f"[Retry] ❌ {vid_id} still failed")
                        still_failed.append(vid_id)
                        if retry_had_error and not check_network():
                            print("[Retry] ⚠️ Network down again, waiting...")
                            if not wait_for_network():
                                still_failed.extend([v for v in failed_ids if v not in still_failed and v != vid_id])
                                break

                failed_ids = still_failed

            if failed_ids:
                print(f"\n[Retry] ❌ {len(failed_ids)} video(s) could not be downloaded after all retries:")
                for vid_id in failed_ids:
                    print(f"  - https://www.youtube.com/watch?v={vid_id}")
            else:
                print("\n[Retry] ✅ All failed videos recovered successfully!")

    except Exception as e:
        print(f"[Download] ❌ Error: {e}")


def check_network(host="www.youtube.com", port=443, timeout=5):
    """Check if we can reach YouTube (DNS + TCP)"""
    try:
        socket.setdefaulttimeout(timeout)
        socket.socket(socket.AF_INET, socket.SOCK_STREAM).connect((host, port))
        return True
    except (socket.error, OSError):
        return False


def wait_for_network(max_wait=MAX_NETWORK_WAIT):
    """Wait until network is available. Returns True if restored, False if timed out."""
    print(f"[Network] ⏳ Waiting for internet connection (up to {max_wait}s)...")
    elapsed = 0
    while elapsed < max_wait:
        if check_network():
            print(f"[Network] ✅ Connection restored after {elapsed}s")
            return True
        time.sleep(NETWORK_CHECK_INTERVAL)
        elapsed += NETWORK_CHECK_INTERVAL
        print(f"[Network] Still waiting... ({elapsed}s / {max_wait}s)")
    print(f"[Network] ❌ No connection after {max_wait}s")
    return False


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

    def _handle_download_request(self, body):
        """Handles the main download logic."""
        url = body.get("url", "").strip()
        if not url:
            self._send_json(400, {"error": "URL is required"})
            return

        ytdlp_cmd = get_ytdlp_cmd()
        if not ytdlp_cmd:
            self._send_json(500, {
                "error": "yt-dlp not found! Install it with: pip install yt-dlp",
                "install_cmd": "pip install yt-dlp"
            })
            return

        quality = body.get("quality", "best")
        is_playlist = body.get("playlist", False)
        playlist_items = body.get("playlist_items", "")

        cmd = list(ytdlp_cmd)

        if quality == "audio":
            cmd += ["-f", "bestaudio", "-x", "--audio-format", "mp3"]
        elif quality == "best":
            cmd += ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"]
        elif quality in ("720", "480", "360"):
            cmd += ["-f", f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<={quality}][ext=mp4]/best"]
        else:
            cmd += ["-f", "best[ext=mp4]/best"]

        if is_playlist:
            cmd += ["-o", os.path.join(DOWNLOAD_DIR, "%(playlist_title)s", "%(playlist_index)03d - %(title)s.%(ext)s")]
            cmd += ["--yes-playlist"]
            if playlist_items:
                cmd += ["--playlist-items", playlist_items]
        else:
            cmd += ["-o", os.path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s")]
            cmd += ["--no-playlist"]

        cmd += [
            "--no-check-certificates", "--merge-output-format", "mp4",
            "--embed-thumbnail", "--add-metadata", "--js-runtimes", "node",
            "--retries", "10", "--fragment-retries", "10", "--retry-sleep", "exp=1:2:60",
        ]
        cmd.append(url)

        mode_text = "playlist" if is_playlist else "single video"
        print(f"\n[Download] Starting download ({mode_text}): {url}")
        print(f"[Download] Quality: {quality}")
        if is_playlist and playlist_items:
            print(f"[Download] Videos: {playlist_items}")
        print(f"[Download] Command: {' '.join(cmd)}")

        thread = threading.Thread(target=self._run_download_thread, args=(cmd, quality, is_playlist), daemon=True)
        thread.start()

        self._send_json(200, {
            "success": True,
            "message": "Download started! Check the server window for progress",
            "download_dir": DOWNLOAD_DIR,
            "playlist": is_playlist
        })

    def _run_download_thread(self, cmd, quality, is_playlist):
        """The thread that runs the download process."""
        try:
            failed_ids = []
            network_error_pattern = re.compile(
                r'ERROR:.*?(\w{11}):.*?(getaddrinfo failed|Network is unreachable|Connection refused|timed out|Connection reset|URLError)',
                re.IGNORECASE
            )

            process = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                encoding="utf-8", errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )
            for line in process.stdout:
                line = line.strip()
                if line:
                    print(f"  [yt-dlp] {line}")
                    match = network_error_pattern.search(line)
                    if match:
                        video_id = match.group(1)
                        if video_id not in failed_ids:
                            failed_ids.append(video_id)
            process.wait()

            if process.returncode == 0:
                print("[Download] ✅ Download completed successfully!")
            else:
                print(f"[Download] ❌ Download failed (code: {process.returncode})")

            if failed_ids and is_playlist:
                self._retry_failed_downloads(failed_ids, quality)

        except Exception as e:
            print(f"[Download] ❌ Error: {e}")

    def _retry_failed_downloads(self, failed_ids, quality):
        """Retry downloading items that failed due to network issues."""
        print(f"\n[Retry] {len(failed_ids)} video(s) failed due to network errors: {failed_ids}")
        retry_round = 0
        while failed_ids and retry_round < MAX_RETRY_ROUNDS:
            retry_round += 1
            print(f"\n[Retry] === Round {retry_round}/{MAX_RETRY_ROUNDS} ===")
            print(f"[Retry] Waiting {FAILED_ITEM_RETRY_DELAY}s before retrying...")
            time.sleep(FAILED_ITEM_RETRY_DELAY)

            if not check_network():
                print("[Retry] ⚠️ No internet connection detected")
                if not wait_for_network():
                    print("[Retry] ❌ Giving up - no internet")
                    break

            failed_ids = self._process_retry_items(failed_ids, quality)

        if failed_ids:
            print(f"\n[Retry] ❌ {len(failed_ids)} video(s) could not be downloaded after all retries:")
            for vid_id in failed_ids:
                print(f"  - https://www.youtube.com/watch?v={vid_id}")
        else:
            print("\n[Retry] ✅ All failed videos recovered successfully!")

    def _process_retry_items(self, failed_ids, quality):
        """Process each item in the retry queue."""
        still_failed = []
        network_error_pattern = re.compile(
            r'ERROR:.*?(\w{11}):.*?(getaddrinfo failed|Network is unreachable|Connection refused|timed out|Connection reset|URLError)',
            re.IGNORECASE
        )
        ytdlp_cmd = get_ytdlp_cmd()

        for vid_id in failed_ids:
            vid_url = f"https://www.youtube.com/watch?v={vid_id}"
            print(f"\n[Retry] Retrying: {vid_url}")

            retry_cmd = list(ytdlp_cmd)
            if quality == "audio":
                retry_cmd += ["-f", "bestaudio", "-x", "--audio-format", "mp3"]
            elif quality == "best":
                retry_cmd += ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"]
            elif quality in ("720", "480", "360"):
                retry_cmd += ["-f", f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<={quality}][ext=mp4]/best"]
            else:
                retry_cmd += ["-f", "best[ext=mp4]/best"]
            
            retry_cmd += ["-o", os.path.join(DOWNLOAD_DIR, "%(playlist_title)s", "%(playlist_index)03d - %(title)s.%(ext)s")]
            retry_cmd += [
                "--no-playlist", "--no-check-certificates", "--merge-output-format", "mp4",
                "--embed-thumbnail", "--add-metadata", "--js-runtimes", "node",
                "--retries", "10", "--fragment-retries", "10", "--retry-sleep", "exp=1:2:60",
                vid_url
            ]

            retry_proc = subprocess.Popen(
                retry_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                encoding="utf-8", errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )
            retry_had_error = False
            for rline in retry_proc.stdout:
                rline = rline.strip()
                if rline:
                    print(f"  [yt-dlp] {rline}")
                    if network_error_pattern.search(rline):
                        retry_had_error = True
            retry_proc.wait()

            if retry_proc.returncode == 0:
                print(f"[Retry] ✅ {vid_id} downloaded successfully!")
            else:
                print(f"[Retry] ❌ {vid_id} still failed")
                still_failed.append(vid_id)
                if retry_had_error and not check_network():
                    print("[Retry] ⚠️ Network down again, waiting...")
                    if not wait_for_network():
                        still_failed.extend([v for v in failed_ids if v not in still_failed and v != vid_id])
                        break
        return still_failed

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

        if self.path == "/playlist-info":
            url = body.get("url", "").strip()
            if not url:
                self._send_json(400, {"error": "URL is required"})
                return
            ytdlp_cmd = get_ytdlp_cmd()
            if not ytdlp_cmd:
                self._send_json(500, {"error": "yt-dlp not found!"})
                return
            self._handle_playlist_info(url, ytdlp_cmd)
        elif self.path == "/download":
            self._handle_download_request(body)

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
