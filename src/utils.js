/**
 * Provider-agnostic утилиты: работа с data URL, конвертация картинок,
 * загрузка файлов на сервер SillyTavern, DOM-escape.
 *
 * Зависит только от settings.js (iigLog).
 */

import { iigLog } from './settings.js';

// ----- Image fetch / convert -----

const REFERENCE_TIMEOUT_MS = 15000;

export async function fetchImageBlob(url, { signal = null, timeoutMs = REFERENCE_TIMEOUT_MS } = {}) {
    try {
        return await fetchWithTimeout(url, {}, timeoutMs, signal, async response => {
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            if (!response.ok || !contentType.startsWith('image/')) {
                iigLog('WARN', `Skipping reference: url=${url} status=${response.status} contentType=${contentType}`);
                return null;
            }
            const blob = await response.blob();
            return (blob.type || contentType).toLowerCase().startsWith('image/') ? blob : null;
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        iigLog('WARN', `Skipping reference fetch: url=${url} err=${error?.message || error}`);
        return null;
    }
}

export async function imageUrlToBase64(url, options = {}) {
    const dataUrl = await imageUrlToDataUrl(url, options);
    return dataUrl ? dataUrl.slice(dataUrl.indexOf(',') + 1) : null;
}

export async function imageUrlToDataUrl(url, options = {}) {
    try {
        const blob = await fetchImageBlob(url, options);
        return blob ? await readFileAsDataUrl(blob, options.signal) : null;
    } catch (error) {
        if (options.signal?.aborted) throw error;
        iigLog('WARN', 'Could not encode reference image:', error);
        return null;
    }
}

export function readFileAsDataUrl(file, signal = null) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const onAbort = () => reader.abort();
        const aborted = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) { aborted(); return; }
        reader.onerror = () => reject(reader.error);
        reader.onabort = aborted;
        reader.onloadend = () => {
            signal?.removeEventListener('abort', onAbort);
            if (reader.result !== null) resolve(String(reader.result || ''));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try { reader.readAsDataURL(file); }
        catch (error) { signal?.removeEventListener('abort', onAbort); reject(error); }
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
    let charName = debugMeta.characterName || 'generated';
    if (!debugMeta.characterName && context.characterId !== undefined && context.characters?.[context.characterId]) {
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
    return encodeLocalMediaPath(result.path);
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
    return encodeLocalMediaPath(result.path);
}

// ----- Small helpers -----

// Accept raw server filesystem paths only; stored URLs are already encoded.
export function encodeLocalMediaPath(path) {
    if (typeof path !== 'string' || !path) throw new Error('No path in media upload response');
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return encoded.startsWith('/') ? encoded : `/${encoded}`;
}

export async function listCharacterGenerationPaths(characterName) {
    const context = SillyTavern.getContext();
    const sanitizedResponse = await fetch('/api/files/sanitize-filename', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ fileName: characterName }),
    });
    if (!sanitizedResponse.ok) {
        throw new Error((await sanitizedResponse.text()) || `HTTP ${sanitizedResponse.status}`);
    }
    const { fileName: folder } = await sanitizedResponse.json();
    if (typeof folder !== 'string' || !folder) throw new Error('Character image folder is empty');
    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ folder, sortField: 'date', sortOrder: 'desc' }),
    });
    if (!response.ok) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
    }
    const files = await response.json();
    if (!Array.isArray(files)) throw new Error('Invalid character image list');
    return files
        .filter((file) => typeof file === 'string' && /^iig_/i.test(file))
        .map((file) => `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`);
}

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
    return div.innerHTML
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function sanitizeForSingleQuotedAttribute(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ----- Binary helpers -----

/**
 * Конвертирует «чистую» base64-строку (без `data:` префикса) в Blob.
 * Используется для multipart-запросов (напр. OpenAI `/v1/images/edits`).
 */
export function base64ToBlob(base64, mimeType = 'image/png') {
    const byteChars = atob(String(base64 || ''));
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
        byteArray[i] = byteChars.charCodeAt(i);
    }
    return new Blob([byteArray], { type: mimeType });
}

