// popup.js — Gemini Browser Controller popup logic

document.addEventListener('DOMContentLoaded', async () => {
  const setupSection = document.getElementById('setup-section');
  const controlSection = document.getElementById('control-section');
  const apiKeyInput = document.getElementById('api-key-input');
  const saveKeyBtn = document.getElementById('save-key-btn');
  const keyError = document.getElementById('key-error');
  const changeKeyBtn = document.getElementById('change-key-btn');
  const commandInput = document.getElementById('command-input');
  const sendBtn = document.getElementById('send-btn');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const actionLogList = document.getElementById('action-log-list');
  const stopBtn = document.getElementById('stop-btn');
  const openSidepanel = document.getElementById('open-sidepanel');

  // Check for existing API key
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (geminiApiKey) {
    showControlPanel();
  }

  // Save API key
  saveKeyBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showError('Please enter an API key.');
      return;
    }
    if (!key.startsWith('AIza')) {
      showError('Invalid key format. Gemini API keys start with "AIza".');
      return;
    }

    saveKeyBtn.textContent = 'Validating...';
    saveKeyBtn.disabled = true;

    try {
      // Validate the key by making a test request
      const valid = await chrome.runtime.sendMessage({
        type: 'VALIDATE_API_KEY',
        apiKey: key
      });

      if (valid.success) {
        await chrome.storage.local.set({ geminiApiKey: key });
        showControlPanel();
      } else {
        showError(valid.error || 'Invalid API key.');
      }
    } catch (err) {
      showError('Failed to validate key: ' + err.message);
    } finally {
      saveKeyBtn.textContent = 'Save';
      saveKeyBtn.disabled = false;
    }
  });

  // Change API key
  changeKeyBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove('geminiApiKey');
    setupSection.classList.remove('hidden');
    controlSection.classList.add('hidden');
    apiKeyInput.value = '';
  });

  // Send command
  sendBtn.addEventListener('click', () => sendCommand());
  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCommand();
    }
  });

  // Quick action buttons
  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'stop') {
        chrome.runtime.sendMessage({ type: 'STOP_EXECUTION' });
        return;
      }
      if (action === 'screenshot') {
        sendCommand('Take a screenshot of the current page');
        return;
      }
      if (action === 'inspect') {
        sendCommand('Describe what you see on the current page');
        return;
      }
      if (action === 'tabgroup') {
        sendCommand('List all open tabs and their groups');
        return;
      }
    });
  });

  // Open side panel
  openSidepanel.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (err) {
      console.error('Failed to open side panel:', err);
    }
  });

  // Listen for status updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATUS_UPDATE') {
      setStatus(msg.status, msg.text);
    }
    if (msg.type === 'ACTION_LOG') {
      addLogEntry(msg.logType, msg.text);
    }
    if (msg.type === 'EXECUTION_STATE') {
      stopBtn.disabled = !msg.running;
    }
  });

  async function sendCommand(overrideText) {
    const text = overrideText || commandInput.value.trim();
    if (!text) return;

    commandInput.value = '';
    setStatus('busy', 'Processing...');
    stopBtn.disabled = false;
    addLogEntry('info', `Command: ${text}`);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'EXECUTE_COMMAND',
        command: text
      });

      if (response.error) {
        setStatus('error', 'Error');
        addLogEntry('error', response.error);
      } else {
        setStatus('ready', 'Ready');
        if (response.result) {
          addLogEntry('success', response.result);
        }
      }
    } catch (err) {
      setStatus('error', 'Error');
      addLogEntry('error', err.message);
    }

    stopBtn.disabled = true;
  }

  function showControlPanel() {
    setupSection.classList.add('hidden');
    controlSection.classList.remove('hidden');
    setStatus('ready', 'Ready');
  }

  function showError(msg) {
    keyError.textContent = msg;
    keyError.classList.remove('hidden');
    setTimeout(() => keyError.classList.add('hidden'), 5000);
  }

  function setStatus(status, text) {
    statusDot.className = 'status-dot';
    if (status === 'busy') statusDot.classList.add('busy');
    if (status === 'error') statusDot.classList.add('error');
    statusText.textContent = text;
  }

  function addLogEntry(type, text) {
    const emptyItem = actionLogList.querySelector('.log-empty');
    if (emptyItem) emptyItem.remove();

    const li = document.createElement('li');
    li.className = `log-${type}`;
    li.textContent = text;
    actionLogList.insertBefore(li, actionLogList.firstChild);

    // Keep only last 50 entries
    while (actionLogList.children.length > 50) {
      actionLogList.removeChild(actionLogList.lastChild);
    }
  }
});
