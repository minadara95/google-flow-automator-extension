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

// ── Tìm ô input chat ─────────────────────────────────────────
// Google Flow dùng div[contenteditable] — textarea là reCAPTCHA ẩn, bỏ qua.
function findInput() {
  const editables = [...document.querySelectorAll('[contenteditable="true"]')];
  if (editables.length === 0) return null;
  // Lấy cái thấp nhất (gần đáy màn hình = ô chat)
  return editables.sort((a, b) =>
    b.getBoundingClientRect().top - a.getBoundingClientRect().top
  )[0];
}

// ── Tìm nút Send ─────────────────────────────────────────────
// Container của input là grandparent (2 cấp lên). Send button = rightmost button trong đó.
function findSendButton() {
  const input = findInput();
  if (!input) return null;
  const container = input.parentElement?.parentElement;
  if (!container) return null;
  const btns = [...container.querySelectorAll('button')].filter(b => isVisible(b));
  if (btns.length === 0) return null;
  return btns.sort((a, b) =>
    b.getBoundingClientRect().right - a.getBoundingClientRect().right
  )[0];
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 &&
    getComputedStyle(el).visibility !== 'hidden' &&
    getComputedStyle(el).display !== 'none';
}

// ── React fiber: trigger onChange trực tiếp ───────────────────
// React lưu event handlers trong __reactFiber* key trên DOM node.
// Gọi trực tiếp để bypass DOM event và cập nhật React state.
function getReactFiber(el) {
  const key = Object.keys(el).find(k =>
    k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
  );
  return key ? el[key] : null;
}

function triggerReactInput(el, text) {
  // Set nội dung DOM trước
  el.textContent = text;

  // Di chuyển cursor về cuối
  try {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_) {}

  // Tìm React's onInput/onChange handler qua fiber tree
  let fiber = getReactFiber(el);
  let found = false;
  while (fiber) {
    const props = fiber.memoizedProps;
    if (props) {
      const handler = props.onInput || props.onChange;
      if (typeof handler === 'function') {
        // Tạo synthetic-like event object mà React component đang chờ
        const syntheticEvent = {
          target: el,
          currentTarget: el,
          type: 'input',
          nativeEvent: new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
          preventDefault: () => {},
          stopPropagation: () => {},
        };
        handler(syntheticEvent);
        found = true;
        break;
      }
    }
    fiber = fiber.return;
  }

  // Dù có hay không tìm được handler, vẫn fire DOM event để chắc chắn
  el.dispatchEvent(new InputEvent('input', {
    bubbles: true, cancelable: false,
    inputType: 'insertText', data: text, composed: true,
  }));

  return found;
}

// ── Xóa input đúng cách ───────────────────────────────────────
function clearReactInput(el) {
  el.focus();
  el.textContent = '';

  let fiber = getReactFiber(el);
  while (fiber) {
    const props = fiber.memoizedProps;
    if (props) {
      const handler = props.onInput || props.onChange;
      if (typeof handler === 'function') {
        handler({
          target: el, currentTarget: el, type: 'input',
          nativeEvent: new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }),
          preventDefault: () => {}, stopPropagation: () => {},
        });
        break;
      }
    }
    fiber = fiber.return;
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', composed: true }));
}

// ── Gửi prompt ───────────────────────────────────────────────
async function handleSendPrompt(prompt) {
  try {
    const input = findInput();
    if (!input) {
      return { success: false, error: 'Không tìm thấy ô chat. Đảm bảo tab Google Flow đang mở đúng project.' };
    }

    // 1. Xóa nội dung cũ
    clearReactInput(input);
    await sleep(200);

    // 2. Điền prompt qua React fiber
    input.focus();
    triggerReactInput(input, prompt);
    await sleep(400);

    // 3. Kiểm tra text đã vào chưa
    const content = input.textContent?.trim();
    if (!content) {
      // Fallback: execCommand (Chrome vẫn hỗ trợ)
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, prompt);
      await sleep(300);
    }

    // 4. Đợi send button enabled (tối đa 3s)
    await waitUntil(() => {
      const btn = findSendButton();
      return btn && !btn.disabled;
    }, 3000);
    await sleep(150);

    // 5. Click send
    const sendBtn = findSendButton();
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      // Fallback: Enter
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      await sleep(50);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    }

    await sleep(300);
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
    '[aria-label*="loading" i]', '[aria-label*="generating" i]', '[role="progressbar"]',
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
  await waitUntil(() => isGenerating(), 8000);
  const done = await waitUntil(() => countImages() > imgCountBefore && !isGenerating(), timeoutMs);
  if (!done) {
    if (!isGenerating()) return { success: true, note: 'Không detect ảnh mới nhưng không còn loading' };
    return { success: false, error: 'Timeout chờ generate' };
  }
  return { success: true };
}

// ── Utils ─────────────────────────────────────────────────────
function waitUntil(condition, timeoutMs, interval = 300) {
  return new Promise((resolve) => {
    const start = Date.now();
    const id = setInterval(() => {
      if (condition()) { clearInterval(id); resolve(true); }
      else if (Date.now() - start >= timeoutMs) { clearInterval(id); resolve(false); }
    }, interval);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