/**
 * Конвертирует data URL (`data:image/png;base64,...`) в Blob.
 */
export function dataUrlToBlob(dataUrl) {
    const parsed = parseImageDataUrl(dataUrl);
    return base64ToBlob(parsed.base64Data, parsed.mimeType);
}

// ----- Fetch with timeout / abort -----

/** One deadline owns the HTTP request and response consumer, with cleanup on every exit. */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 600_000, externalSignal = null, consume = response => response.json()) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(externalSignal.reason);
    const abortError = () => controller.signal.reason instanceof Error
        ? controller.signal.reason : new DOMException('Aborted', 'AbortError');
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = () => reject(abortError()); });
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
    const timeoutId = setTimeout(() => controller.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    try {
        if (externalSignal?.aborted) controller.abort(externalSignal.reason);
        const request = async () => {
            if (controller.signal.aborted) throw abortError();
            return await consume(await fetch(url, { ...init, signal: controller.signal }));
        };
        // The deadline owns both headers and body decoding, even if a reader stalls.
        return await Promise.race([request(), aborted]);
    } finally {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', rejectAborted);
        controller.abort();
    }
}

/**
 * Promise-based delay that resolves early when `signal` aborts. Removes its
 * abort listener on the normal timeout path, so it is safe to call repeatedly
 * (e.g. inside a polling loop) without accumulating listeners.
 */
export function abortableDelay(ms, signal = null) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        let timer = null;
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// ----- Error / UI asset paths -----

export const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';
export const STOPPED_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/stopped.svg';

export function getImagePlaceholderKind(src) {
    try {
        const url = new URL(src, window.location.href);
        if (url.origin !== window.location.origin) return '';
        if (url.pathname === ERROR_IMAGE_PATH) return 'error';
        if (url.pathname === STOPPED_IMAGE_PATH) return 'stopped';
    } catch { /* A pending marker is not necessarily a URL. */ }
    return '';
}

// ----- Provider error -----

/**
 * Унифицированная ошибка провайдера.
 *
 * Все провайдеры должны бросать только `ProviderError`. Это даёт pipeline:
 *   - однозначное решение о retry через `retryable` (вместо regex по message);
 *   - возможность логировать `code` / `status` / `providerId` отдельно от UI-текста;
 *   - стабильное сообщение для toast'а (`message`).
 */
export class ProviderError extends Error {
    /**
     * @param {object} params
     * @param {string} params.message — человекочитаемый текст для UI/логов.
     * @param {string} [params.code] — код ошибки: 'network', 'timeout', '429',
     *   'rate_limit_exceeded', 'invalid_request', ... По возможности берётся из
     *   тела ответа API, иначе — HTTP-статус или служебная метка.
     * @param {boolean} [params.retryable] — следует ли ретраить (см. isRetryableHttpStatus).
     * @param {string} [params.providerId] — id провайдера ('openai' / 'gemini' / ...).
     * @param {number} [params.status] — HTTP статус, если ошибка была ответом сервера.
     * @param {unknown} [params.cause] — исходная ошибка (сохранение stack trace).
     */
    constructor({ message, code = 'unknown', retryable = false, providerId = '', status = 0, cause } = {}) {
        super(message || code || 'Provider error');
        this.name = 'ProviderError';
        this.code = String(code);
        this.retryable = Boolean(retryable);
        this.providerId = String(providerId);
        this.status = Number(status) || 0;
        if (cause !== undefined) this.cause = cause;
    }
}

/**
 * Является ли HTTP-статус «временным» (имеет смысл повторить запрос).
 *   - 408 Request Timeout, 429 Too Many Requests — да;
 *   - 500/502/503/504 — да;
 *   - всё остальное (включая 501/505/4xx) — нет.
 */
export function isRetryableHttpStatus(status) {
    const s = Number(status) || 0;
    if (s === 408 || s === 429) return true;
    if (s === 500 || s === 502 || s === 503 || s === 504) return true;
    return false;
}
