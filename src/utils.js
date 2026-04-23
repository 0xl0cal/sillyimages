/**
 * Provider-agnostic утилиты: работа с data URL, конвертация картинок,
 * загрузка файлов на сервер SillyTavern, DOM-escape.
 *
 * Зависит только от settings.js (iigLog).
 */

import { iigLog } from './settings.js';

// ----- Image fetch / convert -----

export async function fetchImageBlob(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            iigLog('WARN', `Skipping context reference fetch: url=${url} status=${response.status}`);
            return null;
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.startsWith('image/')) {
            iigLog(
                'WARN',
                `Skipping context reference with non-image content-type: url=${url} contentType=${contentType || '(empty)'}`
            );
            return null;
        }

        const blob = await response.blob();
        const blobType = String(blob.type || contentType || '').toLowerCase();
        if (!blobType.startsWith('image/')) {
            iigLog(
                'WARN',
                `Skipping context reference with non-image blob type: url=${url} blobType=${blobType || '(empty)'}`
            );
            return null;
        }
        return blob;
    } catch (error) {
        iigLog('WARN', `Skipping context reference fetch failure: url=${url} err=${error?.message || error}`);
        return null;
    }
}

/** URL → чистый base64 (без data:image/... префикса). */
export async function imageUrlToBase64(url) {
    try {
        const blob = await fetchImageBlob(url);
        if (!blob) {
            return null;
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

/** URL → полный data URL. */
export async function imageUrlToDataUrl(url) {
    try {
        const blob = await fetchImageBlob(url);
        if (!blob) {
            return null;
        }

        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to data URL:', error);
        return null;
    }
}

export async function readFileAsDataUrl(file) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ----- Data URL parsing / PNG conversion -----

const IIG_UPLOAD_FORMAT_MAP = Object.freeze({
    'jpeg': 'jpg',
    'jpg': 'jpg',
    'pjpeg': 'jpg',
    'jfif': 'jpg',
    'png': 'png',
    'x-png': 'png',
    'webp': 'webp',
    'gif': 'gif',
});

const IIG_UPLOAD_ALLOWED_FORMATS = new Set(['jpg', 'png', 'webp', 'gif']);

export function parseImageDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') {
        throw new Error(`Invalid data URL type: ${typeof dataUrl}`);
    }
    if (!dataUrl.startsWith('data:')) {
        throw new Error('Invalid data URL prefix (expected data:)');
    }

    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx <= 5) {
        throw new Error('Invalid data URL format (missing comma)');
    }

    const meta = dataUrl.slice(5, commaIdx).trim();
    const base64Data = dataUrl.slice(commaIdx + 1).trim();
    const metaParts = meta.split(';').map(s => s.trim()).filter(Boolean);
    const mimeType = (metaParts[0] || '').toLowerCase();
    const hasBase64 = metaParts.some(p => p.toLowerCase() === 'base64');

    if (!mimeType.startsWith('image/')) {
        throw new Error(`Invalid data URL mime type: ${mimeType || '(empty)'}`);
    }
    if (!hasBase64) {
        throw new Error('Invalid data URL encoding (base64 flag missing)');
    }
    if (!base64Data) {
        throw new Error('Invalid data URL payload (empty base64)');
    }

    const subtype = mimeType.slice('image/'.length).toLowerCase();
    const normalizedFormat = IIG_UPLOAD_FORMAT_MAP[subtype] || subtype;

    return {
        mimeType,
        subtype,
        normalizedFormat,
        base64Data,
    };
}

export async function convertDataUrlToPng(dataUrl) {
    return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const width = img.naturalWidth || img.width;
            const height = img.naturalHeight || img.height;
            if (!width || !height) {
                reject(new Error('Image decode failed (no dimensions)'));
                return;
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Canvas 2D context unavailable'));
                return;
            }
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('Failed to decode data URL image'));
        img.src = dataUrl;
    });
}

// ----- Upload (via SillyTavern API) -----

export async function saveImageToFile(dataUrl, debugMeta = {}) {
    const context = SillyTavern.getContext();

    let parsed;
    try {
        parsed = parseImageDataUrl(dataUrl);
    } catch (error) {
        iigLog(
            'ERROR',
            `saveImageToFile parse failed: ${error.message}; debug=${JSON.stringify(debugMeta)}; prefix=${String(dataUrl).slice(0, 120)}`
        );
        throw error;
    }

    if (!IIG_UPLOAD_ALLOWED_FORMATS.has(parsed.normalizedFormat)) {
        iigLog(
            'WARN',
            `Unsupported upload format "${parsed.subtype}" (mime=${parsed.mimeType}); converting to PNG; debug=${JSON.stringify(debugMeta)}`
        );
        const converted = await convertDataUrlToPng(dataUrl);
        parsed = parseImageDataUrl(converted);
    }

    const format = parsed.normalizedFormat;
    const base64Data = parsed.base64Data;
    iigLog(
        'INFO',
        `Uploading image: mime=${parsed.mimeType} subtype=${parsed.subtype} format=${format} b64len=${base64Data.length} debug=${JSON.stringify(debugMeta)}`
    );

    // Get character name for subfolder
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;

    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename,
        }),
    });

    if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let parsedError = {};
        try {
            parsedError = raw ? JSON.parse(raw) : {};
        } catch (_e) {
            parsedError = {};
        }
        const errText = parsedError?.error || parsedError?.detail || raw || `Upload failed: ${response.status}`;
        iigLog(
            'ERROR',
            `Upload failed status=${response.status} format=${format} mime=${parsed.mimeType} debug=${JSON.stringify(debugMeta)} response=${String(errText).slice(0, 400)}`
        );
        throw new Error(errText);
    }

    const result = await response.json();
    console.log('[IIG] Image saved to:', result.path);
    return result.path;
}

export async function saveNaisteraMediaToFile(dataUrl, mediaKind = 'video', debugMeta = {}) {
    if (mediaKind !== 'video') {
        throw new Error(`Unsupported mediaKind for file upload: ${mediaKind}`);
    }

    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:video/mp4;base64,')) {
        throw new Error('Only data:video/mp4;base64 URLs are supported');
    }

    const context = SillyTavern.getContext();
    const base64Data = dataUrl.slice('data:video/mp4;base64,'.length).trim();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `iig_video_${timestamp}.mp4`;

    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            name: fileName,
            data: base64Data,
        }),
    });

    if (!response.ok) {
        const raw = await response.text().catch(() => '');
        iigLog(
            'ERROR',
            `ST media upload failed status=${response.status} kind=${mediaKind} debug=${JSON.stringify(debugMeta)} response=${String(raw).slice(0, 400)}`
        );
        throw new Error(raw || `Media upload failed: ${response.status}`);
    }

    const result = await response.json();
    if (!result?.path) {
        throw new Error('No path in media upload response');
    }
    return result.path;
}

// ----- Small helpers -----

export async function checkFileExists(path) {
    try {
        const response = await fetch(path, { method: 'HEAD' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

export function normalizeStoredImagePath(path) {
    const raw = String(path || '').trim();
    if (!raw) return '';
    if (raw.startsWith('data:')) return raw;
    if (/^(?:https?:)?\/\//i.test(raw)) return raw;
    return raw.startsWith('/') ? raw : `/${raw.replace(/^\/+/, '')}`;
}

export function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function sanitizeForSingleQuotedAttribute(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ----- Error / UI asset paths -----

export const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';
