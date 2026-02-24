// ===== Bilal Downloader v3 - Background Service Worker =====
// يعترض طلبات الشبكة الحقيقية ويحفظ روابط الميديا لكل تبويب

const capturedMedia = {}; // { tabId: [ {url, filename, size, contentType, detectedBy, quality, site} ] }

// ===== استعادة البيانات من التخزين المؤقت عند بدء SW =====
async function restoreFromStorage() {
    try {
        const data = await chrome.storage.session.get(null);
        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('tab_')) {
                const tabId = parseInt(key.substring(4));
                if (!isNaN(tabId) && Array.isArray(value)) {
                    capturedMedia[tabId] = value;
                }
            }
        }
    } catch (e) { /* ignore */ }
}
restoreFromStorage();

// حفظ البيانات في التخزين المؤقت
function persistTab(tabId) {
    if (capturedMedia[tabId]) {
        chrome.storage.session.set({ [`tab_${tabId}`]: capturedMedia[tabId] }).catch(() => {});
    }
}

// ===== إعداد قواعد الترويسات للمواقع المعروفة =====
async function setupHeaderRules() {
    try {
        // حذف القواعد القديمة أولاً
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const existingIds = existingRules.map(r => r.id);

        const rules = [
            {
                id: 1001,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
                        { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' }
                    ]
                },
                condition: {
                    requestDomains: ['googlevideo.com'],
                    resourceTypes: ['xmlhttprequest', 'media', 'other']
                }
            },
            {
                id: 1002,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: 'https://www.instagram.com/' },
                        { header: 'Origin', operation: 'set', value: 'https://www.instagram.com' }
                    ]
                },
                condition: {
                    requestDomains: ['cdninstagram.com', 'fbcdn.net'],
                    resourceTypes: ['xmlhttprequest', 'media', 'other']
                }
            },
            {
                id: 1003,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: 'https://www.tiktok.com/' },
                        { header: 'Origin', operation: 'set', value: 'https://www.tiktok.com' }
                    ]
                },
                condition: {
                    requestDomains: ['tiktokcdn.com', 'byteoversea.com'],
                    resourceTypes: ['xmlhttprequest', 'media', 'other']
                }
            },
            {
                id: 1004,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: 'https://twitter.com/' },
                        { header: 'Origin', operation: 'set', value: 'https://twitter.com' }
                    ]
                },
                condition: {
                    requestDomains: ['twimg.com'],
                    resourceTypes: ['xmlhttprequest', 'media', 'other']
                }
            }
        ];

        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: existingIds,
            addRules: rules
        });
    } catch (e) { /* ignore */ }
}
setupHeaderRules();

// ===== تنظيف رابط YouTube للتحميل الكامل =====
function cleanYoutubeUrl(url) {
    try {
        const u = new URL(url);
        // حذف range parameter لتحميل الفيديو كامل
        u.searchParams.delete('range');
        // حذف rn (request number) لأنه متغير
        u.searchParams.delete('rn');
        // حذف rbuf
        u.searchParams.delete('rbuf');
        return u.toString();
    } catch {
        return url;
    }
}

// ===== أنماط الاكتشاف =====

