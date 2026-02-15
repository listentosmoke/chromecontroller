// popup.js — AI Browser Controller popup logic
import { PROVIDERS } from './ai-client.js';

document.addEventListener('DOMContentLoaded', async () => {
  const setupSection = document.getElementById('setup-section');
  const controlSection = document.getElementById('control-section');
  const providerSelect = document.getElementById('provider-select');
  const modelSelect = document.getElementById('model-select');
  const apiKeyInput = document.getElementById('api-key-input');
  const saveKeyBtn = document.getElementById('save-key-btn');
  const keyError = document.getElementById('key-error');
  const keyHintLink = document.getElementById('key-hint-link');
  const settingsBtn = document.getElementById('settings-btn');
  const activeModelSpan = document.getElementById('active-model');
  const commandInput = document.getElementById('command-input');
  const sendBtn = document.getElementById('send-btn');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const actionLogList = document.getElementById('action-log-list');
  const stopBtn = document.getElementById('stop-btn');
  const openSidepanel = document.getElementById('open-sidepanel');

  // ── Populate models when provider changes ──

  function populateModels(provider) {
    const providerConfig = PROVIDERS[provider];
    modelSelect.innerHTML = '';

    const freeModels = providerConfig.models.filter(m => m.free);
    const paidModels = providerConfig.models.filter(m => !m.free);

    if (freeModels.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Free Tier';
      for (const m of freeModels) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        group.appendChild(opt);
      }
      modelSelect.appendChild(group);
    }

    if (paidModels.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Paid';
      for (const m of paidModels) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        group.appendChild(opt);
      }
      modelSelect.appendChild(group);
    }

    modelSelect.value = providerConfig.defaultModel;

    apiKeyInput.placeholder = providerConfig.keyPlaceholder;
    keyHintLink.href = providerConfig.keyHelp;
    keyHintLink.textContent = providerConfig.keyHelpText;
  }

  providerSelect.addEventListener('change', () => {
    populateModels(providerSelect.value);
  });

  // ── Load saved settings ──

  const saved = await chrome.storage.local.get(['aiProvider', 'aiModel', 'aiApiKey']);
  if (saved.aiProvider) {
    providerSelect.value = saved.aiProvider;
  }
  populateModels(providerSelect.value);
  if (saved.aiModel) {
    modelSelect.value = saved.aiModel;
  }

  if (saved.aiApiKey) {
    showControlPanel(saved.aiProvider, saved.aiModel);
  }

  // ── Save settings ──

  saveKeyBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const key = apiKeyInput.value.trim();

    if (!key) {
      showError('Please enter an API key.');
      return;
    }

    if (provider === 'gemini' && !key.startsWith('AIza')) {
      showError('Gemini API keys start with "AIza".');
      return;
    }
    if (provider === 'openrouter' && !key.startsWith('sk-or-')) {
      showError('OpenRouter API keys start with "sk-or-".');
      return;
    }

    saveKeyBtn.textContent = 'Validating...';
    saveKeyBtn.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'VALIDATE_API_KEY',
        provider,
        apiKey: key,
        model
      });

      if (result.success) {
        await chrome.storage.local.set({
          aiProvider: provider,
          aiModel: model,
          aiApiKey: key
        });
        showControlPanel(provider, model);
      } else {
        showError(result.error || 'Invalid API key.');
      }
    } catch (err) {
      showError('Failed to validate: ' + err.message);
    } finally {
      saveKeyBtn.textContent = 'Save';
      saveKeyBtn.disabled = false;
    }
  });

  // ── Settings button ──

  settingsBtn.addEventListener('click', async () => {
    const saved = await chrome.storage.local.get(['aiProvider', 'aiModel', 'aiApiKey']);
    if (saved.aiProvider) providerSelect.value = saved.aiProvider;
    populateModels(providerSelect.value);
    if (saved.aiModel) modelSelect.value = saved.aiModel;
    if (saved.aiApiKey) apiKeyInput.value = saved.aiApiKey;

    setupSection.classList.remove('hidden');
    controlSection.classList.add('hidden');
  });

  // ── Send command ──

  sendBtn.addEventListener('click', () => sendCommand());
  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCommand();
    }
  });

  // ── Quick action buttons ──

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

  // ── Open side panel ──

  openSidepanel.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (err) {
      console.error('Failed to open side panel:', err);
    }
  });

  // ── Listen for background messages ──

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

  // ── Helpers ──

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

  function showControlPanel(provider, model) {
    setupSection.classList.add('hidden');
    controlSection.classList.remove('hidden');
    setStatus('ready', 'Ready');

    if (provider && model) {
      const providerConfig = PROVIDERS[provider];
      const modelConfig = providerConfig?.models.find(m => m.id === model);
      activeModelSpan.textContent = modelConfig?.name || model;
      activeModelSpan.title = `${providerConfig?.name || provider} / ${model}`;
    }
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

    while (actionLogList.children.length > 50) {
      actionLogList.removeChild(actionLogList.lastChild);
    }
  }
});
