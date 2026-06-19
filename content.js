// Các selector có thể có của Google Flow — thử lần lượt
const INPUT_SELECTORS = [
  'textarea[placeholder*="create"]',
  'textarea[placeholder*="Create"]',
  'textarea[placeholder*="want"]',
  'div[contenteditable="true"][aria-label*="create"]',
  'div[contenteditable="true"][aria-label*="Create"]',
  'div[contenteditable="true"][data-placeholder*="create"]',
  'div[contenteditable="true"][data-placeholder*="Create"]',
  'textarea.chat-input',
  'textarea',
  'div[contenteditable="true"]',
];

const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="send" i]',
  'button[aria-label*="Send" i]',
  'button[aria-label*="Submit" i]',
  'button[type="submit"]',
  '[data-testid*="send"]',
  '[data-testid*="submit"]',
];

function findInput() {
  for (const sel of INPUT_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    } catch (_) {}
  }
  return null;
}

function findSendButton() {
  for (const sel of SEND_BUTTON_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (el && isVisible(el) && !el.disabled) return el;
    } catch (_) {}
  }
  // Fallback: tìm button có icon mũi tên gần input
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const svg = btn.querySelector('svg');
    if (svg && isVisible(btn) && !btn.disabled) {
      const rect = btn.getBoundingClientRect();
      // Ưu tiên button góc dưới phải màn hình
      if (rect.bottom > window.innerHeight * 0.7 && rect.right > window.innerWidth * 0.7) {
        return btn;
      }
    }
  }
  return null;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 &&
    getComputedStyle(el).visibility !== 'hidden' &&
    getComputedStyle(el).display !== 'none';
}

function setNativeValue(el, value) {
  // React/Angular có thể override value setter — cần trigger sự kiện thủ công
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLDivElement.prototype,
    'value'
  );

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    if (nativeInputValueSetter) {
      nativeInputValueSetter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.focus();
    el.innerHTML = '';
    // Dùng execCommand để tránh React clobber
    document.execCommand('insertText', false, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }
}

function countImages() {
  // Đếm số ảnh trong vùng kết quả (canvas / img / generated image)
  const imgs = document.querySelectorAll(
    'img[src*="googleusercontent"], img[src*="generatedimages"], img[src*="aisandbox"], canvas, [class*="generated"] img, [class*="result"] img'
  );
  return imgs.length;
}

function isGenerating() {
  // Phát hiện trạng thái đang generate: spinner, loading indicator, disabled button
  const loadingIndicators = [
    '[class*="loading"]',
    '[class*="spinner"]',
    '[class*="generating"]',
    '[aria-label*="loading" i]',
    '[aria-label*="generating" i]',
  ];
  for (const sel of loadingIndicators) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) return true;
  }

  // Kiểm tra nút gửi có bị disabled không (thường bị disable khi đang generate)
  const sendBtn = findSendButton();
  if (sendBtn && sendBtn.disabled) return true;

  return false;
}

// Lắng nghe message từ popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'sendPrompt') {
    handleSendPrompt(message.prompt).then(sendResponse);
    return true; // async response
  }

  if (message.action === 'waitForImage') {
    handleWaitForImage(message.timeoutMs || 90000).then(sendResponse);
    return true;
  }
});

async function handleSendPrompt(prompt) {
  try {
    const input = findInput();
    if (!input) {
      return { success: false, error: 'Không tìm thấy ô nhập prompt. Hãy chắc chắn tab Google Flow đang mở.' };
    }

    // Focus và điền prompt
    input.focus();
    await sleep(200);
    setNativeValue(input, prompt);
    await sleep(500);

    // Tìm và bấm nút gửi
    const sendBtn = findSendButton();
    if (!sendBtn) {
      // Fallback: nhấn Enter
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    } else {
      sendBtn.click();
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleWaitForImage(timeoutMs) {
  const startTime = Date.now();
  const imgCountBefore = countImages();

  // Đợi quá trình generate bắt đầu (tối đa 10s)
  await waitUntil(() => isGenerating(), 10000);

  // Đợi generate xong: số ảnh tăng lên HOẶC không còn generating nữa
  const done = await waitUntil(() => {
    const newCount = countImages();
    const stillGenerating = isGenerating();
    return (newCount > imgCountBefore) && !stillGenerating;
  }, timeoutMs);

  // Nếu vẫn không detect được nhưng đã hết generating — coi như xong
  if (!done) {
    const notGenerating = !isGenerating();
    if (notGenerating) return { success: true, note: 'timeout nhưng không còn generating' };
    return { success: false, error: 'timeout' };
  }

  return { success: true };
}

function waitUntil(condition, timeoutMs, interval = 500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (condition()) {
        clearInterval(check);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(check);
        resolve(false);
      }
    }, interval);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