// ملفات ميديا بالامتداد
const MEDIA_URL_PATTERN = /\.(mp4|webm|mkv|m4v|avi|mov|flv|wmv|m3u8|mpd|mp3|m4a|ogg|aac|flac|wav)(\?|#|$)/i;

// Content-Type ميديا
const MEDIA_CONTENT_TYPES = /^(video|audio)\//i;

// ===== أنماط خاصة بالمواقع =====

// يوتيوب: الفيديو يجي من googlevideo.com/videoplayback
const YOUTUBE_VIDEO_PATTERN = /googlevideo\.com\/videoplayback/i;

// إنستغرام: الفيديو يجي من CDN
const INSTAGRAM_VIDEO_PATTERN = /(cdninstagram\.com|fbcdn\.net|instagram\.com).*\.(mp4|m4v)/i;
const INSTAGRAM_MEDIA_PATTERN = /(cdninstagram\.com|fbcdn\.net).*video/i;

// فيسبوك
const FACEBOOK_VIDEO_PATTERN = /(fbcdn\.net|fbvideo|facebook\.com).*video/i;

// تويتر/X
const TWITTER_VIDEO_PATTERN = /(twimg\.com|video\.twimg).*\.(mp4|m3u8)/i;

// تيك توك
const TIKTOK_VIDEO_PATTERN = /(tiktokcdn\.com|musical\.ly|byteoversea|tiktok).*video/i;

// استخراج اسم الملف من الرابط
function extractFilename(url, site) {
    try {
        const u = new URL(url);

        // أسماء مخصصة حسب الموقع
        if (site === 'youtube') {
            const itag = u.searchParams.get('itag') || '';
            const mime = u.searchParams.get('mime') || '';
            const isAudio = mime.includes('audio');
            return isAudio ? `youtube_audio_${itag}` : `youtube_video_${itag}`;
        }

        if (site === 'instagram') {
            const parts = u.pathname.split('/').filter(Boolean);
            return `instagram_${parts[parts.length - 1] || 'video'}`;
        }

        if (site === 'tiktok') return 'tiktok_video';
        if (site === 'twitter') return 'twitter_video';
        if (site === 'facebook') return 'facebook_video';

        // عام: استخرج اسم الملف من المسار
        const pathParts = u.pathname.split('/').filter(Boolean);
        const last = pathParts[pathParts.length - 1] || '';
        const decoded = decodeURIComponent(last);
        if (/\.(mp4|webm|mkv|m4v|avi|mov|flv|wmv|mp3|m4a|ogg|aac|flac|wav|m3u8)/i.test(decoded)) {
            return decoded;
        }
        return decoded || u.hostname;
    } catch {
        return url.substring(0, 60);
    }
}

// استخراج الامتداد
function extractExtension(url, contentType) {
    // من Content-Type أولاً
    if (contentType) {
        if (contentType.includes('mp4') || contentType.includes('m4v')) return 'mp4';
        if (contentType.includes('webm')) return 'webm';
        if (contentType.includes('mpeg') && contentType.includes('audio')) return 'mp3';
        if (contentType.includes('ogg')) return 'ogg';
        if (contentType.includes('mp4') && contentType.includes('audio')) return 'm4a';
    }
    // من الرابط
    const match = url.match(/\.(mp4|webm|mkv|m4v|avi|mov|flv|wmv|mp3|m4a|ogg|aac|flac|wav|m3u8|mpd)(\?|#|$)/i);
    return match ? match[1].toLowerCase() : null;
}

// استخراج جودة يوتيوب من itag
function getYoutubeQuality(url) {
    try {
        const u = new URL(url);
        const itag = u.searchParams.get('itag');
        const quality = u.searchParams.get('quality') || '';
        const mime = u.searchParams.get('mime') || '';

        // أشهر itags
        const itagMap = {
            '18': '360p', '22': '720p', '37': '1080p', '38': '4K',
            '133': '240p', '134': '360p', '135': '480p', '136': '720p',
            '137': '1080p', '138': '4K', '160': '144p',
            '242': '240p', '243': '360p', '244': '480p', '247': '720p',
            '248': '1080p', '271': '1440p', '313': '2160p',
            '298': '720p60', '299': '1080p60', '302': '720p60', '303': '1080p60',
            '139': 'audio 48k', '140': 'audio 128k', '141': 'audio 256k',
            '171': 'audio 128k', '172': 'audio 256k',
            '249': 'audio 50k', '250': 'audio 70k', '251': 'audio 160k'
        };

        const isAudio = mime.includes('audio');
        const label = itagMap[itag] || quality || (isAudio ? 'audio' : 'video');
        return { quality: label, isAudio };
    } catch {
        return { quality: '', isAudio: false };
    }
}

// تحديد الموقع من الرابط
function detectSite(url) {
    if (YOUTUBE_VIDEO_PATTERN.test(url)) return 'youtube';
    if (INSTAGRAM_VIDEO_PATTERN.test(url) || INSTAGRAM_MEDIA_PATTERN.test(url)) return 'instagram';
    if (FACEBOOK_VIDEO_PATTERN.test(url)) return 'facebook';
    if (TWITTER_VIDEO_PATTERN.test(url)) return 'twitter';
    if (TIKTOK_VIDEO_PATTERN.test(url)) return 'tiktok';
    return null;
}

// ===== اعتراض الطلبات =====
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0) return;
        const url = details.url;
        if (!url || url.startsWith('chrome') || url.startsWith('about')) return;

        // فحص الامتداد
        if (MEDIA_URL_PATTERN.test(url)) {
            const site = detectSite(url);
            addCapturedUrl(details.tabId, url, 'url-pattern', null, null, site);
        }

        // فحص يوتيوب
        if (YOUTUBE_VIDEO_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'youtube-videoplayback', null, null, 'youtube');
        }

        // فحص إنستغرام
        if (INSTAGRAM_VIDEO_PATTERN.test(url) || INSTAGRAM_MEDIA_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'instagram-cdn', null, null, 'instagram');
        }

        // فحص تيك توك
        if (TIKTOK_VIDEO_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'tiktok-cdn', null, null, 'tiktok');
        }

        // فحص تويتر
        if (TWITTER_VIDEO_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'twitter-cdn', null, null, 'twitter');
        }

        // فحص فيسبوك
        if (FACEBOOK_VIDEO_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'facebook-cdn', null, null, 'facebook');
        }
    },
    { urls: ["<all_urls>"] }
);

