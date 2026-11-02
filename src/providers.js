/** Provider registry, model capabilities and generation transports. */

import {
    getSettings,
    iigLog,
    ENDPOINT_PLACEHOLDERS,
    MAX_GENERATION_REFERENCE_IMAGES,
    MAX_ADDITIONAL_REFERENCES,
    normalizeNaisteraModel,
    isNaisteraNovelAIModel,
    normalizeNaisteraCharacterDescriptionsMode,
    normalizeImageContextCount,
    normalizeNaisteraVideoFrequency,
    getEffectiveEndpoint,
    getEffectiveRefInstruction,
    getEffectiveNegativePrompt,
    getLastRequestSnapshot,
} from './settings.js';
import {
    normalizeStoredImagePath,
    imageUrlToBase64,
    imageUrlToDataUrl,
    base64ToBlob,
    fetchWithTimeout,
    abortableDelay,
    ProviderError,
    isRetryableHttpStatus,
} from './utils.js';
import { buildFinalGenerationPrompt } from './parser.js';
import { NOVELAI_MODELS, buildNovelAIParameters, validateNovelAIParameters, splitNovelAICharacterPrompts, isNovelAIMedium } from './novelai.js';
import { t } from './i18n.js';
import { Provider, buildGenerationUrl, throwAsProviderError } from './providerBase.js';
import { A1111Provider } from './a1111.js';
export { Provider, buildGenerationUrl } from './providerBase.js';
export { A1111Provider, A1111_RESOLUTION_PRESETS } from './a1111.js';
import {
    isImageModel, getGeminiCapabilities, classifyOpenRouterModel, getOpenRouterCapabilities,
    isGeminiOpenRouterModel, classifyOpenAIModel, isGptImageFamily,
    getOpenAIModelMaxReferences, aspectRatioToSize, normalizeQualityForModel,
} from './modelCapabilities.js';
export { isImageModel, isGeminiModel, classifyGeminiModel, getGeminiCapabilities, classifyOpenRouterModel, getOpenRouterCapabilities } from './modelCapabilities.js';
import {
    collectCharacterLibraryReferences,
    collectPreviousContextReferences,
    makeReferenceObject,
    getReferenceImage,
    getReferenceDescription,
    getReferenceSource,
    buildAvatarReferencePromptBlock,
    buildCharacterDescriptionPromptBlock,
} from './references.js';

function appendAvatarReferenceGroups(target, groups) {
    for (const group of groups) {
        if (group[0]) target.push(group[0]);
    }
    for (const group of groups) {
        if (group.length > 1) target.push(...group.slice(1));
    }
}

// ----- Max references helper -----

/**
 * Возвращает максимальное число референсных картинок, которое принимает
 * активный провайдер для текущей модели. Используется в UI (warning об
 * усечении matched refs) и в провайдерских `collectReferences` (clipping).
 *
 * В случае provider/модели без поддержки референсов возвращает 0.
 */
export function getActiveProviderMaxReferences(settings = getSettings()) {
    const apiType = settings.apiType;
    if (apiType === 'xai') {
        return 3;
    }
    if (apiType === 'openai' || apiType === 'electronhub') {
        const kind = classifyOpenAIModel(settings.model);
        return getOpenAIModelMaxReferences(kind) || 0;
    }
    if (apiType === 'gemini') {
        return getGeminiCapabilities(settings.model).maxReferences || 0;
    }
    if (apiType === 'openrouter') {
        return getOpenRouterCapabilities(settings.model).maxReferences || 0;
    }
    if (apiType === 'naistera') {
        if (!getProviderById('naistera')?.supportsReferences(settings)) return 0;
        // Naistera не ограничивает число рефов — отдаём верхний потолок,
        // совпадающий с лимитом самого хранилища лорбука.
        return MAX_ADDITIONAL_REFERENCES;
    }
    if (apiType === 'a1111') {
        // txt2img — референсы не поддерживаются.
        return 0;
    }
    return 0;
}

function referenceTextLabel(index, description) {
    const text = String(description || '').replace(/\s+/g, ' ').trim();
    return text ? `Reference ${index}: ${text}` : '';
}

function geminiImageLabel(index, description) {
    const text = String(description || '').replace(/\s+/g, ' ').trim();
    return text ? `IMAGE_${index}: ${text}` : '';
}

function additionalReferenceDescription(ref, settings = getSettings()) {
    if (settings.sendRefDescriptions === false) {
        return '';
    }
    return String(ref?.description || ref?.name || '').trim();
}

function appendPromptBlock(prompt, block) {
    const text = String(block || '').trim();
    return text ? `${prompt}\n\n${text}`.trim() : prompt;
}


function isOpenRouterAiHost(url) {
    try {
        return new URL(url).hostname.endsWith('openrouter.ai');
    } catch {
        return false;
    }
}

function isGoogleNativeHost(url) {
    try {
        return new URL(url).hostname.endsWith('googleapis.com');
    } catch {
        return false;
    }
}



// ----- OpenAI (OpenAI-compatible) -----

// Таймаут для image-запросов. OpenAI допускает долгую генерацию на сложных
// промптах, особенно gpt-image-*.
const OPENAI_REQUEST_TIMEOUT_MS = 600_000;


/**
 * Парсит ответ-ошибку OpenAI-совместимого API в единообразный вид.
 */
