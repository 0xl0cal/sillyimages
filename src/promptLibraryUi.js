/** Style and negative-prompt library view state, rendering and events. */
import { getSettings, saveSettings, iigLog, ensureStyles, createStyle, updateStyle, removeStyle, getPromptLibraryActiveKey, getEffectiveNegativePrompt } from './settings.js';
import { sanitizeForHtml } from './utils.js';
import { t } from './i18n.js';
import { Popup } from '../../../../popup.js';

export function syncNegativePromptInputs(settings) {
    for (const type of ['naistera', 'novelai']) {
        const input = document.getElementById(`iig_${type}_negative_prompt`);
        if (!input) continue;
        const active = settings.apiType === type && settings.activeNegativePromptId
            && ensureStyles(settings, 'negativePrompts').some(item => item.id === settings.activeNegativePromptId)
            && (type === 'novelai' || /^novelai(?:-|$)/i.test(settings.naisteraModel));
        input.disabled = Boolean(active);
        input.title = active ? t`Disable the library prompt to edit this field.` : '';
        input.value = active ? getEffectiveNegativePrompt(settings[`${type}NegativePrompt`], settings) : settings[`${type}NegativePrompt`];
    }
}

let selectedStyleId = '';
let styleSearchQuery = '';
let styleLibraryTab = 'styles';
const styleLibraryStates = { styles: {}, negativePrompts: {} };

function activeStyleKey() { return getPromptLibraryActiveKey(styleLibraryTab); }

function getStyleLibraryLabels() {
    return styleLibraryTab === 'negativePrompts'
        ? { name: t`Negative prompt`, add: t`New negative prompt`, search: t`Search negative prompts`, none: t`Value from API settings`, empty: t`No negative prompts created.` }
        : { name: t`Style`, add: t`New style`, search: t`Search styles`, none: t`No style`, empty: t`No styles created.` };
}

function getSelectedStyle(settings = getSettings()) {
    const styles = ensureStyles(settings, styleLibraryTab);
    if (!styles.some((style) => style.id === selectedStyleId)) {
        selectedStyleId = styles.find((style) => style.id === settings[activeStyleKey()])?.id || styles[0]?.id || '';
    }
    return styles.find((style) => style.id === selectedStyleId) || null;
}

function getStylePreview(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return styleLibraryTab === 'negativePrompts' ? t`Empty negative prompt` : t`Empty style`;
    return text.length > 50 ? `${text.slice(0, 50).trimEnd()}...` : text;
}

function buildStyleListHtml(settings = getSettings()) {
    const styles = ensureStyles(settings, styleLibraryTab);
    const activeId = settings[activeStyleKey()];
    const labels = getStyleLibraryLabels();
    getSelectedStyle(settings);
    const searchHtml = styles.length > 8 || styleSearchQuery ? `
        <label class="iig-style-search-wrap">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input id="iig_style_search" class="text_pole" type="search" value="${sanitizeForHtml(styleSearchQuery)}" placeholder="${labels.search}">
        </label>` : '';
    const rowsHtml = styles.map((style) => `
        <div class="iig-style-item ${style.id === activeId ? 'active' : ''} ${style.id === selectedStyleId ? 'selected' : ''}" data-style-id="${sanitizeForHtml(style.id)}" data-style-search="${sanitizeForHtml(`${style.name} ${style.value}`.toLowerCase())}">
            <button type="button" class="menu_button iig-style-activation" data-style-activate="${sanitizeForHtml(style.id)}" title="${style.id === activeId ? t`Disable` : t`Activate`}">
                <i class="fa-solid ${style.id === activeId ? 'fa-circle-check' : 'fa-circle'}"></i>
            </button>
            <button type="button" class="menu_button iig-style-item-select" data-style-select="${sanitizeForHtml(style.id)}">
                <strong>${sanitizeForHtml(style.name)}</strong>
                <small>${sanitizeForHtml(getStylePreview(style.value))}</small>
            </button>
            <div class="iig-style-item-actions">
                <button type="button" class="menu_button" data-style-duplicate="${sanitizeForHtml(style.id)}" title="${t`Duplicate`}"><i class="fa-solid fa-copy"></i></button>
                <button type="button" class="menu_button redWarningBG" data-style-remove="${sanitizeForHtml(style.id)}" title="${t`Delete`}"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`).join('');

    return `
        ${searchHtml}
        <div class="iig-style-list">
            <button type="button" class="menu_button iig-style-none" data-style-disable aria-pressed="${!activeId}">
                <i class="fa-solid fa-ban"></i>
                <span>${labels.none}</span>
            </button>
            ${rowsHtml ? `${rowsHtml}<div class="iig-library-empty iig-style-search-empty iig-hidden" role="status">${t`Nothing found.`}</div>` : `<div class="iig-library-empty">${labels.empty}</div>`}
        </div>`;
}

