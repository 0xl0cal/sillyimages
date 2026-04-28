/**
 * Settings, defaults, migration и logger для Inline Image Generation.
 *
 * Содержит только код, который не зависит от других модулей расширения.
 * Все остальные модули могут безопасно импортировать отсюда.
 */

import { t } from './i18n.js';

export const MODULE_NAME = 'inline_image_gen';

// Limits / глобальные константы размерностей.
export const MAX_CONTEXT_IMAGES = 3;
export const MAX_GENERATION_REFERENCE_IMAGES = 5;
// Hard cap на размер коллекции additional references. В v2.0 старый лимит 8
// был UI-ограничением; теперь «лорбук» даёт пользователю намного больше
// записей, а на этап генерации всё равно попадает только столько, сколько
// поддерживает активная модель (см. provider capabilities).
export const MAX_ADDITIONAL_REFERENCES = 256;

// Дефолтная «критическая» инструкция, которая дописывается в начало prompt'а
// когда хотя бы один референс отправляется провайдеру. Раньше была
// захардкожена в 3 местах `providers.js` (Gemini / OpenRouter / Naistera).
// Теперь редактируется в настройках и может быть отключена целиком.
export const DEFAULT_REF_INSTRUCTION = '[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]';

// ----- Logger -----

const MAX_LOG_ENTRIES = 200;
const logBuffer = [];

function formatLogArg(a) {
    if (a instanceof Error) {
        const parts = [`${a.name || 'Error'}: ${a.message}`];
        // Useful custom fields on ProviderError / fetch errors / etc.
        for (const key of ['code', 'status', 'providerId', 'cause']) {
            if (a[key] !== undefined && a[key] !== null) {
                parts.push(`${key}=${typeof a[key] === 'object' ? JSON.stringify(a[key]) : a[key]}`);
            }
        }
        if (a.stack) parts.push(a.stack);
        return parts.join('\n');
    }
    if (typeof a === 'object' && a !== null) {
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }
    return String(a);
}

export function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(formatLogArg).join(' ');
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
    toastr.success(t`Logs exported`, t`Image Generation`);
}

// ----- Defaults -----

export const defaultSettings = Object.freeze({
    enabled: true,
    externalBlocks: false,
    processUserMessages: false,
    imageContextEnabled: false,
    imageContextCount: 1,
    styles: [],
    activeStyleId: '',
    apiType: 'openai', // 'openai' | 'gemini' | 'openrouter' | 'electronhub' | 'naistera' | 'a1111'
    endpoint: '',
    /**
     * Если true — endpoint используется «как есть» для генерации (никаких
     * /v1/images/generations, /v1beta/models/..., /chat/completions не
     * дописывается). Fetchmodels в этом режиме отключён: юзер вводит имя
     * модели вручную.
     */
    rawEndpoint: false,
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
    // A1111 / Forge specific (txt2img only — references not supported)
    a1111Width: 512,
    a1111Height: 512,
    a1111Steps: 20,
    a1111CfgScale: 7,
    a1111Sampler: 'Euler a',
    a1111Scheduler: 'Automatic',
    a1111Vae: '',
    a1111HrUpscaler: '',
    a1111HrScale: 2.0,
    a1111DenoisingStrength: 0.7,
    a1111HrSecondPassSteps: 0,
    a1111ClipSkip: 1,
    a1111RestoreFaces: false,
    a1111EnableHr: false,
    a1111AdetailerFace: false,
    a1111Resolution: '',
    a1111PromptPrefix: '',
    a1111NegativePrompt: '',
    a1111Seed: -1,
    // Устаревшее поле: хранилось плоским массивом до v2.0-D.1. Сейчас это
    // refs первого лорбука. При старте `migrateAdditionalReferencesToLorebook`
    // перекладывает его в `lorebooks[0]` и очищает здесь.
    additionalReferences: [],
    // Лорбуки — коллекции ref-записей. У каждого свой `enabled` (matcher
    // собирает refs из всех enabled одновременно). `activeLorebookId` хранит
    // тот, что открыт для редактирования в UI-секции References.
    lorebooks: [],
    activeLorebookId: '',
    // Ref instruction — критический префикс, дописываемый к prompt'у когда
    // хотя бы один reference image отправляется провайдеру. Глобальный
    // (не привязан к connection profile).
    refInstructionEnabled: true,
    refInstruction: DEFAULT_REF_INSTRUCTION,
    // Контролирует отправку текстовых описаний матчнутых лорбук-референсов в
    // image-prompt. По дефолту ON: описания помогают модели понять кого/что
    // именно изображать, особенно когда сами картинки референсов слабо
    // соответствуют запросу.
    sendRefDescriptions: true,
    // Connection profiles — именованные snapshot'ы настроек подключения
    // (apiType / endpoint / apiKey / model / provider-specific). Переключение
    // профиля копирует все поля из профиля в settings. См. CONNECTION_FIELDS.
    connectionProfiles: [],
    activeConnectionProfileId: '',
});

