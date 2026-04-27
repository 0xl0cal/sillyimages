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
import { iigLog } from './settings.js';
import { regenerateSingleTag } from './pipeline.js';

const IMG_SELECTOR = 'img[data-iig-instruction]';

export function initImageActions() {
    const chat = document.getElementById('chat');
    if (!chat) return;

    scanAndAttach(chat);

    const observer = new MutationObserver((mutations) => {
        const dirty = new Set();
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const n of m.addedNodes) {
                    if (n instanceof Element) dirty.add(n);
                }
            }
            if (m.type === 'attributes' && m.target instanceof Element) {
                dirty.add(m.target);
            }
        }
        for (const el of dirty) {
            scanAndAttach(el);
        }
    });
    observer.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
}

function scanAndAttach(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
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

    const isError = img.classList.contains('iig-error-image');
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

    // tagIndex = position among raw IMG_SELECTOR (DOM order, ignoring our wrappers)
    const allImgs = Array.from(messageEl.querySelectorAll(IMG_SELECTOR));
    const tagIndex = allImgs.indexOf(img);
    if (tagIndex < 0) return;

    await regenerateSingleTag(messageId, tagIndex);
}
