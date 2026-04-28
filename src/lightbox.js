/**
 * Полноэкранный просмотр сгенерированных картинок с зумом, пэном и листанием.
 */

import { t } from './i18n.js';

const OVERLAY_ID = 'iig_lightbox';
const IMG_SELECTOR = 'img[data-iig-instruction]:not(.iig-error-image)';
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const ZOOM_STEP = 1.4;
const SWIPE_THRESHOLD = 60;
const TAP_MAX_MOVE = 10;
const DOUBLE_TAP_MS = 300;

export function initLightbox() {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'iig-lightbox';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
        <div class="iig-lightbox-backdrop"></div>
        <div class="iig-lightbox-toolbar">
            <button class="iig-lightbox-btn iig-lightbox-zoom-out" type="button" title="${t`Zoom out`}" aria-label="${t`Zoom out`}"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
            <button class="iig-lightbox-btn iig-lightbox-zoom-reset" type="button" title="${t`Reset zoom`}" aria-label="${t`Reset zoom`}"><i class="fa-solid fa-compress"></i></button>
            <button class="iig-lightbox-btn iig-lightbox-zoom-in" type="button" title="${t`Zoom in`}" aria-label="${t`Zoom in`}"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
            <button class="iig-lightbox-btn iig-lightbox-close" type="button" title="${t`Close`}" aria-label="${t`Close`}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <button class="iig-lightbox-nav iig-lightbox-prev" type="button" title="${t`Previous`}" aria-label="${t`Previous`}"><i class="fa-solid fa-chevron-left"></i></button>
        <button class="iig-lightbox-nav iig-lightbox-next" type="button" title="${t`Next`}" aria-label="${t`Next`}"><i class="fa-solid fa-chevron-right"></i></button>
        <div class="iig-lightbox-content">
            <img class="iig-lightbox-img" src="" alt="" draggable="false">
            <div class="iig-lightbox-caption"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const imgEl = /** @type {HTMLImageElement} */ (overlay.querySelector('.iig-lightbox-img'));
    const captionEl = /** @type {HTMLElement} */ (overlay.querySelector('.iig-lightbox-caption'));
    const prevBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('.iig-lightbox-prev'));
    const nextBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('.iig-lightbox-next'));

    let scale = 1;
    let tx = 0;
    let ty = 0;
    let imageList = [];
    let currentIndex = 0;
    const pointers = new Map();
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let pinchStartTx = 0;
    let pinchStartTy = 0;
    let pinchMidX = 0;
    let pinchMidY = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartTx = 0;
    let dragStartTy = 0;
    let dragMoved = false;
    let lastTapTime = 0;
    let tapCloseTimer = null;
    let swipeStartX = 0;
    let swipeStartY = 0;
    let swipeActive = false;

    const applyTransform = () => {
        imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };

    // Use element's layout size (pre-transform) to compute pan bounds —
    // getBoundingClientRect reflects the old transform until applyTransform runs.
    const clampPan = () => {
        if (scale <= 1) {
            tx = 0;
            ty = 0;
            return;
        }
        const baseW = imgEl.offsetWidth || imgEl.naturalWidth || 0;
        const baseH = imgEl.offsetHeight || imgEl.naturalHeight || 0;
        const parent = imgEl.parentElement;
        const pw = parent?.clientWidth || window.innerWidth;
        const ph = parent?.clientHeight || window.innerHeight;
        const overflowX = Math.max(0, (baseW * scale - pw) / 2);
        const overflowY = Math.max(0, (baseH * scale - ph) / 2);
        tx = Math.max(-overflowX, Math.min(overflowX, tx));
        ty = Math.max(-overflowY, Math.min(overflowY, ty));
    };

    const clearTapCloseTimer = () => {
        if (tapCloseTimer) {
            clearTimeout(tapCloseTimer);
            tapCloseTimer = null;
        }
    };

    const resetZoom = () => {
        scale = 1;
        tx = 0;
        ty = 0;
        overlay.classList.remove('zoomed');
        applyTransform();
    };

    const zoomAtPoint = (newScale, pointX, pointY) => {
        newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
        if (newScale === scale) return;
        const rect = imgEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const factor = newScale / scale;
        tx = pointX - cx - factor * (pointX - cx - tx);
        ty = pointY - cy - factor * (pointY - cy - ty);
        scale = newScale;
        // Toggle class BEFORE applyTransform so CSS transition state matches the
        // first rendered frame (avoids pinch stutter on the first move).
        overlay.classList.toggle('zoomed', scale > 1);
        clampPan();
        applyTransform();
    };

    const zoomAtCenter = (newScale) => {
        const rect = imgEl.getBoundingClientRect();
        zoomAtPoint(newScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
    };

    const collectImagesFromChat = () => {
        const chat = document.getElementById('chat');
        if (!chat) return [];
        return Array.from(chat.querySelectorAll(IMG_SELECTOR)).filter((img) => {
            // Use raw attribute, not resolved .src — empty src resolves to page URL.
            const raw = img.getAttribute('src') || '';
            return raw && !raw.endsWith('[IMG:GEN]');
        });
    };

    const updateNavVisibility = () => {
        const multi = imageList.length > 1;
        prevBtn.style.display = multi ? '' : 'none';
        nextBtn.style.display = multi ? '' : 'none';
    };

    const showImage = (idx) => {
        if (imageList.length === 0) return;
        currentIndex = (idx + imageList.length) % imageList.length;
        const src = imageList[currentIndex];
        imgEl.src = src.src;
        imgEl.alt = src.alt || '';
        captionEl.textContent = src.alt || '';
        resetZoom();
    };

    const openAt = (img) => {
        clearTapCloseTimer();
        lastTapTime = 0;
        imageList = collectImagesFromChat();
        currentIndex = Math.max(0, imageList.findIndex((x) => x === img));
        if (currentIndex < 0) {
            imageList = [img];
            currentIndex = 0;
        }
        updateNavVisibility();
        showImage(currentIndex);
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    };

    const close = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        clearTapCloseTimer();
        lastTapTime = 0;
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        imgEl.src = '';
        captionEl.textContent = '';
        resetZoom();
        imageList = [];
    };

    overlay.querySelector('.iig-lightbox-backdrop')?.addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close')?.addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-zoom-in')?.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomAtCenter(scale * ZOOM_STEP);
    });
    overlay.querySelector('.iig-lightbox-zoom-out')?.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomAtCenter(scale / ZOOM_STEP);
    });
    overlay.querySelector('.iig-lightbox-zoom-reset')?.addEventListener('click', (e) => {
        e.stopPropagation();
        resetZoom();
    });
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showImage(currentIndex - 1);
    });
    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showImage(currentIndex + 1);
    });

    imgEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        zoomAtPoint(scale * delta, e.clientX, e.clientY);
    }, { passive: false });

    imgEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        imgEl.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2) {
            const pts = Array.from(pointers.values());
            pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            pinchStartScale = scale;
            pinchStartTx = tx;
            pinchStartTy = ty;
            pinchMidX = (pts[0].x + pts[1].x) / 2;
            pinchMidY = (pts[0].y + pts[1].y) / 2;
            swipeActive = false;
            dragMoved = false;
        } else if (pointers.size === 1) {
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartTx = tx;
            dragStartTy = ty;
            dragMoved = false;
            if (scale === 1) {
                swipeStartX = e.clientX;
                swipeStartY = e.clientY;
                swipeActive = true;
            } else {
                swipeActive = false;
            }
        }
    });

    imgEl.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2) {
            const pts = Array.from(pointers.values());
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const midX = (pts[0].x + pts[1].x) / 2;
            const midY = (pts[0].y + pts[1].y) / 2;
            const targetScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale * (dist / pinchStartDist)));
            const rect = imgEl.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const factor = targetScale / pinchStartScale;
            tx = midX - cx - factor * (pinchMidX - cx - pinchStartTx);
            ty = midY - cy - factor * (pinchMidY - cy - pinchStartTy);
            scale = targetScale;
            overlay.classList.toggle('zoomed', scale > 1);
            clampPan();
            applyTransform();
            dragMoved = true;
        } else if (pointers.size === 1 && scale > 1) {
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            if (Math.abs(dx) > TAP_MAX_MOVE || Math.abs(dy) > TAP_MAX_MOVE) dragMoved = true;
            tx = dragStartTx + dx;
            ty = dragStartTy + dy;
            clampPan();
            applyTransform();
        } else if (pointers.size === 1 && swipeActive) {
            const dx = e.clientX - swipeStartX;
            const dy = e.clientY - swipeStartY;
            if (Math.abs(dx) > TAP_MAX_MOVE || Math.abs(dy) > TAP_MAX_MOVE) dragMoved = true;
        }
    });

    const onPointerUp = (e) => {
        if (!pointers.has(e.pointerId)) return;
        const wasMulti = pointers.size >= 2;
        pointers.delete(e.pointerId);

        if (wasMulti) {
            pinchStartDist = 0;
            swipeActive = false;
            return;
        }

        if (swipeActive && scale === 1 && imageList.length > 1) {
            const dx = e.clientX - swipeStartX;
            const dy = e.clientY - swipeStartY;
            if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                showImage(currentIndex + (dx < 0 ? 1 : -1));
                swipeActive = false;
                return;
            }
        }
        swipeActive = false;

        if (!dragMoved && scale === 1) {
            const now = Date.now();
            if (now - lastTapTime < DOUBLE_TAP_MS) {
                clearTapCloseTimer();
                zoomAtPoint(2, e.clientX, e.clientY);
                lastTapTime = 0;
            } else {
                lastTapTime = now;
                clearTapCloseTimer();
                tapCloseTimer = setTimeout(() => {
                    tapCloseTimer = null;
                    if (scale === 1 && overlay.classList.contains('open')) {
                        close();
                    }
                }, DOUBLE_TAP_MS);
            }
        } else if (!dragMoved && scale > 1) {
            const now = Date.now();
            if (now - lastTapTime < DOUBLE_TAP_MS) {
                resetZoom();
                lastTapTime = 0;
            } else {
                lastTapTime = now;
            }
        }
    };

    imgEl.addEventListener('pointerup', onPointerUp);
    imgEl.addEventListener('pointercancel', onPointerUp);

    const stopBubble = (e) => e.stopPropagation();
    overlay.addEventListener('touchstart', stopBubble, { passive: true });
    overlay.addEventListener('touchend', stopBubble, { passive: true });
    overlay.addEventListener('pointerdown', stopBubble);
    overlay.addEventListener('pointerup', stopBubble);
    overlay.addEventListener('mousedown', stopBubble);

    document.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('open')) return;
        if (e.key === 'Escape') {
            close(e);
        } else if (e.key === 'ArrowLeft' && scale === 1) {
            e.preventDefault();
            showImage(currentIndex - 1);
        } else if (e.key === 'ArrowRight' && scale === 1) {
            e.preventDefault();
            showImage(currentIndex + 1);
        } else if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            zoomAtCenter(scale * ZOOM_STEP);
        } else if (e.key === '-') {
            e.preventDefault();
            zoomAtCenter(scale / ZOOM_STEP);
        } else if (e.key === '0') {
            e.preventDefault();
            resetZoom();
        }
    });

    // Document-level delegation so we survive any rebuild of #chat.
    document.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const img = /** @type {HTMLImageElement|null} */ (target?.closest(IMG_SELECTOR));
        if (!img) return;
        if (!img.closest('#chat')) return;
        if (img.classList.contains('iig-error-image')) return;
        const rawSrc = img.getAttribute('src') || '';
        if (!rawSrc || rawSrc.endsWith('[IMG:GEN]')) return;
        e.preventDefault();
        e.stopPropagation();
        openAt(img);
    });
}