// ----- Connection profiles -----

/**
 * Список полей, которые входят в профиль подключения. Всё остальное
 * (styles, additionalReferences, imageContext*, maxRetries, enabled, ...)
 * — глобально и общее для всех профилей.
 */
export const CONNECTION_FIELDS = Object.freeze([
    'apiType',
    'endpoint',
    'rawEndpoint',
    'apiKey',
    'model',
    'size',
    'quality',
    'aspectRatio',
    'imageSize',
    'sendCharAvatar',
    'sendUserAvatar',
    'useActiveUserPersonaAvatar',
    'userAvatarFile',
    'naisteraAspectRatio',
    'naisteraModel',
    'naisteraSendCharAvatar',
    'naisteraSendUserAvatar',
    'naisteraVideoTest',
    'naisteraVideoEveryN',
    'a1111Width',
    'a1111Height',
    'a1111Steps',
    'a1111CfgScale',
    'a1111Sampler',
    'a1111Scheduler',
    'a1111Vae',
    'a1111HrUpscaler',
    'a1111HrScale',
    'a1111DenoisingStrength',
    'a1111HrSecondPassSteps',
    'a1111ClipSkip',
    'a1111RestoreFaces',
    'a1111EnableHr',
    'a1111AdetailerFace',
    'a1111Resolution',
    'a1111PromptPrefix',
    'a1111NegativePrompt',
    'a1111Seed',
]);

