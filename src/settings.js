/**
 * Settings, defaults, migration и logger для Inline Image Generation.
 *
 * Содержит только код, который не зависит от других модулей расширения.
 * Все остальные модули могут безопасно импортировать отсюда.
 */

export const MODULE_NAME = 'inline_image_gen';

// Limits / глобальные константы размерностей.
export const MAX_CONTEXT_IMAGES = 3;
export const MAX_GENERATION_REFERENCE_IMAGES = 5;
export const MAX_ADDITIONAL_REFERENCES = 8;

// ----- Logger -----

const MAX_LOG_ENTRIES = 200;
const logBuffer = [];

export function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;

    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }

    if (level === 'ERROR') {
        console.error('[IIG]', ...args);
    } else if (level === 'WARN') {
        console.warn('[IIG]', ...args);
    } else {
        console.log('[IIG]', ...args);
    }
}

export function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

// ----- Defaults -----

export const defaultSettings = Object.freeze({
    enabled: true,
    externalBlocks: false,
    imageContextEnabled: false,
    imageContextCount: 1,
    styles: [],
    activeStyleId: '',
    apiType: 'openai', // 'openai' | 'gemini' | 'openrouter' | 'electronhub' | 'naistera'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0, // No auto-retry - user clicks error image to retry manually
    retryDelay: 1000,
    // Nano-banana specific
    sendCharAvatar: false,
    sendUserAvatar: false,
    useActiveUserPersonaAvatar: false,
    userAvatarFile: '', // Selected user avatar filename from /User Avatars/
    aspectRatio: '1:1', // "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
    imageSize: '1K', // "1K", "2K", "4K"
    // Naistera specific
    naisteraAspectRatio: '1:1',
    naisteraModel: 'grok', // 'grok' | 'grok-pro' | 'nano banana 2' | 'novelai'
    naisteraSendCharAvatar: false,
    naisteraSendUserAvatar: false,
    naisteraVideoTest: false,
    naisteraVideoEveryN: 1,
    additionalReferences: [],
});

// ----- Image/Video model keyword lists (used by providers.js) -----

export const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen',
];

export const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo',
];

// ----- Endpoint constants (UI + provider helpers) -----

export const NAISTERA_MODELS = Object.freeze(['grok', 'grok-pro', 'nano banana 2', 'novelai']);

export const DEFAULT_ENDPOINTS = Object.freeze({
    naistera: 'https://naistera.org',
    openrouter: 'https://openrouter.ai/api/v1',
    electronhub: 'https://api.electronhub.ai',
});

export const ENDPOINT_PLACEHOLDERS = Object.freeze({
    openai: 'https://api.openai.com',
    gemini: 'https://generativelanguage.googleapis.com',
    openrouter: 'https://openrouter.ai/api/v1',
    electronhub: 'https://api.electronhub.ai',
    naistera: 'https://naistera.org',
});

// ----- Settings accessors -----

/**
 * Возвращает настройки расширения, создавая их при первом вызове
 * и добавляя недостающие дефолтные ключи (дешёвая миграция).
 */
export function getSettings() {
    const context = SillyTavern.getContext();

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    // Ensure all default keys exist
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }

    return context.extensionSettings[MODULE_NAME];
}

export function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

// ----- Naistera helpers (знают про настройки, но не про провайдеров) -----

export function normalizeNaisteraModel(model) {
    const raw = String(model || '').trim().toLowerCase();
    if (!raw) return 'grok';
    if (raw === 'grok pro') return 'grok-pro';
    if (raw === 'grok-pro') return 'grok-pro';
    if (raw === 'grok-imagine-pro') return 'grok-pro';
    if (raw === 'imagine-pro') return 'grok-pro';
    if (raw === 'nano-banana') return 'nano banana 2';
    if (raw === 'nano banana') return 'nano banana 2';
    // Legacy value migration: map removed "nano banana pro" to "nano banana 2".
    if (raw === 'nano-banana-pro') return 'nano banana 2';
    if (raw === 'nano banana pro') return 'nano banana 2';
    if (raw === 'nano-banana-2') return 'nano banana 2';
    if (raw === 'nano banana 2') return 'nano banana 2';
    if (raw === 'novel ai') return 'novelai';
    if (raw === 'novelai') return 'novelai';
    if (NAISTERA_MODELS.includes(raw)) return raw;
    return 'grok';
}

export function naisteraModelSupportsReferences(model) {
    const normalized = normalizeNaisteraModel(model);
    return normalized !== 'novelai' && normalized !== 'grok-pro';
}

export function shouldUseNaisteraVideoTest(model) {
    const normalized = normalizeNaisteraModel(model);
    return normalized === 'grok' || normalized === 'grok-pro' || normalized.startsWith('nano banana');
}

export function normalizeNaisteraVideoFrequency(value) {
    const numeric = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(numeric) || numeric < 1) return 1;
    return Math.min(numeric, 999);
}

