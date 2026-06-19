const promptsInput = document.getElementById('prompts-input');
const promptStats = document.getElementById('prompt-stats');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const statusBox = document.getElementById('status-box');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const currentPromptText = document.getElementById('current-prompt-text');
const logArea = document.getElementById('log-area');
const delayInput = document.getElementById('delay-input');
const timeoutInput = document.getElementById('timeout-input');
const urlInput = document.getElementById('url-input');
const urlBox = document.getElementById('url-box');
const urlStatus = document.getElementById('url-status');
const btnGo = document.getElementById('btn-go');

let isRunning = false;

// ── URL helpers ───────────────────────────────────────────────
function isValidFlowUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'labs.google' && u.pathname.includes('/tools/flow/');
  } catch (_) { return false; }
}

function updateUrlUi(url) {
  const valid = isValidFlowUrl(url);
  urlBox.className = 'url-box ' + (url ? (valid ? 'valid' : 'invalid') : '');
  urlStatus.className = 'url-status ' + (url ? (valid ? 'ok' : 'err') : '');
  urlStatus.textContent = !url ? '—' : valid ? '✓' : '✗ URL không hợp lệ';
}

chrome.storage.local.get(['flowUrl'], ({ flowUrl }) => {
  if (flowUrl) { urlInput.value = flowUrl; updateUrlUi(flowUrl); }
});

urlInput.addEventListener('input', () => {
  const url = urlInput.value.trim();
  updateUrlUi(url);
  if (isValidFlowUrl(url)) chrome.storage.local.set({ flowUrl: url });
});

urlInput.addEventListener('paste', () => {
  setTimeout(() => {
    const url = urlInput.value.trim();
    updateUrlUi(url);
    if (isValidFlowUrl(url)) chrome.storage.local.set({ flowUrl: url });
  }, 0);
});