function makeProfileId() {
    return `iig-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Извлекает из settings только те поля, что входят в профиль. */
export function extractConnectionFields(settings = getSettings()) {
    const snapshot = {};
    for (const key of CONNECTION_FIELDS) {
        snapshot[key] = settings[key];
    }
    return snapshot;
}

/** Гарантирует валидность structure `connectionProfiles` и возвращает массив. */
export function ensureConnectionProfiles(settings = getSettings()) {
    if (!Array.isArray(settings.connectionProfiles)) {
        settings.connectionProfiles = [];
    }
    // Нормализация каждого профиля.
    settings.connectionProfiles = settings.connectionProfiles.map((raw) => {
        const id = String(raw?.id || '').trim() || makeProfileId();
        const name = String(raw?.name || '').trim() || t`Untitled`;
        const fields = {};
        for (const key of CONNECTION_FIELDS) {
            fields[key] = raw?.[key] ?? defaultSettings[key];
        }
        return { id, name, ...fields };
    });
    // Активный id валиден?
    if (!settings.connectionProfiles.some(p => p.id === settings.activeConnectionProfileId)) {
        settings.activeConnectionProfileId = settings.connectionProfiles[0]?.id || '';
    }
    return settings.connectionProfiles;
}

/** Возвращает активный профиль или null. */
export function getActiveConnectionProfile(settings = getSettings()) {
    const profiles = ensureConnectionProfiles(settings);
    return profiles.find(p => p.id === settings.activeConnectionProfileId) || null;
}

/**
 * Миграция: если connectionProfiles пусты, создаёт `Default` профиль
 * со snapshot'ом текущих top-level connection-полей. Вызывать однократно
 * при инициализации.
 */
export function migrateConnectionProfilesFromLegacy(settings = getSettings()) {
    ensureConnectionProfiles(settings);
    if (settings.connectionProfiles.length > 0) {
        return;
    }
    const id = makeProfileId();
    settings.connectionProfiles.push({
        id,
        name: 'Default',
        ...extractConnectionFields(settings),
    });
    settings.activeConnectionProfileId = id;
}

/**
 * Создаёт новый профиль со snapshot'ом текущих connection-полей.
 * Активным становится новый профиль. Возвращает созданный профиль.
 */
export function createConnectionProfile(name, settings = getSettings()) {
    ensureConnectionProfiles(settings);
    const profile = {
        id: makeProfileId(),
        name: String(name || '').trim() || t`Profile ${settings.connectionProfiles.length + 1}`,
        ...extractConnectionFields(settings),
    };
    settings.connectionProfiles.push(profile);
    settings.activeConnectionProfileId = profile.id;
    return profile;
}

/**
 * Записывает текущие connection-поля settings в указанный профиль.
 * По умолчанию — в активный. Возвращает обновлённый профиль или null.
 */
export function saveCurrentIntoProfile(profileId = null, settings = getSettings()) {
    const targetId = profileId || settings.activeConnectionProfileId;
    const profile = ensureConnectionProfiles(settings).find(p => p.id === targetId);
    if (!profile) return null;
    Object.assign(profile, extractConnectionFields(settings));
    return profile;
}

/**
 * Загружает профиль в top-level settings (копирует connection-поля).
 * Обновляет `activeConnectionProfileId`. Возвращает загруженный профиль
 * или null если не найден.
 */
export function loadConnectionProfile(profileId, settings = getSettings()) {
    const profile = ensureConnectionProfiles(settings).find(p => p.id === profileId);
    if (!profile) return null;
    for (const key of CONNECTION_FIELDS) {
        settings[key] = profile[key];
    }
    settings.activeConnectionProfileId = profile.id;
    return profile;
}

export function renameConnectionProfile(profileId, newName, settings = getSettings()) {
    const profile = ensureConnectionProfiles(settings).find(p => p.id === profileId);
    if (!profile) return null;
    profile.name = String(newName || '').trim() || profile.name;
    return profile;
}

/**
 * Удаляет профиль. Если удалённый был активным — активным становится первый
 * оставшийся профиль (без загрузки его в settings — это отдельный шаг).
 * Запрещает удаление последнего профиля (возвращает false).
 */
export function removeConnectionProfile(profileId, settings = getSettings()) {
    const profiles = ensureConnectionProfiles(settings);
    if (profiles.length <= 1) return false;
    const index = profiles.findIndex(p => p.id === profileId);
    if (index === -1) return false;
    profiles.splice(index, 1);
    if (settings.activeConnectionProfileId === profileId) {
        settings.activeConnectionProfileId = profiles[0]?.id || '';
    }
    return true;
}

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
    a1111: 'http://127.0.0.1:7860',
});

export const ENDPOINT_PLACEHOLDERS = Object.freeze({
    openai: 'https://api.openai.com',
    gemini: 'https://generativelanguage.googleapis.com',
    openrouter: 'https://openrouter.ai/api/v1',
    electronhub: 'https://api.electronhub.ai',
    naistera: 'https://naistera.org',
    a1111: 'http://127.0.0.1:7860',
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
        if (apiType === 'a1111') return DEFAULT_ENDPOINTS.a1111;
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

    // Если в endpoint уже записан чужой дефолт из ENDPOINT_PLACEHOLDERS —
    // значит юзер переключает тип API и не правил endpoint вручную. В этом
    // случае заменяем на дефолт нового типа. Сравниваем без протокола/слэшей,
    // чтобы поймать и `https://api.openai.com` и `https://api.openai.com/`.
    const norm = trimmed.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    for (const [type, url] of Object.entries(ENDPOINT_PLACEHOLDERS)) {
        if (type === apiType) continue;
        const otherNorm = String(url).replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
        if (norm === otherNorm) {
            return true;
        }
    }

    // Оригинальная Naistera-ветка (не трогать).
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
        name: String(style?.name || t`Style ${index + 1}`).trim() || t`Style ${index + 1}`,
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
        name: String(name || '').trim() || t`Style ${styles.length + 1}`,
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

// ----- Last request snapshot (in-memory, NOT persisted) -----

/**
 * Снимок последнего запроса генерации для UI «Show last request».
 * Живёт только в памяти страницы: при перезагрузке SillyTavern сбрасывается.
 * НЕ входит в defaultSettings и НЕ сохраняется в `context.extensionSettings`.
 *
 * @type {null | {
 *   timestamp: number,
 *   prompt: string,
 *   references: Array<{ dataUrl: string, label: string }>,
 *   metadata: {
 *     provider: string,
 *     apiType: string,
 *     model: string,
 *     aspectRatio?: string,
 *     imageSize?: string,
 *     size?: string,
 *     quality?: string,
 *     refInstructionApplied: boolean,
 *   }
 * }}
 */
let lastRequestSnapshot = null;

export function setLastRequestSnapshot(snapshot) {
    lastRequestSnapshot = snapshot || null;
}

export function getLastRequestSnapshot() {
    return lastRequestSnapshot;
}

export function clearLastRequestSnapshot() {
    lastRequestSnapshot = null;
}

// ----- Ref instruction -----

/**
 * Возвращает актуальную «критическую инструкцию» для провайдера или пустую
 * строку, если юзер её выключил. Пустое значение `refInstruction` trimmed до
 * нуля тоже трактуется как «выключено», чтобы случайный clear textarea не
 * ломал логику `if (refInstruction)` в провайдерах.
 */
export function getEffectiveRefInstruction(settings = getSettings()) {
    if (settings.refInstructionEnabled === false) {
        return '';
    }
    const raw = String(settings.refInstruction ?? '').trim();
    return raw || DEFAULT_REF_INSTRUCTION;
}

// ----- Lorebooks & additional references -----

/**
 * Генерирует стабильный id для ref-записи (нужен для drag-reorder и
 * детерминированных операций UI).
 */
function makeReferenceId() {
    return `iig-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeLorebookId() {
    return `iig-lb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Нормализует строку с secondary-ключами в массив. Разделитель — запятая,
 * игнорируем пустые и повторяющиеся (после нормализации). Оставляем
 * comma-separated строку в хранилище — в matcher разбирается по месту.
 */
export function normalizeSecondaryKeysString(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ');
}

/**
 * Нормализует имя группы. Пустое → '' (ungrouped).
 */
export function normalizeGroupName(raw) {
    return String(raw || '').trim();
}

/**
 * Нормализует одну ref-запись: добавляет id, приводит поля к ожидаемым типам,
 * применяет defaults для новых полей из v2.0 (group / priority / regex / etc).
 */
function normalizeReferenceEntry(raw) {
    const priorityRaw = Number.parseInt(String(raw?.priority ?? 0), 10);
    return {
        id: String(raw?.id || '').trim() || makeReferenceId(),
        name: String(raw?.name || '').trim(),
        description: String(raw?.description || '').trim(),
        imagePath: String(raw?.imagePath || '').trim(),
        matchMode: raw?.matchMode === 'always' ? 'always' : 'match',
        enabled: raw?.enabled !== false,
        group: normalizeGroupName(raw?.group),
        priority: Number.isFinite(priorityRaw) ? priorityRaw : 0,
        useRegex: raw?.useRegex === true,
        secondaryKeys: normalizeSecondaryKeysString(raw?.secondaryKeys),
    };
}

/**
 * Нормализует массив refs одного лорбука + применяет hard-cap.
 */
function normalizeReferencesArrayInternal(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    return arr.slice(0, MAX_ADDITIONAL_REFERENCES).map(normalizeReferenceEntry);
}

/**
 * Нормализует структуру `settings.lorebooks`: добавляет id / enabled / meta,
 * приводит refs к каноничному виду. Гарантирует как минимум один лорбук
 * («My library») — если массив пустой.
 *
 * Валидирует `activeLorebookId`: если он указывает на удалённый/отсутствующий
 * лорбук — выставляется первый существующий.
 */
export function ensureLorebooks(settings = getSettings()) {
    if (!Array.isArray(settings.lorebooks)) {
        settings.lorebooks = [];
    }

    settings.lorebooks = settings.lorebooks.map((raw) => ({
        id: String(raw?.id || '').trim() || makeLorebookId(),
        name: String(raw?.name || '').trim() || 'Untitled',
        enabled: raw?.enabled !== false,
        refs: normalizeReferencesArrayInternal(raw?.refs),
        meta: {
            sourceUrl: String(raw?.meta?.sourceUrl || '').trim(),
            importedAt: Number.isFinite(raw?.meta?.importedAt) ? raw.meta.importedAt : null,
            version: Number.isFinite(raw?.meta?.version) ? raw.meta.version : null,
        },
    }));

    if (settings.lorebooks.length === 0) {
        settings.lorebooks.push({
            id: makeLorebookId(),
            name: 'My library',
            enabled: true,
            refs: [],
            meta: { sourceUrl: '', importedAt: null, version: null },
        });
    }

    if (!settings.lorebooks.some((lb) => lb.id === settings.activeLorebookId)) {
        settings.activeLorebookId = settings.lorebooks[0].id;
    }

    return settings.lorebooks;
}

/**
 * One-time migration из старого `settings.additionalReferences` (flat array)
 * в `settings.lorebooks[0]`. Вызывается из init. Идемпотентно.
 */
export function migrateAdditionalReferencesToLorebook(settings = getSettings()) {
    ensureLorebooks(settings);

    const legacyRefs = Array.isArray(settings.additionalReferences) ? settings.additionalReferences : [];
    if (legacyRefs.length === 0) {
        settings.additionalReferences = [];
        return;
    }

    // Переливаем в refs первого лорбука (обычно «My library»). Существующие
    // refs в лорбуке сохраняются, legacy добавляются в конец (не перезаписывают).
    const target = settings.lorebooks[0];
    const existingIds = new Set(target.refs.map((r) => r.id));
    const migrated = normalizeReferencesArrayInternal(legacyRefs)
        .filter((r) => !existingIds.has(r.id));
    target.refs = target.refs.concat(migrated).slice(0, MAX_ADDITIONAL_REFERENCES);

    // Очищаем legacy-поле после успешной миграции.
    settings.additionalReferences = [];
    iigLog('INFO', `Migrated ${migrated.length} additional references to lorebook "${target.name}"`);
}

/**
 * Возвращает активный лорбук (тот, что редактируется в UI) или первый, если
 * `activeLorebookId` битый. Никогда не возвращает null при валидном settings.
 */
export function getActiveLorebook(settings = getSettings()) {
    const lorebooks = ensureLorebooks(settings);
    return lorebooks.find((lb) => lb.id === settings.activeLorebookId) || lorebooks[0] || null;
}

/**
 * Массив refs активного лорбука (read-write: мутация возвращённого массива
 * изменит state в settings).
 *
 * Имя `ensureAdditionalReferencesArray` сохранено ради минимальной diff — до
 * миграции все consumer-места считали это главным массивом refs. Теперь оно
 * эквивалентно «refs активного лорбука».
 */
export function ensureAdditionalReferencesArray(settings = getSettings()) {
    const active = getActiveLorebook(settings);
    if (!active) {
        return [];
    }
    active.refs = normalizeReferencesArrayInternal(active.refs);
    return active.refs;
}

/**
 * Все refs из всех enabled лорбуков в один плоский массив. Matcher использует
 * это для поиска совпадений по prompt. Порядок сохраняет: refs внутри лорбука
 * в исходном порядке, лорбуки — в порядке массива `settings.lorebooks`.
 *
 * К каждому ref добавляется «невидимое» поле `_lorebookName` (underscore-
 * префикс, чтобы не путали с persisted-полями). UI/debug используют это
 * чтобы показать, из какого лорбука пришёл сматченный ref.
 */
export function getAllEnabledLorebookReferences(settings = getSettings()) {
    const lorebooks = ensureLorebooks(settings);
    const result = [];
    for (const lb of lorebooks) {
        if (!lb.enabled) continue;
        for (const ref of lb.refs) {
            result.push({ ...ref, _lorebookName: lb.name });
        }
    }
    return result;
}

/**
 * Возвращает массив уникальных имён групп из refs активного лорбука в порядке
 * первого появления. Пустая группа ('') не включается.
 */
export function getAdditionalReferenceGroups(settings = getSettings()) {
    const refs = ensureAdditionalReferencesArray(settings);
    const seen = new Set();
    const groups = [];
    for (const ref of refs) {
        const name = normalizeGroupName(ref.group);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        groups.push(name);
    }
    return groups;
}

// ----- Lorebook CRUD -----

export function createLorebook(name, settings = getSettings()) {
    ensureLorebooks(settings);
    const lorebook = {
        id: makeLorebookId(),
        name: String(name || '').trim() || `Lorebook ${settings.lorebooks.length + 1}`,
        enabled: true,
        refs: [],
        meta: { sourceUrl: '', importedAt: Date.now(), version: null },
    };
    settings.lorebooks.push(lorebook);
    settings.activeLorebookId = lorebook.id;
    return lorebook;
}

export function renameLorebook(lorebookId, newName, settings = getSettings()) {
    const lb = ensureLorebooks(settings).find((x) => x.id === lorebookId);
    if (!lb) return null;
    lb.name = String(newName || '').trim() || lb.name;
    return lb;
}

export function setLorebookEnabled(lorebookId, enabled, settings = getSettings()) {
    const lb = ensureLorebooks(settings).find((x) => x.id === lorebookId);
    if (!lb) return null;
    lb.enabled = Boolean(enabled);
    return lb;
}

/**
 * Удаляет лорбук. Запрещает удаление последнего. Если удалённый был активным —
 * активным становится первый оставшийся.
 */
export function removeLorebook(lorebookId, settings = getSettings()) {
    const lorebooks = ensureLorebooks(settings);
    if (lorebooks.length <= 1) return false;
    const index = lorebooks.findIndex((x) => x.id === lorebookId);
    if (index === -1) return false;
    lorebooks.splice(index, 1);
    if (settings.activeLorebookId === lorebookId) {
        settings.activeLorebookId = lorebooks[0]?.id || '';
    }
    return true;
}

export function setActiveLorebook(lorebookId, settings = getSettings()) {
    const lb = ensureLorebooks(settings).find((x) => x.id === lorebookId);
    if (!lb) return null;
    settings.activeLorebookId = lb.id;
    return lb;
}
