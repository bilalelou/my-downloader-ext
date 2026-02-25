// ===== Bilal Video Downloader v4 - Python Backend =====
const PYTHON_SERVER = 'http://127.0.0.1:9876';

// ===== Check Python server status =====
let serverOnline = false;

async function checkServer() {
    const el = document.getElementById('serverStatus');
    try {
        const resp = await fetch(`${PYTHON_SERVER}/ping`, { signal: AbortSignal.timeout(1500) });
        const data = await resp.json();
        if (data.pong) {
            serverOnline = true;
            el.textContent = '🟢 Server is running';
            el.className = 'server-on';
        }
    } catch {
        serverOnline = false;
        el.textContent = '🔴 Server is off — run start_server.bat';
        el.className = 'server-off';
    }
}
checkServer();

// ===== Scan button =====
document.getElementById('scanBtn').addEventListener('click', async () => {
    const status = document.getElementById('status');
    status.innerText = "Scanning...";

    // Update server status
    await checkServer();

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
            status.innerText = "This is a protected page ❌";
            return;
        }

        const currentSite = detectCurrentSite(tab.url);

        // ===== YouTube playlist =====
        if (currentSite === 'youtube' && isYoutubePlaylist(tab.url)) {
            const pageTitle = await getPageTitle(tab.id);
            showPlaylistDownload(status, tab.url, pageTitle);
            return;
        }

        // ===== YouTube single video =====
        if (currentSite === 'youtube') {
            const pageTitle = await getPageTitle(tab.id);
            showYoutubeDownload(status, tab.url, pageTitle);
            return;
        }

        // ===== 1) Get intercepted URLs from Background =====
        let networkUrls = [];
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getCapturedMedia',
                tabId: tab.id
            });
            networkUrls = response?.urls || [];
        } catch (e) { /* service worker not ready */ }

        // ===== 2) Scan the page =====
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => {
                const found = [];

                // <video> elements
                document.querySelectorAll('video').forEach(video => {
                    if (video.src?.trim() && !video.src.startsWith('blob:')) {
                        found.push({ url: video.src, duration: video.duration || 0, type: 'video' });
                    }
                    video.querySelectorAll('source').forEach(source => {
                        if (source.src?.trim() && !source.src.startsWith('blob:')) {
                            found.push({ url: source.src, duration: video.duration || 0, type: 'source' });
                        }
                    });
                });

                // <audio> elements
                document.querySelectorAll('audio').forEach(audio => {
                    if (audio.src?.trim() && !audio.src.startsWith('blob:')) {
                        found.push({ url: audio.src, duration: audio.duration || 0, type: 'audio' });
                    }
                    audio.querySelectorAll('source').forEach(source => {
                        if (source.src?.trim() && !source.src.startsWith('blob:')) {
                            found.push({ url: source.src, duration: audio.duration || 0, type: 'audio-source' });
                        }
                    });
                });

                // <img> elements — only large images
                document.querySelectorAll('img').forEach(img => {
                    if (img.src?.trim() && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
                        if (img.naturalWidth >= 200 && img.naturalHeight >= 200) {
                            found.push({ url: img.src, duration: 0, type: 'image', width: img.naturalWidth, height: img.naturalHeight });
                        }
                    }
                    // srcset — largest image
                    if (img.srcset) {
                        const parts = img.srcset.split(',').map(s => s.trim()).filter(Boolean);
                        const last = parts[parts.length - 1];
                        if (last) {
                            const srcUrl = last.split(/\s+/)[0];
                            if (srcUrl && !srcUrl.startsWith('data:') && !found.some(f => f.url === srcUrl)) {
                                found.push({ url: srcUrl, duration: 0, type: 'image-srcset' });
                            }
                        }
                    }
                });

                // CSS background images
                document.querySelectorAll('[style*="background"]').forEach(el => {
                    const bg = getComputedStyle(el).backgroundImage;
                    const match = bg?.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
                    if (match && !found.some(f => f.url === match[1])) {
                        const imgUrl = match[1];
                        if (/\.(jpg|jpeg|png|webp|gif|avif|svg)(\?|#|$)/i.test(imgUrl)) {
                            found.push({ url: imgUrl, duration: 0, type: 'image-bg' });
                        }
                    }
                });

                // Meta tags — video + images
                ['og:video', 'og:video:url', 'og:video:secure_url'].forEach(prop => {
                    const url = document.querySelector(`meta[property="${prop}"]`)?.content;
                    if (url?.trim() && !found.some(f => f.url === url)) {
                        found.push({ url, duration: 0, type: 'meta-video' });
                    }
                });
                ['og:image', 'og:image:url', 'og:image:secure_url'].forEach(prop => {
                    const url = document.querySelector(`meta[property="${prop}"]`)?.content;
                    if (url?.trim() && !found.some(f => f.url === url)) {
                        found.push({ url, duration: 0, type: 'meta-image' });
                    }
                });

                // Performance entries
                try {
                    const mediaPattern = /\.(mp4|webm|mkv|m4v|avi|mov|m3u8|mpd|mp3|m4a|ogg|aac|flac|jpg|jpeg|png|webp|gif|avif|svg)(\?|#|$)/i;
                    performance.getEntriesByType('resource').forEach(entry => {
                        if (mediaPattern.test(entry.name) && !found.some(f => f.url === entry.name)) {
                            const isAudio = /\.(mp3|m4a|ogg|aac|flac)(\?|#|$)/i.test(entry.name);
                            const isImage = /\.(jpg|jpeg|png|webp|gif|avif|svg)(\?|#|$)/i.test(entry.name);
                            found.push({ url: entry.name, duration: 0, type: isAudio ? 'perf-audio' : isImage ? 'perf-image' : 'perf-video' });
                        }
                    });
                } catch (e) { /* ignore */ }

                return {
                    media: [...new Map(found.map(item => [item.url, item])).values()],
                    pageTitle: document.title || ''
                };
            }
        });

        // ===== 3) Merge results =====
        if (!injectionResults?.[0]?.result) {
            status.innerText = "An error occurred while scanning ❌";
            return;
        }

        const { media: pageMedia, pageTitle } = injectionResults[0].result;
        const allUrls = new Set(pageMedia.map(m => m.url));
        const networkItems = networkUrls
            .filter(n => !allUrls.has(n.url))
            .map(n => ({
                url: n.url, duration: 0, type: 'network',
                filename: n.filename, extension: n.extension,
                contentType: n.contentType, size: n.size,
                site: n.site, quality: n.quality,
                isAudioOnly: n.isAudio, fromNetwork: true
            }));

        const mediaList = [...networkItems, ...pageMedia];

        if (mediaList.length === 0) {
            let hint = "No media found ❌\n\n";
            hint += "💡 Try playing the video or wait for the page to load, then click scan again";
            status.innerText = hint;
            return;
        }

        // ===== 4) Display results =====
        showMediaResults(status, mediaList, currentSite, pageTitle, tab);

    } catch (error) {
        status.innerText = `Error: ${error.message} ❌`;
    }
});


