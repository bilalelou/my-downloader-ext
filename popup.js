// ===== Bilal Video Downloader v4 - Python Backend =====
const PYTHON_SERVER = 'http://127.0.0.1:9876';

// ===== فحص حالة سيرفر Python =====
let serverOnline = false;

async function checkServer() {
    const el = document.getElementById('serverStatus');
    try {
        const resp = await fetch(`${PYTHON_SERVER}/ping`, { signal: AbortSignal.timeout(1500) });
        const data = await resp.json();
        if (data.pong) {
            serverOnline = true;
            el.textContent = '🟢 السيرفر يعمل';
            el.className = 'server-on';
        }
    } catch {
        serverOnline = false;
        el.textContent = '🔴 السيرفر مطفي — شغّل start_server.bat';
        el.className = 'server-off';
    }
}
checkServer();

// ===== زر البحث =====
document.getElementById('scanBtn').addEventListener('click', async () => {
    const status = document.getElementById('status');
    status.innerText = "جاري البحث...";

    // تحديث حالة السيرفر
    await checkServer();

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
            status.innerText = "هذي صفحة محمية ❌";
            return;
        }

        const currentSite = detectCurrentSite(tab.url);

        // ===== لو YouTube بلايلست =====
        if (currentSite === 'youtube' && isYoutubePlaylist(tab.url)) {
            const pageTitle = await getPageTitle(tab.id);
            showPlaylistDownload(status, tab.url, pageTitle);
            return;
        }

        // ===== لو YouTube فيديو واحد =====
        if (currentSite === 'youtube') {
            const pageTitle = await getPageTitle(tab.id);
            showYoutubeDownload(status, tab.url, pageTitle);
            return;
        }

        // ===== 1) جلب الروابط المعترضة من Background =====
        let networkUrls = [];
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getCapturedMedia',
                tabId: tab.id
            });
            networkUrls = response?.urls || [];
        } catch (e) { /* service worker مو جاهز */ }

        // ===== 2) مسح الصفحة =====
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => {
                const found = [];

                // عناصر <video>
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

                // عناصر <audio>
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

                // Meta tags
                ['og:video', 'og:video:url', 'og:video:secure_url'].forEach(prop => {
                    const url = document.querySelector(`meta[property="${prop}"]`)?.content;
                    if (url?.trim() && !found.some(f => f.url === url)) {
                        found.push({ url, duration: 0, type: 'meta-video' });
                    }
                });

                // Performance entries
                try {
                    const mediaPattern = /\.(mp4|webm|mkv|m4v|avi|mov|m3u8|mpd|mp3|m4a|ogg|aac|flac)(\?|#|$)/i;
                    performance.getEntriesByType('resource').forEach(entry => {
                        if (mediaPattern.test(entry.name) && !found.some(f => f.url === entry.name)) {
                            const isAudio = /\.(mp3|m4a|ogg|aac|flac)(\?|#|$)/i.test(entry.name);
                            found.push({ url: entry.name, duration: 0, type: isAudio ? 'perf-audio' : 'perf-video' });
                        }
                    });
                } catch (e) { /* ignore */ }

                return {
                    media: [...new Map(found.map(item => [item.url, item])).values()],
                    pageTitle: document.title || ''
                };
            }
        });

        // ===== 3) دمج النتائج =====
        if (!injectionResults?.[0]?.result) {
            status.innerText = "صار خطأ أثناء البحث ❌";
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
            let hint = "ما لقيت أي فيديو أو صوت ❌\n\n";
            hint += "💡 شغّل الفيديو أول وبعدين اضغط بحث مرة ثانية";
            status.innerText = hint;
            return;
        }

        // ===== 4) عرض النتائج =====
        showMediaResults(status, mediaList, currentSite, pageTitle, tab);

    } catch (error) {
        status.innerText = `صار خطأ: ${error.message} ❌`;
    }
});


// ===== جلب عنوان الصفحة =====
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


