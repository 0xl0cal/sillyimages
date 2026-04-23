/**
 * Провайдер-абстракция.
 *
 * Цель на этапе 1:
 *   - свести три текущих варианта (openai/gemini/naistera) под единый интерфейс;
 *   - убрать `if (apiType === '...')` из pipeline.js;
 *   - сохранить 100% идентичное поведение (никаких новых фич).
 *
 * На этапе 2 здесь появятся OpenRouter, Electron Hub, расширенные capabilities
 * и единый формат ошибок. Сейчас — минимально достаточный скелет.
 */

import {
    getSettings,
    iigLog,
    IMAGE_MODEL_KEYWORDS,
    VIDEO_MODEL_KEYWORDS,
    NAISTERA_MODELS,
    ENDPOINT_PLACEHOLDERS,
    MAX_GENERATION_REFERENCE_IMAGES,
    normalizeNaisteraModel,
    naisteraModelSupportsReferences,
    normalizeImageContextCount,
    normalizeNaisteraVideoFrequency,
    getEffectiveEndpoint,
} from './settings.js';
import {
    normalizeStoredImagePath,
    imageUrlToBase64,
    imageUrlToDataUrl,
} from './utils.js';
import { buildFinalGenerationPrompt } from './parser.js';
import {
    getCharacterAvatarBase64,
    getCharacterAvatarDataUrl,
    getUserAvatarBase64,
    getUserAvatarDataUrl,
    collectPreviousContextReferences,
} from './references.js';

// ----- Model detection helpers -----

export function isImageModel(modelId) {
    const mid = String(modelId || '').toLowerCase();

    // Exclude video models
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }

    // Exclude vision models
    if (mid.includes('vision') && mid.includes('preview')) return false;

    // Check for image model keywords
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }

    return false;
}

export function isGeminiModel(modelId) {
    const mid = String(modelId || '').toLowerCase();
    return mid.includes('nano-banana');
}

// Valid params for Gemini / nano-banana.
const VALID_GEMINI_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_GEMINI_IMAGE_SIZES = ['1K', '2K', '4K'];

// ----- Base Provider -----

/**
 * @typedef {object} ProviderCapabilities
 * @property {string} endpointPlaceholder
 * @property {boolean} requiresApiKey
 * @property {number} referencesMaxCount
 * @property {'base64' | 'dataUrl' | 'none'} referencesFormat
 */

export class Provider {
    /** @type {string} */
    get id() { throw new Error('Provider.id not implemented'); }
    /** @type {string} */
    get displayName() { return this.id; }
    /** @type {ProviderCapabilities} */
    get capabilities() {
        return {
            endpointPlaceholder: ENDPOINT_PLACEHOLDERS[this.id] || 'https://api.example.com',
            requiresApiKey: true,
            referencesMaxCount: MAX_GENERATION_REFERENCE_IMAGES,
            referencesFormat: 'base64',
        };
    }

    /**
     * Pre-run validation. Вызывается из pipeline перед generate.
     * @param {object} settings
     * @returns {string[]} список ошибок (пустой — всё ок)
     */
    validate(settings) {
        const errors = [];
        const caps = this.capabilities;
        if (!settings.endpoint && this.id !== 'naistera') {
            errors.push('URL эндпоинта не настроен');
        }
        if (caps.requiresApiKey && !settings.apiKey) {
            errors.push('API ключ не настроен');
        }
        return errors;
    }

    /**
     * Собирает referenceImages в формате, который ожидает `generate`.
     * На этапе 1 возвращаемое значение отдаётся `generate` как-есть,
     * pipeline не вмешивается.
     *
     * @param {{ prompt: string, messageId?: number, matchedAdditionalRefs?: any[] }} ctx
     * @returns {Promise<any[]>}
     */
    async collectReferences(_ctx) {
        return [];
    }

    /**
     * Главная функция — делает сетевой запрос и возвращает либо data URL строкой,
     * либо `{ kind: 'video', dataUrl, posterDataUrl?, contentType }`.
     *
     * @param {{ prompt: string, style: string, references: any[], options: object }} request
     */
    async generate(_request) {
        throw new Error(`Provider[${this.id}].generate() not implemented`);
    }
}

// ----- OpenAI (OpenAI-compatible) -----

export class OpenAIProvider extends Provider {
    get id() { return 'openai'; }
    get displayName() { return 'OpenAI'; }

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const refs = [];