function buildStyleEditorHtml(settings = getSettings()) {
    const selectedStyle = getSelectedStyle(settings);
    if (!selectedStyle) {
        return `<div class="iig-library-empty iig-style-editor-empty">${getStyleLibraryLabels().empty}</div>`;
    }
    const isActive = selectedStyle.id === settings[activeStyleKey()];

    return `
        <div class="iig-style-editor-content" data-style-editor-id="${sanitizeForHtml(selectedStyle.id)}">
            <div class="iig-style-editor-status ${isActive ? 'active' : ''}">
                <i class="fa-solid ${isActive ? 'fa-circle-check' : 'fa-circle'}"></i>
                <span>${isActive ? t`Active` : t`Inactive`}</span>
            </div>
            <label class="iig-style-field" for="iig_style_name">
                <span>${t`Name`}</span>
                <input type="text" id="iig_style_name" class="text_pole" value="${sanitizeForHtml(selectedStyle.name)}">
            </label>
            <label class="iig-style-field" for="iig_style_value">
                <span>${getStyleLibraryLabels().name}</span>
                <textarea id="iig_style_value" class="text_pole iig-settings-textarea" rows="6" placeholder="${styleLibraryTab === 'negativePrompts' ? 'lowres, bad anatomy, blurry' : 'masterpiece, cinematic lighting, painterly'}">${sanitizeForHtml(selectedStyle.value)}</textarea>
            </label>
            <div class="iig-style-editor-actions">
                <button type="button" id="iig_style_toggle_active" class="menu_button iig-button-inline">
                    <i class="fa-solid ${isActive ? 'fa-ban' : 'fa-circle-check'}"></i>
                    <span>${isActive ? t`Disable` : t`Activate`}</span>
                </button>
                <button type="button" id="iig_style_duplicate" class="menu_button iig-button-inline"><i class="fa-solid fa-copy"></i><span>${t`Duplicate`}</span></button>
                <button type="button" id="iig_style_remove" class="menu_button iig-button-inline redWarningBG"><i class="fa-solid fa-trash"></i><span>${t`Delete`}</span></button>
                <span class="iig-style-autosave"><i class="fa-solid fa-floppy-disk"></i> ${t`Autosave`}</span>
            </div>
        </div>
    `;
}

function filterStyleList() {
    const query = styleSearchQuery.trim().toLowerCase();
    let visibleCount = 0;
    document.querySelectorAll('#iig_style_presets .iig-style-item').forEach((item) => {
        const visible = !query || String(item.getAttribute('data-style-search') || '').includes(query);
        item.classList.toggle('iig-hidden', !visible);
        if (visible) visibleCount++;
    });
    document.querySelector('#iig_style_presets .iig-style-search-empty')?.classList.toggle('iig-hidden', !query || visibleCount > 0);
}

function renderSelectedStyleEditor(settings = getSettings()) {
    document.querySelectorAll('#iig_style_presets .iig-style-item').forEach((item) => {
        item.classList.toggle('selected', item.getAttribute('data-style-id') === selectedStyleId);
    });
    const editorContainer = document.getElementById('iig_style_editor');
    if (editorContainer) {
        editorContainer.innerHTML = buildStyleEditorHtml(settings);
    }
}

export function renderStyleSettings(scrollTop) {
    const settings = getSettings();
    const listContainer = document.getElementById('iig_style_presets');
    const editorContainer = document.getElementById('iig_style_editor');
    const previousScrollTop = scrollTop ?? (listContainer?.querySelector('.iig-style-list')?.scrollTop || 0);
    if (listContainer) {
        listContainer.innerHTML = buildStyleListHtml(settings);
    }
    if (editorContainer) {
        editorContainer.innerHTML = buildStyleEditorHtml(settings);
    }
    filterStyleList();
    const nextList = listContainer?.querySelector('.iig-style-list');
    if (nextList && previousScrollTop) {
        nextList.scrollTop = previousScrollTop;
    }
    document.querySelectorAll('[data-style-library]').forEach(button => {
        const selected = button.dataset.styleLibrary === styleLibraryTab;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-selected', String(selected));
    });
    const addLabel = document.querySelector('#iig_style_add span');
    if (addLabel) addLabel.textContent = getStyleLibraryLabels().add;
    const libraryTitle = document.getElementById('iig_prompt_library_title');
    if (libraryTitle) libraryTitle.textContent = styleLibraryTab === 'negativePrompts' ? t`Negative prompt library` : t`Style library`;
    syncNegativePromptInputs(settings);
}

async function createStyleFromPrompt(settings) {
    const name = await Popup.show.input(getStyleLibraryLabels().add, t`Name`);
    const normalizedName = String(name || '').trim();
    if (!normalizedName) return;
    const style = createStyle(normalizedName, styleLibraryTab);
    selectedStyleId = style.id;
    saveSettings();
    renderStyleSettings();
    iigLog('INFO', `Created style: ${style.name}`);
}

