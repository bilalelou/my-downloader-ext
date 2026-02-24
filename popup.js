// ===== Bilal Video Downloader v3 - تحميل مباشر =====

document.getElementById('scanBtn').addEventListener('click', async () => {
    const status = document.getElementById('status');
    status.innerText = "جاري البحث...";

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
            status.innerText = "هذي صفحة محمية ❌";
            return;
        }

        // تحديد الموقع الحالي
        const currentSite = detectCurrentSite(tab.url);

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

                // عناصر <video> (مو blob)
                document.querySelectorAll('video').forEach(video => {
                    if (video.src?.trim() && !video.src.startsWith('blob:')) {
                        found.push({
                            url: video.src,
                            duration: video.duration || 0,
                            type: 'video'
                        });
                    }
                    video.querySelectorAll('source').forEach(source => {
                        if (source.src?.trim() && !source.src.startsWith('blob:')) {
                            found.push({
                                url: source.src,
                                duration: video.duration || 0,
                                type: 'source'
                            });
                        }
                    });
                });

                // Shadow DOM
                document.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) {
                        el.shadowRoot.querySelectorAll('video').forEach(video => {
                            if (video.src?.trim() && !video.src.startsWith('blob:')) {
                                found.push({
                                    url: video.src,
                                    duration: video.duration || 0,
                                    type: 'shadow-video'
                                });
                            }
                        });
                    }
                });

                // عناصر <audio>
                document.querySelectorAll('audio').forEach(audio => {
                    if (audio.src?.trim() && !audio.src.startsWith('blob:')) {
                        found.push({
                            url: audio.src,
                            duration: audio.duration || 0,
                            type: 'audio'
                        });
                    }
                    audio.querySelectorAll('source').forEach(source => {
                        if (source.src?.trim() && !source.src.startsWith('blob:')) {
                            found.push({
                                url: source.src,
                                duration: audio.duration || 0,
                                type: 'audio-source'
                            });
                        }
                    });
                });

                // ===== Meta tags (مهم لإنستغرام وغيره) =====
                const metaVideo = document.querySelector('meta[property="og:video"]')?.content;
                const metaVideoUrl = document.querySelector('meta[property="og:video:url"]')?.content;
                const metaVideoSecure = document.querySelector('meta[property="og:video:secure_url"]')?.content;
                [metaVideo, metaVideoUrl, metaVideoSecure].forEach(url => {
                    if (url?.trim() && !found.some(f => f.url === url)) {
                        found.push({ url, duration: 0, type: 'meta-video' });
                    }
                });

                // ===== Performance entries =====
                try {
                    const entries = performance.getEntriesByType('resource');
                    const mediaPattern = /\.(mp4|webm|mkv|m4v|avi|mov|m3u8|mpd|mp3|m4a|ogg|aac|flac)(\?|#|$)/i;
                    entries.forEach(entry => {
                        if (mediaPattern.test(entry.name) && !found.some(f => f.url === entry.name)) {
                            const isAudio = /\.(mp3|m4a|ogg|aac|flac)(\?|#|$)/i.test(entry.name);
                            found.push({
                                url: entry.name,
                                duration: 0,
                                type: isAudio ? 'perf-audio' : 'perf-video'
                            });
                        }
                    });
                } catch (e) { /* ignore */ }

                // ===== البحث في JSON-LD (بعض المواقع تحطه) =====
                try {
                    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
                        const data = JSON.parse(script.textContent);
                        const findVideoUrls = (obj) => {
                            if (!obj || typeof obj !== 'object') return;
                            if (obj.contentUrl && typeof obj.contentUrl === 'string') {
                                if (!found.some(f => f.url === obj.contentUrl)) {
                                    found.push({ url: obj.contentUrl, duration: 0, type: 'jsonld-video' });
                                }
                            }
                            if (obj.embedUrl && typeof obj.embedUrl === 'string' && obj.embedUrl.includes('.mp4')) {
                                if (!found.some(f => f.url === obj.embedUrl)) {
                                    found.push({ url: obj.embedUrl, duration: 0, type: 'jsonld-video' });
                                }
                            }
                            if (Array.isArray(obj)) obj.forEach(findVideoUrls);
                            else Object.values(obj).forEach(v => { if (typeof v === 'object') findVideoUrls(v); });
                        };
                        findVideoUrls(data);
                    });
                } catch (e) { /* ignore */ }

                const pageTitle = document.title || '';

                return {
                    media: [...new Map(found.map(item => [item.url, item])).values()],
                    pageTitle
                };
            }
        });

        // ===== 3) دمج النتائج =====
        if (!injectionResults?.[0]?.result) {
            status.innerText = "صار خطأ أثناء البحث ❌";
            return;
        }

        const { media: pageMedia, pageTitle } = injectionResults[0].result;

        // دمج روابط الشبكة
        const allUrls = new Set(pageMedia.map(m => m.url));
        const networkItems = networkUrls
            .filter(n => !allUrls.has(n.url))
            .map(n => ({
                url: n.url,
                duration: 0,
                type: 'network',
                filename: n.filename,
                extension: n.extension,
                contentType: n.contentType,
                size: n.size,
                site: n.site,
                quality: n.quality,
                isAudioOnly: n.isAudio,
                fromNetwork: true
            }));

        // ترتيب: روابط الشبكة أولاً (أقوى)، بعدين الصفحة
        const mediaList = [...networkItems, ...pageMedia];

        if (mediaList.length === 0) {
            let hint = "ما لقيت أي فيديو أو صوت ❌\n\n";
            if (currentSite === 'youtube') {
                hint += "💡 يوتيوب: شغّل الفيديو خله يحمل شوي، وبعدين اضغط بحث مرة ثانية";
            } else if (currentSite === 'instagram') {
                hint += "💡 إنستغرام: افتح الريل أو البوست لحاله (اضغط عليه)، شغل الفيديو، وبعدين اضغط بحث";
            } else {
                hint += "💡 شغّل الفيديو أول وبعدين اضغط بحث مرة ثانية";
            }
            status.innerText = hint;
            return;
        }

        // ===== 4) عرض النتائج =====
        status.innerText = '';

        // عنوان الموقع
        if (currentSite) {
            const siteHeader = document.createElement('div');
            siteHeader.className = 'site-badge';
            const siteNames = {
                youtube: '🎬 YouTube', instagram: '📸 Instagram',
                tiktok: '🎵 TikTok', twitter: '🐦 Twitter/X', facebook: '📘 Facebook'
            };
            siteHeader.textContent = siteNames[currentSite] || currentSite;
            status.appendChild(siteHeader);
        }

        const header = document.createElement('p');
        header.style.cssText = 'color:#28a745;font-weight:bold;margin:0 0 8px;font-size:14px;';
        header.textContent = `لقينا ${mediaList.length} ميديا! ✅`;
        status.appendChild(header);

        mediaList.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'media-card';

            // ===== استخراج اسم الملف =====
            let filename = '';
            let extension = '';
            let quality = item.quality || '';

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

            // لو ما لقينا امتداد، شوف Content-Type
            if (!extension && item.contentType) {
                if (item.contentType.includes('mp4')) extension = 'mp4';
                else if (item.contentType.includes('webm')) extension = 'webm';
            }

            // ===== تصنيف البطاقة =====
            const site = item.site || currentSite;
            const isAudio = item.isAudioOnly || item.type?.includes('audio') || /\.(mp3|m4a|ogg|aac|flac|wav)$/i.test(extension);
            let icon, typeText, cardClass;

            if (site === 'youtube') {
                icon = isAudio ? '🔊' : '🎬';
                typeText = quality || (extension?.toUpperCase()) || (isAudio ? 'AUDIO' : 'VIDEO');
                cardClass = isAudio ? 'card-audio' : 'card-network';
            } else if (site === 'instagram') {
                icon = '📸';
                typeText = 'MP4';
                cardClass = 'card-network';
                filename = pageTitle ? pageTitle.substring(0, 40) : 'instagram_video';
            } else if (site === 'tiktok') {
                icon = '🎵';
                typeText = 'MP4';
                cardClass = 'card-network';
                filename = 'tiktok_video';
            } else if (item.fromNetwork) {
                icon = '🌐';
                typeText = extension?.toUpperCase() || 'MEDIA';
                cardClass = 'card-network';
            } else if (isAudio) {
                icon = '🔊';
                typeText = extension?.toUpperCase() || 'AUDIO';
                cardClass = 'card-audio';
            } else {
                icon = '🎬';
                typeText = extension?.toUpperCase() || 'VIDEO';
                cardClass = 'card-video';
            }

            card.classList.add(cardClass);

            // ===== العنوان =====
            const titleRow = document.createElement('div');
            titleRow.className = 'card-title';

            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = typeText;
            titleRow.appendChild(badge);

            const nameEl = document.createElement('span');
            nameEl.className = 'filename';
            nameEl.textContent = `${icon} ${filename}`;
            titleRow.appendChild(nameEl);

            card.appendChild(titleRow);

            // ===== معلومات =====
            const info = [];
            if (item.duration && Number.isFinite(item.duration) && item.duration > 0) {
                const m = Math.floor(item.duration / 60);
                const s = Math.floor(item.duration % 60);
                info.push(`⏱ ${m}:${s.toString().padStart(2, '0')}`);
            }
            if (item.size && item.size > 0) {
                if (item.size > 1048576) {
                    info.push(`📦 ${(item.size / 1048576).toFixed(1)} MB`);
                } else if (item.size > 1024) {
                    info.push(`📦 ${(item.size / 1024).toFixed(0)} KB`);
                }
            }
            if (quality && site === 'youtube') {
                info.push(`🎯 ${quality}`);
            }
            if (info.length > 0) {
                const infoEl = document.createElement('div');
                infoEl.className = 'card-info';
                infoEl.textContent = info.join('  •  ');
                card.appendChild(infoEl);
            }

            // ===== زر التحميل =====
            const dlBtn = document.createElement('button');
            dlBtn.textContent = '⬇️ تحميل مباشر';
            dlBtn.className = 'download-link';
            dlBtn.style.border = 'none';
            dlBtn.style.cursor = 'pointer';
            dlBtn.style.width = '100%';
            dlBtn.style.textAlign = 'center';
            dlBtn.addEventListener('click', () => {
                const safeName = (filename || 'video').replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
                const dlFilename = extension ? `${safeName}.${extension}` : safeName;
                chrome.downloads.download({ url: item.url, filename: dlFilename }, () => {
                    if (chrome.runtime.lastError) {
                        // Fallback: فتح في تبويب جديد
                        chrome.tabs.create({ url: item.url });
                    }
                });
            });
            card.appendChild(dlBtn);

            status.appendChild(card);
        });

    } catch (error) {
        status.innerText = `صار خطأ: ${error.message} ❌`;
    }
});


// تحديد الموقع الحالي
function detectCurrentSite(url) {
    if (!url) return null;
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
    if (url.includes('facebook.com') || url.includes('fb.com')) return 'facebook';
    return null;
}
