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

        // ===== لو YouTube — نعرض واجهة التحميل بـ yt-dlp مباشرة =====
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
