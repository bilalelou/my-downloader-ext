# Bilal Downloader 🚀

A smart Chrome extension for downloading videos, audio, and images from YouTube, Instagram, TikTok, Twitter/X, Facebook, and any website with media content.

## Features

- **🎬 YouTube** — Download videos in any quality (Best, 720p, 480p, 360p) or extract audio as MP3
- **🎵 YouTube Playlists** — Download entire playlists with range selection support
- **📸 Instagram** — Detect and download videos from posts and reels
- **🎵 TikTok** — Download TikTok videos
- **🐦 Twitter/X** — Download Twitter videos
- **📘 Facebook** — Download Facebook videos
- **🖼️ Images** — Detect and download large images (≥200×200) from any page
- **🌐 Any Website** — Scans pages for video, audio, and image media via DOM, meta tags, network interception, and performance entries

## Architecture

| File | Description |
|------|-------------|
| `manifest.json` | Chrome extension manifest (Manifest V3) |
| `popup.html` | Extension popup UI with dark theme design |
| `popup.js` | Popup logic — page scanning, media detection, UI rendering |
| `background.js` | Service worker — network request interception, media URL capture |
| `download_server.py` | Local Python server (port 9876) for yt-dlp downloads |
| `start_server.bat` | One-click server setup and launcher |

## How It Works

1. **Network Interception** — The background service worker intercepts all network requests and captures media URLs (videos from YouTube, Instagram CDN, TikTok CDN, etc.)
2. **Page Scanning** — When you click "Scan", the popup injects a script that scans the page for `<video>`, `<audio>`, `<img>` elements, meta tags, CSS background images, and performance entries
3. **Smart Detection** — Results are merged, deduplicated, and displayed with file type, size, duration, and dimensions
4. **Download** — Direct download via Chrome's download API, or via a local Python server using yt-dlp for YouTube and supported sites

## Installation

### 1. Load the Extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked** and select this project folder

### 2. Setup the Download Server (for YouTube)

**Prerequisites:** Python 3.7+ and Node.js (for YouTube decryption)

```bash
# Option A: Double-click
start_server.bat

# Option B: Manual
pip install yt-dlp
python download_server.py
```

The server runs on `http://127.0.0.1:9876` and handles yt-dlp downloads.

## Usage

1. Navigate to any page with media content
2. Click the extension icon
3. Click **Scan for Media** 🔍
4. Choose quality (for YouTube) or click **Download** on detected media

## Supported Formats

| Type | Formats |
|------|---------|
| Video | MP4, WebM, MKV, M4V, AVI, MOV, FLV, WMV, M3U8 |
| Audio | MP3, M4A, OGG, AAC, FLAC, WAV |
| Image | JPG, PNG, WebP, GIF, AVIF, SVG |

## Tech Stack

- **Extension**: Chrome Manifest V3, vanilla JavaScript
- **UI**: Custom dark theme with glassmorphism, Inter font
- **Backend**: Python HTTP server + yt-dlp
- **APIs**: `chrome.webRequest`, `chrome.scripting`, `chrome.downloads`, `chrome.declarativeNetRequest`

## License

MIT
