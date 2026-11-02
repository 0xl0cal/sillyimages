/** Reference image transfer and the v1 lorebook interchange format. */
import { getSettings, saveSettings, createLorebook } from './settings.js';
import { imageUrlToDataUrl, saveImageToFile, normalizeStoredImagePath } from './utils.js';
import { t } from './i18n.js';

export function normalizeReferenceUrlList(rawValue) {
    return String(rawValue || '')
        .split(/\r?\n+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

export function getReferenceNameFromUrl(url, fallbackIndex = 0) {
    try {
        const parsed = new URL(url, window.location.href);
        const pathname = parsed.pathname || '';
        const fileName = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '').trim();
        if (fileName) {
            return fileName;
        }
    } catch (_error) {
        // ignore and fallback
    }
    return `reference-${fallbackIndex + 1}`;
}

/**
 * Скачивает одну картинку с URL и сохраняет её через `saveImageToFile`,
 * возвращая относительный путь на сервере ST. Бросает Error если URL
 * недоступен / не является картинкой.
 *
 * @param {string} url
 * @param {{ mode?: string, refIndex?: number, refName?: string }} [meta]
 * @returns {Promise<string>} нормализованный imagePath
 */
export async function downloadReferenceImageFromUrl(url, meta = {}) {
    const trimmed = String(url || '').trim();
    if (!trimmed) throw new Error(t`Add at least one URL`);

    const dataUrl = await imageUrlToDataUrl(trimmed);
    if (!dataUrl) throw new Error(t`Failed to load image: ${trimmed}`);

    const savedPath = await saveImageToFile(dataUrl, {
        mode: meta.mode || 'additional-reference-import',
        sourceUrl: trimmed,
        refIndex: Number.isFinite(meta.refIndex) ? meta.refIndex : 0,
        refName: String(meta.refName || getReferenceNameFromUrl(trimmed, meta.refIndex || 0)),
    });
    return normalizeStoredImagePath(savedPath);
}

// ----- Lorebook JSON export / import -----

/**
 * Формат JSON-экспорта лорбука, v1.
 *
 * Из ref-записи исключаются:
 *   - `id` — пересоздаётся при импорте (иначе конфликт с чужими лорбуками);
 *   - `imagePath` — локальный путь на машине экспортёра, бесполезен на чужой;
 *   - сама картинка (base64) — не включается, чтобы файл оставался лёгким
 *     и можно было делиться публично без утечек.
 *
 * Вместо них добавляется пустое поле `imageUrl: ''` — юзер вручную вставляет
 * прямые ссылки на картинки, чтобы получатель при импорте смог их скачать.
 */
export function buildLorebookExportJson(lorebook) {
    const refs = Array.isArray(lorebook?.refs) ? lorebook.refs : [];
    return {
        kind: 'iig-lorebook',
        version: 1,
        name: String(lorebook?.name || 'Lorebook'),
        refs: refs.map((ref) => ({
            name: String(ref?.name || ''),
            description: String(ref?.description || ''),
            matchMode: ref?.matchMode === 'always' ? 'always' : 'match',
            enabled: ref?.enabled !== false,
            group: String(ref?.group || ''),
            priority: Number.isFinite(ref?.priority) ? ref.priority : 0,
            useRegex: ref?.useRegex === true,
            secondaryKeys: String(ref?.secondaryKeys || ''),
            imageUrl: '',
        })),
    };
}

/**
 * Нормализует имя лорбука в имя файла. Убирает запрещённые символы,
 * схлопывает пробелы в underscore'ы, обрезает до 64 символов.
 */
export function lorebookFileNameFromTitle(title) {
    const base = String(title || 'lorebook')
        .normalize('NFKD')
        .replace(/[^\w\s.-]+/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 64) || 'lorebook';
    return `${base}.iig.json`;
}

/**
 * Парсит и валидирует JSON-содержимое файла лорбука. Возвращает нормализованный
 * payload `{ kind, version, name, refs }`. Бросает Error с понятным
 * сообщением если формат не подходит.
 */
export function parseLorebookJson(rawText) {
    let payload;
    try {
        payload = JSON.parse(String(rawText || ''));
    } catch (e) {
        throw new Error(t`File is not valid JSON: ${e.message || e}`);
    }
    if (!payload || typeof payload !== 'object') {
        throw new Error(t`Invalid lorebook: top-level must be an object`);
    }
    if (payload.kind !== 'iig-lorebook') {
        throw new Error(t`Invalid lorebook: "kind" field must be "iig-lorebook"`);
    }
    if (payload.version !== 1) {
        throw new Error(t`Unsupported lorebook version: ${payload.version}`);
    }
    if (!Array.isArray(payload.refs)) {
        throw new Error(t`Invalid lorebook: "refs" must be an array`);
    }
    return {
        kind: 'iig-lorebook',
        version: 1,
        name: String(payload.name || 'Imported lorebook'),
        refs: payload.refs,
    };
}

/**
 * Создаёт новый лорбук из провалидированного payload и скачивает картинки
 * для refs с непустым `imageUrl`. Возвращает статистику импорта.
 *
 * @param {{ name: string, refs: Array }} payload
 * @param {{ sourceUrl?: string }} [meta]
 * @returns {Promise<{ lorebookId: string, refsCount: number, imagesDownloaded: number, imagesFailed: number }>}
 */
export async function importLorebookFromPayload(payload, meta = {}) {
    const settings = getSettings();
    const newLorebook = createLorebook(payload.name, settings);
    newLorebook.meta = {
        sourceUrl: String(meta.sourceUrl || '').trim(),
        importedAt: Date.now(),
        version: 1,
    };

    let imagesDownloaded = 0;
    let imagesFailed = 0;

    for (let index = 0; index < payload.refs.length; index++) {
        const raw = payload.refs[index];
        const ref = {
            name: String(raw?.name || '').trim(),
            description: String(raw?.description || '').trim(),
            imagePath: '',
            matchMode: raw?.matchMode === 'always' ? 'always' : 'match',
            enabled: raw?.enabled !== false,
            group: String(raw?.group || '').trim(),
            priority: Number.parseInt(String(raw?.priority ?? 0), 10) || 0,
            useRegex: raw?.useRegex === true,
            secondaryKeys: String(raw?.secondaryKeys || ''),
        };

        const imageUrl = String(raw?.imageUrl || '').trim();
        if (imageUrl) {
            try {
                ref.imagePath = await downloadReferenceImageFromUrl(imageUrl, {
                    mode: 'lorebook-import',
                    refIndex: index,
                    refName: ref.name,
                });
                imagesDownloaded++;
            } catch (error) {
                console.error(`[IIG] Failed to download imageUrl for "${ref.name}":`, error);
                imagesFailed++;
            }
        }

        newLorebook.refs.push(ref);
    }

    saveSettings();
    return {
        lorebookId: newLorebook.id,
        refsCount: payload.refs.length,
        imagesDownloaded,
        imagesFailed,
    };
}

/**
 * Fetches JSON-content по URL, парсит, импортирует. Удобная обёртка.
 */
export async function importLorebookFromUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) throw new Error(t`URL is empty`);

    let response;
    try {
        response = await fetch(trimmed);
    } catch (e) {
        throw new Error(t`Could not reach URL: ${e.message || e}`);
    }
    if (!response.ok) {
        throw new Error(t`URL returned HTTP ${response.status}`);
    }
    const text = await response.text();
    const payload = parseLorebookJson(text);
    return importLorebookFromPayload(payload, { sourceUrl: trimmed });
}

/**
 * Читает File, парсит, импортирует.
 */
export async function importLorebookFromFile(file) {
    if (!(file instanceof File)) throw new Error(t`No file selected`);
    const text = await file.text();
    const payload = parseLorebookJson(text);
    return importLorebookFromPayload(payload);
}

/**
 * Инициирует скачивание текстового содержимого в браузере.
 * Создаёт Blob → анкер → click → cleanup.
 */
export function triggerBrowserDownload(fileName, content, mimeType = 'application/json') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Небольшая задержка чтобы Safari успел забрать blob — потом revoke.
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}
