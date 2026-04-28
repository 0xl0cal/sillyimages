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
    MAX_ADDITIONAL_REFERENCES,
    normalizeNaisteraModel,
    naisteraModelSupportsReferences,
    normalizeImageContextCount,
    normalizeNaisteraVideoFrequency,
    getEffectiveEndpoint,
    getEffectiveRefInstruction,
} from './settings.js';
import {
    normalizeStoredImagePath,
    imageUrlToBase64,
    imageUrlToDataUrl,
    base64ToBlob,
    fetchWithTimeout,
    ProviderError,
    isRetryableHttpStatus,
} from './utils.js';
import { buildFinalGenerationPrompt } from './parser.js';
import { t } from './i18n.js';
import {
    getCharacterAvatarBase64,
    getCharacterAvatarDataUrl,
    getUserAvatarBase64,
    getUserAvatarDataUrl,
    collectPreviousContextReferences,
} from './references.js';

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

// ----- Endpoint URL builder (raw mode support) -----

/**
 * Возвращает URL для POST-запроса генерации с учётом флага `rawEndpoint`.
 * В raw-режиме суффикс игнорируется — используется endpoint целиком.
 *
 * @param {object} settings
 * @param {string} pathSuffix — путь, который дописывается в обычном режиме
 *   (например, `/v1/images/generations`). Должен начинаться со `/`.
 * @returns {string} абсолютный URL
 */
export function buildGenerationUrl(settings, pathSuffix) {
    const base = (getEffectiveEndpoint(settings) || String(settings.endpoint || '')).replace(/\/$/, '');
    if (settings.rawEndpoint) {
        return base;
    }
    return `${base}${pathSuffix}`;
}

function isOpenRouterAiHost(url) {
    try {
        return new URL(url).hostname.endsWith('openrouter.ai');
    } catch {
        return false;
    }
}

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
    // Принимаем как прокси-алиасы (nano-banana*), так и официальные id Google.
    return mid.includes('nano-banana')
        || mid.startsWith('gemini-2.5-flash-image')
        || mid.startsWith('gemini-3-pro-image')
        || mid.startsWith('gemini-3.1-flash-image');
}

/**
 * Классификация модели Gemini Image.
 *
 * Возвращает одну из:
 *   - `'gemini-3.1-flash-image'` (Nano Banana 2 Preview)
 *   - `'gemini-3-pro-image'`     (Nano Banana Pro Preview)
 *   - `'gemini-2.5-flash-image'` (Nano Banana — stable)
 *   - `'unknown'` — вернётся optimistic default для прокси с кастомными id.
 */
export function classifyGeminiModel(modelId) {
    const id = String(modelId || '').toLowerCase().trim();
    if (!id) return 'unknown';

    // Официальные id — проверяем точные префиксы.
    if (id.startsWith('gemini-3.1-flash-image')) return 'gemini-3.1-flash-image';
    if (id.startsWith('gemini-3-pro-image')) return 'gemini-3-pro-image';
    if (id.startsWith('gemini-2.5-flash-image')) return 'gemini-2.5-flash-image';

    // Прокси-алиасы. Проверяем по убыванию специфичности.
    if (id.includes('nano-banana-2') || id.includes('nano banana 2')) return 'gemini-3.1-flash-image';
    if (id.includes('nano-banana-pro') || id.includes('nano banana pro')) return 'gemini-3-pro-image';
    if (id.includes('nano-banana')) return 'gemini-2.5-flash-image';

    return 'unknown';
}

/**
 * Capabilities каждой Gemini-модели по официальным докам Google.
 *
 * - `maxReferences` — общее число входных картинок, которое модель обрабатывает
 *   с высокой точностью (3 / 11 / 14).
 * - `imageSizes` — whitelist значений для поля `imageConfig.imageSize`; для
 *   2.5 Flash Google игнорирует/не поддерживает параметр → `null`.
 * - `aspectRatios` — whitelist значений `imageConfig.aspectRatio`.
 */
