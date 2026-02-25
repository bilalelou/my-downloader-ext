// ===== Bilal Downloader v3 - Background Service Worker =====
// Intercepts real network requests and saves media URLs for each tab

const capturedMedia = {}; // { tabId: [ {url, filename, size, contentType, detectedBy, quality, site} ] }

// ===== Restore data from session storage on SW startup =====
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

// Save data to session storage
function persistTab(tabId) {
    if (capturedMedia[tabId]) {
        chrome.storage.session.set({ [`tab_${tabId}`]: capturedMedia[tabId] }).catch(() => { });
    }
}

// ===== Setup header rules for known sites =====
async function setupHeaderRules() {
    try {
        // Remove old rules first
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

// ===== Clean YouTube URL for full download =====
function cleanYoutubeUrl(url) {
    try {
        const u = new URL(url);
        // Remove range parameter to download full video
        u.searchParams.delete('range');
        // Remove rn (request number) as it's variable
        u.searchParams.delete('rn');
        // Remove rbuf
        u.searchParams.delete('rbuf');
        return u.toString();
    } catch {
        return url;
    }
}

// ===== Detection patterns =====

// Media files by extension
const MEDIA_URL_PATTERN = /\.(mp4|webm|mkv|m4v|avi|mov|flv|wmv|m3u8|mpd|mp3|m4a|ogg|aac|flac|wav)(\?|#|$)/i;

// Media Content-Type
const MEDIA_CONTENT_TYPES = /^(video|audio)\//i;

// ===== Site-specific patterns =====

// YouTube: video comes from googlevideo.com/videoplayback
const YOUTUBE_VIDEO_PATTERN = /googlevideo\.com\/videoplayback/i;

// Instagram: video comes from CDN
const INSTAGRAM_VIDEO_PATTERN = /(cdninstagram\.com|fbcdn\.net|instagram\.com).*\.(mp4|m4v)/i;
const INSTAGRAM_MEDIA_PATTERN = /(cdninstagram\.com|fbcdn\.net).*video/i;

// Facebook
const FACEBOOK_VIDEO_PATTERN = /(fbcdn\.net|fbvideo|facebook\.com).*video/i;

// Twitter/X
const TWITTER_VIDEO_PATTERN = /(twimg\.com|video\.twimg).*\.(mp4|m3u8)/i;

// TikTok
const TIKTOK_VIDEO_PATTERN = /(tiktokcdn\.com|musical\.ly|byteoversea|tiktok).*video/i;

// Extract filename from URL
function extractFilename(url, site) {
    try {
        const u = new URL(url);

        // Custom names per site
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

        // General: extract filename from path
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

// Extract file extension
function extractExtension(url, contentType) {
    // From Content-Type first
    if (contentType) {
        if (contentType.includes('mp4') || contentType.includes('m4v')) return 'mp4';
        if (contentType.includes('webm')) return 'webm';
        if (contentType.includes('mpeg') && contentType.includes('audio')) return 'mp3';
        if (contentType.includes('ogg')) return 'ogg';
        if (contentType.includes('mp4') && contentType.includes('audio')) return 'm4a';
    }
    // From URL
    const match = url.match(/\.(mp4|webm|mkv|m4v|avi|mov|flv|wmv|mp3|m4a|ogg|aac|flac|wav|m3u8|mpd)(\?|#|$)/i);
    return match ? match[1].toLowerCase() : null;
}

// Extract YouTube quality from itag
function getYoutubeQuality(url) {
    try {
        const u = new URL(url);
        const itag = u.searchParams.get('itag');
        const quality = u.searchParams.get('quality') || '';
        const mime = u.searchParams.get('mime') || '';

        // Common itags
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

// Detect site from URL
function detectSite(url) {
    if (YOUTUBE_VIDEO_PATTERN.test(url)) return 'youtube';
    if (INSTAGRAM_VIDEO_PATTERN.test(url) || INSTAGRAM_MEDIA_PATTERN.test(url)) return 'instagram';
    if (FACEBOOK_VIDEO_PATTERN.test(url)) return 'facebook';
    if (TWITTER_VIDEO_PATTERN.test(url)) return 'twitter';
    if (TIKTOK_VIDEO_PATTERN.test(url)) return 'tiktok';
    return null;
}

// ===== Intercept requests =====
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0) return;
        const url = details.url;
        if (!url || url.startsWith('chrome') || url.startsWith('about')) return;

        // Check file extension
        if (MEDIA_URL_PATTERN.test(url)) {
            const site = detectSite(url);
            addCapturedUrl(details.tabId, url, 'url-pattern', null, null, site);
        }

        // Check YouTube
        if (YOUTUBE_VIDEO_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'youtube-videoplayback', null, null, 'youtube');
        }

        // Check Instagram
        if (INSTAGRAM_VIDEO_PATTERN.test(url) || INSTAGRAM_MEDIA_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'instagram-cdn', null, null, 'instagram');
        }

        // Check TikTok
        if (TIKTOK_VIDEO_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'tiktok-cdn', null, null, 'tiktok');
        }

        // Check Twitter
        if (TWITTER_VIDEO_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'twitter-cdn', null, null, 'twitter');
        }

        // Check Facebook
        if (FACEBOOK_VIDEO_PATTERN.test(url)) {
            addCapturedUrl(details.tabId, url, 'facebook-cdn', null, null, 'facebook');
        }
    },
    { urls: ["<all_urls>"] }
);

// Intercept responses - Content-Type + size
chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        if (details.tabId < 0) return;

        const headers = details.responseHeaders || [];
        const contentType = headers.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        const contentLength = headers.find(h => h.name.toLowerCase() === 'content-length')?.value || '0';
        const contentRange = headers.find(h => h.name.toLowerCase() === 'content-range')?.value || '';
        let size = parseInt(contentLength) || 0;

        // If Content-Range exists, total size is after "/"
        if (contentRange) {
            const totalMatch = contentRange.match(/\/(\d+)/);
            if (totalMatch) size = parseInt(totalMatch[1]) || size;
        }

        const site = detectSite(details.url);

        // If Content-Type is media
        if (MEDIA_CONTENT_TYPES.test(contentType)) {
            addCapturedUrl(details.tabId, details.url, 'content-type', contentType, size, site);
            return;
        }

        // If large file (> 300KB) with media indicators
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

// ===== Save captured URLs =====
function addCapturedUrl(tabId, url, detectedBy, contentType, size, site) {
    if (!capturedMedia[tabId]) {
        capturedMedia[tabId] = [];
    }

    // Skip images and static assets
    const skipPatterns = /\.(jpg|jpeg|png|gif|svg|ico|webp|css|js|woff|woff2|ttf|eot|json|xml|txt)(\?|#|$)/i;
    if (skipPatterns.test(url)) return;

    // Skip small HLS/DASH segments
    const isSegment = /\.(ts|m4s)(\?|#|$)/i.test(url);
    // For YouTube + small range requests, skip (probe requests)
    if (site === 'youtube') {
        try {
            const u = new URL(url);
            const range = u.searchParams.get('range');
            if (range) {
                const [start, end] = range.split('-').map(Number);
                // If chunk size is less than 100KB, skip (probe requests)
                if (end - start < 102400) return;
            }
        } catch { /* ignore */ }
    }

    // Avoid duplicates (compare base URLs without range params)
    const baseUrl = getBaseUrl(url, site);
    const existing = capturedMedia[tabId].find(item => getBaseUrl(item.url, item.site) === baseUrl);
    if (existing) {
        // Update info
        if (size && size > (existing.size || 0)) existing.size = size;
        if (contentType && !existing.contentType) existing.contentType = contentType;
        if (!existing.site && site) existing.site = site;
        return;
    }

    // Additional site-specific info
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

    // Max 200 URLs per tab
    if (capturedMedia[tabId].length > 200) {
        capturedMedia[tabId] = capturedMedia[tabId].slice(-200);
    }

    // Persist to session storage (survives SW restarts)
    persistTab(tabId);
}

// Extract base URL (without range and variable params)
function getBaseUrl(url, site) {
    try {
        const u = new URL(url);
        if (site === 'youtube') {
            // For YouTube URLs, compare by itag + id
            const itag = u.searchParams.get('itag') || '';
            const id = u.searchParams.get('id') || u.pathname;
            return `yt:${id}:${itag}`;
        }
        // For others, use host + path
        return u.origin + u.pathname;
    } catch {
        return url;
    }
}

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
    delete capturedMedia[tabId];
    chrome.storage.session.remove(`tab_${tabId}`).catch(() => { });
});

// Cleanup when tab navigates to a new page
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
        delete capturedMedia[details.tabId];
        chrome.storage.session.remove(`tab_${details.tabId}`).catch(() => { });
    }
});

// Sort media by size and timestamp
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

// ===== Communication with popup =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ===== Download media with correct headers =====
    if (message.action === 'downloadMedia') {
        const { url, filename, site } = message;

        // Clean URL based on site
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

        // If data exists in memory
        if (capturedMedia[tabId] && capturedMedia[tabId].length > 0) {
            sendResponse({ urls: getSortedMedia(tabId) });
        } else {
            // Restore from session storage (if SW was restarted)
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
        chrome.storage.session.remove(`tab_${message.tabId}`).catch(() => { });
        sendResponse({ success: true });
        return true;
    }
});