// ===== واجهة تحميل YouTube عبر Python =====
function showYoutubeDownload(status, videoUrl, pageTitle) {
    status.innerHTML = '';

    const badge = document.createElement('div');
    badge.className = 'site-badge';
    badge.textContent = '🎬 YouTube';
    status.appendChild(badge);

    const titleEl = document.createElement('p');
    titleEl.style.cssText = 'font-size:12px;font-weight:600;color:#333;margin:8px 0 4px;line-height:1.4;';
    titleEl.textContent = pageTitle || videoUrl;
    status.appendChild(titleEl);

    if (!serverOnline) {
        const warn = document.createElement('div');
        warn.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px;margin:8px 0;font-size:12px;color:#856404;text-align:right;line-height:1.6;';
        warn.innerHTML = `
            <b>⚠️ سيرفر التحميل مطفي!</b><br>
            <b>1.</b> افتح مجلد الإضافة<br>
            <b>2.</b> شغّل <b>start_server.bat</b><br>
            <span style="font-size:11px;color:#999;">لازم يكون عندك Python + yt-dlp مثبتين</span>
        `;
        status.appendChild(warn);
        return;
    }

    // بطاقة التحميل
    const card = document.createElement('div');
    card.className = 'media-card card-network';

    const readyMsg = document.createElement('div');
    readyMsg.style.cssText = 'font-size:13px;font-weight:bold;color:#155724;margin-bottom:8px;';
    readyMsg.textContent = '✅ جاهز للتحميل عبر yt-dlp';
    card.appendChild(readyMsg);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:#888;margin-bottom:8px;';
    hint.textContent = 'اختر الجودة المطلوبة:';
    card.appendChild(hint);

    const qualityRow = document.createElement('div');
    qualityRow.className = 'quality-row';

    const qualities = [
        { label: '🎬 أفضل جودة', value: 'best' },
        { label: '720p', value: '720' },
        { label: '480p', value: '480' },
        { label: '360p', value: '360' },
        { label: '🔊 صوت MP3', value: 'audio' },
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
    dlStatus.style.cssText = 'margin-top:8px;font-size:12px;color:#666;display:none;';
    card.appendChild(dlStatus);

    status.appendChild(card);
}


// ===== تحميل عبر Python =====
async function downloadViaPython(btn, url, quality, title) {
    const dlStatus = document.getElementById('dlStatus');
    const originalText = btn.textContent;

    document.querySelectorAll('.q-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

    btn.textContent = '⏳ جاري...';
    btn.style.background = '#ffc107';
    btn.style.color = '#333';
    btn.style.borderColor = '#ffc107';
    btn.style.opacity = '1';

    dlStatus.style.display = 'block';
    dlStatus.textContent = '📡 إرسال الطلب للسيرفر...';

    try {
        const resp = await fetch(`${PYTHON_SERVER}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, quality, title })
        });

        const data = await resp.json();

        if (data.success) {
            btn.textContent = '✅ بدأ!';
            btn.style.background = '#28a745';
            btn.style.color = '#fff';
            btn.style.borderColor = '#28a745';
            dlStatus.innerHTML = `✅ ${data.message}<br><span style="font-size:10px;color:#888;">📁 ${data.download_dir}</span>`;
        } else {
            throw new Error(data.error || 'Unknown error');
        }

    } catch (err) {
        btn.textContent = '❌ خطأ';
        btn.style.background = '#dc3545';
        btn.style.color = '#fff';
        btn.style.borderColor = '#dc3545';

        if (err.message.includes('fetch')) {
            dlStatus.textContent = '🔴 السيرفر مطفي! شغّل start_server.bat';
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


// ===== عرض نتائج المواقع الأخرى =====
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
    header.style.cssText = 'color:#28a745;font-weight:bold;margin:0 0 8px;font-size:14px;';
    header.textContent = `لقينا ${mediaList.length} ميديا! ✅`;
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
                const extMatch = lastPart.match(/\.(mp4|webm|mkv|m4v|avi|mov|flv|wmv|mp3|m4a|ogg|aac|flac|wav|m3u8)$/i);
                extension = extMatch ? extMatch[1].toLowerCase() : '';
                filename = lastPart || u.hostname;
            } catch {
                filename = item.url.substring(0, 50);
            }
        }

        if (!extension && item.contentType) {
            if (item.contentType.includes('mp4')) extension = 'mp4';
            else if (item.contentType.includes('webm')) extension = 'webm';
        }

        const site = item.site || currentSite;
        const isAudio = item.isAudioOnly || item.type?.includes('audio');
        let icon, typeText, cardClass;

        if (site === 'instagram') {
            icon = '📸'; typeText = 'MP4'; cardClass = 'card-network';
            filename = pageTitle ? pageTitle.substring(0, 40) : 'instagram_video';
        } else if (site === 'tiktok') {
            icon = '🎵'; typeText = 'MP4'; cardClass = 'card-network'; filename = 'tiktok_video';
        } else if (item.fromNetwork) {
            icon = '🌐'; typeText = extension?.toUpperCase() || 'MEDIA'; cardClass = 'card-network';
        } else if (isAudio) {
            icon = '🔊'; typeText = extension?.toUpperCase() || 'AUDIO'; cardClass = 'card-audio';
        } else {
            icon = '🎬'; typeText = extension?.toUpperCase() || 'VIDEO'; cardClass = 'card-video';
        }
        card.classList.add(cardClass);

        // العنوان
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

        // معلومات
        const info = [];
        if (item.duration && Number.isFinite(item.duration) && item.duration > 0) {
            const m = Math.floor(item.duration / 60);
            const s = Math.floor(item.duration % 60);
            info.push(`⏱ ${m}:${s.toString().padStart(2, '0')}`);
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

        // زر التحميل — لو السيرفر شغال نستخدم yt-dlp للمواقع المدعومة
        const supportedSites = ['instagram', 'tiktok', 'twitter', 'facebook'];
        const canUsePython = serverOnline && supportedSites.includes(site);

        if (canUsePython) {
            const dlBtn = document.createElement('button');
            dlBtn.textContent = '⬇️ تحميل عبر yt-dlp';
            dlBtn.className = 'download-link';
            dlBtn.style.cssText = 'border:none;cursor:pointer;width:100%;text-align:center;background:linear-gradient(135deg,#28a745,#1e7e34);';
            dlBtn.addEventListener('click', () => downloadViaPython(dlBtn, item.url, 'best', filename));
            card.appendChild(dlBtn);
        } else {
            const dlBtn = document.createElement('button');
            dlBtn.textContent = '⬇️ تحميل مباشر';
            dlBtn.className = 'download-link';
            dlBtn.style.cssText = 'border:none;cursor:pointer;width:100%;text-align:center;';
            dlBtn.addEventListener('click', () => {
                dlBtn.textContent = '⏳ جاري...';
                dlBtn.disabled = true;
                const safeName = (filename || 'video').replaceAll(/[<>:"/\\|?*]/g, '_').substring(0, 100);
                const dlFilename = extension ? `${safeName}.${extension}` : `${safeName}.mp4`;
                chrome.runtime.sendMessage({
                    action: 'downloadMedia', url: item.url, filename: dlFilename, site
                }, (response) => {
                    dlBtn.textContent = response?.success ? '✅ بدأ!' : '❌ خطأ';
                    setTimeout(() => { dlBtn.textContent = '⬇️ تحميل مباشر'; dlBtn.disabled = false; }, 3000);
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

// ===== هل الرابط بلايلست YouTube =====
function isYoutubePlaylist(url) {
    try {
        const u = new URL(url);
        return u.searchParams.has('list');
    } catch { return false; }
}


// ===== جلب معلومات البلايلست من السيرفر =====
async function fetchPlaylistInfo(url) {
    const resp = await fetch(`${PYTHON_SERVER}/playlist-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(35000)
    });
    return await resp.json();
}

// ===== واجهة تحميل البلايلست =====
async function showPlaylistDownload(status, playlistUrl, pageTitle) {
    status.innerHTML = '';

    const badge = document.createElement('div');
    badge.className = 'site-badge';
    badge.textContent = '🎵 YouTube Playlist';
    status.appendChild(badge);

    const titleEl = document.createElement('p');
    titleEl.style.cssText = 'font-size:12px;font-weight:600;color:#333;margin:8px 0 4px;line-height:1.4;';
    titleEl.textContent = pageTitle || playlistUrl;
    status.appendChild(titleEl);

    if (!serverOnline) {
        const warn = document.createElement('div');
        warn.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px;margin:8px 0;font-size:12px;color:#856404;text-align:right;line-height:1.6;';
        warn.innerHTML = `
            <b>⚠️ سيرفر التحميل مطفي!</b><br>
            شغّل <b>start_server.bat</b> أولاً
        `;
        status.appendChild(warn);
        return;
    }

    // عرض رسالة تحميل المعلومات
    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'text-align:center;padding:15px;color:#666;font-size:13px;';
    loadingEl.textContent = '⏳ جاري جلب معلومات البلايلست...';
    status.appendChild(loadingEl);

    try {
        const info = await fetchPlaylistInfo(playlistUrl);
        loadingEl.remove();

        if (!info.success) {
            throw new Error(info.error || 'فشل جلب المعلومات');
        }

        // عدد الفيديوهات
        const countEl = document.createElement('div');
        countEl.style.cssText = 'font-size:13px;font-weight:bold;color:#155724;background:#d4edda;padding:8px 12px;border-radius:8px;margin:8px 0;';
        countEl.textContent = `🎬 ${info.playlist_title || 'بلايلست'} — ${info.count} فيديو`;
        status.appendChild(countEl);

        // بطاقة التحميل
        const card = document.createElement('div');
        card.className = 'media-card card-network';

        // اختيار الجودة
        const hintQ = document.createElement('div');
        hintQ.style.cssText = 'font-size:11px;color:#888;margin-bottom:6px;';
        hintQ.textContent = 'اختر الجودة:';
        card.appendChild(hintQ);

        const qualityRow = document.createElement('div');
        qualityRow.className = 'quality-row';
        const qualities = [
            { label: '🎬 أفضل جودة', value: 'best' },
            { label: '720p', value: '720' },
            { label: '480p', value: '480' },
            { label: '360p', value: '360' },
            { label: '🔊 صوت MP3', value: 'audio' },
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

        // اختيار النطاق
        const rangeSection = document.createElement('div');
        rangeSection.style.cssText = 'margin-top:10px;';

        const rangeLabel = document.createElement('div');
        rangeLabel.style.cssText = 'font-size:11px;color:#888;margin-bottom:4px;';
        rangeLabel.textContent = `نطاق الفيديوهات (اختياري — اتركه فارغ لتحميل الكل):`;
        rangeSection.appendChild(rangeLabel);

        const rangeInput = document.createElement('input');
        rangeInput.type = 'text';
        rangeInput.placeholder = `مثل: 1-10 أو 1,3,5 أو 1-5,8,10-12`;
        rangeInput.style.cssText = 'width:100%;padding:6px 10px;border:1px solid #dee2e6;border-radius:6px;font-size:12px;direction:ltr;text-align:left;box-sizing:border-box;';
        rangeSection.appendChild(rangeInput);
        card.appendChild(rangeSection);

        // أزرار التحميل
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

        const dlAllBtn = document.createElement('button');
        dlAllBtn.className = 'action-btn green-btn';
        dlAllBtn.style.cssText += 'flex:1;';
        dlAllBtn.textContent = `⬇️ تحميل الكل (${info.count})`;
        dlAllBtn.addEventListener('click', () => {
            const items = rangeInput.value.trim();
            downloadPlaylist(dlAllBtn, playlistUrl, selectedQuality, items, info.count);
        });
        btnRow.appendChild(dlAllBtn);
        card.appendChild(btnRow);

        // حالة التحميل
        const dlStatus = document.createElement('div');
        dlStatus.id = 'plDlStatus';
        dlStatus.style.cssText = 'margin-top:8px;font-size:12px;color:#666;display:none;';
        card.appendChild(dlStatus);

        status.appendChild(card);

        // قائمة الفيديوهات
        if (info.videos && info.videos.length > 0) {
            const listHeader = document.createElement('div');
            listHeader.style.cssText = 'font-size:12px;font-weight:bold;color:#555;margin-top:10px;margin-bottom:4px;';
            listHeader.textContent = `📋 قائمة الفيديوهات:`;
            status.appendChild(listHeader);

            const listContainer = document.createElement('div');
            listContainer.style.cssText = 'max-height:180px;overflow-y:auto;border:1px solid #e9ecef;border-radius:8px;background:#fff;';

            info.videos.forEach((v, i) => {
                const row = document.createElement('div');
                row.style.cssText = `padding:6px 10px;font-size:11px;color:#444;border-bottom:1px solid #f0f0f0;direction:ltr;text-align:left;display:flex;gap:6px;align-items:center;${i%2===0?'background:#fafafa;':''}`;

                const numSpan = document.createElement('span');
                numSpan.style.cssText = 'font-weight:bold;color:#007bff;min-width:24px;flex-shrink:0;';
                numSpan.textContent = `${i + 1}.`;
                row.appendChild(numSpan);

                const titleSpan = document.createElement('span');
                titleSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                titleSpan.textContent = v.title || 'بدون عنوان';
                row.appendChild(titleSpan);

                if (v.duration) {
                    const durSpan = document.createElement('span');
                    durSpan.style.cssText = 'color:#888;font-size:10px;flex-shrink:0;';
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
        errEl.style.cssText = 'background:#f8d7da;border:1px solid #f5c6cb;border-radius:8px;padding:10px;margin:8px 0;font-size:12px;color:#721c24;text-align:right;';
        errEl.textContent = `❌ ${err.message}`;
        status.appendChild(errEl);

        // Fallback: عرض تحميل مباشر بدون معلومات
        showPlaylistFallback(status, playlistUrl);
    }
}


// ===== Fallback بلايلست بدون معلومات =====
function showPlaylistFallback(status, playlistUrl) {
    const card = document.createElement('div');
    card.className = 'media-card card-network';

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:12px;color:#666;margin-bottom:8px;';
    msg.textContent = '💡 يمكنك تحميل البلايلست مباشرة:';
    card.appendChild(msg);

    const qualityRow = document.createElement('div');
    qualityRow.className = 'quality-row';
    let selectedQuality = 'best';
    [{ label: '🎬 أفضل', value: 'best' }, { label: '720p', value: '720' }, { label: '480p', value: '480' }, { label: '🔊 MP3', value: 'audio' }].forEach(q => {
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
    dlBtn.textContent = '⬇️ تحميل البلايلست كاملة';
    dlBtn.addEventListener('click', () => downloadPlaylist(dlBtn, playlistUrl, selectedQuality, '', 0));
    card.appendChild(dlBtn);

    const dlStatus = document.createElement('div');
    dlStatus.id = 'plDlStatus';
    dlStatus.style.cssText = 'margin-top:8px;font-size:12px;color:#666;display:none;';
    card.appendChild(dlStatus);

    status.appendChild(card);
}


// ===== تحميل البلايلست =====
async function downloadPlaylist(btn, url, quality, playlistItems, totalCount) {
    const dlStatus = document.getElementById('plDlStatus');
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = '⏳ جاري...';
    btn.style.opacity = '0.7';

    if (dlStatus) {
        dlStatus.style.display = 'block';
        dlStatus.textContent = '📡 إرسال طلب تحميل البلايلست...';
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
            btn.textContent = '✅ بدأ!';
            btn.style.background = '#28a745';
            if (dlStatus) {
                const itemsText = playlistItems ? `(فيديوهات: ${playlistItems})` : `(كل الفيديوهات${totalCount ? ' - ' + totalCount : ''})`;
                dlStatus.innerHTML = `✅ ${data.message} ${itemsText}<br><span style="font-size:10px;color:#888;">📁 ${data.download_dir}</span>`;
            }
        } else {
            throw new Error(data.error || 'Unknown error');
        }

    } catch (err) {
        btn.textContent = '❌ خطأ';
        btn.style.background = '#dc3545';
        if (dlStatus) {
            dlStatus.textContent = err.message.includes('fetch')
                ? '🔴 السيرفر مطفي! شغّل start_server.bat'
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