// اعتراض الردود - Content-Type + حجم
chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        if (details.tabId < 0) return;

        const headers = details.responseHeaders || [];
        const contentType = headers.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        const contentLength = headers.find(h => h.name.toLowerCase() === 'content-length')?.value || '0';
        const contentRange = headers.find(h => h.name.toLowerCase() === 'content-range')?.value || '';
        let size = parseInt(contentLength) || 0;

        // لو فيه Content-Range، الحجم الكلي يكون بعد "/"
        if (contentRange) {
            const totalMatch = contentRange.match(/\/(\d+)/);
            if (totalMatch) size = parseInt(totalMatch[1]) || size;
        }

        const site = detectSite(details.url);

        // لو Content-Type ميديا
        if (MEDIA_CONTENT_TYPES.test(contentType)) {
            addCapturedUrl(details.tabId, details.url, 'content-type', contentType, size, site);
            return;
        }

        // لو ملف كبير (> 300KB) وفيه إشارة للميديا
        if (size > 307200) {
            const urlLower = details.url.toLowerCase();
            if (urlLower.includes('video') || urlLower.includes('media') || urlLower.includes('stream') ||
                urlLower.includes('play') || urlLower.includes('clip') || site) {
                addCapturedUrl(details.tabId, details.url, 'large-media', contentType, size, site);
            }
        }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
);