function duplicateStyleById(styleId, settings) {
    const source = ensureStyles(settings, styleLibraryTab).find((style) => style.id === styleId);
    if (!source) return;
    const copy = createStyle(t`Copy of ${source.name}`, styleLibraryTab);
    updateStyle(copy.id, { value: source.value }, styleLibraryTab);
    selectedStyleId = copy.id;
    saveSettings();
    renderStyleSettings();
}

async function deleteStyleById(styleId, settings) {
    const styles = ensureStyles(settings, styleLibraryTab);
    const index = styles.findIndex((style) => style.id === styleId);
    const style = styles[index];
    if (!style) return;
    const confirmed = await Popup.show.confirm(t`Delete "${style.name}"?`, t`Confirm`);
    if (!confirmed) return;
    removeStyle(styleId, styleLibraryTab);
    const remaining = ensureStyles(settings, styleLibraryTab);
    selectedStyleId = remaining[Math.min(index, remaining.length - 1)]?.id || '';
    saveSettings();
    renderStyleSettings();
}

export function bindStylesSectionEvents(settings) {
    document.querySelector('.iig-prompt-library-tabs')?.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-style-library]');
        const next = tab?.dataset.styleLibrary;
        if (!next || next === styleLibraryTab) return;
        styleLibraryStates[styleLibraryTab] = {
            selectedStyleId, styleSearchQuery,
            scrollTop: document.querySelector('#iig_style_presets .iig-style-list')?.scrollTop || 0,
        };
        styleLibraryTab = next;
        selectedStyleId = styleLibraryStates[next].selectedStyleId || '';
        styleSearchQuery = styleLibraryStates[next].styleSearchQuery || '';
        renderStyleSettings(styleLibraryStates[next].scrollTop || 0);
    });
    document.getElementById('iig_style_add')?.addEventListener('click', () => {
        createStyleFromPrompt(settings).catch((error) => console.warn('[IIG] Failed to create style:', error));
    });

    document.getElementById('iig_style_presets')?.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'iig_style_search') return;
        styleSearchQuery = target.value;
        filterStyleList();
    });

    document.getElementById('iig_style_presets')?.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.closest('[data-style-disable]')) {
            settings[activeStyleKey()] = '';
            saveSettings();
            renderStyleSettings();
            return;
        }
        const activateButton = target.closest('[data-style-activate]');
        if (activateButton) {
            const styleId = String(activateButton.getAttribute('data-style-activate') || '');
            selectedStyleId = styleId;
            settings[activeStyleKey()] = settings[activeStyleKey()] === styleId ? '' : styleId;
            saveSettings();
            renderStyleSettings();
            return;
        }
        const selectButton = target.closest('[data-style-select]');
        if (selectButton) {
            const nextStyleId = String(selectButton.getAttribute('data-style-select') || '');
            if (nextStyleId && nextStyleId !== selectedStyleId) {
                selectedStyleId = nextStyleId;
                renderSelectedStyleEditor(settings);
            }
            return;
        }
        const duplicateButton = target.closest('[data-style-duplicate]');
        if (duplicateButton) {
            duplicateStyleById(String(duplicateButton.getAttribute('data-style-duplicate') || ''), settings);
            return;
        }
        const removeButton = target.closest('[data-style-remove]');
        if (removeButton) {
            await deleteStyleById(String(removeButton.getAttribute('data-style-remove') || ''), settings);
        }
    });

    document.getElementById('iig_style_editor')?.addEventListener('input', (event) => {
        const selectedStyle = getSelectedStyle(settings);
        const target = event.target;
        if (!selectedStyle || !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        const updated = target.id === 'iig_style_name'
            ? updateStyle(selectedStyle.id, { name: target.value }, styleLibraryTab)
            : target.id === 'iig_style_value' ? updateStyle(selectedStyle.id, { value: target.value }, styleLibraryTab) : null;
        if (!updated) return;
        saveSettings();
        const row = [...document.querySelectorAll('#iig_style_presets .iig-style-item')]
            .find((item) => item.getAttribute('data-style-id') === selectedStyle.id);
        if (row && updated) {
            const title = row.querySelector('strong');
            const preview = row.querySelector('small');
            if (title) title.textContent = updated.name;
            if (preview) preview.textContent = getStylePreview(updated.value);
            row.setAttribute('data-style-search', `${updated.name} ${updated.value}`.toLowerCase());
            if (styleSearchQuery) filterStyleList();
        }
        if (styleLibraryTab === 'negativePrompts') syncNegativePromptInputs(settings);
    });

    document.getElementById('iig_style_editor')?.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const selectedStyle = getSelectedStyle(settings);
        if (!target || !selectedStyle) return;
        if (target.closest('#iig_style_toggle_active')) {
            settings[activeStyleKey()] = settings[activeStyleKey()] === selectedStyle.id ? '' : selectedStyle.id;
            saveSettings();
            renderStyleSettings();
            return;
        }
        if (target.closest('#iig_style_duplicate')) {
            duplicateStyleById(selectedStyle.id, settings);
            return;
        }
        if (target.closest('#iig_style_remove')) {
            await deleteStyleById(selectedStyle.id, settings);
        }
    });
}
