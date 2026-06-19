// Content script chỉ dùng cho ping check và waitForImage.
// Typing được xử lý trong popup.js qua executeScript({ world: 'MAIN' }).

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ success: true });
    return;
  }
  if (message.action === 'waitForImage') {
    handleWaitForImage(message.timeoutMs || 90000).then(sendResponse);
    return true;
  }
});

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 &&
    getComputedStyle(el).visibility !== 'hidden' &&
    getComputedStyle(el).display !== 'none';
}

function countImages() {
  return document.querySelectorAll(
    'img[src*="googleusercontent"], img[src*="generatedimages"], img[src*="aisandbox"], [class*="generated"] img, [class*="result"] img'
  ).length;
}

function isGenerating() {
  for (const sel of ['[class*="loading"]', '[class*="spinner"]', '[class*="generating"]', '[role="progressbar"]']) {
    try { const el = document.querySelector(sel); if (el && isVisible(el)) return true; } catch (_) {}
  }
  return false;
}

async function handleWaitForImage(timeoutMs) {
  const before = countImages();
  await waitUntil(() => isGenerating(), 8000);
  const done = await waitUntil(() => countImages() > before && !isGenerating(), timeoutMs);
  if (!done && !isGenerating()) return { success: true };
  if (!done) return { success: false, error: 'Timeout' };
  return { success: true };
}

function waitUntil(fn, ms, interval = 300) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (fn()) { clearInterval(id); resolve(true); }
      else if (Date.now() - t0 >= ms) { clearInterval(id); resolve(false); }
    }, interval);
  });
}