// ===== حفظ الروابط =====
function addCapturedUrl(tabId, url, detectedBy, contentType, size, site) {
    if (!capturedMedia[tabId]) {
        capturedMedia[tabId] = [];
    }

    // تجاهل الصور والأصول
    const skipPatterns = /\.(jpg|jpeg|png|gif|svg|ico|webp|css|js|woff|woff2|ttf|eot|json|xml|txt)(\?|#|$)/i;
    if (skipPatterns.test(url)) return;

    // تجاهل أجزاء HLS/DASH الصغيرة
    const isSegment = /\.(ts|m4s)(\?|#|$)/i.test(url);
    // لو يوتيوب + range request لجزء صغير، تجاهل
    if (site === 'youtube') {
        try {
            const u = new URL(url);
            const range = u.searchParams.get('range');
            if (range) {
                const [start, end] = range.split('-').map(Number);
                // لو حجم القطعة أقل من 100KB، تجاهل (هذي probe requests)
                if (end - start < 102400) return;
            }
        } catch { /* ignore */ }
    }

    // تجنب التكرار (للروابط الأساسية بدون range params)
    const baseUrl = getBaseUrl(url, site);
    const existing = capturedMedia[tabId].find(item => getBaseUrl(item.url, item.site) === baseUrl);
    if (existing) {
        // حدث المعلومات
        if (size && size > (existing.size || 0)) existing.size = size;
        if (contentType && !existing.contentType) existing.contentType = contentType;
        if (!existing.site && site) existing.site = site;
        return;
    }

    // معلومات إضافية حسب الموقع
    let quality = '';
    let isAudio = false;
    if (site === 'youtube') {
        const ytInfo = getYoutubeQuality(url);
        quality = ytInfo.quality;
        isAudio = ytInfo.isAudio;
    }

    capturedMedia[tabId].push({
        url,
        filename: extractFilename(url, site),
        extension: extractExtension(url, contentType),
        detectedBy,
        contentType: contentType || null,
        size: size || 0,
        isSegment,
        site: site || null,
        quality,
        isAudio,
        timestamp: Date.now()
    });

    // أقصى 200 رابط
    if (capturedMedia[tabId].length > 200) {
        capturedMedia[tabId] = capturedMedia[tabId].slice(-200);
    }

    // حفظ في التخزين المؤقت (يبقى حتى لو SW انطفأ)
    persistTab(tabId);
}

// استخراج الرابط الأساسي (بدون range وأشياء متغيرة)
function getBaseUrl(url, site) {
    try {
        const u = new URL(url);
        if (site === 'youtube') {
            // لروابط يوتيوب، نقارن بالـ itag + id
            const itag = u.searchParams.get('itag') || '';
            const id = u.searchParams.get('id') || u.pathname;
            return `yt:${id}:${itag}`;
        }
        // للباقي، استخدم الهوست + المسار
        return u.origin + u.pathname;
    } catch {
        return url;
    }
}

// تنظيف لما التبويب ينقفل
chrome.tabs.onRemoved.addListener((tabId) => {
    delete capturedMedia[tabId];
    chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
});

// تنظيف لما التبويب يتنقل لصفحة جديدة
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
        delete capturedMedia[details.tabId];
        chrome.storage.session.remove(`tab_${details.tabId}`).catch(() => {});
    }
});

// ترتيب الميديا
function getSortedMedia(tabId) {
    const urls = capturedMedia[tabId] || [];
    const sorted = [...urls]
        .filter(u => !u.isSegment)
        .sort((a, b) => {
            if (a.size !== b.size) return (b.size || 0) - (a.size || 0);
            return b.timestamp - a.timestamp;
        });
    return sorted.length > 0 ? sorted : urls;
}

// ===== التواصل مع popup =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ===== تحميل ميديا مع ترويسات صحيحة =====
    if (message.action === 'downloadMedia') {
        const { url, filename, site } = message;

        // تنظيف الرابط حسب الموقع
        let cleanUrl = url;
        if (site === 'youtube') {
            cleanUrl = cleanYoutubeUrl(url);
        }

        chrome.downloads.download({
            url: cleanUrl,
            filename: filename || 'video.mp4'
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ success: true, downloadId });
            }
        });
        return true;
    }

    if (message.action === 'getCapturedMedia') {
        const tabId = message.tabId;

        // لو البيانات موجودة في الذاكرة
        if (capturedMedia[tabId] && capturedMedia[tabId].length > 0) {
            sendResponse({ urls: getSortedMedia(tabId) });
        } else {
            // استرجاع من التخزين المؤقت (لو SW انطفأ ورجع)
            chrome.storage.session.get(`tab_${tabId}`).then(data => {
                const stored = data[`tab_${tabId}`];
                if (stored && Array.isArray(stored)) {
                    capturedMedia[tabId] = stored;
                }
                sendResponse({ urls: getSortedMedia(tabId) });
            }).catch(() => {
                sendResponse({ urls: [] });
            });
        }
        return true;
    }

    if (message.action === 'clearCapturedMedia') {
        delete capturedMedia[message.tabId];
        chrome.storage.session.remove(`tab_${message.tabId}`).catch(() => {});
        sendResponse({ success: true });
        return true;
    }
});