        if (settings.sendCharAvatar) {
            const charAvatar = await getCharacterAvatarBase64();
            if (charAvatar) refs.push(charAvatar);
        }
        if (settings.sendUserAvatar) {
            const userAvatar = await getUserAvatarBase64();
            if (userAvatar) refs.push(userAvatar);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= MAX_GENERATION_REFERENCE_IMAGES) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const b64 = await imageUrlToBase64(imagePath);
            if (b64) refs.push(b64);
        }

        if (settings.imageContextEnabled) {
            const contextCount = normalizeImageContextCount(settings.imageContextCount);
            const contextRefs = await collectPreviousContextReferences(messageId, 'base64', contextCount);
            refs.push(...contextRefs);
        }

        if (refs.length > MAX_GENERATION_REFERENCE_IMAGES) {
            refs.length = MAX_GENERATION_REFERENCE_IMAGES;
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;

        const fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        // Map aspect ratio to size if provided in tag
        let size = settings.size;
        if (options.aspectRatio) {
            if (options.aspectRatio === '16:9') size = '1792x1024';
            else if (options.aspectRatio === '9:16') size = '1024x1792';
            else if (options.aspectRatio === '1:1') size = '1024x1024';
        }

        const body = {
            model: settings.model,
            prompt: fullPrompt,
            n: 1,
            size: size,
            quality: options.quality || settings.quality,
            response_format: 'b64_json',
        };

        // Add reference image if supported (for models like GPT-Image-1, FLUX)
        if (references.length > 0) {
            body.image = `data:image/png;base64,${references[0]}`;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error (${response.status}): ${text}`);
        }

        const result = await response.json();

        const dataList = result.data || [];
        if (dataList.length === 0) {
            if (result.url) return result.url;
            throw new Error('No image data in response');
        }

        const imageObj = dataList[0];
        const imageData = imageObj.b64_json || imageObj.url;

        if (imageObj.b64_json) {
            return `data:image/png;base64,${imageObj.b64_json}`;
        }

        return imageData;
    }
}

// ----- Gemini (nano-banana, gemini-*-image) -----

export class GeminiProvider extends Provider {
    get id() { return 'gemini'; }
    get displayName() { return 'Gemini / nano-banana'; }

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const refs = [];

        if (settings.sendCharAvatar) {
            const charAvatar = await getCharacterAvatarBase64();
            if (charAvatar) refs.push(charAvatar);
        }
        if (settings.sendUserAvatar) {
            const userAvatar = await getUserAvatarBase64();
            if (userAvatar) refs.push(userAvatar);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= MAX_GENERATION_REFERENCE_IMAGES) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const b64 = await imageUrlToBase64(imagePath);
            if (b64) refs.push(b64);
        }

        if (settings.imageContextEnabled) {
            const contextCount = normalizeImageContextCount(settings.imageContextCount);
            const contextRefs = await collectPreviousContextReferences(messageId, 'base64', contextCount);
            refs.push(...contextRefs);
        }

        if (refs.length > MAX_GENERATION_REFERENCE_IMAGES) {
            refs.length = MAX_GENERATION_REFERENCE_IMAGES;
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        const model = settings.model;
        const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;

        // Determine aspect ratio: tag option > settings, with validation
        let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
        if (!VALID_GEMINI_ASPECT_RATIOS.includes(aspectRatio)) {
            iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}", falling back to settings or default`);
            aspectRatio = VALID_GEMINI_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
        }

        // Determine image size: tag option > settings, with validation
        let imageSize = options.imageSize || settings.imageSize || '1K';
        if (!VALID_GEMINI_IMAGE_SIZES.includes(imageSize)) {
            iigLog('WARN', `Invalid image_size "${imageSize}", falling back to settings or default`);
            imageSize = VALID_GEMINI_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
        }

        iigLog('INFO', `Using aspect ratio: ${aspectRatio}, image size: ${imageSize}`);

        const parts = [];

        for (const imgB64 of references.slice(0, MAX_GENERATION_REFERENCE_IMAGES)) {
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: imgB64,
                },
            });
        }

        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        if (references.length > 0) {
            const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
            fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
        }

        parts.push({ text: fullPrompt });

        console.log(`[IIG] Gemini request: ${references.length} reference image(s) + prompt (${fullPrompt.length} chars)`);

        const body = {
            contents: [{
                role: 'user',
                parts: parts,
            }],
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: imageSize,
                },
            },
        };

        iigLog('INFO', `Gemini request config: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize}, promptLength=${fullPrompt.length}, refImages=${references.length}`);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error (${response.status}): ${text}`);
        }

        const result = await response.json();

        const candidates = result.candidates || [];
        if (candidates.length === 0) {
            throw new Error('No candidates in response');
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

        throw new Error('No image found in Gemini response');
    }
}

// ----- Naistera (custom / grok / nano banana 2 / novelai proxy) -----

export class NaisteraProvider extends Provider {
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
            errors.push('API ключ не настроен');
        }
        const m = normalizeNaisteraModel(settings.naisteraModel);
        if (!NAISTERA_MODELS.includes(m)) {
            errors.push('Для Naistera выберите модель: grok / grok-pro / nano banana');
        }
        return errors;
    }

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [], providerOptions = {} }) {
        const settings = getSettings();
        const normalizedModel = normalizeNaisteraModel(providerOptions.model || settings.naisteraModel);
        if (!naisteraModelSupportsReferences(normalizedModel)) {
            return [];
        }

        const refs = [];

        if (settings.naisteraSendCharAvatar) {
            const d = await getCharacterAvatarDataUrl();
            if (d) refs.push(d);
        }
        if (settings.naisteraSendUserAvatar) {
            const d = await getUserAvatarDataUrl();
            if (d) refs.push(d);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= MAX_GENERATION_REFERENCE_IMAGES) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const d = await imageUrlToDataUrl(imagePath);
            if (d) refs.push(d);
        }

        if (settings.imageContextEnabled) {
            const contextCount = normalizeImageContextCount(settings.imageContextCount);
            const contextRefs = await collectPreviousContextReferences(messageId, 'dataUrl', contextCount);
            refs.push(...contextRefs);
        }

        if (refs.length > MAX_GENERATION_REFERENCE_IMAGES) {
            refs.length = MAX_GENERATION_REFERENCE_IMAGES;
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        const endpoint = getEffectiveEndpoint(settings);
        const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;

        const aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
        const model = normalizeNaisteraModel(options.model || settings.naisteraModel || 'grok');
        const preset = options.preset || null;
        const wantsVideoTest = Boolean(options.videoTestMode);
        const videoEveryN = normalizeNaisteraVideoFrequency(options.videoEveryN ?? settings.naisteraVideoEveryN);
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        if (references.length > 0) {
            const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
            fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
        }

        const body = {
            prompt: fullPrompt,
            aspect_ratio: aspectRatio,
            model,
        };
        if (preset) body.preset = preset;
        if (references.length > 0) {
            body.reference_images = references.slice(0, MAX_GENERATION_REFERENCE_IMAGES);
        }
        if (wantsVideoTest) {
            body.video_test_mode = true;
            body.video_test_every_n_messages = videoEveryN;
        }

        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });
        } catch (error) {
            const pageOrigin = window.location.origin;
            let endpointOrigin = endpoint;
            try {
                endpointOrigin = new URL(url, window.location.href).origin;
            } catch (parseErr) {
                console.warn('[IIG] Failed to parse Naistera endpoint origin:', parseErr);
            }
            const rawMessage = String(error?.message || '').trim() || 'Failed to fetch';
            throw new Error(
                `Network/CORS error while requesting ${endpointOrigin} from ${pageOrigin}. `
                + `The browser blocked access to the response before the API could return JSON. `
                + `Original error: ${rawMessage}`
            );
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error (${response.status}): ${text}`);
        }

        const result = await response.json();
        if (!result?.data_url) {
            throw new Error('No data_url in response');
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

/**
 * Резолвит активного провайдера с учётом model-detection для nano-banana моделей
 * поверх apiType='openai'.
 */
export function resolveActiveProvider(settings = getSettings()) {
    if (settings.apiType === 'openai' && isGeminiModel(settings.model)) {
        return providers.get('gemini');
    }
    return providers.get(settings.apiType);
}

// Default registration: three current providers.
registerProvider(new OpenAIProvider());
registerProvider(new GeminiProvider());
registerProvider(new NaisteraProvider());

// ----- Models fetcher (общий для всех /v1/models-совместимых) -----

export async function fetchModels() {
    const settings = getSettings();
    const endpoint = getEffectiveEndpoint(settings);

    if (!endpoint || !settings.apiKey) {
        console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
        return [];
    }

    const url = `${endpoint}/v1/models`;

    try {
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
        const models = data.data || [];

        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

// ----- Validation (общий entry, используется pipeline) -----

export function validateSettings() {
    const settings = getSettings();
    const provider = resolveActiveProvider(settings);
    if (!provider) {
        throw new Error(`Ошибка настроек: неизвестный API (${settings.apiType})`);
    }
    const errors = provider.validate(settings);

    // Общий чек: для openai/gemini требуется model.
    if (provider.id !== 'naistera' && !settings.model) {
        errors.push('Модель не выбрана');
    }

    if (errors.length > 0) {
        throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
    }
}