const GEMINI_CAPS = Object.freeze({
    'gemini-3.1-flash-image': {
        maxReferences: 14,
        imageSizes: ['512', '1K', '2K', '4K'],
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'],
    },
    'gemini-3-pro-image': {
        maxReferences: 11,
        imageSizes: ['1K', '2K', '4K'],
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    },
    'gemini-2.5-flash-image': {
        maxReferences: 3,
        imageSizes: null, // модель не принимает imageSize, не отправляем
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    },
    'unknown': {
        maxReferences: MAX_GENERATION_REFERENCE_IMAGES,
        imageSizes: ['1K', '2K', '4K'],
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    },
});

export function getGeminiCapabilities(modelId) {
    return GEMINI_CAPS[classifyGeminiModel(modelId)] || GEMINI_CAPS.unknown;
}

// ----- OpenRouter capabilities -----

/**
 * Классификация OpenRouter image-модели по префиксу провайдера.
 *
 * Возвращает одну из:
 *   - `'gemini-3.1-flash-image'`
 *   - `'gemini-3-pro-image'`
 *   - `'gemini-2.5-flash-image'`
 *   - `'flux'`     — black-forest-labs/flux.*
 *   - `'sourceful'`
 *   - `'unknown'`
 */
export function classifyOpenRouterModel(modelId) {
    const id = String(modelId || '').toLowerCase().trim();
    if (!id) return 'unknown';

    // Gemini через OpenRouter: префикс `google/`.
    if (id.startsWith('google/')) {
        const stripped = id.slice('google/'.length);
        const geminiKind = classifyGeminiModel(stripped);
        if (geminiKind !== 'unknown') return geminiKind;
    }

    if (id.startsWith('black-forest-labs/')) return 'flux';
    if (id.startsWith('sourceful/')) return 'sourceful';
    return 'unknown';
}

function isGeminiOpenRouterModel(modelId) {
    const kind = classifyOpenRouterModel(modelId);
    return kind === 'gemini-3.1-flash-image'
        || kind === 'gemini-3-pro-image'
        || kind === 'gemini-2.5-flash-image';
}

/**
 * Общий whitelist aspect ratios для generic OpenRouter моделей (flux и др.)
 * Документация OpenRouter: эти пресеты маппятся в конкретные размеры на
 * их стороне. 1:4/4:1/1:8/8:1 поддерживает только gemini-3.1-flash-image.
 */
const OPENROUTER_GENERIC_ASPECTS = Object.freeze(
    ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
);

/**
 * Capabilities OpenRouter-модели. Для gemini-* делегируется в GEMINI_CAPS,
 * иначе — generic (без image_size, общий aspect whitelist).
 */
