chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') { sendResponse({ success: true }); return; }
  if (message.action === 'sendPrompt') { handleSendPrompt(message.prompt).then(sendResponse); return true; }
  if (message.action === 'waitForImage') { handleWaitForImage(message.timeoutMs || 90000).then(sendResponse); return true; }
});

// ── Tìm input: div[contenteditable] thấp nhất (bỏ qua textarea reCAPTCHA) ──
function findInput() {
  const all = [...document.querySelectorAll('[contenteditable="true"]')];
  if (!all.length) return null;
  return all.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
}

// ── Tìm send button: rightmost button trong grandparent container của input ──
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

// ── Gửi prompt ───────────────────────────────────────────────────────────────
async function handleSendPrompt(prompt) {
  try {
    const input = findInput();
    if (!input) return { success: false, error: 'Không tìm thấy ô chat.' };

    // 1. Focus vào ô input
    input.click();
    input.focus();
    await sleep(300);

    // 2. Chọn hết nội dung cũ rồi thay bằng prompt mới — 1 thao tác execCommand
    //    Chrome vẫn hỗ trợ đầy đủ và nó fire đúng input event mà React lắng nghe
    document.execCommand('selectAll', false, null);
    await sleep(100);
    document.execCommand('insertText', false, prompt);
    await sleep(500);

    // 3. Xác nhận text đã vào
    const hasText = input.textContent?.trim().length > 0;
    if (!hasText) {
      return { success: false, error: 'execCommand không điền được text. Tab có đang active không?' };
    }

    // 4. Đợi send button enabled (tối đa 4s)
    const btnEnabled = await waitUntil(() => {
      const btn = findSendButton();
      return !!(btn && !btn.disabled);
    }, 4000);

    await sleep(200);

    // 5. Click send — chỉ 1 lần duy nhất
    const sendBtn = findSendButton();
    if (!sendBtn) return { success: false, error: 'Không tìm thấy nút send.' };
    if (sendBtn.disabled) return { success: false, error: 'Nút send vẫn bị disabled.' };

    sendBtn.click();
    await sleep(300);
    return { success: true };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Chờ ảnh generate xong ────────────────────────────────────────────────────
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
  if (!done) {
    if (!isGenerating()) return { success: true };
    return { success: false, error: 'Timeout' };
  }
  return { success: true };
}

// ── Utils ─────────────────────────────────────────────────────────────────────
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
