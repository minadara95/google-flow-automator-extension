chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') { sendResponse({ success: true }); return; }
  if (message.action === 'sendPrompt') { handleSendPrompt(message.prompt).then(sendResponse); return true; }
  if (message.action === 'waitForImage') { handleWaitForImage(message.timeoutMs || 90000).then(sendResponse); return true; }
});

function findInput() {
  const all = [...document.querySelectorAll('[contenteditable="true"]')];
  if (!all.length) return null;
  return all.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
}

function findSendButton() {
  const input = findInput();
  if (!input) return null;
  const container = input.parentElement?.parentElement;
  if (!container) return null;
  const btns = [...container.querySelectorAll('button')].filter(isVisible);
  if (!btns.length) return null;
  return btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
}

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 &&
    getComputedStyle(el).visibility !== 'hidden' &&
    getComputedStyle(el).display !== 'none';
}

// ── Paste text vào contenteditable qua ClipboardEvent ────────
// execCommand cần keyboard focus thật (bị block khi popup đang mở).
// ClipboardEvent paste không cần keyboard focus — React xử lý được.
function pasteText(el, text) {
  el.focus();

  // Chọn toàn bộ nội dung hiện tại trong element (không dùng selectAll toàn trang)
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  // Tạo DataTransfer với text mới, fire paste event
  // React lắng nghe onPaste và cập nhật state từ clipboardData
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  dt.setData('text', text);

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });

  const handled = el.dispatchEvent(pasteEvent);
  return handled;
}

async function handleSendPrompt(prompt) {
  try {
    const input = findInput();
    if (!input) return { success: false, error: 'Không tìm thấy ô chat.' };

    // Paste prompt vào ô input (thay thế nội dung cũ nếu có)
    input.click();
    input.focus();
    await sleep(200);

    pasteText(input, prompt);
    await sleep(600);

    // Kiểm tra text đã vào chưa
    const hasText = input.textContent?.trim().length > 0;
    if (!hasText) {
      return { success: false, error: 'Paste không thành công — Google Flow có thể đã thay đổi cách xử lý input.' };
    }

    // Đợi send button enabled
    await waitUntil(() => {
      const btn = findSendButton();
      return !!(btn && !btn.disabled);
    }, 4000);
    await sleep(200);

    const sendBtn = findSendButton();
    if (!sendBtn || sendBtn.disabled) {
      return { success: false, error: `Nút send vẫn disabled sau khi paste. Text hiện tại: "${input.textContent?.slice(0, 50)}"` };
    }

    sendBtn.click();
    await sleep(300);
    return { success: true };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Chờ ảnh generate xong ────────────────────────────────────
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