export function getOpenRouterCapabilities(modelId) {
    const kind = classifyOpenRouterModel(modelId);
    if (kind === 'gemini-3.1-flash-image' || kind === 'gemini-3-pro-image' || kind === 'gemini-2.5-flash-image') {
        return GEMINI_CAPS[kind];
    }
    // flux / sourceful / unknown — aspect_ratio допустим, image_size не передаём.
    return {
        maxReferences: MAX_GENERATION_REFERENCE_IMAGES,
        imageSizes: null,
        aspectRatios: OPENROUTER_GENERIC_ASPECTS,
    };
}

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
            errors.push(t`Endpoint URL is not configured`);
        }
        if (caps.requiresApiKey && !settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        return errors;
    }

    /**
     * Поддерживает ли текущая конфигурация (apiType + model) референсы.
     * UI использует это чтобы показать/скрыть блоки «Аватары», «Контекст
     * картинок», «Дополнительные референсы». По умолчанию — да, каждый
     * провайдер может переопределить.
     */
    supportsReferences(_settings) {
        return true;
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

    /**
     * Возвращает список id моделей, доступных для генерации.
     *
     * Базовая реализация — OpenAI-совместимый `GET {endpoint}/v1/models`
     * + фильтр по `isImageModel`. Провайдеры, у которых формат другой
     * (OpenRouter, hypothetical custom endpoints), переопределяют.
     *
     * @returns {Promise<string[]>}
     */
    async fetchModels() {
        const settings = getSettings();
        const endpoint = getEffectiveEndpoint(settings);

        if (!endpoint || !settings.apiKey) {
            console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
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
        const models = data.data || [];
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    }
}

// ----- OpenAI (OpenAI-compatible) -----

// Таймаут для image-запросов. OpenAI допускает долгую генерацию на сложных
// промптах, особенно gpt-image-*.
const OPENAI_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Классификация модели OpenAI-совместимого API.
 * Возвращает строку-идентификатор семейства.
 */
function classifyOpenAIModel(modelId) {
    const id = String(modelId || '').toLowerCase().trim();
    // Сначала специфичные подстроки, потом общие.
    if (id.includes('gpt-image-2')) return 'gpt-image-2';
    if (id.includes('gpt-image-1.5') || id.includes('gpt-image-1-5')) return 'gpt-image-1.5';
    if (id.includes('gpt-image-1-mini')) return 'gpt-image-1-mini';
    if (id.includes('gpt-image-1')) return 'gpt-image-1';
    if (id.includes('gpt-image')) return 'gpt-image'; // generic prefix
    if (id.includes('flux-1-kontext')) return 'flux-kontext';
    if (id.includes('dall-e-3')) return 'dall-e-3';
    if (id.includes('dall-e-2')) return 'dall-e-2';
    return 'unknown';
}

/**
 * Считается ли модель «GPT Image семейством» — для них /edits поддерживает
 * множественные референсы через `image[]`.
 */
function isGptImageFamily(kind) {
    return kind === 'gpt-image-2' || kind === 'gpt-image-1.5' || kind === 'gpt-image-1-mini'
        || kind === 'gpt-image-1' || kind === 'gpt-image';
}

/**
 * Максимум референсов, поддерживаемых конкретной моделью в `/v1/images/edits`:
 *   - gpt-image-*: до `MAX_GENERATION_REFERENCE_IMAGES` (мультиреф `image[]`).
 *   - flux-1-kontext-*: 1 (у Flux Kontext дизайн — один reference).
 *   - dall-e-2: 1.
 *   - dall-e-3 / unknown: 0 — через /edits они не ходят.
 */
function getOpenAIModelMaxReferences(kind) {
    if (isGptImageFamily(kind)) return MAX_GENERATION_REFERENCE_IMAGES;
    if (kind === 'flux-kontext') return 1;
    if (kind === 'dall-e-2') return 1;
    return 0;
}

/**
 * aspect ratio → size для конкретного семейства модели.
 * Таблица из PLAN.md (раздел про OpenAI). Где размер не определён,
 * возвращает null — вызывающий код берёт settings.size либо 'auto'.
 */
function aspectRatioToSize(aspect, modelKind) {
    if (!aspect) return null;

    // gpt-image-2: можно любые WxH, но для готовых пресетов из тега — таблица PLAN.
    if (modelKind === 'gpt-image-2') {
        const map = {
            '1:1': '1024x1024',
            '16:9': '2048x1152',
            '9:16': '1152x2048',
            '3:2': '1536x1024',
            '2:3': '1024x1536',
            '4:3': '1536x1152',
            '3:4': '1152x1536',
        };
        return map[aspect] || null;
    }

    // gpt-image-1.5 и gpt-image-1-mini и gpt-image-1: фиксированный список.
    if (modelKind === 'gpt-image-1.5' || modelKind === 'gpt-image-1-mini' || modelKind === 'gpt-image-1' || modelKind === 'gpt-image') {
        const map = {
            '1:1': '1024x1024',
            '16:9': '1536x1024',
            '9:16': '1024x1536',
            '3:2': '1536x1024',
            '2:3': '1024x1536',
            '4:3': '1536x1024',
            '3:4': '1024x1536',
        };
        return map[aspect] || null;
    }

    // dall-e-3
    if (modelKind === 'dall-e-3') {
        const map = {
            '1:1': '1024x1024',
            '16:9': '1792x1024',
            '9:16': '1024x1792',
        };
        return map[aspect] || null;
    }

    // dall-e-2 — только квадраты
    if (modelKind === 'dall-e-2') {
        return '1024x1024';
    }

    // unknown / flux-kontext — возвращаем null, используем settings.size.
    return null;
}

/**
 * Разрешённые значения `quality` для модели. Возвращает null если параметр
 * не поддерживается и его не нужно передавать.
 */
function normalizeQualityForModel(userQuality, modelKind) {
    const q = String(userQuality || '').toLowerCase().trim();

    if (isGptImageFamily(modelKind)) {
        // gpt-image-*: low / medium / high / auto
        const allowed = new Set(['low', 'medium', 'high', 'auto']);
        if (allowed.has(q)) return q;
        // legacy значения UI: standard/hd → high
        if (q === 'hd') return 'high';
        if (q === 'standard') return 'medium';
        return 'auto';
    }

    if (modelKind === 'dall-e-3') {
        const allowed = new Set(['standard', 'hd']);
        return allowed.has(q) ? q : 'standard';
    }

    if (modelKind === 'dall-e-2') {
        return 'standard'; // единственное валидное значение
    }

    // unknown — передаём как есть, пусть прокси решает.
    return q || null;
}

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
 * Переводит TypeError/AbortError, возникающие при `fetch` на сетевом уровне,
 * в ProviderError с понятным текстом и `retryable: true`. Вызывается
 * вокруг `fetchWithTimeout` в провайдерах.
 *
 * Если это уже ProviderError — пробрасывается как есть.
 *
 * @param {unknown} error
 * @param {string} endpointLabel — короткое имя endpoint-а для сообщения.
 * @param {string} providerId
 */
function throwAsProviderError(error, endpointLabel, providerId) {
    if (error instanceof ProviderError) {
        throw error;
    }
    // AbortError = наш таймаут (fetchWithTimeout) или внешний abort.
    if (error?.name === 'AbortError') {
        throw new ProviderError({
            message: t`Request to ${endpointLabel} timed out. Check your connection and try regenerating.`,
            code: 'timeout',
            retryable: true,
            providerId,
            cause: error,
        });
    }
    // TypeError: Failed to fetch — DNS, CORS, сервер недоступен, ERR_CONNECTION_*.
    if (error?.name === 'TypeError') {
        throw new ProviderError({
            message: t`Connection problem with ${endpointLabel}. Server is unreachable or blocked. Try regenerating.`,
            code: 'network',
            retryable: true,
            providerId,
            cause: error,
        });
    }
    // Неожиданная ошибка — заворачиваем в ProviderError с retryable=false,
    // чтобы pipeline не ретраил подозрительное.
    throw new ProviderError({
        message: String(error?.message || error) || 'Unknown provider error',
        code: 'unknown',
        retryable: false,
        providerId,
        cause: error,
    });
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

function extractImageFromResult(result) {
    const dataList = Array.isArray(result?.data) ? result.data : [];
    if (dataList.length === 0) {
        if (result?.url) return result.url;
        iigLog('ERROR', 'OpenAI no-image response body:', result);
        throw new Error(`No image data in response. Top-level keys: ${Object.keys(result || {}).join(',')}`);
    }
    const imageObj = dataList[0];
    if (imageObj?.b64_json) {
        return `data:image/png;base64,${imageObj.b64_json}`;
    }
    if (imageObj?.url) {
        return imageObj.url;
    }
    iigLog('ERROR', 'OpenAI data[0] has no b64_json/url:', result);
    throw new Error(`Response data[0] has no b64_json or url. data[0] keys: ${Object.keys(imageObj || {}).join(',')}`);
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
        const settings = getSettings();
        const modelKind = classifyOpenAIModel(settings.model);
        // Flux Kontext принимает только 1 reference; gpt-image-* — до MAX.
        const maxRefs = getOpenAIModelMaxReferences(modelKind) || MAX_GENERATION_REFERENCE_IMAGES;
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
            if (refs.length >= maxRefs) break;
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

        if (refs.length > maxRefs) {
            refs.length = maxRefs;
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = getSettings();
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

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
        });
    }

    async _generateWithGenerations({ url, apiKey, model, modelKind, prompt, size, quality }) {

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

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, OPENAI_REQUEST_TIMEOUT_MS);
        } catch (error) {
            throwAsProviderError(error, `OpenAI /v1/images/generations (${url})`, 'openai');
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

    async _generateWithEdits({ url, apiKey, model, modelKind, prompt, size, quality, references }) {
        const form = new FormData();

        form.append('model', model);
        form.append('prompt', prompt);
        form.append('n', '1');
        if (size) form.append('size', size);
        if (quality) form.append('quality', quality);

        // GPT Image family: поле `image[]` для множественных референсов
        // (OpenAI gpt-image-1 / 1.5 / 2 поддерживает multi-image edit).
        // Остальные (dall-e-2, unknown): одиночный `image`.
        if (isGptImageFamily(modelKind) && references.length > 1) {
            references.forEach((ref, idx) => {
                const blob = base64ToBlob(ref, 'image/png');
                // OpenAI принимает повторный `image[]` как массив.
                form.append('image[]', blob, `reference-${idx}.png`);
            });
        } else {
            const blob = base64ToBlob(references[0], 'image/png');
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
            }, OPENAI_REQUEST_TIMEOUT_MS);
        } catch (error) {
            throwAsProviderError(error, `OpenAI /v1/images/edits (${url})`, 'openai');
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

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const caps = getGeminiCapabilities(settings.model);
        const maxRefs = caps.maxReferences;
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
            if (refs.length >= maxRefs) break;
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

        if (refs.length > maxRefs) {
            refs.length = maxRefs;
        }
        return refs;
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
        for (const imgB64 of references.slice(0, caps.maxReferences)) {
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: imgB64,
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

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, GEMINI_REQUEST_TIMEOUT_MS);
        } catch (error) {
            throwAsProviderError(error, `Gemini ${model}`, 'gemini');
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

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const caps = getOpenRouterCapabilities(settings.model);
        const maxRefs = caps.maxReferences;
        const refs = [];

        // Референсы в формате dataUrl (OpenRouter принимает base64 data URL в image_url.url).
        if (settings.sendCharAvatar) {
            const d = await getCharacterAvatarDataUrl();
            if (d) refs.push(d);
        }
        if (settings.sendUserAvatar) {
            const d = await getUserAvatarDataUrl();
            if (d) refs.push(d);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= maxRefs) break;
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

        if (refs.length > maxRefs) {
            refs.length = maxRefs;
        }
        return refs;
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
        // По докам OpenRouter text должен идти первым, далее картинки.
        let content;
        if (references.length > 0) {
            const parts = [{ type: 'text', text: fullPrompt }];
            for (const dataUrl of references.slice(0, caps.maxReferences)) {
                parts.push({
                    type: 'image_url',
                    image_url: { url: dataUrl },
                });
            }
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

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            }, OPENROUTER_REQUEST_TIMEOUT_MS);
        } catch (error) {
            throwAsProviderError(error, `OpenRouter ${model}`, 'openrouter');
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
        if (!NAISTERA_MODELS.includes(m)) {
            errors.push(t`For Naistera, select a model: grok / grok-pro / nano banana`);
        }
        return errors;
    }

    supportsReferences(settings) {
        return naisteraModelSupportsReferences(settings.naisteraModel);
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
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        const body = {
            prompt: fullPrompt,
            aspect_ratio: aspectRatio,
            model,
        };
        if (preset) body.preset = preset;
        if (references.length > 0) {
            body.reference_images = references;
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

        const result = await response.json();
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

// ----- A1111 / Forge (txt2img only, no references) -----

const A1111_DEFAULT_ENDPOINT = 'http://127.0.0.1:7860';
const A1111_REQUEST_TIMEOUT_MS = 600_000;
export const A1111_DEFAULT_SAMPLERS = Object.freeze([
    'Euler a', 'Euler', 'LMS', 'Heun', 'DPM2', 'DPM2 a',
    'DPM++ 2S a', 'DPM++ 2M', 'DPM++ SDE', 'DPM++ 2M SDE',
    'DDIM', 'PLMS', 'UniPC', 'LCM', 'Restart',
]);
export const A1111_DEFAULT_SCHEDULERS = Object.freeze([
    'Automatic', 'Karras', 'Exponential', 'SGM Uniform', 'Simple', 'Normal', 'DDIM', 'Beta',
]);

export const A1111_RESOLUTION_PRESETS = Object.freeze([
    { id: '512x512', width: 512, height: 512, name: '512x512 (1:1, SD 1.5)' },
    { id: '768x512', width: 768, height: 512, name: '768x512 (3:2, SD 1.5)' },
    { id: '512x768', width: 512, height: 768, name: '512x768 (2:3, SD 1.5)' },
    { id: '960x540', width: 960, height: 540, name: '960x540 (16:9)' },
    { id: '540x960', width: 540, height: 960, name: '540x960 (9:16)' },
    { id: '1024x1024', width: 1024, height: 1024, name: '1024x1024 (1:1, SDXL)' },
    { id: '1152x896', width: 1152, height: 896, name: '1152x896 (9:7, SDXL)' },
    { id: '896x1152', width: 896, height: 1152, name: '896x1152 (7:9, SDXL)' },
    { id: '1216x832', width: 1216, height: 832, name: '1216x832 (19:13, SDXL)' },
    { id: '832x1216', width: 832, height: 1216, name: '832x1216 (13:19, SDXL)' },
    { id: '1344x768', width: 1344, height: 768, name: '1344x768 (4:3, SDXL)' },
    { id: '768x1344', width: 768, height: 1344, name: '768x1344 (3:4, SDXL)' },
    { id: '1536x640', width: 1536, height: 640, name: '1536x640 (24:10, SDXL)' },
    { id: '640x1536', width: 640, height: 1536, name: '640x1536 (10:24, SDXL)' },
    { id: '1920x1088', width: 1920, height: 1088, name: '1920x1088 (16:9, 1080p)' },
    { id: '1088x1920', width: 1088, height: 1920, name: '1088x1920 (9:16, 1080p)' },
]);

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
function clampFloat(v, min, max, fallback) {
    const n = parseFloat(v);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

export class A1111Provider extends Provider {
    get id() { return 'a1111'; }
    get displayName() { return 'AUTOMATIC1111 / Forge / reForge'; }

    get capabilities() {
        return {
            ...super.capabilities,
            requiresApiKey: false,
            referencesFormat: null,
        };
    }

    supportsReferences(_settings) {
        return false;
    }

    validate(settings) {
        const errors = [];
        const ep = String(settings.endpoint || '').trim();
        if (!ep && !A1111_DEFAULT_ENDPOINT) {
            errors.push(t`Endpoint URL is not configured`);
        }
        return errors;
    }

    async collectReferences(_ctx) {
        return [];
    }

    async generate({ prompt, options = {} }) {
        const settings = getSettings();
        const url = buildGenerationUrl(settings, '/sdapi/v1/txt2img');

        // SDXL/A1111 ждёт comma-separated tag-style промпт, не natural language.
        // Поэтому пропускаем `[STYLE: ...]` injection и `Additional References:`
        // блок из buildFinalGenerationPrompt — тег-промпт идёт чистым,
        // юзер задаёт свой tag-style префикс через a1111PromptPrefix.
        // (style-параметр игнорируем: наша styles-секция заточена под LLM.)
        const rawPrompt = String(prompt || '').trim();
        const positive = settings.a1111PromptPrefix
            ? `${String(settings.a1111PromptPrefix).trim()}, ${rawPrompt}`.replace(/^,\s*|,\s*$/g, '').trim()
            : rawPrompt;

        const overrideSettings = {
            CLIP_stop_at_last_layers: clampInt(settings.a1111ClipSkip, 1, 12, 1),
        };
        if (settings.model) overrideSettings.sd_model_checkpoint = settings.model;
        const isValidVae = settings.a1111Vae && !['N/A', '', 'None'].includes(String(settings.a1111Vae));
        if (isValidVae) overrideSettings.sd_vae = settings.a1111Vae;

        const body = {
            prompt: positive,
            negative_prompt: String(settings.a1111NegativePrompt || ''),
            steps: clampInt(settings.a1111Steps, 1, 150, 20),
            cfg_scale: clampFloat(settings.a1111CfgScale, 1, 30, 7),
            width: clampInt(settings.a1111Width, 64, 4096, 512),
            height: clampInt(settings.a1111Height, 64, 4096, 512),
            sampler_name: String(settings.a1111Sampler || 'Euler a'),
            scheduler: String(settings.a1111Scheduler || 'Automatic'),
            seed: clampInt(settings.a1111Seed, -1, 2 ** 31 - 1, -1),
            n_iter: 1,
            batch_size: 1,
            restore_faces: !!settings.a1111RestoreFaces,
            enable_hr: !!settings.a1111EnableHr,
            hr_upscaler: settings.a1111HrUpscaler || undefined,
            hr_scale: clampFloat(settings.a1111HrScale, 1, 4, 2),
            denoising_strength: clampFloat(settings.a1111DenoisingStrength, 0, 1, 0.7),
            hr_second_pass_steps: clampInt(settings.a1111HrSecondPassSteps, 0, 150, 0),
            clip_skip: clampInt(settings.a1111ClipSkip, 1, 12, 1),
            override_settings: overrideSettings,
            override_settings_restore_afterwards: false,
            save_images: true,
            send_images: true,
        };

        if (settings.a1111AdetailerFace) {
            body.alwayson_scripts = {
                ADetailer: {
                    args: [true, true, { ad_model: 'face_yolov8n.pt' }],
                },
            };
        }

        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) {
            headers.Authorization = `Basic ${btoa(settings.apiKey)}`;
        }

        iigLog('INFO', `A1111 request: model=${settings.model || '(default)'} steps=${body.steps} cfg=${body.cfg_scale} ${body.width}x${body.height} sampler=${body.sampler_name} hires=${body.enable_hr}`);

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            }, A1111_REQUEST_TIMEOUT_MS);
        } catch (error) {
            throwAsProviderError(error, 'A1111', 'a1111');
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new ProviderError({
                message: `A1111 ${response.status}: ${String(text).slice(0, 800)}`,
                code: String(response.status),
                status: response.status,
                retryable: isRetryableHttpStatus(response.status),
                providerId: 'a1111',
            });
        }

        const result = await response.json();
        const b64 = Array.isArray(result?.images) ? result.images[0] : null;
        if (!b64 || typeof b64 !== 'string') {
            iigLog('ERROR', 'A1111 no-image response:', result);
            throw new ProviderError({
                message: `No image in A1111 response. Top-level keys: ${Object.keys(result || {}).join(',')}`,
                code: 'no_image',
                retryable: false,
                providerId: 'a1111',
            });
        }
        return `data:image/png;base64,${b64}`;
    }

    async fetchModels() {
        const settings = getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || A1111_DEFAULT_ENDPOINT).replace(/\/$/, '');
        const url = `${endpoint}/sdapi/v1/sd-models`;
        const headers = {};
        if (settings.apiKey) headers.Authorization = `Basic ${btoa(settings.apiKey)}`;

        const response = await fetch(url, { method: 'GET', headers });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data)) return [];
        return data.map((m) => m?.title || m?.model_name).filter(Boolean);
    }

    async fetchSamplers() {
        const settings = getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || A1111_DEFAULT_ENDPOINT).replace(/\/$/, '');
        const headers = {};
        if (settings.apiKey) headers.Authorization = `Basic ${btoa(settings.apiKey)}`;
        try {
            const response = await fetch(`${endpoint}/sdapi/v1/samplers`, { headers });
            if (!response.ok) return Array.from(A1111_DEFAULT_SAMPLERS);
            const data = await response.json();
            if (!Array.isArray(data)) return Array.from(A1111_DEFAULT_SAMPLERS);
            const list = data.map((s) => s?.name).filter(Boolean);
            return list.length ? list : Array.from(A1111_DEFAULT_SAMPLERS);
        } catch {
            return Array.from(A1111_DEFAULT_SAMPLERS);
        }
    }

    async fetchSchedulers() {
        const settings = getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || A1111_DEFAULT_ENDPOINT).replace(/\/$/, '');
        const headers = {};
        if (settings.apiKey) headers.Authorization = `Basic ${btoa(settings.apiKey)}`;
        try {
            const response = await fetch(`${endpoint}/sdapi/v1/schedulers`, { headers });
            if (!response.ok) return Array.from(A1111_DEFAULT_SCHEDULERS);
            const data = await response.json();
            if (!Array.isArray(data)) return Array.from(A1111_DEFAULT_SCHEDULERS);
            const list = data.map((s) => s?.label || s?.name).filter(Boolean);
            return list.length ? list : Array.from(A1111_DEFAULT_SCHEDULERS);
        } catch {
            return Array.from(A1111_DEFAULT_SCHEDULERS);
        }
    }

    async fetchVaes() {
        const settings = getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || A1111_DEFAULT_ENDPOINT).replace(/\/$/, '');
        const headers = {};
        if (settings.apiKey) headers.Authorization = `Basic ${btoa(settings.apiKey)}`;
        try {
            const response = await fetch(`${endpoint}/sdapi/v1/sd-vae`, { headers });
            if (!response.ok) return [];
            const data = await response.json();
            if (!Array.isArray(data)) return [];
            return data.map((v) => v?.model_name).filter(Boolean);
        } catch {
            return [];
        }
    }

    async fetchUpscalers() {
        const settings = getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || A1111_DEFAULT_ENDPOINT).replace(/\/$/, '');
        const headers = {};
        if (settings.apiKey) headers.Authorization = `Basic ${btoa(settings.apiKey)}`;
        try {
            const response = await fetch(`${endpoint}/sdapi/v1/upscalers`, { headers });
            if (!response.ok) return [];
            const data = await response.json();
            if (!Array.isArray(data)) return [];
            return data.map((u) => u?.name).filter(Boolean);
        } catch {
            return [];
        }
    }

    async ping() {
        // /sdapi/v1/sd-models — лёгкий endpoint, доступен сразу после --api.
        // Если он отвечает 200, сервер жив.
        const settings = getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || A1111_DEFAULT_ENDPOINT).replace(/\/$/, '');
        const headers = {};
        if (settings.apiKey) headers.Authorization = `Basic ${btoa(settings.apiKey)}`;
        const response = await fetch(`${endpoint}/sdapi/v1/sd-models`, { headers });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return true;
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
registerProvider(new GeminiProvider());
registerProvider(new OpenRouterProvider());
registerProvider(new ElectronHubProvider());
registerProvider(new NaisteraProvider());
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
    if (settings.rawEndpoint) {
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
    if (provider.id !== 'naistera' && !settings.model) {
        errors.push(t`Model is not selected`);
    }

    if (errors.length > 0) {
        throw new Error(t`Settings error: ${errors.join(', ')}`);
    }
}