// ===== Get page title =====
async function getPageTitle(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.title
        });
        return results?.[0]?.result || '';
    } catch {
        return '';
    }
}


// ===== YouTube download UI via Python =====
function showYoutubeDownload(status, videoUrl, pageTitle) {
    status.innerHTML = '';

    const badge = document.createElement('div');
    badge.className = 'site-badge';
    badge.textContent = '🎬 YouTube';
    status.appendChild(badge);

    const titleEl = document.createElement('p');
    titleEl.style.cssText = 'font-size:12px;font-weight:600;color:#e2e8f0;margin:8px 0 4px;line-height:1.4;';
    titleEl.textContent = pageTitle || videoUrl;
    status.appendChild(titleEl);

    if (!serverOnline) {
        const warn = document.createElement('div');
        warn.style.cssText = 'background:rgba(234,179,8,0.1);border:1px solid rgba(234,179,8,0.25);border-radius:8px;padding:10px;margin:8px 0;font-size:12px;color:#fde047;text-align:right;line-height:1.6;';
        warn.innerHTML = `
            <b>⚠️ Download server is off!</b><br>
            <b>1.</b> Open the extension folder<br>
            <b>2.</b> Run <b>start_server.bat</b><br>
            <span style="font-size:11px;color:#94a3b8;">Python + yt-dlp must be installed</span>
        `;
        status.appendChild(warn);
        return;
    }

    // Download card
    const card = document.createElement('div');
    card.className = 'media-card card-network';

    const readyMsg = document.createElement('div');
    readyMsg.style.cssText = 'font-size:13px;font-weight:bold;color:#86efac;margin-bottom:8px;';
    readyMsg.textContent = '✅ Ready to download via yt-dlp';
    card.appendChild(readyMsg);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:#94a3b8;margin-bottom:8px;';
    hint.textContent = 'Choose quality:';
    card.appendChild(hint);

    const qualityRow = document.createElement('div');
    qualityRow.className = 'quality-row';

    const qualities = [
        { label: '🎬 Best', value: 'best' },
        { label: '720p', value: '720' },
        { label: '480p', value: '480' },
        { label: '360p', value: '360' },
        { label: '🔊 MP3 Audio', value: 'audio' },
    ];

    qualities.forEach(q => {
        const btn = document.createElement('button');
        btn.className = `q-btn${q.value === 'audio' ? ' audio-btn' : ''}`;
        btn.textContent = q.label;
        btn.addEventListener('click', () => downloadViaPython(btn, videoUrl, q.value, pageTitle));
        qualityRow.appendChild(btn);
    });

    card.appendChild(qualityRow);

    const dlStatus = document.createElement('div');
    dlStatus.id = 'dlStatus';
    dlStatus.style.cssText = 'margin-top:8px;font-size:12px;color:#94a3b8;display:none;';
    card.appendChild(dlStatus);

    status.appendChild(card);
}


