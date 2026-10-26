/**
 * Inline corner buttons on generated chat images:
 *   - successful image: Download + Regenerate
 *   - error placeholder: Retry
 *
 * Each generated <img> is wrapped in <span class="iig-img-host"> with the
 * actions div as a sibling. Wrapping is runtime-only — message storage HTML
 * is untouched. MutationObserver re-attaches after ST re-renders messages.
 */

import { t } from './i18n.js';
import { iigLog, getSettings } from './settings.js';
import { regenerateSingleTag } from './pipeline.js';
import { restoreMessageImageBindings } from './parser.js';
import { getImagePlaceholderKind } from './utils.js';

const IMG_SELECTOR = 'img[data-iig-instruction]';
const initializedChats = new WeakSet();

export function applyImageActionsStyle(settings = getSettings()) {
    const enabled = settings.imageActionsEnabled !== false;
    const rawOpacity = Number(settings.imageActionsOpacity);
    const opacity = Number.isFinite(rawOpacity)
        ? Math.max(0, Math.min(100, rawOpacity)) / 100
        : 0.8;
    document.documentElement.style.setProperty('--iig-actions-opacity', String(opacity));
    document.body.classList.toggle('iig-actions-hidden', !enabled);
}

export function initImageActions() {
    const chat = document.getElementById('chat');
    if (!chat || initializedChats.has(chat)) return;
    initializedChats.add(chat);

    applyImageActionsStyle();
    const scan = root => scanAndAttach(root).catch(error => iigLog('WARN', 'Could not refresh image controls:', error));
    scan(chat);

    chat.addEventListener('click', async (event) => {
        const img = event.target instanceof Element ? event.target.closest('img') : null;
        if (!img?.closest('.mes_text') || !getImagePlaceholderKind(img.getAttribute('src') || '')) return;
        event.preventDefault();
        event.stopPropagation();
        if (!img.hasAttribute('data-iig-instruction')) await scanAndAttach(img);
        if (img.hasAttribute('data-iig-instruction')) await regenerateOne(img);
    }, { capture: true });
    chat.addEventListener('keydown', event => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || !getImagePlaceholderKind(img.getAttribute('src') || '')) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        img.click();
    });

    const dirtyRoots = new Set();
    let scanFrame = null;
    const scheduleScan = (root) => {
        dirtyRoots.add(root.closest('.mes') || root);
        if (scanFrame !== null) return;
        scanFrame = requestAnimationFrame(() => {
            scanFrame = null;
            const roots = [...dirtyRoots];
            dirtyRoots.clear();
            for (const dirtyRoot of roots) scan(dirtyRoot);
        });
    };

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const n of m.addedNodes) {
                    if (!(n instanceof Element)) continue;
                    if (n.matches('img') || n.querySelector('img')) {
                        scheduleScan(n);
                    }
                }
            }
            if (m.type === 'attributes' && m.target instanceof HTMLImageElement && m.target.closest('.mes_text')) {
                scheduleScan(m.target);
            }
        }
    });
    observer.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'data-iig-instruction'] });
}

async function scanAndAttach(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    if (!root.isConnected) return;
    const messageRoot = root.closest('.mes');
    const messages = messageRoot ? [messageRoot] : [...root.querySelectorAll('.mes')];
    const context = SillyTavern.getContext();
    for (const messageEl of messages) {
        const messageId = Number.parseInt(messageEl.getAttribute('mesid') || '', 10);
        const message = context.chat?.[messageId];
        const mesTextEl = messageEl.querySelector('.mes_text');
        if (message && mesTextEl?.querySelector('img, video')) await restoreMessageImageBindings(message, mesTextEl);
    }
    if (!root.isConnected) return;
    if (root instanceof HTMLImageElement && root.matches?.(IMG_SELECTOR)) {
        attachActions(root);
        return;
    }
    const imgs = root.querySelectorAll?.(IMG_SELECTOR);
    if (!imgs) return;
    for (const img of imgs) {
        attachActions(img);
    }
}

