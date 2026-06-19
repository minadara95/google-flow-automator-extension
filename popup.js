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

// ── URL helpers ──────────────────────────────────────────────
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

// Khôi phục URL đã lưu
chrome.storage.local.get(['flowUrl'], ({ flowUrl }) => {
  if (flowUrl) {
    urlInput.value = flowUrl;
    updateUrlUi(flowUrl);
  }
});

urlInput.addEventListener('input', () => {
  const url = urlInput.value.trim();
  updateUrlUi(url);
  if (isValidFlowUrl(url)) {
    chrome.storage.local.set({ flowUrl: url });
  }
});

urlInput.addEventListener('paste', () => {
  // paste event fires before value updates — đợi một tick
  setTimeout(() => {
    const url = urlInput.value.trim();
    updateUrlUi(url);
    if (isValidFlowUrl(url)) chrome.storage.local.set({ flowUrl: url });
  }, 0);
});

btnGo.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!isValidFlowUrl(url)) {
    alert('URL không hợp lệ. Ví dụ:\nhttps://labs.google/fx/vi/tools/flow/project/abc123');
    return;
  }
  // Tìm tab đang mở URL này, nếu có thì focus; không thì mở tab mới
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

// ── Prompt parser ────────────────────────────────────────────
function parsePrompts(text) {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

promptsInput.addEventListener('input', () => {
  const prompts = parsePrompts(promptsInput.value);
  promptStats.innerHTML = prompts.length > 0 ? `<b>${prompts.length}</b> prompt được phát hiện` : '';
});

// ── Log helpers ──────────────────────────────────────────────
function addLog(text, type = 'done') {
  const icons = { done: '✓', running: '⟳', error: '✗' };
  const item = document.createElement('div');
  item.className = `log-item ${type}`;
  item.innerHTML = `<span class="icon">${icons[type]}</span><span class="text">${text}</span>`;
  logArea.appendChild(item);
  logArea.scrollTop = logArea.scrollHeight;
}

function setProgress(current, total) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  progressBar.style.width = pct + '%';
  progressText.textContent = `${current} / ${total}`;
}

// ── Tab helpers ──────────────────────────────────────────────
async function getFlowTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://labs.google/*' }, (tabs) => {
      const tab = tabs.find(t => t.url && t.url.includes('/tools/flow/'));
      resolve(tab || null);
    });
  });
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false });
      }
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main automation ──────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  const prompts = parsePrompts(promptsInput.value);
  if (prompts.length === 0) {
    alert('Vui lòng nhập ít nhất 1 prompt!');
    return;
  }

  const savedUrl = urlInput.value.trim();
  if (!isValidFlowUrl(savedUrl)) {
    alert('Vui lòng nhập URL project Google Flow hợp lệ trước khi bắt đầu.');
    urlInput.focus();
    return;
  }

  // Tìm tab đang mở — nếu chưa có, mở rồi đợi load
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

  // Focus tab Flow
  chrome.tabs.update(tab.id, { active: true });

  for (let i = 0; i < prompts.length; i++) {
    if (!isRunning) { addLog('Đã dừng bởi người dùng.', 'error'); break; }

    const prompt = prompts[i];
    const short = prompt.length > 55 ? prompt.slice(0, 55) + '…' : prompt;
    currentPromptText.textContent = `▶ ${short}`;
    addLog(`[${i + 1}/${prompts.length}] Đang gửi prompt…`, 'running');

    const sendResult = await sendMessageToTab(tab.id, { action: 'sendPrompt', prompt });

    if (!sendResult.success) {
      addLog(`[${i + 1}] Lỗi gửi — ${sendResult.error || 'không tìm thấy input'}`, 'error');
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
