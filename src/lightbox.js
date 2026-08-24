/**
 * Полноэкранный просмотр сгенерированных картинок с зумом, пэном и листанием.
 */

import { t } from './i18n.js';
import { removeCharacterGeneration } from './references.js';
import { Popup } from '../../../../popup.js';

const OVERLAY_ID = 'iig_lightbox';
const IMG_SELECTOR = 'img[data-iig-instruction]:not(.iig-error-image)';
const GALLERY_IMG_SELECTOR = 'img[data-iig-lightbox]';
const OPENABLE_IMG_SELECTOR = `${IMG_SELECTOR}, ${GALLERY_IMG_SELECTOR}`;
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const ZOOM_STEP = 1.4;
const WHEEL_ZOOM_SENSITIVITY = 0.0035;
const PINCH_ZOOM_SENSITIVITY = 1.65;
const WHEEL_END_DELAY = 90;
const PAN_RESISTANCE = 0.28;
const SCALE_EPSILON = 0.001;
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
            <button class="iig-lightbox-btn iig-lightbox-delete" type="button" title="${t`Delete generation`}" aria-label="${t`Delete generation`}" hidden><i class="fa-solid fa-trash"></i></button>
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
    const deleteBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('.iig-lightbox-delete'));

    let scale = 1;
    let tx = 0;
    let ty = 0;
    let imageList = [];
    let currentIndex = 0;
    let currentSourceElement = null;
    const pointers = new Map();
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let pinchAnchorX = 0;
    let pinchAnchorY = 0;
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
    let transformFrame = 0;
    let wheelEndTimer = null;
    let lastZoomPointX = null;
    let lastZoomPointY = null;
    const geometry = {
        baseWidth: 0,
        baseHeight: 0,
        viewportWidth: 0,
        viewportHeight: 0,
        centerX: 0,
        centerY: 0,
    };

    const renderTransform = () => {
        transformFrame = 0;
        imgEl.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    };

    const applyTransform = (immediate = false) => {
        if (immediate) {
            if (transformFrame) cancelAnimationFrame(transformFrame);
            renderTransform();
            return;
        }
        if (!transformFrame) transformFrame = requestAnimationFrame(renderTransform);
    };

    const refreshGeometry = () => {
        const parent = imgEl.parentElement;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();
        geometry.baseWidth = imgEl.offsetWidth || imgEl.naturalWidth || 0;
        geometry.baseHeight = imgEl.offsetHeight || imgEl.naturalHeight || 0;
        geometry.viewportWidth = parent.clientWidth || window.innerWidth;
        geometry.viewportHeight = parent.clientHeight || window.innerHeight;
        geometry.centerX = parentRect.left + imgEl.offsetLeft + geometry.baseWidth / 2;
        geometry.centerY = parentRect.top + imgEl.offsetTop + geometry.baseHeight / 2;
    };

    const getPanBounds = (scaleValue = scale) => ({
        x: Math.max(0, (geometry.baseWidth * scaleValue - geometry.viewportWidth) / 2),
        y: Math.max(0, (geometry.baseHeight * scaleValue - geometry.viewportHeight) / 2),
    });

    const applyResistance = (value, limit) => {
        if (value > limit) return limit + (value - limit) * PAN_RESISTANCE;
        if (value < -limit) return -limit + (value + limit) * PAN_RESISTANCE;
        return value;
    };

    const clampPan = (elastic = false) => {
        if (scale <= MIN_SCALE + SCALE_EPSILON && !elastic) {
            tx = 0;
            ty = 0;
            return;
        }
        const bounds = getPanBounds();
        if (elastic) {
            tx = applyResistance(tx, bounds.x);
            ty = applyResistance(ty, bounds.y);
        } else {
            tx = Math.max(-bounds.x, Math.min(bounds.x, tx));
            ty = Math.max(-bounds.y, Math.min(bounds.y, ty));
        }
    };

    const updateZoomState = () => {
        overlay.classList.toggle('zoomed', scale > MIN_SCALE + SCALE_EPSILON);
    };

    const syncStateFromRenderedTransform = () => {
        const value = getComputedStyle(imgEl).transform;
        if (!value || value === 'none') return;
        try {
            const matrix = new DOMMatrixReadOnly(value);
            const renderedScale = Math.hypot(matrix.a, matrix.b);
            if (Number.isFinite(renderedScale) && renderedScale > 0) scale = renderedScale;
            if (Number.isFinite(matrix.e)) tx = matrix.e;
            if (Number.isFinite(matrix.f)) ty = matrix.f;
        } catch (_error) {
            // Keep the current state when the browser cannot parse the matrix.
        }
    };

    const beginInteraction = () => {
        if (!overlay.classList.contains('interacting')) {
            syncStateFromRenderedTransform();
            overlay.classList.add('interacting');
            applyTransform(true);
        }
        refreshGeometry();
    };

    const endInteraction = () => {
        if (!overlay.classList.contains('interacting')) return;
        applyTransform(true);
        overlay.classList.remove('interacting');
        // Commit the current gesture frame before animating back into bounds.
        void imgEl.offsetWidth;
        clampPan(false);
        updateZoomState();
        applyTransform(true);
    };

    const clearTapCloseTimer = () => {
        if (tapCloseTimer) {
            clearTimeout(tapCloseTimer);
            tapCloseTimer = null;
        }
    };

    const resetZoom = (animate = true) => {
        if (!animate) overlay.classList.add('interacting');
        scale = 1;
        tx = 0;
        ty = 0;
        updateZoomState();
        applyTransform(true);
        if (!animate) {
            void imgEl.offsetWidth;
            overlay.classList.remove('interacting');
        }
    };

    const clearWheelEndTimer = () => {
        if (wheelEndTimer) {
            clearTimeout(wheelEndTimer);
            wheelEndTimer = null;
        }
    };

    const zoomAtPoint = (newScale, pointX, pointY, elastic = false) => {
        newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
        if (Math.abs(newScale - scale) < SCALE_EPSILON) return;
        if (!geometry.baseWidth || !geometry.baseHeight) refreshGeometry();
        const localX = (pointX - geometry.centerX - tx) / scale;
        const localY = (pointY - geometry.centerY - ty) / scale;
        tx = pointX - geometry.centerX - localX * newScale;
        ty = pointY - geometry.centerY - localY * newScale;
        scale = newScale;
        updateZoomState();
        clampPan(elastic);
        applyTransform();
    };

    const rememberZoomPoint = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        lastZoomPointX = x;
        lastZoomPointY = y;
    };

    const zoomAtPreferredPoint = (newScale) => {
        refreshGeometry();
        const pointX = lastZoomPointX ?? geometry.centerX + tx;
        const pointY = lastZoomPointY ?? geometry.centerY + ty;
        zoomAtPoint(newScale, pointX, pointY);
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

    const collectImagesFor = (img) => {
        const gallery = img.closest('[data-iig-lightbox-gallery]');
        if (gallery) {
            return Array.from(gallery.querySelectorAll(GALLERY_IMG_SELECTOR))
                .filter((item) => item.getAttribute('src'));
        }
        return collectImagesFromChat();
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
        currentSourceElement = src;
        const caption = src.getAttribute('data-iig-lightbox-caption') || src.alt || '';
        deleteBtn.hidden = !src.getAttribute('data-iig-generation-id');
        geometry.baseWidth = 0;
        geometry.baseHeight = 0;
        imgEl.src = src.src;
        imgEl.alt = caption;
        captionEl.textContent = caption;
        pointers.clear();
        clearWheelEndTimer();
        resetZoom(false);
    };

    const openAt = (img) => {
        clearTapCloseTimer();
        clearWheelEndTimer();
        lastTapTime = 0;
        lastZoomPointX = null;
        lastZoomPointY = null;
        pointers.clear();
        imageList = collectImagesFor(img);
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
        currentSourceElement = null;
        deleteBtn.hidden = true;
        resetZoom(false);
        imageList = [];
    };

    overlay.querySelector('.iig-lightbox-backdrop')?.addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close')?.addEventListener('click', close);
    deleteBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const source = currentSourceElement;
        const generationId = String(source?.getAttribute('data-iig-generation-id') || '').trim();
        const characterKey = String(source?.getAttribute('data-iig-generation-key') || '').trim();
        if (!source || !generationId || !characterKey) return;
        const confirmed = await Popup.show.confirm(t`Delete this generation?`, t`Confirm`);
        if (!confirmed) return;
        deleteBtn.disabled = true;
        try {
            const rawPath = String(source.getAttribute('src') || '').trim();
            const resolved = new URL(rawPath, window.location.origin);
            const isLocalGeneration = resolved.origin === window.location.origin
                && resolved.pathname.startsWith('/user/images/');
            if (isLocalGeneration) {
                let localPath = resolved.pathname;
                try {
                    localPath = decodeURIComponent(localPath);
                } catch (_error) {
                    // The raw pathname is still valid when it has no encoded characters.
                }
                const context = SillyTavern.getContext();
                const response = await fetch('/api/images/delete', {
                    method: 'POST',
                    headers: context.getRequestHeaders(),
                    body: JSON.stringify({ path: localPath }),
                });
                if (!response.ok && response.status !== 404) {
                    throw new Error((await response.text().catch(() => '')) || `HTTP ${response.status}`);
                }
            }
            const removed = removeCharacterGeneration(characterKey, generationId);
            if (!removed) throw new Error(t`Generation was not found`);
            const gallery = source.closest('[data-iig-lightbox-gallery]');
            source.closest('.iig-library-generation-item')?.remove();
            imageList = gallery
                ? Array.from(gallery.querySelectorAll(GALLERY_IMG_SELECTOR)).filter((item) => item.getAttribute('src'))
                : [];
            const count = gallery?.closest('.iig-library-editor-section')?.querySelector('.iig-library-section-count');
            if (count) count.textContent = String(imageList.length);
            if (imageList.length === 0) {
                close();
            } else {
                currentIndex = Math.min(currentIndex, imageList.length - 1);
                updateNavVisibility();
                showImage(currentIndex);
            }
            toastr.success(t`Generation deleted`, t`Image Generation`);
        } catch (error) {
            console.error('[IIG] Failed to delete generation:', error);
            toastr.error(t`Failed to delete generation: ${error.message || error}`, t`Image Generation`);
        } finally {
            deleteBtn.disabled = false;
        }
    });
    overlay.querySelector('.iig-lightbox-zoom-in')?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearWheelEndTimer();
        endInteraction();
        zoomAtPreferredPoint(scale * ZOOM_STEP);
    });
    overlay.querySelector('.iig-lightbox-zoom-out')?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearWheelEndTimer();
        endInteraction();
        zoomAtPreferredPoint(scale / ZOOM_STEP);
    });
    overlay.querySelector('.iig-lightbox-zoom-reset')?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearWheelEndTimer();
        endInteraction();
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
        rememberZoomPoint(e.clientX, e.clientY);
        beginInteraction();
        const normalizedDelta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
        const factor = Math.max(0.7, Math.min(1.4, Math.exp(-normalizedDelta * WHEEL_ZOOM_SENSITIVITY)));
        zoomAtPoint(scale * factor, e.clientX, e.clientY, true);
        clearWheelEndTimer();
        wheelEndTimer = setTimeout(() => {
            wheelEndTimer = null;
            endInteraction();
        }, WHEEL_END_DELAY);
    }, { passive: false });

    imgEl.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!pointers.has(e.pointerId) && pointers.size >= 2) return;
        e.preventDefault();
        rememberZoomPoint(e.clientX, e.clientY);
        imgEl.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2) {
            clearWheelEndTimer();
            beginInteraction();
            const pts = Array.from(pointers.values());
            pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            pinchStartScale = scale;
            const midX = (pts[0].x + pts[1].x) / 2;
            const midY = (pts[0].y + pts[1].y) / 2;
            pinchAnchorX = (midX - geometry.centerX - tx) / scale;
            pinchAnchorY = (midY - geometry.centerY - ty) / scale;
            swipeActive = false;
            dragMoved = false;
        } else if (pointers.size === 1) {
            if (scale > MIN_SCALE + SCALE_EPSILON) {
                clearWheelEndTimer();
                beginInteraction();
            }
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartTx = tx;
            dragStartTy = ty;
            dragMoved = false;
            if (scale <= MIN_SCALE + SCALE_EPSILON) {
                swipeStartX = e.clientX;
                swipeStartY = e.clientY;
                swipeActive = true;
            } else {
                swipeActive = false;
            }
        }
    });

    imgEl.addEventListener('pointermove', (e) => {
        rememberZoomPoint(e.clientX, e.clientY);
        if (!pointers.has(e.pointerId)) return;
        e.preventDefault();
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2 && pinchStartDist > 0) {
            const pts = Array.from(pointers.values());
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const midX = (pts[0].x + pts[1].x) / 2;
            const midY = (pts[0].y + pts[1].y) / 2;
            const ratio = Math.max(0.01, dist / pinchStartDist);
            const targetScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale * Math.pow(ratio, PINCH_ZOOM_SENSITIVITY)));
            tx = midX - geometry.centerX - pinchAnchorX * targetScale;
            ty = midY - geometry.centerY - pinchAnchorY * targetScale;
            scale = targetScale;
            updateZoomState();
            clampPan(true);
            applyTransform();
            dragMoved = true;
        } else if (pointers.size === 1 && scale > MIN_SCALE + SCALE_EPSILON) {
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            if (Math.abs(dx) > TAP_MAX_MOVE || Math.abs(dy) > TAP_MAX_MOVE) dragMoved = true;
            tx = dragStartTx + dx;
            ty = dragStartTy + dy;
            clampPan(true);
            applyTransform();
        } else if (pointers.size === 1 && swipeActive) {
            const dx = e.clientX - swipeStartX;
            const dy = e.clientY - swipeStartY;
            if (Math.abs(dx) > TAP_MAX_MOVE || Math.abs(dy) > TAP_MAX_MOVE) dragMoved = true;
        }
    });

    const onPointerUp = (e) => {
        if (!pointers.has(e.pointerId)) return;
        const canceled = e.type === 'pointercancel';
        const wasMulti = pointers.size >= 2;
        pointers.delete(e.pointerId);
        if (imgEl.hasPointerCapture(e.pointerId)) imgEl.releasePointerCapture(e.pointerId);

        if (wasMulti) {
            pinchStartDist = 0;
            swipeActive = false;
            const remaining = Array.from(pointers.values())[0];
            if (remaining && !canceled) {
                dragStartX = remaining.x;
                dragStartY = remaining.y;
                dragStartTx = tx;
                dragStartTy = ty;
                dragMoved = true;
            } else {
                endInteraction();
            }
            return;
        }

        if (canceled) {
            swipeActive = false;
            endInteraction();
            return;
        }

        if (swipeActive && scale <= MIN_SCALE + SCALE_EPSILON && imageList.length > 1) {
            const dx = e.clientX - swipeStartX;
            const dy = e.clientY - swipeStartY;
            if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                showImage(currentIndex + (dx < 0 ? 1 : -1));
                swipeActive = false;
                return;
            }
        }
        swipeActive = false;

        if (!dragMoved && scale <= MIN_SCALE + SCALE_EPSILON) {
            const now = Date.now();
            if (now - lastTapTime < DOUBLE_TAP_MS) {
                clearTapCloseTimer();
                refreshGeometry();
                zoomAtPoint(2, e.clientX, e.clientY);
                lastTapTime = 0;
            } else {
                lastTapTime = now;
                clearTapCloseTimer();
                tapCloseTimer = setTimeout(() => {
                    tapCloseTimer = null;
                    if (scale <= MIN_SCALE + SCALE_EPSILON && overlay.classList.contains('open')) {
                        close();
                    }
                }, DOUBLE_TAP_MS);
            }
        } else if (!dragMoved && scale > MIN_SCALE + SCALE_EPSILON) {
            const now = Date.now();
            if (now - lastTapTime < DOUBLE_TAP_MS) {
                endInteraction();
                resetZoom();
                lastTapTime = 0;
            } else {
                lastTapTime = now;
                endInteraction();
            }
        } else {
            endInteraction();
        }
    };

    imgEl.addEventListener('pointerup', onPointerUp);
    imgEl.addEventListener('pointercancel', onPointerUp);
    imgEl.addEventListener('contextmenu', (e) => {
        clearTapCloseTimer();
        lastTapTime = 0;
        e.stopPropagation();
    });

    imgEl.addEventListener('load', () => {
        refreshGeometry();
        clampPan(false);
        applyTransform(true);
    });

    const handleViewportResize = () => {
        if (!overlay.classList.contains('open')) return;
        refreshGeometry();
        clampPan(false);
        applyTransform(true);
    };
    window.addEventListener('resize', handleViewportResize, { passive: true });
    window.visualViewport?.addEventListener('resize', handleViewportResize, { passive: true });

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
        } else if (e.key === 'ArrowLeft' && scale <= MIN_SCALE + SCALE_EPSILON) {
            e.preventDefault();
            showImage(currentIndex - 1);
        } else if (e.key === 'ArrowRight' && scale <= MIN_SCALE + SCALE_EPSILON) {
            e.preventDefault();
            showImage(currentIndex + 1);
        } else if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            clearWheelEndTimer();
            endInteraction();
            zoomAtPreferredPoint(scale * ZOOM_STEP);
        } else if (e.key === '-') {
            e.preventDefault();
            clearWheelEndTimer();
            endInteraction();
            zoomAtPreferredPoint(scale / ZOOM_STEP);
        } else if (e.key === '0') {
            e.preventDefault();
            clearWheelEndTimer();
            endInteraction();
            resetZoom();
        }
    });

    // Document-level delegation so we survive any rebuild of #chat.
    document.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const img = /** @type {HTMLImageElement|null} */ (target?.closest(OPENABLE_IMG_SELECTOR));
        if (!img) return;
        if (!img.closest('#chat') && !img.closest('[data-iig-lightbox-gallery]')) return;
        if (img.classList.contains('iig-error-image')) return;
        const rawSrc = img.getAttribute('src') || '';
        if (!rawSrc || rawSrc.endsWith('[IMG:GEN]')) return;
        e.preventDefault();
        e.stopPropagation();
        openAt(img);
    });
}
