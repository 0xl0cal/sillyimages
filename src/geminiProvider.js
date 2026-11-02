/** Gemini image generation and model discovery. */
import { getSettings, iigLog, getEffectiveEndpoint, getEffectiveRefInstruction } from './settings.js';
import { fetchWithTimeout, ProviderError, isRetryableHttpStatus } from './utils.js';
import { buildFinalGenerationPrompt } from './parser.js';
import { Provider, buildGenerationUrl, throwAsProviderError } from './providerBase.js';
import { isImageModel, getGeminiCapabilities } from './modelCapabilities.js';
import { getReferenceImage, getReferenceDescription } from './references.js';
import { geminiImageLabel, collectProviderReferences } from './providerReferences.js';

function isGoogleNativeHost(url) {
    try {
        return new URL(url).hostname.endsWith('googleapis.com');
    } catch {
        return false;
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
