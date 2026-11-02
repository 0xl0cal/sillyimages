/** Provider registry, active capabilities and shared UI entry points. */
import { getSettings, iigLog, MAX_ADDITIONAL_REFERENCES } from './settings.js';
import { t } from './i18n.js';
import { Provider } from './providerBase.js';
import { A1111Provider } from './a1111.js';
import { OpenAIProvider, XAIProvider, ElectronHubProvider } from './openaiProviders.js';
import { GeminiProvider } from './geminiProvider.js';
import { OpenRouterProvider } from './openrouterProvider.js';
import { NaisteraProvider } from './naisteraProvider.js';
import { NovelAIProvider } from './novelaiProvider.js';
import {
    classifyOpenAIModel, getOpenAIModelMaxReferences, getGeminiCapabilities, getOpenRouterCapabilities,
} from './modelCapabilities.js';

export { Provider, buildGenerationUrl } from './providerBase.js';
export { A1111Provider, A1111_RESOLUTION_PRESETS } from './a1111.js';
export { OpenAIProvider, XAIProvider, ElectronHubProvider } from './openaiProviders.js';
export { GeminiProvider } from './geminiProvider.js';
export { OpenRouterProvider } from './openrouterProvider.js';
export { NaisteraProvider } from './naisteraProvider.js';
export { NovelAIProvider } from './novelaiProvider.js';
export {
    isImageModel, isGeminiModel, classifyGeminiModel, getGeminiCapabilities, classifyOpenRouterModel,
    getOpenRouterCapabilities,
} from './modelCapabilities.js';

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
