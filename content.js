// Ping handler — kiểm tra script đã inject chưa
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ success: true });
    return;
  }
  if (message.action === 'sendPrompt') {
    handleSendPrompt(message.prompt).then(sendResponse);
    return true;
  }
  if (message.action === 'waitForImage') {
    handleWaitForImage(message.timeoutMs || 90000).then(sendResponse);
    return true;
  }
});

// ── Tìm ô input ──────────────────────────────────────────────
function findInput() {
  // Ưu tiên textarea/input thật
  const textareas = [...document.querySelectorAll('textarea, input[type="text"]')];
  for (const el of textareas) {
    if (isVisible(el)) return el;
  }
  // Fallback: contenteditable
  const editables = [...document.querySelectorAll('[contenteditable="true"]')];
  for (const el of editables) {
    if (isVisible(el)) return el;
  }
  return null;
}

// ── Tìm nút Send ─────────────────────────────────────────────
function findSendButton() {
  const input = findInput();

  if (input) {
    // Đi ngược lên DOM tìm container chứa cả input lẫn send button
    let container = input.parentElement;
    for (let i = 0; i < 6; i++) {
      if (!container) break;
      const btns = [...container.querySelectorAll('button')].filter(b => isVisible(b) && !b.disabled && b.querySelector('svg'));
      if (btns.length > 0) {
        // Lấy button ở phải nhất trong container đó (send arrow)
        return btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
      }
      container = container.parentElement;
    }
  }

  // Fallback: button nằm SAT cạnh ô input (khoảng cách ngang < 100px)
  if (input) {
    const inputRect = input.getBoundingClientRect();
    const allBtns = [...document.querySelectorAll('button')];
    const nearby = allBtns.filter(btn => {
      if (!isVisible(btn) || btn.disabled) return false;
      const r = btn.getBoundingClientRect();
      // Cùng hàng ngang với input và nằm bên phải
      return Math.abs(r.top - inputRect.top) < 60 && r.left >= inputRect.right - 20;
    });
    if (nearby.length > 0) {
      return nearby.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    }
  }

  return null;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 &&
    getComputedStyle(el).visibility !== 'hidden' &&
    getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).opacity !== '0';
}

// ── Xóa nội dung input đúng cách với React ───────────────────
async function clearInput(el) {
  el.focus();
  await sleep(100);

  if (el.isContentEditable) {
    // Select all rồi delete để React nhận sự kiện xóa
    document.execCommand('selectAll', false, null);
    await sleep(50);
    document.execCommand('delete', false, null);
  } else {
    // textarea / input: dùng native setter để bypass React
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await sleep(100);
}

// ── Gõ text vào input — mô phỏng typing để React nhận onChange ──
async function typeIntoInput(el, text) {
  el.focus();
  await sleep(100);

  if (el.isContentEditable) {
    // execCommand('insertText') là cách duy nhất React contenteditable nhận được
    document.execCommand('insertText', false, text);

    // Nếu execCommand không hoạt động (một số trình duyệt block), fallback clipboard
    if (el.textContent.trim() === '') {
      await pasteViaClipboard(el, text);
    }
  } else {
    // textarea: native setter + React synthetic event
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;

    // Trigger đầy đủ các sự kiện React lắng nghe
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
  }
}

// Fallback: dùng Clipboard API để paste
async function pasteViaClipboard(el, text) {
  try {
    await navigator.clipboard.writeText(text);
    el.focus();
    document.execCommand('paste');
  } catch (_) {
    // Clipboard bị block — thử DataTransfer
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    }));
  }
}

// ── Gửi prompt chính ─────────────────────────────────────────
async function handleSendPrompt(prompt) {
  try {
    const input = findInput();
    if (!input) {
      return { success: false, error: 'Không tìm thấy ô input. Hãy đảm bảo tab Google Flow đang mở đúng project.' };
    }

    // 1. Xóa nội dung cũ nếu có
    await clearInput(input);
    await sleep(200);

    // 2. Gõ prompt mới
    await typeIntoInput(input, prompt);
    await sleep(300);

    // 3. Kiểm tra nội dung đã vào chưa
    const content = input.isContentEditable ? input.textContent : input.value;
    if (!content || content.trim() === '') {
      return { success: false, error: 'Không thể điền text vào input (React block). Thử reload tab.' };
    }

    // 4. Đợi send button sáng lên (enabled)
    await waitUntil(() => {
      const btn = findSendButton();
      return btn && !btn.disabled;
    }, 3000);

    await sleep(200);

    // 5. Bấm send hoặc nhấn Enter
    const sendBtn = findSendButton();
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      // Fallback: Enter key
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13,
        bubbles: true, cancelable: true
      }));
      await sleep(50);
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13,
        bubbles: true, cancelable: true
      }));
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Chờ ảnh generate xong ────────────────────────────────────
function countImages() {
  return document.querySelectorAll(
    'img[src*="googleusercontent"], img[src*="generatedimages"], img[src*="aisandbox"], [class*="generated"] img, [class*="result"] img, [class*="image"] img'
  ).length;
}

function isGenerating() {
  const selectors = [
    '[class*="loading"]', '[class*="spinner"]', '[class*="generating"]',
    '[aria-label*="loading" i]', '[aria-label*="generating" i]',
    '[role="progressbar"]',
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return true;
    } catch (_) {}
  }
  return false;
}

async function handleWaitForImage(timeoutMs) {
  const imgCountBefore = countImages();

  // Đợi bắt đầu generate (tối đa 8s)
  await waitUntil(() => isGenerating(), 8000);

  // Đợi generate xong
  const done = await waitUntil(() => {
    return countImages() > imgCountBefore && !isGenerating();
  }, timeoutMs);

  if (!done) {
    // Dù không detect được ảnh mới — nếu không còn loading thì coi như xong
    if (!isGenerating()) return { success: true, note: 'Không detect ảnh mới nhưng không còn loading' };
    return { success: false, error: 'Timeout chờ generate' };
  }

  return { success: true };
}

// ── Utils ─────────────────────────────────────────────────────
function waitUntil(condition, timeoutMs, interval = 300) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (condition()) { clearInterval(check); resolve(true); }
      else if (Date.now() - start >= timeoutMs) { clearInterval(check); resolve(false); }
    }, interval);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