export function normalizeImageContextCount(value) {
    const numeric = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(numeric) || numeric < 1) return 1;
    return Math.min(numeric, MAX_CONTEXT_IMAGES);
}

export function getAssistantMessageOrdinal(messageId) {
    const context = SillyTavern.getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    let ordinal = 0;
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) {
            continue;
        }
        ordinal += 1;
        if (i === messageId) {
            return ordinal;
        }
    }
    return Math.max(1, messageId + 1);
}

export function shouldTriggerNaisteraVideoForMessage(messageId, everyN) {
    const normalizedEveryN = normalizeNaisteraVideoFrequency(everyN);
    if (normalizedEveryN <= 1) return true;
    const ordinal = getAssistantMessageOrdinal(messageId);
    return ordinal % normalizedEveryN === 0;
}

// ----- Endpoint normalization -----

export function getEndpointPlaceholder(apiType) {
    return ENDPOINT_PLACEHOLDERS[apiType] || 'https://api.example.com';
}

export function normalizeConfiguredEndpoint(apiType, endpoint) {
    const trimmed = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        if (apiType === 'naistera') return DEFAULT_ENDPOINTS.naistera;
        if (apiType === 'openrouter') return DEFAULT_ENDPOINTS.openrouter;
        if (apiType === 'electronhub') return DEFAULT_ENDPOINTS.electronhub;
        return '';
    }
    if (apiType === 'naistera') {
        return trimmed.replace(/\/api\/generate$/i, '');
    }
    return trimmed;
}

export function shouldReplaceEndpointForApiType(apiType, endpoint) {
    const trimmed = String(endpoint || '').trim();
    if (!trimmed) return true;
    if (apiType !== 'naistera') return false;
    return /\/v1\/images\/generations\/?$/i.test(trimmed)
        || /\/v1\/models\/?$/i.test(trimmed)
        || /\/v1beta\/models\//i.test(trimmed);
}

export function getEffectiveEndpoint(settings = getSettings()) {
    return normalizeConfiguredEndpoint(settings.apiType, settings.endpoint);
}

// ----- Styles -----

export function ensureStyles(settings = getSettings()) {
    if (!Array.isArray(settings.styles)) {
        const migratedPresets = Array.isArray(settings.stylePresets) ? settings.stylePresets : [];
        settings.styles = migratedPresets.map((preset) => ({
            id: String(preset?.id || `iig-style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
            name: String(preset?.name || '').trim(),
            value: String(preset?.style || '').trim(),
        }));
    }

    settings.styles = settings.styles.map((style, index) => ({
        id: String(style?.id || `iig-style-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`),
        name: String(style?.name || `Стиль ${index + 1}`).trim() || `Стиль ${index + 1}`,
        value: String(style?.value ?? style?.style ?? '').trim(),
    }));

    if (!settings.styles.some((style) => style.id === settings.activeStyleId)) {
        settings.activeStyleId = '';
    }

    return settings.styles;
}

export function createStyle(name = '') {
    const settings = getSettings();
    const styles = ensureStyles(settings);
    const style = {
        id: `iig-style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: String(name || '').trim() || `Стиль ${styles.length + 1}`,
        value: '',
    };
    styles.push(style);
    settings.activeStyleId = style.id;
    return style;
}

export function getActiveStyle(settings = getSettings()) {
    const styles = ensureStyles(settings);
    return styles.find((style) => style.id === settings.activeStyleId) || null;
}

export function updateStyle(styleId, patch) {
    const settings = getSettings();
    const style = ensureStyles(settings).find((item) => item.id === styleId);
    if (!style) {
        return null;
    }

    if (Object.hasOwn(patch, 'name')) {
        style.name = String(patch.name || '').trim() || style.name;
    }
    if (Object.hasOwn(patch, 'value')) {
        style.value = String(patch.value || '').trim();
    }

    return style;
}

export function removeStyle(styleId) {
    const settings = getSettings();
    const styles = ensureStyles(settings);
    const index = styles.findIndex((item) => item.id === styleId);
    if (index === -1) {
        return false;
    }

    styles.splice(index, 1);
    if (settings.activeStyleId === styleId) {
        settings.activeStyleId = styles[0]?.id || '';
    }
    return true;
}

// ----- Additional references array helpers -----

export function ensureAdditionalReferencesArray(settings = getSettings()) {
    if (!Array.isArray(settings.additionalReferences)) {
        settings.additionalReferences = [];
    }

    settings.additionalReferences = settings.additionalReferences
        .slice(0, MAX_ADDITIONAL_REFERENCES)
        .map((ref) => ({
            name: String(ref?.name || '').trim(),
            description: String(ref?.description || '').trim(),
            imagePath: String(ref?.imagePath || '').trim(),
            matchMode: ref?.matchMode === 'always' ? 'always' : 'match',
            enabled: ref?.enabled !== false,
        }));

    return settings.additionalReferences;
}
