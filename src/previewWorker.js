/** One decoded preview per worker, independent of document rendering deadlines. */
let paused = false;
const waiters = new Set();
const waitForIdle = () => paused ? new Promise(resolve => waiters.add(resolve)) : undefined;

self.onmessage = async ({ data }) => {
    if ('paused' in data) {
        paused = data.paused;
        if (!paused) { for (const resume of waiters) resume(); waiters.clear(); }
        return;
    }
    let bitmap, canvas;
    try {
        await waitForIdle();
        bitmap = await createImageBitmap(data.blob, { resizeWidth: data.width, resizeQuality: 'high' });
        await waitForIdle();
        const width = Math.max(1, Math.min(data.width, bitmap.width, Math.round(bitmap.width * 1024 / bitmap.height)));
        const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
        canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        self.postMessage({ id: data.id, blob, pixels: width * height });
    } catch (error) {
        self.postMessage({ id: data.id, error: String(error) });
    } finally {
        bitmap?.close();
        if (canvas) canvas.width = canvas.height = 0;
    }
};