// ===== Download via Python =====
async function downloadViaPython(btn, url, quality, title) {
    const dlStatus = document.getElementById('dlStatus');
    const originalText = btn.textContent;

    document.querySelectorAll('.q-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

    btn.textContent = '⏳ Loading...';
    btn.style.background = 'rgba(234,179,8,0.3)';
    btn.style.color = '#fde047';
    btn.style.borderColor = 'rgba(234,179,8,0.4)';
    btn.style.opacity = '1';

    dlStatus.style.display = 'block';
    dlStatus.textContent = '📡 Sending request to server...';

    try {
        const resp = await fetch(`${PYTHON_SERVER}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, quality, title })
        });

        const data = await resp.json();

        if (data.success) {
            btn.textContent = '✅ Started!';
            btn.style.background = 'rgba(34,197,94,0.3)';
            btn.style.color = '#86efac';
            btn.style.borderColor = 'rgba(34,197,94,0.4)';
            dlStatus.innerHTML = `✅ ${data.message}<br><span style="font-size:10px;color:#64748b;">📁 ${data.download_dir}</span>`;
        } else {
            throw new Error(data.error || 'Unknown error');
        }

    } catch (err) {
        btn.textContent = '❌ Error';
        btn.style.background = 'rgba(239,68,68,0.3)';
        btn.style.color = '#fca5a5';
        btn.style.borderColor = 'rgba(239,68,68,0.4)';

        if (err.message.includes('fetch')) {
            dlStatus.textContent = '🔴 Server is off! Run start_server.bat';
        } else {
            dlStatus.textContent = `❌ ${err.message}`;
        }
    }

    setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
        document.querySelectorAll('.q-btn').forEach(b => { b.disabled = false; b.style.opacity = '1'; });
    }, 5000);
}


// ===== Display results for other sites =====
function showMediaResults(status, mediaList, currentSite, pageTitle, tab) {
    status.innerText = '';

    if (currentSite) {
        const siteHeader = document.createElement('div');
        siteHeader.className = 'site-badge';
        const siteNames = {
            instagram: '📸 Instagram', tiktok: '🎵 TikTok',
            twitter: '🐦 Twitter/X', facebook: '📘 Facebook'
        };
        siteHeader.textContent = siteNames[currentSite] || currentSite;
        status.appendChild(siteHeader);
    }

    const header = document.createElement('p');
    header.style.cssText = 'color:#86efac;font-weight:bold;margin:0 0 8px;font-size:14px;';
    header.textContent = `Found ${mediaList.length} media! ✅`;
    status.appendChild(header);

    mediaList.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'media-card';

        let filename = '';
        let extension = '';

        if (item.fromNetwork && item.filename) {
            filename = item.filename;
            extension = item.extension || '';
        } else {
            try {
                const u = new URL(item.url);
                const lastPart = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
                const extMatch = lastPart.match(/\.(mp4|webm|mkv|m4v|avi|mov|flv|wmv|mp3|m4a|ogg|aac|flac|wav|m3u8|jpg|jpeg|png|webp|gif|avif|svg)$/i);
                extension = extMatch ? extMatch[1].toLowerCase() : '';
                filename = lastPart || u.hostname;
            } catch {
                filename = item.url.substring(0, 50);
            }
        }

        if (!extension && item.contentType) {
            if (item.contentType.includes('mp4')) extension = 'mp4';
            else if (item.contentType.includes('webm')) extension = 'webm';
            else if (item.contentType.includes('jpeg') || item.contentType.includes('jpg')) extension = 'jpg';
            else if (item.contentType.includes('png')) extension = 'png';
            else if (item.contentType.includes('webp')) extension = 'webp';
            else if (item.contentType.includes('gif')) extension = 'gif';
        }

        const site = item.site || currentSite;
        const isAudio = item.isAudioOnly || item.type?.includes('audio');
        const isImage = item.type?.includes('image');
        let icon, typeText, cardClass;

        if (site === 'instagram') {
            icon = '📸'; typeText = 'MP4'; cardClass = 'card-network';
            filename = pageTitle ? pageTitle.substring(0, 40) : 'instagram_video';
        } else if (site === 'tiktok') {
            icon = '🎵'; typeText = 'MP4'; cardClass = 'card-network'; filename = 'tiktok_video';
        } else if (item.fromNetwork) {
            icon = '🌐'; typeText = extension?.toUpperCase() || 'MEDIA'; cardClass = 'card-network';
        } else if (isImage) {
            icon = '🖼️'; typeText = extension?.toUpperCase() || 'IMAGE'; cardClass = 'card-image';
        } else if (isAudio) {
            icon = '🔊'; typeText = extension?.toUpperCase() || 'AUDIO'; cardClass = 'card-audio';
        } else {
            icon = '🎬'; typeText = extension?.toUpperCase() || 'VIDEO'; cardClass = 'card-video';
        }
        card.classList.add(cardClass);

        // Title row
        const titleRow = document.createElement('div');
        titleRow.className = 'card-title';
        const badgeEl = document.createElement('span');
        badgeEl.className = 'badge';
        badgeEl.textContent = typeText;
        titleRow.appendChild(badgeEl);
        const nameEl = document.createElement('span');
        nameEl.className = 'filename';
        nameEl.textContent = `${icon} ${filename}`;
        titleRow.appendChild(nameEl);
        card.appendChild(titleRow);

        // Info
        const info = [];
        if (item.duration && Number.isFinite(item.duration) && item.duration > 0) {
            const m = Math.floor(item.duration / 60);
            const s = Math.floor(item.duration % 60);
            info.push(`⏱ ${m}:${s.toString().padStart(2, '0')}`);
        }
        if (item.width && item.height) {
            info.push(`📐 ${item.width}×${item.height}`);
        }
        if (item.size && item.size > 0) {
            if (item.size > 1048576) info.push(`📦 ${(item.size / 1048576).toFixed(1)} MB`);
            else if (item.size > 1024) info.push(`📦 ${(item.size / 1024).toFixed(0)} KB`);
        }
        if (info.length > 0) {
            const infoEl = document.createElement('div');
            infoEl.className = 'card-info';
            infoEl.textContent = info.join('  •  ');
            card.appendChild(infoEl);
        }

        // Download button — if server is online, use yt-dlp for supported sites
        const supportedSites = ['instagram', 'tiktok', 'twitter', 'facebook'];
        const canUsePython = serverOnline && supportedSites.includes(site);

        if (canUsePython) {
            const dlBtn = document.createElement('button');
            dlBtn.textContent = '⬇️ Download via yt-dlp';
            dlBtn.className = 'download-link';
            dlBtn.style.cssText = 'border:none;cursor:pointer;width:100%;text-align:center;background:linear-gradient(135deg,#22c55e,#16a34a);box-shadow:0 4px 12px rgba(34,197,94,0.3);';
            dlBtn.addEventListener('click', () => downloadViaPython(dlBtn, item.url, 'best', filename));
            card.appendChild(dlBtn);
        } else {
            const dlBtn = document.createElement('button');
            dlBtn.textContent = isImage ? '⬇️ Download Image' : '⬇️ Direct Download';
            dlBtn.className = 'download-link';
            dlBtn.style.cssText = 'border:none;cursor:pointer;width:100%;text-align:center;';
            dlBtn.addEventListener('click', () => {
                dlBtn.textContent = '⏳ Loading...';
                dlBtn.disabled = true;
                const safeName = (filename || (isImage ? 'image' : 'video')).replaceAll(/[<>:"/\\|?*]/g, '_').substring(0, 100);
                const dlFilename = extension ? `${safeName}.${extension}` : isImage ? `${safeName}.jpg` : `${safeName}.mp4`;
                chrome.runtime.sendMessage({
                    action: 'downloadMedia', url: item.url, filename: dlFilename, site
                }, (response) => {
                    dlBtn.textContent = response?.success ? '✅ Started!' : '❌ Error';
                    setTimeout(() => { dlBtn.textContent = isImage ? '⬇️ Download Image' : '⬇️ Direct Download'; dlBtn.disabled = false; }, 3000);
                });
            });
            card.appendChild(dlBtn);
        }

        status.appendChild(card);
    });
}


function detectCurrentSite(url) {
    if (!url) return null;
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
    if (url.includes('facebook.com') || url.includes('fb.com')) return 'facebook';
    return null;
}

// ===== Check if URL is a YouTube playlist =====
function isYoutubePlaylist(url) {
    try {
        const u = new URL(url);
        return u.searchParams.has('list');
    } catch { return false; }
}


// ===== Fetch playlist info from server =====
async function fetchPlaylistInfo(url) {
    const resp = await fetch(`${PYTHON_SERVER}/playlist-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(35000)
    });
    return await resp.json();
}

// ===== Playlist download UI =====
async function showPlaylistDownload(status, playlistUrl, pageTitle) {
    status.innerHTML = '';

    const badge = document.createElement('div');
    badge.className = 'site-badge';
    badge.textContent = '🎵 YouTube Playlist';
    status.appendChild(badge);

    const titleEl = document.createElement('p');
    titleEl.style.cssText = 'font-size:12px;font-weight:600;color:#e2e8f0;margin:8px 0 4px;line-height:1.4;';
    titleEl.textContent = pageTitle || playlistUrl;
    status.appendChild(titleEl);

    if (!serverOnline) {
        const warn = document.createElement('div');
        warn.style.cssText = 'background:rgba(234,179,8,0.1);border:1px solid rgba(234,179,8,0.25);border-radius:8px;padding:10px;margin:8px 0;font-size:12px;color:#fde047;text-align:right;line-height:1.6;';
        warn.innerHTML = `
            <b>⚠️ Download server is off!</b><br>
            Run <b>start_server.bat</b> first
        `;
        status.appendChild(warn);
        return;
    }

    // Show loading message
    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'text-align:center;padding:15px;color:#94a3b8;font-size:13px;';
    loadingEl.textContent = '⏳ Fetching playlist info...';
    status.appendChild(loadingEl);

    try {
        const info = await fetchPlaylistInfo(playlistUrl);
        loadingEl.remove();

        if (!info.success) {
            throw new Error(info.error || 'Failed to fetch info');
        }

        // Video count
        const countEl = document.createElement('div');
        countEl.style.cssText = 'font-size:13px;font-weight:bold;color:#86efac;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.2);padding:8px 12px;border-radius:8px;margin:8px 0;';
        countEl.textContent = `🎬 ${info.playlist_title || 'Playlist'} — ${info.count} videos`;
        status.appendChild(countEl);

        // Download card
        const card = document.createElement('div');
        card.className = 'media-card card-network';

        // Quality selection
        const hintQ = document.createElement('div');
        hintQ.style.cssText = 'font-size:11px;color:#94a3b8;margin-bottom:6px;';
        hintQ.textContent = 'Choose quality:';
        card.appendChild(hintQ);

        const qualityRow = document.createElement('div');
        qualityRow.className = 'quality-row';
        const qualities = [
            { label: '🎬 Best', value: 'best' },
            { label: '720p', value: '720' },
            { label: '480p', value: '480' },
            { label: '360p', value: '360' },
            { label: '🔊 MP3 Audio', value: 'audio' },
        ];
        let selectedQuality = 'best';

        qualities.forEach(q => {
            const btn = document.createElement('button');
            btn.className = `q-btn${q.value === 'audio' ? ' audio-btn' : ''}${q.value === 'best' ? ' q-selected' : ''}`;
            btn.textContent = q.label;
            btn.addEventListener('click', () => {
                qualityRow.querySelectorAll('.q-btn').forEach(b => b.classList.remove('q-selected'));
                btn.classList.add('q-selected');
                selectedQuality = q.value;
            });
            qualityRow.appendChild(btn);
        });
        card.appendChild(qualityRow);

        // Range selection
        const rangeSection = document.createElement('div');
        rangeSection.style.cssText = 'margin-top:10px;';

        const rangeLabel = document.createElement('div');
        rangeLabel.style.cssText = 'font-size:11px;color:#94a3b8;margin-bottom:4px;';
        rangeLabel.textContent = `Video range (optional — leave empty to download all):`;
        rangeSection.appendChild(rangeLabel);

        const rangeInput = document.createElement('input');
        rangeInput.type = 'text';
        rangeInput.placeholder = `e.g. 1-10 or 1,3,5 or 1-5,8,10-12`;
        rangeInput.style.cssText = 'width:100%;padding:6px 10px;border:1px solid rgba(255,255,255,0.12);border-radius:6px;font-size:12px;direction:ltr;text-align:left;box-sizing:border-box;background:rgba(255,255,255,0.06);color:#e2e8f0;';
        rangeSection.appendChild(rangeInput);
        card.appendChild(rangeSection);

        // Download buttons
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

        const dlAllBtn = document.createElement('button');
        dlAllBtn.className = 'action-btn green-btn';
        dlAllBtn.style.cssText += 'flex:1;';
        dlAllBtn.textContent = `⬇️ Download All (${info.count})`;
        dlAllBtn.addEventListener('click', () => {
            const items = rangeInput.value.trim();
            downloadPlaylist(dlAllBtn, playlistUrl, selectedQuality, items, info.count);
        });
        btnRow.appendChild(dlAllBtn);
        card.appendChild(btnRow);

        // Download status
        const dlStatus = document.createElement('div');
        dlStatus.id = 'plDlStatus';
        dlStatus.style.cssText = 'margin-top:8px;font-size:12px;color:#94a3b8;display:none;';
        card.appendChild(dlStatus);

        status.appendChild(card);

        // Video list
        if (info.videos && info.videos.length > 0) {
            const listHeader = document.createElement('div');
            listHeader.style.cssText = 'font-size:12px;font-weight:bold;color:#c4c4d4;margin-top:10px;margin-bottom:4px;';
            listHeader.textContent = `📋 Video List:`;
            status.appendChild(listHeader);

            const listContainer = document.createElement('div');
            listContainer.style.cssText = 'max-height:180px;overflow-y:auto;border:1px solid rgba(255,255,255,0.08);border-radius:8px;background:rgba(255,255,255,0.04);';

            info.videos.forEach((v, i) => {
                const row = document.createElement('div');
                row.style.cssText = `padding:6px 10px;font-size:11px;color:#c4c4d4;border-bottom:1px solid rgba(255,255,255,0.05);direction:ltr;text-align:left;display:flex;gap:6px;align-items:center;${i % 2 === 0 ? 'background:rgba(255,255,255,0.03);' : ''}}`;

                const numSpan = document.createElement('span');
                numSpan.style.cssText = 'font-weight:bold;color:#818cf8;min-width:24px;flex-shrink:0;';
                numSpan.textContent = `${i + 1}.`;
                row.appendChild(numSpan);

                const titleSpan = document.createElement('span');
                titleSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                titleSpan.textContent = v.title || 'Untitled';
                row.appendChild(titleSpan);

                if (v.duration) {
                    const durSpan = document.createElement('span');
                    durSpan.style.cssText = 'color:#64748b;font-size:10px;flex-shrink:0;';
                    const m = Math.floor(v.duration / 60);
                    const s = Math.floor(v.duration % 60);
                    durSpan.textContent = `${m}:${s.toString().padStart(2, '0')}`;
                    row.appendChild(durSpan);
                }

                listContainer.appendChild(row);
            });

            status.appendChild(listContainer);
        }

    } catch (err) {
        loadingEl.remove();
        const errEl = document.createElement('div');
        errEl.style.cssText = 'background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:10px;margin:8px 0;font-size:12px;color:#fca5a5;text-align:right;';
        errEl.textContent = `❌ ${err.message}`;
        status.appendChild(errEl);

        // Fallback: direct download without info
        showPlaylistFallback(status, playlistUrl);
    }
}


// ===== Playlist fallback (without info) =====
function showPlaylistFallback(status, playlistUrl) {
    const card = document.createElement('div');
    card.className = 'media-card card-network';

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:8px;';
    msg.textContent = '💡 You can download the playlist directly:';
    card.appendChild(msg);

    const qualityRow = document.createElement('div');
    qualityRow.className = 'quality-row';
    let selectedQuality = 'best';
    [{ label: '🎬 Best', value: 'best' }, { label: '720p', value: '720' }, { label: '480p', value: '480' }, { label: '🔊 MP3', value: 'audio' }].forEach(q => {
        const btn = document.createElement('button');
        btn.className = `q-btn${q.value === 'best' ? ' q-selected' : ''}`;
        btn.textContent = q.label;
        btn.addEventListener('click', () => {
            qualityRow.querySelectorAll('.q-btn').forEach(b => b.classList.remove('q-selected'));
            btn.classList.add('q-selected');
            selectedQuality = q.value;
        });
        qualityRow.appendChild(btn);
    });
    card.appendChild(qualityRow);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'action-btn green-btn';
    dlBtn.style.cssText += 'margin-top:8px;';
    dlBtn.textContent = '⬇️ Download Full Playlist';
    dlBtn.addEventListener('click', () => downloadPlaylist(dlBtn, playlistUrl, selectedQuality, '', 0));
    card.appendChild(dlBtn);

    const dlStatus = document.createElement('div');
    dlStatus.id = 'plDlStatus';
    dlStatus.style.cssText = 'margin-top:8px;font-size:12px;color:#94a3b8;display:none;';
    card.appendChild(dlStatus);

    status.appendChild(card);
}


// ===== Download playlist =====
async function downloadPlaylist(btn, url, quality, playlistItems, totalCount) {
    const dlStatus = document.getElementById('plDlStatus');
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = '⏳ Loading...';
    btn.style.opacity = '0.7';

    if (dlStatus) {
        dlStatus.style.display = 'block';
        dlStatus.textContent = '📡 Sending playlist download request...';
    }

    try {
        const resp = await fetch(`${PYTHON_SERVER}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                quality,
                playlist: true,
                playlist_items: playlistItems
            })
        });

        const data = await resp.json();

        if (data.success) {
            btn.textContent = '✅ Started!';
            btn.style.background = '#28a745';
            if (dlStatus) {
                const itemsText = playlistItems ? `(videos: ${playlistItems})` : `(all videos${totalCount ? ' - ' + totalCount : ''})`;
                dlStatus.innerHTML = `✅ ${data.message} ${itemsText}<br><span style="font-size:10px;color:#64748b;">📁 ${data.download_dir}</span>`;
            }
        } else {
            throw new Error(data.error || 'Unknown error');
        }

    } catch (err) {
        btn.textContent = '❌ Error';
        btn.style.background = 'rgba(239,68,68,0.3)';
        if (dlStatus) {
            dlStatus.textContent = err.message.includes('fetch')
                ? '🔴 Server is off! Run start_server.bat'
                : `❌ ${err.message}`;
        }
    }

    setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '';
        btn.style.opacity = '1';
        btn.disabled = false;
    }, 5000);
}
