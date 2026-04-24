/**
 * Полноэкранный просмотр сгенерированных картинок по клику.
 */

import { t } from './i18n.js';

const OVERLAY_ID = 'iig_lightbox';

export function initLightbox() {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'iig-lightbox';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
        <div class="iig-lightbox-backdrop"></div>
        <button class="iig-lightbox-close" type="button" title="${t`Close`}" aria-label="${t`Close`}">
            <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="iig-lightbox-content">
            <img class="iig-lightbox-img" src="" alt="">
            <div class="iig-lightbox-caption"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const imgEl = /** @type {HTMLImageElement} */ (overlay.querySelector('.iig-lightbox-img'));
    const captionEl = /** @type {HTMLElement} */ (overlay.querySelector('.iig-lightbox-caption'));

    const close = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        imgEl.src = '';
        captionEl.textContent = '';
    };

    overlay.querySelector('.iig-lightbox-backdrop')?.addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close')?.addEventListener('click', close);
    imgEl.addEventListener('click', close);

    // stopPropagation, чтобы ST-драуеры не ловили «клик снаружи».
    const stopBubble = (e) => e.stopPropagation();
    overlay.addEventListener('touchstart', stopBubble, { passive: true });
    overlay.addEventListener('touchend', stopBubble, { passive: true });
    overlay.addEventListener('pointerdown', stopBubble);
    overlay.addEventListener('pointerup', stopBubble);
    overlay.addEventListener('mousedown', stopBubble);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) {
            close(e);
        }
    });

    // Маркер наших картинок — data-iig-instruction (сохраняется после персиста,
    // в отличие от класса iig-generated-image, который ставится только на
    // DOM-элемент во время генерации).
    const chatEl = document.getElementById('chat');
    chatEl?.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const img = /** @type {HTMLImageElement|null} */ (
            target?.closest('img[data-iig-instruction]')
        );
        if (!img) return;
        if (img.classList.contains('iig-error-image')) return;
        if (!img.src || img.src.endsWith('[IMG:GEN]')) return;
        e.preventDefault();
        e.stopPropagation();
        imgEl.src = img.src;
        imgEl.alt = img.alt || '';
        captionEl.textContent = img.alt || '';
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    });
}
