// popup.js — AI Browser Controller popup logic
import { PROVIDERS } from './ai-client.js';

document.addEventListener('DOMContentLoaded', async () => {
  const setupSection = document.getElementById('setup-section');
  const controlSection = document.getElementById('control-section');
  const providerSelect = document.getElementById('provider-select');
  const modelSelect = document.getElementById('model-select');
  const modelCount = document.getElementById('model-count');
  const modelField = document.getElementById('model-field');
  const apiKeyInput = document.getElementById('api-key-input');
  const loadModelsBtn = document.getElementById('load-models-btn');
  const saveBtn = document.getElementById('save-btn');
  const keyError = document.getElementById('key-error');
  const modelStatus = document.getElementById('model-status');
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

  let loadedModels = [];

  // ── Update hints when provider changes ──

  function updateProviderHints(provider) {
    const config = PROVIDERS[provider];
    apiKeyInput.placeholder = config.keyPlaceholder;
    keyHintLink.href = config.keyHelp;
    keyHintLink.textContent = config.keyHelpText;

    // Reset model list when provider changes
    modelSelect.innerHTML = '<option value="">-- Click "Load Models" --</option>';
    modelSelect.disabled = true;
    saveBtn.disabled = true;
    modelCount.textContent = '';
    loadedModels = [];
  }

  providerSelect.addEventListener('change', () => {
    updateProviderHints(providerSelect.value);
  });

  // ── Load saved settings ──

  const saved = await chrome.storage.local.get(['aiProvider', 'aiModel', 'aiApiKey']);
  if (saved.aiProvider) {
    providerSelect.value = saved.aiProvider;
  }
  updateProviderHints(providerSelect.value);

  if (saved.aiApiKey && saved.aiModel) {
    // Verify the model is actually usable by doing a quick check
    // Show the control panel — if the model fails at runtime, the user
    // will see the error and can click Settings to re-pick
    showControlPanel(saved.aiProvider, saved.aiModel);
  } else if (saved.aiApiKey) {
    // Has key but no model selected (or stale model cleared) — show setup
    // with key pre-filled so user just needs to load models and pick one
    apiKeyInput.value = saved.aiApiKey;
  }

  // ── Load Models button ──

  loadModelsBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const key = apiKeyInput.value.trim();

    if (!key) {
      showError('Please enter an API key first.');
      return;
    }

    if (provider === 'groq' && !key.startsWith('gsk_')) {
      showError('Groq API keys start with "gsk_".');
      return;
    }
    if (provider === 'openrouter' && !key.startsWith('sk-or-')) {
      showError('OpenRouter API keys start with "sk-or-".');
      return;
    }

    loadModelsBtn.textContent = 'Loading...';
    loadModelsBtn.disabled = true;
    hideError();
    showModelStatus('Fetching available models...');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'FETCH_MODELS',
        provider,
        apiKey: key
      });

      if (!result.success) {
        showError(result.error || 'Failed to fetch models.');
        hideModelStatus();
        return;
      }

      loadedModels = result.models;
      populateModelDropdown(provider, result.models);
      hideModelStatus();

    } catch (err) {
      showError('Failed to fetch models: ' + err.message);
      hideModelStatus();
    } finally {
      loadModelsBtn.textContent = 'Load Models';
      loadModelsBtn.disabled = false;
    }
  });

  // ── Populate model dropdown from fetched data ──

  function populateModelDropdown(provider, models) {
    modelSelect.innerHTML = '';

    if (models.length === 0) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
      modelSelect.disabled = true;
      saveBtn.disabled = true;
      modelCount.textContent = '(0)';
      return;
    }

    if (provider === 'openrouter') {
      // Group: free first, then paid
      const freeModels = models.filter(m => m.isFree);
      const paidModels = models.filter(m => !m.isFree);

      if (freeModels.length > 0) {
        const group = document.createElement('optgroup');
        group.label = `Free (${freeModels.length})`;
        for (const m of freeModels) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          if (m.contextLength) opt.title = `Context: ${(m.contextLength / 1000).toFixed(0)}k`;
          group.appendChild(opt);
        }
        modelSelect.appendChild(group);
      }

      if (paidModels.length > 0) {
        const group = document.createElement('optgroup');
        group.label = `Paid (${paidModels.length})`;
        for (const m of paidModels) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          if (m.contextLength) opt.title = `Context: ${(m.contextLength / 1000).toFixed(0)}k`;
          group.appendChild(opt);
        }
        modelSelect.appendChild(group);
      }
    } else {
      // Groq: flat list
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        let label = m.name;
        if (m.contextWindow) {
          label += ` (${(m.contextWindow / 1000).toFixed(0)}k ctx)`;
        }
        opt.textContent = label;
        modelSelect.appendChild(opt);
      }
    }

    modelCount.textContent = `(${models.length} available)`;
    modelSelect.disabled = false;
    saveBtn.disabled = false;

    // Try to select a previously saved model
    if (saved.aiModel && models.some(m => m.id === saved.aiModel)) {
      modelSelect.value = saved.aiModel;
    }
  }

  // ── Save button ──

  saveBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const key = apiKeyInput.value.trim();

    if (!key || !model) {
      showError('Please select a model.');
      return;
    }

    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;

    try {
      // Validate the key + set up client in background
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
        showError(result.error || 'Validation failed.');
      }
    } catch (err) {
      showError('Failed to save: ' + err.message);
    } finally {
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }
  });

  // ── Settings button (go back to setup) ──

  settingsBtn.addEventListener('click', async () => {
    const saved = await chrome.storage.local.get(['aiProvider', 'aiModel', 'aiApiKey']);
    if (saved.aiProvider) providerSelect.value = saved.aiProvider;
    updateProviderHints(providerSelect.value);
    if (saved.aiApiKey) apiKeyInput.value = saved.aiApiKey;

    setupSection.classList.remove('hidden');
    controlSection.classList.add('hidden');

    // Auto-load models if we have a key
    if (saved.aiApiKey) {
      loadModelsBtn.click();
    }
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
      // Show short readable name
      const shortName = model.split('/').pop().replace(/:free$/, '');
      activeModelSpan.textContent = shortName;
      activeModelSpan.title = `${PROVIDERS[provider]?.name || provider} / ${model}`;
    }
  }

  function showError(msg) {
    keyError.textContent = msg;
    keyError.classList.remove('hidden');
    setTimeout(() => keyError.classList.add('hidden'), 8000);
  }

  function hideError() {
    keyError.classList.add('hidden');
  }

  function showModelStatus(msg) {
    modelStatus.textContent = msg;
    modelStatus.classList.remove('hidden');
  }

  function hideModelStatus() {
    modelStatus.classList.add('hidden');
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