function attachActions(img) {
    if (!img.src || img.src.endsWith('[IMG:GEN]')) return;

    const kind = getImagePlaceholderKind(img.getAttribute('src') || '');
    const isError = Boolean(kind);
    const wasError = img.classList.contains('iig-error-image');
    for (const [name, enabled] of [['iig-error-image', isError], ['iig-stopped-image', kind === 'stopped']]) {
        if (img.classList.contains(name) !== enabled) img.classList.toggle(name, enabled);
    }
    if (isError) {
        img.setAttribute('role', 'button');
        img.tabIndex = 0;
        if (!img.title) img.title = t`Retry`;
    } else if (wasError) {
        if (img.getAttribute('role') === 'button') img.removeAttribute('role');
        if (img.getAttribute('tabindex') === '0') img.removeAttribute('tabindex');
    }
    let host = img.parentElement;

    if (host?.classList?.contains('iig-img-host')) {
        const existing = host.querySelector(':scope > .iig-img-actions');
        if (existing && existing.dataset.iigError === (isError ? '1' : '0')) return;
        existing?.remove();
        host.appendChild(buildActions(img, isError));
        return;
    }

    host = document.createElement('span');
    host.className = 'iig-img-host';
    img.replaceWith(host);
    host.appendChild(img);
    host.appendChild(buildActions(img, isError));
}

function buildActions(img, isError) {
    const actions = document.createElement('div');
    actions.className = 'iig-img-actions';
    actions.dataset.iigError = isError ? '1' : '0';
    actions.innerHTML = isError
        ? `<button class="iig-img-action iig-img-retry" type="button" title="${t`Retry`}" aria-label="${t`Retry`}"><i class="fa-solid fa-rotate-right"></i></button>`
        : `<button class="iig-img-action iig-img-download" type="button" title="${t`Download`}" aria-label="${t`Download`}"><i class="fa-solid fa-download"></i></button>`
          + `<button class="iig-img-action iig-img-regen" type="button" title="${t`Regenerate this image`}" aria-label="${t`Regenerate this image`}"><i class="fa-solid fa-rotate-right"></i></button>`;

    const stopAll = (e) => { e.stopPropagation(); e.preventDefault(); };
    actions.addEventListener('pointerdown', (e) => e.stopPropagation());
    actions.addEventListener('click', (e) => e.stopPropagation());

    actions.querySelector('.iig-img-download')?.addEventListener('click', async (e) => {
        stopAll(e);
        await downloadImage(img);
    });
    actions.querySelector('.iig-img-regen')?.addEventListener('click', async (e) => {
        stopAll(e);
        await regenerateOne(img);
    });
    actions.querySelector('.iig-img-retry')?.addEventListener('click', async (e) => {
        stopAll(e);
        await regenerateOne(img);
    });

    return actions;
}

async function downloadImage(img) {
    const src = img.src;
    let url = src;
    let cleanup = null;
    if (!src.startsWith('data:')) {
        try {
            const resp = await fetch(src);
            const blob = await resp.blob();
            url = URL.createObjectURL(blob);
            cleanup = () => URL.revokeObjectURL(url);
        } catch (err) {
            iigLog('ERROR', 'Image download failed:', err);
            toastr.error(t`Failed to download image`, t`Image Generation`);
            return;
        }
    }
    const ext = guessExtension(src);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig_${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (cleanup) setTimeout(cleanup, 100);
}

function guessExtension(src) {
    if (src.startsWith('data:')) {
        const m = src.match(/^data:image\/([a-z0-9+]+)/i);
        if (m) return m[1].replace('jpeg', 'jpg');
    }
    const m = src.match(/\.([a-z0-9]+)(?:\?|#|$)/i);
    if (m) return m[1].toLowerCase();
    return 'png';
}

async function regenerateOne(img) {
    const messageEl = img.closest('.mes');
    if (!messageEl) {
        toastr.error(t`Could not locate message`, t`Image Generation`);
        return;
    }
    const messageId = parseInt(messageEl.getAttribute('mesid') || '', 10);
    if (Number.isNaN(messageId)) return;

    // Use the source tag index, including videos and media absent from the rendered message.
    const allMedia = Array.from(messageEl.querySelectorAll('img[data-iig-instruction], video[data-iig-instruction]'));
    const sourceIndex = Number(img.getAttribute('data-iig-tag-index') ?? NaN);
    const tagIndex = Number.isInteger(sourceIndex) && sourceIndex >= 0 ? sourceIndex : allMedia.indexOf(img);
    if (tagIndex < 0) return;

    await regenerateSingleTag(messageId, tagIndex);
}
