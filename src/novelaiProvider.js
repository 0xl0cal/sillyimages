/** Direct NovelAI generation with serialized no-Anlas checks. */
import { getSettings, getEffectiveEndpoint, getEffectiveNegativePrompt, getLastRequestSnapshot } from './settings.js';
import { fetchWithTimeout, ProviderError, isRetryableHttpStatus } from './utils.js';
import { buildFinalGenerationPrompt } from './parser.js';
import {
    NOVELAI_MODELS, buildNovelAIParameters, validateNovelAIParameters, splitNovelAICharacterPrompts,
    isNovelAIMedium,
} from './novelai.js';
import { t } from './i18n.js';
import { Provider } from './providerBase.js';
import { buildCharacterDescriptionPromptBlock } from './references.js';
import { appendPromptBlock } from './providerReferences.js';

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
