/**
 * Lightbox-оверлей для просмотра сгенерированных картинок (.iig-generated-image)
 * в полноэкранном размере. Клик по картинке в чате открывает её в оверлее
 * поверх всего UI; закрытие — клик по бэкдропу / крестику / картинке / Esc.
 *
 * Почему не нативный viewer ST: его попросту нет — картинки в чате кликабельны
 * только через браузерный right-click "Открыть в новой вкладке".
 *
 * Критичный момент — все pointer/touch/click события внутри оверлея
 * останавливаем (stopPropagation), иначе ST-драуеры (extensions panel,
 * character drawer) ловят клик «снаружи своей области» и закрываются,
 * пока оверлей ещё поверх экрана. Юзер потом закрывает lightbox —
 * и оказывается, что ST-UI за спиной уже перекочевал в chat view.
 */

import { t } from './i18n.js';

const OVERLAY_ID = 'iig_lightbox';

/**
 * Инициализирует lightbox один раз. Повторный вызов — no-op
 * (используется флаг наличия элемента).
 */
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
        // Clear src to release memory; also стопит остаточные image decode'ы.
        imgEl.src = '';
        captionEl.textContent = '';
    };

    overlay.querySelector('.iig-lightbox-backdrop')?.addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close')?.addEventListener('click', close);
    // Клик по самой картинке — тоже закрывает (touch-friendly: тапнул где угодно).
    imgEl.addEventListener('click', close);

    // Глотаем все pointer/touch phases на оверлее, чтобы ST-драуеры не
    // ловили «клик снаружи». Pointer/mousedown критичны для desktop,
    // touch — для iOS/Android.
    const stopBubble = (e) => e.stopPropagation();
    overlay.addEventListener('touchstart', stopBubble, { passive: true });
    overlay.addEventListener('touchend', stopBubble, { passive: true });
    overlay.addEventListener('pointerdown', stopBubble);
    overlay.addEventListener('pointerup', stopBubble);
    overlay.addEventListener('mousedown', stopBubble);

    // Esc закрывает (но только если оверлей реально открыт, иначе
    // конфликтуем с другими Esc-handlers ST).
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) {
            close(e);
        }
    });

    // Делегирование: слушаем клики по #chat, ищем картинку-потомка.
    // Это переживает перерисовку сообщений / регенерацию картинок,
    // без необходимости навешивать listener на каждый <img>.
    const chatEl = document.getElementById('chat');
    chatEl?.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const img = /** @type {HTMLImageElement|null} */ (target?.closest('.iig-generated-image'));
        if (!img) return;
        // Пропускаем error-placeholders (`.iig-error-image`) — туда ходят
        // через corner-retry, а не fullscreen-просмотр.
        if (img.classList.contains('iig-error-image')) return;
        e.preventDefault();
        e.stopPropagation();
        imgEl.src = img.src;
        imgEl.alt = img.alt || '';
        captionEl.textContent = img.alt || '';
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        // Блокируем скролл body — иначе iOS Safari скроллит фон под оверлеем.
        document.body.style.overflow = 'hidden';
    });
}
