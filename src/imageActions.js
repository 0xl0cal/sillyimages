/**
 * Floating corner-buttons over generated images: download / regenerate (single)
 * for successful images, retry-only for error placeholders.
 */

import { t } from './i18n.js';
import { iigLog } from './settings.js';
import { regenerateSingleTag } from './pipeline.js';

const OVERLAY_ID = 'iig_image_actions';
const IMG_SELECTOR = 'img[data-iig-instruction]';

export function initImageActions() {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'iig-image-actions';
    overlay.innerHTML = `
        <button class="iig-img-action iig-img-download" type="button" title="${t`Download`}" aria-label="${t`Download`}"><i class="fa-solid fa-download"></i></button>
        <button class="iig-img-action iig-img-regen" type="button" title="${t`Regenerate this image`}" aria-label="${t`Regenerate this image`}"><i class="fa-solid fa-rotate-right"></i></button>
        <button class="iig-img-action iig-img-retry" type="button" title="${t`Retry`}" aria-label="${t`Retry`}"><i class="fa-solid fa-rotate-right"></i></button>
    `;
    document.body.appendChild(overlay);

    let currentImg = null;
    let hideTimer = null;

    const positionOver = (img) => {
        const rect = img.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        // Top-right inset by 8px
        overlay.style.top = `${Math.max(8, rect.top + 8)}px`;
        overlay.style.left = `${Math.max(8, rect.right - overlay.offsetWidth - 8)}px`;
    };

    const showFor = (img) => {
        clearTimeout(hideTimer);
        currentImg = img;
        const isError = img.classList.contains('iig-error-image');
        overlay.classList.toggle('iig-error-mode', isError);
        overlay.classList.add('open');
        // Force layout for offsetWidth before positioning
        overlay.style.visibility = 'hidden';
        requestAnimationFrame(() => {
            positionOver(img);
            overlay.style.visibility = '';
        });
    };

    const hide = () => {
        currentImg = null;
        overlay.classList.remove('open');
    };

    const scheduleHide = () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 200);
    };

    document.addEventListener('pointerover', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const img = /** @type {HTMLImageElement|null} */ (target?.closest(IMG_SELECTOR));
        if (!img || !img.closest('#chat')) return;
        if (!img.src || img.src.endsWith('[IMG:GEN]')) return;
        showFor(img);
    });

    document.addEventListener('pointerout', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const img = target?.closest(IMG_SELECTOR);
        if (!img) return;
        scheduleHide();
    });

    overlay.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    overlay.addEventListener('pointerleave', scheduleHide);

    // Reposition on scroll/resize while overlay is open.
    const reposition = () => { if (currentImg && overlay.classList.contains('open')) positionOver(currentImg); };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    overlay.querySelector('.iig-img-download')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!currentImg) return;
        await downloadImage(currentImg);
    });
    overlay.querySelector('.iig-img-regen')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!currentImg) return;
        const ref = currentImg;
        hide();
        await regenerateOne(ref);
    });
    overlay.querySelector('.iig-img-retry')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!currentImg) return;
        const ref = currentImg;
        hide();
        await regenerateOne(ref);
    });
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

    const allImgs = Array.from(messageEl.querySelectorAll(IMG_SELECTOR));
    const tagIndex = allImgs.indexOf(img);
    if (tagIndex < 0) return;

    await regenerateSingleTag(messageId, tagIndex);
}
