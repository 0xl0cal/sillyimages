/** OpenAI-compatible and chat-completion image response decoding. */
import { iigLog } from './settings.js';

export async function parseOpenAIError(response) {
    const raw = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch (_e) {
        payload = null;
    }
    const err = payload?.error || {};
    const message = err.message || err.detail || raw || `HTTP ${response.status}`;
    const code = err.code || err.type || String(response.status);
    return { message: String(message).slice(0, 800), code, status: response.status };
}

export function extractOpenRouterImage(message) {
    if (!message || typeof message !== 'object') return null;
    const images = Array.isArray(message.images) ? message.images : [];
    for (const img of images) {
        if (!img || typeof img !== 'object') continue;
        if (typeof img.image_url?.url === 'string') return img.image_url.url;
        if (typeof img.data_url === 'string') return img.data_url;
        if (typeof img.b64_json === 'string' && img.b64_json) {
            const mime = img.image_base64?.media_type || img.media_type || 'image/png';
            return `data:${mime};base64,${img.b64_json}`;
        }
        if (typeof img.image_base64?.data === 'string' && img.image_base64.data) {
            const mime = img.image_base64.media_type || 'image/png';
            return `data:${mime};base64,${img.image_base64.data}`;
        }
        if (typeof img.url === 'string') return img.url;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'image_url' && typeof part.image_url?.url === 'string') return part.image_url.url;
        if (part.type === 'image' && typeof part.image === 'string') return part.image;
        if (part.type === 'input_image' && typeof part.image_url === 'string') return part.image_url;
    }
    return null;
}

export function extractImageFromResult(result, base64MimeType = 'image/png') {
    const dataList = Array.isArray(result?.data) ? result.data : [];
    if (dataList.length === 0) {
        if (result?.url) return result.url;
        iigLog('ERROR', 'OpenAI no-image response body:', result);
        throw new Error(`No image data in response. Top-level keys: ${Object.keys(result || {}).join(',')}`);
    }
    const imageObj = dataList[0];
    if (imageObj?.b64_json) {
        return `data:${base64MimeType};base64,${imageObj.b64_json}`;
    }
    if (imageObj?.url) {
        return imageObj.url;
    }
    iigLog('ERROR', 'OpenAI data[0] has no b64_json/url:', result);
    throw new Error(`Response data[0] has no b64_json or url. data[0] keys: ${Object.keys(imageObj || {}).join(',')}`);
}