async function parseOpenAIError(response) {
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


/**
 * Распаковывает результат /generations или /edits.
 * OpenAI: `data[0].b64_json` (для gpt-image-* всегда) или `data[0].url`.
 */
// Вытаскивает картинку из choices[0].message с поддержкой нескольких форматов:
//   - real openrouter.ai: images[].image_url.url (data URL или http)
//   - llmrouter и compat: images[].data_url, images[].b64_json + images[].image_base64
//   - fallback: message.content[] с type=image_url|image|input_image
function extractOpenRouterImage(message) {
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

function extractImageFromResult(result, base64MimeType = 'image/png') {
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

async function collectProviderReferences({ messageId, matchedAdditionalRefs = [] }, maxRefs, format = 'base64', avatars = [['char', 'sendCharAvatar'], ['user', 'sendUserAvatar']]) {
    const settings = getSettings();
    const refs = [];
    const groups = [];
    // Both primary avatars precede appearance images; provider order is explicit.
    for (const [kind, enabledKey] of avatars) {
        groups.push(settings[enabledKey] ? await collectCharacterLibraryReferences(kind, format, settings) : []);
    }
    appendAvatarReferenceGroups(refs, groups);

    for (const ref of matchedAdditionalRefs) {
        if (refs.length >= maxRefs) break;
        const imagePath = normalizeStoredImagePath(ref.imagePath);
        if (!imagePath) continue;
        const image = format === 'dataUrl'
            ? await imageUrlToDataUrl(imagePath)
            : await imageUrlToBase64(imagePath);
        if (image) refs.push(makeReferenceObject(image, additionalReferenceDescription(ref, settings), 'additional'));
    }

    if (settings.imageContextEnabled) {
        const contextCount = normalizeImageContextCount(settings.imageContextCount);
        const contextRefs = await collectPreviousContextReferences(messageId, format, contextCount);
        refs.push(...contextRefs.map((ref) => makeReferenceObject(ref, '', 'context')));
    }

    if (refs.length > maxRefs) {
        refs.length = maxRefs;
    }
    return refs;
}

export class OpenAIProvider extends Provider {
    get id() { return 'openai'; }
    get displayName() { return 'OpenAI'; }

    supportsReferences(settings) {
        // Референсы работают только там, где есть `/v1/images/edits`
        // с multi-image входом: семейство gpt-image-* и flux-1-kontext-*.
        // dall-e-2 формально умеет /edits с одним image, но мы не делаем
        // под него исключение — UI проще.
        const kind = classifyOpenAIModel(settings.model);
        return isGptImageFamily(kind) || kind === 'flux-kontext';
    }

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [] }) {
        const modelKind = classifyOpenAIModel(getSettings().model);
        // Flux Kontext принимает только 1 reference; gpt-image-* — до MAX.
        const maxRefs = getOpenAIModelMaxReferences(modelKind) || MAX_GENERATION_REFERENCE_IMAGES;
        return collectProviderReferences({ messageId, matchedAdditionalRefs }, maxRefs, 'base64');
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);
        fullPrompt = appendPromptBlock(fullPrompt, buildAvatarReferencePromptBlock(references, settings));

        // Префикс refInstruction — только когда реально уходит хотя бы один
        // ref в /v1/images/edits. Без рефов /generations не нуждается в нём.
        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        const modelKind = classifyOpenAIModel(settings.model);
        const requestedSize = options.aspectRatio
            ? (aspectRatioToSize(options.aspectRatio, modelKind) || settings.size)
            : settings.size;
        const quality = normalizeQualityForModel(options.quality || settings.quality, modelKind);

        iigLog(
            'INFO',
            `OpenAI generate: model=${settings.model} kind=${modelKind} refs=${references.length} size=${requestedSize} quality=${quality} raw=${!!settings.rawEndpoint}`
        );

        const signal = options.signal || null;

        // Роутинг: есть референсы → /v1/images/edits (multipart),
        // иначе → /v1/images/generations (JSON). В raw-режиме оба пути шлются
        // на один URL (settings.endpoint целиком) — юзер сам отвечает за
        // корректность настройки.
        if (references.length > 0) {
            return await this._generateWithEdits({
                url: buildGenerationUrl(settings, '/v1/images/edits'),
                apiKey: settings.apiKey,
                model: settings.model,
                modelKind,
                prompt: fullPrompt,
                size: requestedSize,
                quality,
                references,
                signal,
            });
        }

        return await this._generateWithGenerations({
            url: buildGenerationUrl(settings, '/v1/images/generations'),
            apiKey: settings.apiKey,
            model: settings.model,
            modelKind,
            prompt: fullPrompt,
            size: requestedSize,
            quality,
            signal,
        });
    }

    async _generateWithGenerations({ url, apiKey, model, modelKind, prompt, size, quality, signal = null }) {

        const body = {
            model,
            prompt,
            n: 1,
        };
        if (size) body.size = size;
        if (quality) body.quality = quality;

        // response_format=b64_json поддерживается dall-e-*. Для gpt-image-* OpenAI
        // возвращает b64 всегда, параметр игнорируется/отклоняется — не отправляем
        // его для семейства gpt-image-*, чтобы не словить 400 на строгих прокси.
        if (!isGptImageFamily(modelKind)) {
            body.response_format = 'b64_json';
        }

        // moderation: 'low' поддерживает gpt-image-1 family. dall-e-* не знает
        // этот параметр — строгие прокси отдают 400.
        if (isGptImageFamily(modelKind)) {
            body.moderation = 'low';
        }

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, OPENAI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `OpenAI /v1/images/generations (${url})`, 'openai', signal);
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `OpenAI /generations ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'openai',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }

    async _generateWithEdits({ url, apiKey, model, modelKind, prompt, size, quality, references, signal = null }) {
        const form = new FormData();

        form.append('model', model);
        form.append('prompt', prompt);
        form.append('n', '1');
        if (size) form.append('size', size);
        if (quality) form.append('quality', quality);
        // moderation поддерживает только gpt-image-1 family (см. _generateWithGenerations).
        if (isGptImageFamily(modelKind)) form.append('moderation', 'low');

        // GPT Image family: поле `image[]` для множественных референсов
        // (OpenAI gpt-image-1 / 1.5 / 2 поддерживает multi-image edit).
        // Остальные (dall-e-2, unknown): одиночный `image`.
        if (isGptImageFamily(modelKind) && references.length > 1) {
            references.forEach((ref, idx) => {
                const blob = base64ToBlob(getReferenceImage(ref), 'image/png');
                // OpenAI принимает повторный `image[]` как массив.
                form.append('image[]', blob, `reference-${idx}.png`);
            });
        } else {
            const blob = base64ToBlob(getReferenceImage(references[0]), 'image/png');
            form.append('image', blob, 'reference-0.png');
        }

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    // Content-Type с boundary FormData проставит сам.
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: form,
            }, OPENAI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `OpenAI /v1/images/edits (${url})`, 'openai', signal);
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `OpenAI /edits ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'openai',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }
}

// ----- xAI Imagine -----

const XAI_MAX_REFERENCE_IMAGES = 3;
const XAI_ASPECT_RATIOS = new Set([
    'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
    '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20',
]);

function normalizeXAIAspectRatio(value) {
    const normalized = String(value || '').trim();
    return XAI_ASPECT_RATIOS.has(normalized) ? normalized : '1:1';
}

function normalizeXAIResolution(value) {
    return String(value || '').trim().toLowerCase() === '2k' ? '2k' : '1k';
}