btnGo.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!isValidFlowUrl(url)) { alert('URL không hợp lệ.'); return; }
  chrome.tabs.query({ url: 'https://labs.google/*' }, (tabs) => {
    const existing = tabs.find(t => t.url && t.url.includes('/tools/flow/'));
    if (existing) {
      chrome.tabs.update(existing.id, { active: true });
      chrome.windows.update(existing.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
});

// ── Prompt parser ─────────────────────────────────────────────
function parsePrompts(text) {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

promptsInput.addEventListener('input', () => {
  const prompts = parsePrompts(promptsInput.value);
  promptStats.innerHTML = prompts.length > 0 ? `<b>${prompts.length}</b> prompt được phát hiện` : '';
});

// ── Log helpers ───────────────────────────────────────────────
function addLog(text, type = 'done') {
  const icons = { done: '✓', running: '⟳', error: '✗' };
  const item = document.createElement('div');
  item.className = `log-item ${type}`;
  item.innerHTML = `<span class="icon">${icons[type]}</span><span class="text">${text}</span>`;
  logArea.appendChild(item);
  logArea.scrollTop = logArea.scrollHeight;
}

function setProgress(current, total) {
  progressBar.style.width = total > 0 ? (current / total) * 100 + '%' : '0%';
  progressText.textContent = `${current} / ${total}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Tab helpers ───────────────────────────────────────────────
async function getFlowTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://labs.google/*' }, (tabs) => {
      resolve(tabs.find(t => t.url && t.url.includes('/tools/flow/')) || null);
    });
  });
}

async function ensureContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
          if (chrome.runtime.lastError) resolve(false);
          else setTimeout(() => resolve(true), 500);
        });
      } else {
        resolve(true);
      }
    });
  });
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(response || { success: false });
    });
  });
}

// ── Gửi prompt qua executeScript world:MAIN ──────────────────
// Chạy trực tiếp trong JavaScript context của trang — execCommand
// hoạt động đúng, không bị block bởi popup focus.
async function sendPromptMainWorld(tabId, prompt) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (promptText) => {
        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        function findInput() {
          const all = [...document.querySelectorAll('[contenteditable="true"]')];
          if (!all.length) return null;
          return all.sort((a, b) =>
            b.getBoundingClientRect().top - a.getBoundingClientRect().top
          )[0];
        }

        function findSendButton(input) {
          const container = input.parentElement?.parentElement;
          if (!container) return null;
          const btns = [...container.querySelectorAll('button')].filter(b => {
            if (!b) return false;
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (!btns.length) return null;
          return btns.sort((a, b) =>
            b.getBoundingClientRect().right - a.getBoundingClientRect().right
          )[0];
        }

        const input = findInput();
        if (!input) return { success: false, error: 'Không tìm thấy ô chat.' };

        // Focus và clear
        input.click();
        input.focus();
        await sleep(200);
        document.execCommand('selectAll', false, null);
        await sleep(80);

        // Gõ text — trong MAIN world execCommand hoạt động bình thường
        document.execCommand('insertText', false, promptText);
        await sleep(500);

        const hasText = input.textContent?.trim().length > 0;
        if (!hasText) return { success: false, error: 'execCommand không điền được text.' };

        // Đợi send button enabled tối đa 4s
        let sendBtn = null;
        for (let i = 0; i < 40; i++) {
          sendBtn = findSendButton(input);
          if (sendBtn && !sendBtn.disabled) break;
          await sleep(100);
        }

        if (!sendBtn || sendBtn.disabled) {
          return { success: false, error: `Send button vẫn disabled. Text: "${input.textContent?.slice(0, 40)}"` };
        }

        sendBtn.click();
        await sleep(300);
        return { success: true };
      },
      args: [prompt],
    });

    return results?.[0]?.result || { success: false, error: 'executeScript không trả về kết quả.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Main automation ───────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  const prompts = parsePrompts(promptsInput.value);
  if (prompts.length === 0) { alert('Vui lòng nhập ít nhất 1 prompt!'); return; }

  const savedUrl = urlInput.value.trim();
  if (!isValidFlowUrl(savedUrl)) {
    alert('Vui lòng nhập URL project Google Flow hợp lệ trước khi bắt đầu.');
    urlInput.focus();
    return;
  }

  let tab = await getFlowTab();
  if (!tab) {
    chrome.tabs.create({ url: savedUrl });
    addLog('Đang mở tab Google Flow, vui lòng đợi vài giây rồi bấm lại…', 'running');
    statusBox.style.display = 'block';
    return;
  }

  const delayMs = (parseInt(delayInput.value) || 5) * 1000;
  const timeoutMs = (parseInt(timeoutInput.value) || 90) * 1000;

  isRunning = true;
  btnStart.disabled = true;
  btnStop.style.display = 'block';
  statusBox.style.display = 'block';
  logArea.innerHTML = '';
  setProgress(0, prompts.length);

  // Focus tab và inject content script (cho waitForImage)
  chrome.tabs.update(tab.id, { active: true });
  chrome.windows.update(tab.windowId, { focused: true });
  const injected = await ensureContentScript(tab.id);
  if (!injected) {
    addLog('Không inject được content script. Reload tab Google Flow rồi thử lại.', 'error');
    isRunning = false;
    btnStart.disabled = false;
    btnStop.style.display = 'none';
    return;
  }

  for (let i = 0; i < prompts.length; i++) {
    if (!isRunning) { addLog('Đã dừng bởi người dùng.', 'error'); break; }

    const prompt = prompts[i];
    const short = prompt.length > 55 ? prompt.slice(0, 55) + '…' : prompt;
    currentPromptText.textContent = `▶ ${short}`;
    addLog(`[${i + 1}/${prompts.length}] Đang gửi prompt…`, 'running');

    // Dùng executeScript MAIN world thay vì messaging
    const sendResult = await sendPromptMainWorld(tab.id, prompt);

    if (!sendResult.success) {
      addLog(`[${i + 1}] Lỗi: ${sendResult.error}`, 'error');
      setProgress(i + 1, prompts.length);
      continue;
    }

    addLog(`[${i + 1}/${prompts.length}] Đang chờ generate…`, 'running');
    const waitResult = await sendMessageToTab(tab.id, { action: 'waitForImage', timeoutMs });

    if (waitResult.success) {
      addLog(`[${i + 1}/${prompts.length}] Hoàn thành ✓`, 'done');
    } else {
      addLog(`[${i + 1}/${prompts.length}] Timeout — tiếp tục prompt tiếp theo`, 'error');
    }

    setProgress(i + 1, prompts.length);
    if (i < prompts.length - 1 && isRunning) await sleep(delayMs);
  }

  if (isRunning) currentPromptText.textContent = '✅ Hoàn tất tất cả prompt!';
  isRunning = false;
  btnStart.disabled = false;
  btnStop.style.display = 'none';
});

btnStop.addEventListener('click', () => {
  isRunning = false;
  btnStop.style.display = 'none';
  btnStart.disabled = false;
  currentPromptText.textContent = '⏹ Đã dừng';
});
