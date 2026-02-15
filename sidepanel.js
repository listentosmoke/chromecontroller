// sidepanel.js — Side panel chat UI for AI Browser Controller

document.addEventListener('DOMContentLoaded', async () => {
  const messagesContainer = document.getElementById('messages');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const clearChat = document.getElementById('clear-chat');
  const statusDot = document.querySelector('.dot');
  const statusLabel = document.getElementById('status-label');
  const modelBadge = document.getElementById('model-badge');

  let currentActionLog = null;
  let isExecuting = false;

  // Show active model
  const saved = await chrome.storage.local.get(['aiProvider', 'aiModel']);
  if (saved.aiModel) {
    // Show short model name
    const shortName = saved.aiModel.split('/').pop().replace(/:free$/, '');
    modelBadge.textContent = shortName;
    modelBadge.title = `${saved.aiProvider || 'groq'} / ${saved.aiModel}`;
  }

  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  // Send on Enter (Shift+Enter for newline)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // Stop button
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_EXECUTION' });
  });

  // Clear chat
  clearChat.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    messagesContainer.innerHTML = '';
    addSystemMessage('Conversation cleared. Type a new command.');
  });

  // Example commands
  messagesContainer.addEventListener('click', (e) => {
    if (e.target.closest('ul.examples li')) {
      const text = e.target.textContent.replace(/^"|"$/g, '');
      chatInput.value = text;
      chatInput.focus();
    }
  });

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATUS_UPDATE') {
      setStatus(msg.status, msg.text);
    }

    if (msg.type === 'ACTION_LOG') {
      addActionLogEntry(msg.logType, msg.text);
    }

    if (msg.type === 'EXECUTION_STATE') {
      isExecuting = msg.running;
      sendBtn.disabled = msg.running;
      stopBtn.classList.toggle('hidden', !msg.running);
    }
  });

  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isExecuting) return;

    // Add user message
    addMessage('user', text);
    chatInput.value = '';
    chatInput.style.height = 'auto';

    // Create action log container for this execution
    currentActionLog = createActionLog();

    setStatus('busy', 'Processing...');
    isExecuting = true;
    sendBtn.disabled = true;
    stopBtn.classList.remove('hidden');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'EXECUTE_COMMAND',
        command: text
      });

      if (response.error) {
        addMessage('error', response.error);
      } else {
        let assistantText = response.result || 'Done.';
        if (response.thinking) {
          assistantText = response.thinking + '\n\n' + assistantText;
        }
        addMessage('assistant', assistantText);
      }
    } catch (err) {
      addMessage('error', err.message);
    }

    currentActionLog = null;
    isExecuting = false;
    sendBtn.disabled = false;
    stopBtn.classList.add('hidden');
    setStatus('ready', 'Ready');
    scrollToBottom();
  }

  function addMessage(type, text) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.textContent = text;
    messagesContainer.appendChild(div);
    scrollToBottom();
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message system';
    div.innerHTML = `<p>${text}</p>`;
    messagesContainer.appendChild(div);
    scrollToBottom();
  }

  function createActionLog() {
    const div = document.createElement('div');
    div.className = 'message action-log';
    messagesContainer.appendChild(div);
    scrollToBottom();
    return div;
  }

  function addActionLogEntry(type, text) {
    if (!currentActionLog) {
      currentActionLog = createActionLog();
    }

    const icons = {
      success: '\u2713',
      error: '\u2717',
      info: '\u2022',
      pending: '\u25CB'
    };

    const entry = document.createElement('div');
    entry.className = `action-entry ${type}`;
    entry.innerHTML = `<span class="icon">${icons[type] || '\u2022'}</span><span>${escapeHtml(text)}</span>`;
    currentActionLog.appendChild(entry);
    scrollToBottom();
  }

  function setStatus(status, text) {
    statusDot.className = `dot ${status}`;
    statusLabel.textContent = text;
  }

  function scrollToBottom() {
    const container = document.getElementById('chat-container');
    container.scrollTop = container.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
});