function normalizeXAIQuality(value) {
    return String(value || '').trim().toLowerCase() === 'low' ? 'low' : 'medium';
}

function makeXAIImageInput(reference) {
    const source = getReferenceImage(reference);
    const url = source.startsWith('data:') ? source : `data:image/png;base64,${source}`;
    return { type: 'image_url', url };
}

export class XAIProvider extends Provider {
    get id() { return 'xai'; }
    get displayName() { return 'xAI'; }

    get capabilities() {
        return {
            endpointPlaceholder: ENDPOINT_PLACEHOLDERS.xai,
            requiresApiKey: true,
            referencesMaxCount: XAI_MAX_REFERENCE_IMAGES,
            referencesFormat: 'dataUrl',
        };
    }

    supportsReferences(settings) {
        return String(settings.model || '').toLowerCase().includes('grok-imagine-image');
    }

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [] }) {
        return collectProviderReferences(
            { messageId, matchedAdditionalRefs },
            XAI_MAX_REFERENCE_IMAGES,
            'dataUrl',
        );
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);
        fullPrompt = appendPromptBlock(fullPrompt, buildAvatarReferencePromptBlock(references, settings));

        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
        }

        const body = {
            model: settings.model,
            prompt: fullPrompt,
            n: 1,
            response_format: 'b64_json',
            aspect_ratio: normalizeXAIAspectRatio(options.aspectRatio || settings.xaiAspectRatio),
            resolution: normalizeXAIResolution(options.imageSize || settings.xaiResolution),
        };
        if (String(settings.model || '').toLowerCase().includes('grok-imagine-image-2.0')) {
            body.quality = normalizeXAIQuality(options.quality || settings.xaiQuality);
        }

        if (references.length === 1) {
            body.image = makeXAIImageInput(references[0]);
        } else if (references.length > 1) {
            body.images = references.slice(0, XAI_MAX_REFERENCE_IMAGES).map(makeXAIImageInput);
        }

        const path = references.length > 0 ? '/v1/images/edits' : '/v1/images/generations';
        const url = buildGenerationUrl(settings, path);
        const signal = options.signal || null;
        iigLog('INFO', `xAI generate: model=${settings.model} refs=${references.length} aspect=${body.aspect_ratio} resolution=${body.resolution} quality=${body.quality}`);

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, OPENAI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `xAI ${path} (${url})`, 'xai', signal);
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `xAI ${path} ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'xai',
            });
        }

        return extractImageFromResult(await response.json(), 'image/jpeg');
    }
}

// ----- Gemini (nano-banana, gemini-*-image) -----

const GEMINI_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Парсит ошибку от Gemini-ответа в единообразный вид.
 * Формат Google: `{ error: { code, message, status } }`.
 */
async function parseGeminiError(response) {
    const raw = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch (_e) {
        payload = null;
    }
    const err = payload?.error || {};
    const message = err.message || raw || `HTTP ${response.status}`;
    const code = err.status || err.code || String(response.status);
    return { message: String(message).slice(0, 800), code, status: response.status };
}

export class GeminiProvider extends Provider {
    get id() { return 'gemini'; }
    get displayName() { return 'Gemini / nano-banana'; }

    async collectReferences(ctx) {
        const maxRefs = getGeminiCapabilities(getSettings().model).maxReferences;
        return collectProviderReferences(ctx, maxRefs, 'base64', [['user', 'sendUserAvatar'], ['char', 'sendCharAvatar']]);
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        const model = settings.model;
        const caps = getGeminiCapabilities(model);
        const url = buildGenerationUrl(settings, `/v1beta/models/${model}:generateContent`);

        // aspect ratio: tag > settings > дефолт `1:1`, с валидацией по модели.
        let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
        if (!caps.aspectRatios.includes(aspectRatio)) {
            iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}" for ${model}, falling back`);
            aspectRatio = caps.aspectRatios.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
        }

        // imageSize: только если модель поддерживает (у 2.5 Flash — нет).
        let imageSize = null;
        if (Array.isArray(caps.imageSizes)) {
            imageSize = options.imageSize || settings.imageSize || '1K';
            if (!caps.imageSizes.includes(imageSize)) {
                iigLog('WARN', `Invalid image_size "${imageSize}" for ${model}, falling back`);
                imageSize = caps.imageSizes.includes(settings.imageSize) ? settings.imageSize : '1K';
            }
        }

        iigLog(
            'INFO',
            `Gemini ${model} (caps maxRefs=${caps.maxReferences}): aspect=${aspectRatio} size=${imageSize || '(default)'}`
        );

        const parts = [];

        // Лимит референсов — по модели, а не по глобальной константе.
        for (const [idx, ref] of references.slice(0, caps.maxReferences).entries()) {
            const label = geminiImageLabel(idx + 1, getReferenceDescription(ref));
            if (label) {
                parts.push({ text: label });
            }
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: getReferenceImage(ref),
                },
            });
        }

        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        parts.push({ text: fullPrompt });

        console.log(`[IIG] Gemini request: ${references.length} reference image(s) + prompt (${fullPrompt.length} chars)`);

        const imageConfig = { aspectRatio };
        if (imageSize) {
            imageConfig.imageSize = imageSize;
        }

        const body = {
            contents: [{
                role: 'user',
                parts: parts,
            }],
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig,
            },
        };

        iigLog('INFO', `Gemini request config: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize || '(default)'}, promptLength=${fullPrompt.length}, refImages=${references.length}`);

        const authHeader = isGoogleNativeHost(url)
            ? { 'x-goog-api-key': settings.apiKey }
            : { 'Authorization': `Bearer ${settings.apiKey}` };
        const signal = options.signal || null;

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    ...authHeader,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, GEMINI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `Gemini ${model}`, 'gemini', signal);
        }

        if (!response.ok) {
            const { message, code, status } = await parseGeminiError(response);
            throw new ProviderError({
                message: `Gemini ${model} ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'gemini',
            });
        }

        const result = await response.json();

        const candidates = result.candidates || [];
        if (candidates.length === 0) {
            iigLog('ERROR', 'Gemini empty-candidates response body:', result);
            throw new ProviderError({
                message: `No candidates in Gemini response. Body keys: ${Object.keys(result || {}).join(',')}`,
                code: 'empty_response',
                retryable: false,
                providerId: 'gemini',
            });
        }

        const responseParts = candidates[0].content?.parts || [];

        for (const part of responseParts) {
            // Check both camelCase and snake_case variants
            if (part.inlineData) {
                return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            }
            if (part.inline_data) {
                return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
            }
        }

        iigLog('ERROR', 'Gemini no-image response body:', result);
        throw new ProviderError({
            message: `No image found in Gemini response. Parts: ${responseParts.length}, types: [${responseParts.map(p => Object.keys(p).join('+')).join(' | ')}]`,
            code: 'no_image',
            retryable: false,
            providerId: 'gemini',
        });
    }

    /**
     * Gemini models listing. Стратегия двух попыток:
     *   1) Нативный Google API: `GET {endpoint}/v1beta/models?key={apiKey}`
     *      — ответ формата `{ models: [{ name: 'models/gemini-...', ...supportedGenerationMethods }] }`.
     *   2) OpenAI-совместимый прокси: `GET {endpoint}/v1/models` с `Authorization: Bearer`
     *      — ответ формата `{ data: [{ id }] }`.
     *
     * Если первая попытка провалилась (4xx/5xx/network) — пробуем вторую.
     * Фильтруем только image-генеративные модели (см. isImageModel).
     */
    async fetchModels() {
        const settings = getSettings();
        const endpoint = getEffectiveEndpoint(settings);

        if (!endpoint || !settings.apiKey) {
            console.warn('[IIG] Gemini fetchModels: endpoint or API key not set');
            return [];
        }

        // Attempt 1 — native Google API.
        try {
            const url = `${endpoint}/v1beta/models?key=${encodeURIComponent(settings.apiKey)}`;
            const response = await fetch(url, { method: 'GET' });
            if (response.ok) {
                const data = await response.json();
                const models = Array.isArray(data?.models) ? data.models : [];
                // name = 'models/gemini-2.5-flash-image' → вырезаем 'models/'.
                return models
                    .map(m => String(m?.name || '').replace(/^models\//, ''))
                    .filter(id => id && isImageModel(id));
            }
            console.debug('[IIG] Gemini native /v1beta/models failed, status', response.status);
        } catch (e) {
            console.debug('[IIG] Gemini native /v1beta/models error', e?.message || e);
        }

        // Attempt 2 — OpenAI-compatible proxy fallback.
        try {
            const url = `${endpoint}/v1/models`;
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${settings.apiKey}` },
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            const models = Array.isArray(data?.data) ? data.data : [];
            return models.map(m => m.id).filter(id => id && isImageModel(id));
        } catch (e) {
            throw new Error(`Gemini fetchModels: both /v1beta/models and /v1/models failed (${e?.message || e})`);
        }
    }
}

