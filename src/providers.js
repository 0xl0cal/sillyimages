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
    base64ToBlob,
    fetchWithTimeout,
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
}

// ----- OpenAI (OpenAI-compatible) -----

// Таймаут для image-запросов. OpenAI допускает долгую генерацию на сложных
// промптах, особенно gpt-image-*.
const OPENAI_REQUEST_TIMEOUT_MS = 120_000;

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
    return { message: String(message).slice(0, 800), code };
}

/**
 * Переводит TypeError/AbortError, возникающие при `fetch` на сетевом уровне,
 * в человеко-читаемое сообщение. Вызывается вокруг `fetchWithTimeout` в
 * провайдерах — без этого юзер видит "Failed to fetch" без контекста.
 *
 * @param {unknown} error
 * @param {string} endpointLabel — короткое имя endpoint-а для сообщения
 */
function rethrowNetworkErrorAsHuman(error, endpointLabel) {
    // AbortError = наш таймаут (fetchWithTimeout) или внешний abort.
    if (error?.name === 'AbortError') {
        throw new Error(
            `Превышено время ожидания ответа от ${endpointLabel}. `
            + 'Проверьте подключение и попробуйте перегенерировать.'
        );
    }
    // TypeError: Failed to fetch — DNS, CORS, сервер недоступен, ERR_CONNECTION_*.
    if (error?.name === 'TypeError') {
        throw new Error(
            `Проблема с подключением к ${endpointLabel}. `
            + 'Сервер недоступен или заблокирован. Попробуйте перегенерировать.'
        );
    }
    // Остальное — пробрасываем как есть (уже обработанная API-ошибка).
    throw error;
}

/**
 * Распаковывает результат /generations или /edits.
 * OpenAI: `data[0].b64_json` (для gpt-image-* всегда) или `data[0].url`.
 */
function extractImageFromResult(result) {
    const dataList = Array.isArray(result?.data) ? result.data : [];
    if (dataList.length === 0) {
        if (result?.url) return result.url;
        throw new Error('No image data in response');
    }
    const imageObj = dataList[0];
    if (imageObj?.b64_json) {
        return `data:image/png;base64,${imageObj.b64_json}`;
    }
    if (imageObj?.url) {
        return imageObj.url;
    }
    throw new Error('Response data[0] has no b64_json or url');
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
        const baseUrl = String(settings.endpoint || '').replace(/\/$/, '');
        const fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        const modelKind = classifyOpenAIModel(settings.model);
        const requestedSize = options.aspectRatio
            ? (aspectRatioToSize(options.aspectRatio, modelKind) || settings.size)
            : settings.size;
        const quality = normalizeQualityForModel(options.quality || settings.quality, modelKind);

        iigLog(
            'INFO',
            `OpenAI generate: model=${settings.model} kind=${modelKind} refs=${references.length} size=${requestedSize} quality=${quality}`
        );

        // Роутинг: есть референсы → /v1/images/edits (multipart),
        // иначе → /v1/images/generations (JSON).
        if (references.length > 0) {
            return await this._generateWithEdits({
                baseUrl,
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
            baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            modelKind,
            prompt: fullPrompt,
            size: requestedSize,
            quality,
        });
    }

    async _generateWithGenerations({ baseUrl, apiKey, model, modelKind, prompt, size, quality }) {
        const url = `${baseUrl}/v1/images/generations`;

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
            rethrowNetworkErrorAsHuman(error, `OpenAI /v1/images/generations (${baseUrl})`);
        }

        if (!response.ok) {
            const { message, code } = await parseOpenAIError(response);
            throw new Error(`OpenAI /generations ${response.status} ${code}: ${message}`);
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }

    async _generateWithEdits({ baseUrl, apiKey, model, modelKind, prompt, size, quality, references }) {
        const url = `${baseUrl}/v1/images/edits`;
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
            rethrowNetworkErrorAsHuman(error, `OpenAI /v1/images/edits (${baseUrl})`);
        }

        if (!response.ok) {
            const { message, code } = await parseOpenAIError(response);
            throw new Error(`OpenAI /edits ${response.status} ${code}: ${message}`);
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }
}

// ----- Gemini (nano-banana, gemini-*-image) -----

const GEMINI_REQUEST_TIMEOUT_MS = 120_000;

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
    return { message: String(message).slice(0, 800), code };
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
        const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;

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
            const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
            fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
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
            rethrowNetworkErrorAsHuman(error, `Gemini ${model}`);
        }

        if (!response.ok) {
            const { message, code } = await parseGeminiError(response);
            throw new Error(`Gemini ${model} ${response.status} ${code}: ${message}`);
        }

        const result = await response.json();

        const candidates = result.candidates || [];
        if (candidates.length === 0) {
            throw new Error('No candidates in Gemini response');
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
