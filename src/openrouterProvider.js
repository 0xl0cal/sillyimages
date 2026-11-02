/** OpenRouter chat-completion image generation and model discovery. */
import { getSettings, iigLog, getEffectiveRefInstruction } from './settings.js';
import { imageUrlToDataUrl, fetchWithTimeout, ProviderError, isRetryableHttpStatus } from './utils.js';
import { buildFinalGenerationPrompt } from './parser.js';
import { t } from './i18n.js';
import { Provider, buildGenerationUrl, throwAsProviderError } from './providerBase.js';
import { classifyOpenRouterModel, getOpenRouterCapabilities, isGeminiOpenRouterModel } from './modelCapabilities.js';
import { getReferenceImage, getReferenceDescription } from './references.js';
import { referenceTextLabel, collectProviderReferences } from './providerReferences.js';
import { extractOpenRouterImage } from './imageResponse.js';

function isOpenRouterAiHost(url) {
    try {
        return new URL(url).hostname.endsWith('openrouter.ai');
    } catch {
        return false;
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
        const maxRefs = getOpenRouterCapabilities((ctx.settings || getSettings()).model).maxReferences;
        return collectProviderReferences(ctx, maxRefs, 'dataUrl', [['user', 'sendUserAvatar'], ['char', 'sendCharAvatar']]);
    }

    async generate({ prompt, style, references = [], options = {}, settings = getSettings() }) {
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