// ----- OpenRouter (chat completions с modalities=image) -----

const OPENROUTER_REQUEST_TIMEOUT_MS = 600_000;
const OPENROUTER_DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1';

/**
 * Парсит ошибку от OpenRouter. Формат — как у OpenAI (`{ error: { message, code, type } }`),
 * но иногда приходит просто `{ error: string }`.
 */
async function parseOpenRouterError(response) {
    const raw = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch (_e) {
        payload = null;
    }
    const errField = payload?.error;
    let message;
    let code;
    if (typeof errField === 'string') {
        message = errField;
        code = String(response.status);
    } else {
        message = errField?.message || errField?.detail || raw || `HTTP ${response.status}`;
        code = errField?.code || errField?.type || String(response.status);
    }
    return { message: String(message).slice(0, 800), code, status: response.status };
}

export class OpenRouterProvider extends Provider {
    get id() { return 'openrouter'; }
    get displayName() { return 'OpenRouter'; }

    get capabilities() {
        return {
            ...super.capabilities,
            referencesFormat: 'dataUrl',
        };
    }

    validate(settings) {
        const errors = [];
        if (!settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        // Endpoint имеет дефолт (https://openrouter.ai/api/v1), поэтому не требуем.
        return errors;
    }

    async collectReferences(ctx) {
        const maxRefs = getOpenRouterCapabilities(getSettings().model).maxReferences;
        return collectProviderReferences(ctx, maxRefs, 'dataUrl', [['user', 'sendUserAvatar'], ['char', 'sendCharAvatar']]);
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        const url = buildGenerationUrl(settings, '/chat/completions');

        const model = settings.model;
        const caps = getOpenRouterCapabilities(model);
        const isGeminiOR = isGeminiOpenRouterModel(model);

        // aspect_ratio: валидируем по caps.
        let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
        if (!caps.aspectRatios.includes(aspectRatio)) {
            iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}" for ${model}, falling back`);
            aspectRatio = caps.aspectRatios.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
        }

        // image_size: только для Gemini 3 pro / 3.1 flash (список не null).
        let imageSize = null;
        if (Array.isArray(caps.imageSizes)) {
            imageSize = options.imageSize || settings.imageSize || '1K';
            if (!caps.imageSizes.includes(imageSize)) {
                iigLog('WARN', `Invalid image_size "${imageSize}" for ${model}, falling back`);
                imageSize = caps.imageSizes.includes(settings.imageSize) ? settings.imageSize : '1K';
            }
        }

        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        // messages.content: строка если нет refs, массив частей — если есть.
        // Для image-conditioned chat providers отправляем пары description → image,
        // затем основной prompt последним chunk'ом.
        let content;
        if (references.length > 0) {
            const parts = [];
            for (const [idx, ref] of references.slice(0, caps.maxReferences).entries()) {
                const label = referenceTextLabel(idx + 1, getReferenceDescription(ref));
                if (label) {
                    parts.push({ type: 'text', text: label });
                }
                parts.push({
                    type: 'image_url',
                    image_url: { url: getReferenceImage(ref) },
                });
            }
            parts.push({ type: 'text', text: fullPrompt });
            content = parts;
        } else {
            content = fullPrompt;
        }

        // modalities: Gemini отдаёт и текст и картинку; Flux/Sourceful — только картинку.
        const modalities = isGeminiOR ? ['image', 'text'] : ['image'];

        const body = {
            model,
            messages: [{ role: 'user', content }],
            modalities,
            // llmrouter и часть совместимых сервисов отдают картинку CDN-ссылкой
            // по умолчанию; этот флаг просит base64. Real openrouter.ai и так
            // base64 шлёт, флаг ему ничего не ломает.
            enable_base64_output: true,
        };

        const imageConfig = { aspect_ratio: aspectRatio };
        if (imageSize) imageConfig.image_size = imageSize;
        body.image_config = imageConfig;

        iigLog(
            'INFO',
            `OpenRouter request: model=${model} kind=${classifyOpenRouterModel(model)} refs=${references.length} aspect=${aspectRatio} size=${imageSize || '(default)'} modalities=${modalities.join(',')}`
        );

        const headers = {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        };
        // X-Title / HTTP-Referer нужны только настоящему openrouter.ai
        // (для аттрибуции в их leaderboard'е). 3rd-party OpenRouter-совместимые
        // сервисы часто не разрешают X-Title в CORS — добавим только если
        // endpoint реально на openrouter.ai.
        if (isOpenRouterAiHost(url)) {
            headers['HTTP-Referer'] = window.location.origin;
            headers['X-Title'] = 'SillyTavern Inline Image Generation';
        }

        const signal = options.signal || null;
        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            }, OPENROUTER_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `OpenRouter ${model}`, 'openrouter', signal);
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenRouterError(response);
            throw new ProviderError({
                message: `OpenRouter ${model} ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'openrouter',
            });
        }

        const result = await response.json();
        const message = result?.choices?.[0]?.message;
        const imageUrl = extractOpenRouterImage(message);

        if (!imageUrl || typeof imageUrl !== 'string') {
            iigLog('ERROR', 'OpenRouter no-image response body:', result);
            throw new ProviderError({
                message: `No image in OpenRouter response. Body keys: ${Object.keys(result || {}).join(',')}; message keys: ${Object.keys(message || {}).join(',')}`,
                code: 'no_image',
                retryable: false,
                providerId: 'openrouter',
            });
        }

        if (imageUrl.startsWith('data:')) {
            return imageUrl;
        }
        const dataUrl = await imageUrlToDataUrl(imageUrl);
        if (!dataUrl) {
            throw new ProviderError({
                message: `Failed to fetch image from URL: ${imageUrl}`,
                code: 'image_fetch_failed',
                retryable: true,
                providerId: 'openrouter',
            });
        }
        return dataUrl;
    }

    /**
     * Свой fetchModels: фильтры `input_modalities=image,text` + `output_modalities=image`.
     */
    async fetchModels() {
        const settings = getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || OPENROUTER_DEFAULT_ENDPOINT)
            .replace(/\/$/, '');

        if (!settings.apiKey) {
            console.warn('[IIG] OpenRouter fetchModels: API key not set');
            return [];
        }

        const url = `${endpoint}/models?input_modalities=image%2Ctext&output_modalities=image`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];
        return models.map(m => m.id).filter(Boolean);
    }
}

// ----- Electron Hub (OpenAI-совместимый агрегатор, flux-1-kontext-*) -----

const ELECTRONHUB_DEFAULT_ENDPOINT = 'https://api.electronhub.ai';

/**
 * Electron Hub — OpenAI-совместимый прокси с 200+ моделями. Отличия:
 *   - `/v1/images/edits` принимает только один `image` (без `image[]`),
 *     так что flux-1-kontext-* маршрутизируется через /edits с 1 референсом;
 *   - `/v1/models` возвращает модели со всеми типами (chat/image/embeddings),
 *     у image-моделей в поле `endpoints` есть `/v1/images/generations`
 *     и/или `/v1/images/edits` — фильтруем именно по ним.
 *
 * Всё остальное наследуется от OpenAIProvider (classifier / aspect / quality
 * / _generateWithEdits / _generateWithGenerations / error parsing).
 */
export class ElectronHubProvider extends OpenAIProvider {
    get id() { return 'electronhub'; }
    get displayName() { return 'Electron Hub'; }

    /**
     * Валидация: endpoint опционален (есть дефолт в normalizeConfiguredEndpoint),
     * apiKey обязателен.
     */
    validate(settings) {
        const errors = [];
        if (!settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        return errors;
    }

    /**
     * Список image-моделей через фильтр по полю `endpoints`. Если поле
     * отсутствует в ответе — фолбэк на keyword-based isImageModel.
     */
    async fetchModels() {
        const settings = getSettings();
        const endpoint = (getEffectiveEndpoint(settings) || ELECTRONHUB_DEFAULT_ENDPOINT).replace(/\/$/, '');

        if (!settings.apiKey) {
            console.warn('[IIG] Electron Hub fetchModels: API key not set');
            return [];
        }

        const url = `${endpoint}/v1/models`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];

        return models.filter((m) => {
            const eps = Array.isArray(m?.endpoints) ? m.endpoints.map(String) : null;
            if (eps && eps.length > 0) {
                return eps.some((e) =>
                    e.includes('/images/generations') || e.includes('/images/edits'),
                );
            }
            return isImageModel(m.id);
        }).map((m) => m.id).filter(Boolean);
    }
}

// ----- Naistera (custom / grok / nano banana 2 / novelai proxy) -----

export class NaisteraProvider extends Provider {
    constructor() {
        super();
        this.modelCatalog = new Map();
        this.modelCatalogStatus = { authenticated: false, tier: null, publicFallback: false };
    }

    get id() { return 'naistera'; }
    get displayName() { return 'Naistera'; }

    get capabilities() {
        return {
            ...super.capabilities,
            referencesFormat: 'dataUrl',
        };
    }

    validate(settings) {
        const errors = [];
        if (!settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        const m = normalizeNaisteraModel(settings.naisteraModel);
        if (!m) {
            errors.push(t`Model is not selected`);
        }
        return errors;
    }

    supportsReferences(settings) {
        if (isNaisteraNovelAIModel(settings.naisteraModel)) return false;
        const model = this.modelCatalog.get(normalizeNaisteraModel(settings.naisteraModel));
        return model ? model.references !== false : true;
    }

    supportsNegativePrompt(settings) {
        const model = this.modelCatalog.get(normalizeNaisteraModel(settings.naisteraModel));
        return model?.negativePrompt === true;
    }

    getGenerationParameters(settings) {
        if (!isNaisteraNovelAIModel(settings.naisteraModel)) return null;
        return this.modelCatalog.get(normalizeNaisteraModel(settings.naisteraModel))?.parameters || null;
    }

    getGenerationSettings(settings, options = {}) {
        const rules = this.getGenerationParameters(settings);
        if (!rules) return {};
        const numeric = (key, saved) => {
            const rule = rules[key];
            const raw = options[key] ?? saved;
            const value = raw === null || raw === '' || raw === undefined ? rule.default : Number(raw);
            return Math.min(rule.max, Math.max(rule.min, Number.isFinite(value) ? value : rule.default));
        };
        const requestedSampler = options.sampler ?? settings.naisteraSampler;
        const result = {
            steps: Math.round(numeric('steps', settings.naisteraSteps)),
            sampler: rules.sampler.choices.includes(requestedSampler) ? requestedSampler : rules.sampler.default,
            scale: numeric('scale', settings.naisteraCfgScale),
        };
        if (rules.cfg_rescale) result.cfg_rescale = numeric('cfg_rescale', settings.naisteraCfgRescale);
        return result;
    }

    getModelLabel(modelId) {
        return this.modelCatalog.get(String(modelId || ''))?.name || super.getModelLabel(modelId);
    }

    getModelCatalogStatus() {
        return { ...this.modelCatalogStatus };
    }

    async fetchModels() {
        const settings = getSettings();
        const endpoint = getEffectiveEndpoint(settings).replace(/\/$/, '');
        const url = `${endpoint}/api/models`;
        const request = async (authenticated) => {
            const headers = { 'Accept': 'application/json' };
            if (authenticated && settings.apiKey) {
                headers.Authorization = `Bearer ${settings.apiKey}`;
            }
            return await fetch(url, { method: 'GET', headers });
        };

        let response;
        let publicFallback = false;
        try {
            response = await request(true);
        } catch (error) {
            if (!settings.apiKey || error?.name !== 'TypeError') throw error;
            iigLog('WARN', 'Naistera authenticated model discovery was blocked; retrying the public catalog');
            publicFallback = true;
            response = await request(false);
        }

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Naistera /api/models ${response.status}: ${String(detail).slice(0, 500)}`);
        }

        const payload = await response.json();
        const models = (Array.isArray(payload?.models) ? payload.models : [])
            .filter((model) => model?.id && model.visible !== false && model.deprecated !== true)
            .map((model) => ({
                id: String(model.id),
                name: String(model.name || model.id),
                references: model.references !== false,
                negativePrompt: model.negative_prompt === true,
                parameters: model.parameters || null,
            }));

        this.modelCatalog = new Map(models.map((model) => [model.id, model]));
        this.modelCatalogStatus = {
            authenticated: payload?.authenticated === true,
            tier: payload?.tier || null,
            publicFallback,
        };
        iigLog('INFO', `Naistera models loaded: ${models.length}; authenticated=${payload?.authenticated === true}; tier=${payload?.tier || 'public'}`);
        return models.map((model) => model.id);
    }

    async pollJob(endpoint, jobId, settings, signal = null) {
        const base = endpoint.replace(/\/api\/generate\/?$/i, '').replace(/\/$/, '');
        const url = `${base}/api/generate/jobs/${encodeURIComponent(jobId)}`;
        const intervalMs = Math.max(1000, Math.min(30000, Number(settings.naisteraPollIntervalMs) || 3000));
        const timeoutMs = Math.max(30000, Math.min(900000, Number(settings.naisteraPollTimeoutMs) || 600000));
        const started = Date.now();
        const abortedByUser = () => signal?.aborted
            && (signal.reason === 'user-cancel' || signal.reason?.message === 'user-cancel');
        const throwAborted = () => {
            throw new ProviderError({
                message: t`Generation stopped by user`,
                code: 'aborted',
                retryable: false,
                providerId: 'naistera',
            });
        };
        while (Date.now() - started < timeoutMs) {
            if (abortedByUser()) throwAborted();
            let response;
            try {
                response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${settings.apiKey}`,
                        'Accept': 'application/json',
                    },
                    signal,
                });
            } catch (error) {
                if (error?.name === 'AbortError' && abortedByUser()) throwAborted();
                throw error;
            }
            const text = await response.text().catch(() => '');
            let result = null;
            try {
                result = text ? JSON.parse(text) : null;
            } catch (_err) {
                result = null;
            }
            if (!response.ok) {
                throw new ProviderError({
                    message: `Polling API Error (${response.status}): ${String(text).slice(0, 800)}`,
                    code: String(response.status),
                    status: response.status,
                    retryable: isRetryableHttpStatus(response.status),
                    providerId: 'naistera',
                });
            }
            const status = String(result?.status || '').toLowerCase();
            if (status === 'completed' || result?.data_url) return result;
            if (status === 'failed' || result?.error) {
                throw new ProviderError({
                    message: `Generation failed: ${result?.detail || result?.error?.detail || 'Unknown Error'}`,
                    code: String(result?.error?.status_code || 'failed'),
                    status: Number(result?.error?.status_code) || 0,
                    retryable: isRetryableHttpStatus(Number(result?.error?.status_code) || 0),
                    providerId: 'naistera',
                });
            }
            // Abort-aware wait so Stop is responsive instead of blocking a full interval.
            await abortableDelay(intervalMs, signal);
            if (abortedByUser()) throwAborted();
        }
        throw new ProviderError({
            message: `Naistera polling timed out after ${Math.round(timeoutMs / 1000)}s`,
            code: 'timeout',
            retryable: true,
            providerId: 'naistera',
        });
    }

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [], providerOptions = {} }) {
        const settings = getSettings();
        const normalizedModel = normalizeNaisteraModel(providerOptions.model || settings.naisteraModel);
        if (!this.modelCatalog.has(normalizedModel)) {
            await this.fetchModels().catch((error) => {
                iigLog('WARN', `Naistera model metadata unavailable: ${error?.message || error}`);
            });
        }
        if (!this.supportsReferences({ ...settings, naisteraModel: normalizedModel })) {
            return [];
        }
        const refs = await collectProviderReferences({ messageId, matchedAdditionalRefs }, Infinity, 'dataUrl', [
            ['user', 'naisteraSendUserAvatar'], ['char', 'naisteraSendCharAvatar'],
        ]);

        const descriptionMode = normalizeNaisteraCharacterDescriptionsMode(settings.naisteraCharacterDescriptionsMode);
        if (descriptionMode !== 'as-is') {
            return refs.map((ref) => {
                const source = getReferenceSource(ref);
                return source === 'char' || source === 'user'
                    ? makeReferenceObject(getReferenceImage(ref), '', source)
                    : ref;
            });
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        const endpoint = getEffectiveEndpoint(settings);
        const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;

        const aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
        const model = normalizeNaisteraModel(options.model || settings.naisteraModel);
        if (!this.modelCatalog.has(model)) await this.fetchModels();
        if (!this.supportsReferences({ ...settings, naisteraModel: model })) references = [];
        const preset = options.preset || null;
        const wantsVideoTest = Boolean(options.videoTestMode);
        const videoEveryN = normalizeNaisteraVideoFrequency(options.videoEveryN ?? settings.naisteraVideoEveryN);
        const wrapStyle = options.wrapStyle ?? !isNaisteraNovelAIModel(model);
        let fullPrompt = buildFinalGenerationPrompt(
            prompt,
            style,
            options.matchedAdditionalRefs || [],
            settings,
            { wrapStyle, supportsImageReferences: this.supportsReferences({ ...settings, naisteraModel: model }) },
        );
        const descriptionMode = normalizeNaisteraCharacterDescriptionsMode(settings.naisteraCharacterDescriptionsMode);
        const characterDescriptionPromptBlock = options.characterDescriptionPromptBlock
            ?? await buildCharacterDescriptionPromptBlock({
                includeChar: true,
                includeUser: true,
                references,
                mode: descriptionMode,
            }, settings);
        fullPrompt = appendPromptBlock(fullPrompt, characterDescriptionPromptBlock);

        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        const body = {
            prompt: fullPrompt,
            aspect_ratio: aspectRatio,
            model,
            ...this.getGenerationSettings({ ...settings, naisteraModel: model }, options),
        };
        const negativePrompt = String(options.negativePrompt ?? getEffectiveNegativePrompt(
            settings.naisteraNegativePrompt, { ...settings, naisteraModel: model },
        )).trim();
        if (negativePrompt && this.supportsNegativePrompt({ ...settings, naisteraModel: model })) {
            body.negative_prompt = negativePrompt;
        }
        if (preset) body.preset = preset;
        if (references.length > 0) {
            body.reference_objects = references
                .map((ref) => ({
                    image: getReferenceImage(ref),
                    description: getReferenceDescription(ref),
                }))
                .filter((ref) => ref.image);
        }
        if (wantsVideoTest) {
            body.video_test_mode = true;
            body.video_test_every_n_messages = videoEveryN;
        }
        if (settings.naisteraPolling) {
            body.sync = false;
        }

        const signal = options.signal || null;
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError' && signal?.aborted && (signal.reason === 'user-cancel' || signal.reason?.message === 'user-cancel')) {
                throw new ProviderError({
                    message: t`Generation stopped by user`,
                    code: 'aborted',
                    retryable: false,
                    providerId: 'naistera',
                    cause: error,
                });
            }
            const pageOrigin = window.location.origin;
            let endpointOrigin = endpoint;
            try {
                endpointOrigin = new URL(url, window.location.href).origin;
            } catch (parseErr) {
                console.warn('[IIG] Failed to parse Naistera endpoint origin:', parseErr);
            }
            const rawMessage = String(error?.message || '').trim() || 'Failed to fetch';
            throw new ProviderError({
                message: `Network/CORS error while requesting ${endpointOrigin} from ${pageOrigin}. `
                    + `The browser blocked access to the response before the API could return JSON. `
                    + `Original error: ${rawMessage}`,
                code: 'network',
                retryable: true,
                providerId: 'naistera',
                cause: error,
            });
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new ProviderError({
                message: `API Error (${response.status}): ${String(text).slice(0, 800)}`,
                code: String(response.status),
                status: response.status,
                retryable: isRetryableHttpStatus(response.status),
                providerId: 'naistera',
            });
        }

        let result = await response.json();
        if (result?.job_id && !result?.data_url) {
            result = await this.pollJob(endpoint, result.job_id, settings, signal);
        }
        if (!result?.data_url) {
            throw new ProviderError({
                message: 'No data_url in response',
                code: 'empty_response',
                retryable: false,
                providerId: 'naistera',
            });
        }
        if (result.media_kind === 'video') {
            return {
                kind: 'video',
                dataUrl: result.data_url,
                posterDataUrl: result.poster_data_url || '',
                contentType: result.content_type || 'video/mp4',
            };
        }
        return result.data_url;
    }
}


// ----- Direct NovelAI text-to-image -----

async function verifyNovelAIFreeAccess(url, settings, model, signal) {
    const unavailable = () => new ProviderError({
        message: t`Anlas protection: could not verify free generation.`,
        code: 'anlas_protection', retryable: false, providerId: 'novelai',
    });
    let subscription;
    try {
        const target = new URL(url);
        if (!target.pathname.endsWith('/ai/generate-image') || target.search || target.hash) throw unavailable();
        target.pathname = target.pathname.replace(/\/ai\/generate-image$/, '/user/subscription');
        const response = await fetchWithTimeout(target.href, {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' },
        }, 15000, signal);
        if (!response.ok) throw unavailable();
        subscription = await response.json();
    } catch (cause) {
        if (signal?.aborted) throw new ProviderError({
            message: t`Generation stopped by user`, code: 'aborted', retryable: false, providerId: 'novelai', cause,
        });
        throw unavailable();
    }
    if (subscription?.active !== true || subscription.tier !== 3
        || typeof subscription.expiresAt !== 'number' || !Number.isFinite(subscription.expiresAt)
        || subscription.expiresAt * 1000 <= Date.now()) {
        throw new ProviderError({
            message: t`Anlas protection requires an active Opus subscription.`,
            code: 'anlas_protection', retryable: false, providerId: 'novelai',
        });
    }
    const usage = subscription.usage;
    const hasRegularUsage = usage?.isNegative === false
        && Number.isFinite(usage.percent) && usage.percent > 0;
    // Activated boosts have a separate 0-400% balance, independent of the regular bar.
    const hasExtraUsage = Number.isFinite(usage?.purchasedPercent)
        && usage.purchasedPercent > 0 && usage.purchasedPercent <= 400;
    if (model.startsWith('nai-diffusion-5-') && !hasRegularUsage && !hasExtraUsage) {
        throw new ProviderError({
            message: t`Anlas protection: the free V5 allowance is unavailable.`,
            code: 'anlas_protection', retryable: false, providerId: 'novelai',
        });
    }
}

export class NovelAIProvider extends Provider {
    #noAnlasQueue = Promise.resolve();
    get id() { return 'novelai'; }
    get displayName() { return 'NovelAI'; }
    get capabilities() { return { ...super.capabilities, referencesMaxCount: 0 }; }
    supportsReferences() { return false; }
    supportsNegativePrompt(settings = getSettings()) { return !isNovelAIMedium(settings.model); }
    getModelLabel(model) { return NOVELAI_MODELS[model] || model; }
    async fetchModels() { return Object.keys(NOVELAI_MODELS); }

    validate(settings) {
        const errors = validateNovelAIParameters(settings);
        if (!settings.apiKey) errors.push(t`API key is not configured`);
        if (!Object.hasOwn(NOVELAI_MODELS, settings.model)) errors.push(t`Select a NovelAI image model`);
        return errors;
    }

    async generate(args) {
        const settings = { ...getSettings() };
        if (settings.novelaiNeverSpendAnlas === false) return this.#generateRequest(args, settings);
        // Recheck the allowance after earlier guarded requests finish using it.
        const task = this.#noAnlasQueue.then(() => this.#generateRequest(args, settings));
        this.#noAnlasQueue = task.catch(() => {});
        const signal = args.options?.signal;
        if (!signal) return task;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                reject(new ProviderError({
                    message: t`Generation stopped by user`, code: 'aborted', retryable: false, providerId: this.id,
                }));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            task.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
            if (signal.aborted) onAbort();
        });
    }

    async #generateRequest({ prompt, style = '', options = {} }, settings) {
        if (options.signal?.aborted) throw new ProviderError({
            message: t`Generation stopped by user`, code: 'aborted', retryable: false, providerId: this.id,
        });
        const model = options.model || settings.model;
        const requestSettings = { ...settings, model, novelaiAspectRatio: options.aspectRatio || settings.novelaiAspectRatio };
        const errors = this.validate(requestSettings);
        if (errors.length) throw new ProviderError({ message: errors.join('; '), code: 'invalid_request', providerId: this.id });
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings, {
            wrapStyle: false, supportsImageReferences: false,
        });
        const descriptions = options.characterDescriptionPromptBlock
            ?? await buildCharacterDescriptionPromptBlock({
                includeChar: true, includeUser: true, mode: settings.novelaiCharacterDescriptionsMode,
            }, settings);
        fullPrompt = appendPromptBlock(fullPrompt, descriptions);
        const negativePrompt = String(options.negativePrompt ?? getEffectiveNegativePrompt(settings.novelaiNegativePrompt, settings)).trim();
        const parameters = buildNovelAIParameters(requestSettings, fullPrompt, negativePrompt, model);
        const body = { action: 'generate', model, input: splitNovelAICharacterPrompts(fullPrompt).base, parameters };
        const snapshot = getLastRequestSnapshot();
        if (snapshot?.metadata?.apiType === this.id) {
            snapshot.metadata.seed = parameters.seed;
            snapshot.parameters = parameters;
        }
        const endpoint = getEffectiveEndpoint(settings);
        const url = settings.rawEndpoint || endpoint.endsWith('/ai/generate-image')
            ? endpoint : `${endpoint}/ai/generate-image`;
        if (settings.novelaiNeverSpendAnlas !== false) {
            await verifyNovelAIFreeAccess(url, settings, model, options.signal);
        }
        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body),
            }, 600000, options.signal);
        } catch (cause) {
            throw new ProviderError({
                message: cause.message, code: options.signal?.aborted ? 'aborted' : 'network',
                retryable: !options.signal?.aborted, providerId: this.id, cause,
            });
        }
        if (!response.ok) {
            const detail = await response.text();
            throw new ProviderError({
                message: `NovelAI ${response.status}: ${detail.slice(0, 800)}`,
                status: response.status, code: String(response.status),
                retryable: isRetryableHttpStatus(response.status), providerId: this.id,
            });
        }
        let result;
        try { result = await response.json(); }
        catch (cause) { throw new ProviderError({ message: t`NovelAI returned an invalid JSON response`, code: 'invalid_response', providerId: this.id, cause }); }
        const image = result?.images?.[0]?.image;
        if (typeof image !== 'string' || !image.trim()) {
            throw new ProviderError({ message: t`NovelAI returned no image`, code: 'invalid_response', providerId: this.id });
        }
        return `data:image/png;base64,${image}`;
    }
}

// ----- Registry -----

const providers = new Map();

/** @param {Provider} provider */
export function registerProvider(provider) {
    providers.set(provider.id, provider);
}

/** @returns {Provider | undefined} */
export function getProviderById(id) {
    return providers.get(id);
}

export function getAllProviders() {
    return Array.from(providers.values());
}

export function resolveActiveProvider(settings = getSettings()) {
    return providers.get(settings.apiType);
}

// Default registration.
registerProvider(new OpenAIProvider());
registerProvider(new XAIProvider());
registerProvider(new GeminiProvider());
registerProvider(new OpenRouterProvider());
registerProvider(new ElectronHubProvider());
registerProvider(new NaisteraProvider());
registerProvider(new NovelAIProvider());
registerProvider(new A1111Provider());

// ----- Models fetcher (делегируется провайдеру) -----

export async function fetchModels() {
    const settings = getSettings();
    const provider = resolveActiveProvider(settings);
    if (!provider) {
        console.warn('[IIG] fetchModels: no active provider for apiType=', settings.apiType);
        return [];
    }

    // Raw endpoint mode: юзер дал полный URL генерации; дискавери моделей
    // не производится — юзер вводит имя модели вручную.
    if (settings.rawEndpoint && settings.apiType !== 'naistera') {
        iigLog('INFO', 'fetchModels skipped: raw endpoint mode (enter model name manually)');
        toastr.info(t`Raw endpoint mode: enter model name manually`, t`Image Generation`, { timeOut: 3000 });
        return [];
    }

    try {
        return await provider.fetchModels();
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(t`Failed to load models: ${error.message}`, t`Image Generation`);
        return [];
    }
}

// ----- Validation (общий entry, используется pipeline) -----

export function validateSettings() {
    const settings = getSettings();
    const provider = resolveActiveProvider(settings);
    if (!provider) {
        throw new Error(t`Settings error: unknown API (${settings.apiType})`);
    }
    const errors = provider.validate(settings);

    // Общий чек: для openai/gemini требуется model.
    // Naistera selects model via its own dropdown; A1111 falls back to whatever
    // checkpoint is currently loaded on the server when model field is empty.
    if (provider.id !== 'naistera' && provider.id !== 'a1111' && !settings.model) {
        errors.push(t`Model is not selected`);
    }

    if (errors.length > 0) {
        throw new Error(t`Settings error: ${errors.join(', ')}`);
    }
}
