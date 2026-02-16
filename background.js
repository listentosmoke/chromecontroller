// background.js — Service worker: orchestrates AI client, debugger, tab groups, and content scripts
import { AIClient, fetchModels } from './ai-client.js';

let aiClient = null;
let isExecuting = false;
let shouldStop = false;
let debuggerAttachedTabs = new Set();

// ── Initialization ──

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

  // Migrate from older versions:
  // 1. Remove legacy key names
  // 2. Clear stale Gemini models/provider from previous versions
  chrome.storage.local.get(['geminiApiKey', 'aiModel', 'aiProvider']).then(saved => {
    const removals = ['geminiApiKey'];
    // Clear stale Gemini models that no longer apply
    if (saved.aiModel && saved.aiModel.startsWith('gemini-')) {
      removals.push('aiModel');
    }
    // Clear stale Gemini provider
    if (saved.aiProvider === 'gemini') {
      removals.push('aiProvider');
    }
    chrome.storage.local.remove(removals);
  });
});

// ── Message Router ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'VALIDATE_API_KEY':
      handleValidateKey(msg.provider, msg.apiKey, msg.model).then(sendResponse);
      return true;

    case 'FETCH_MODELS':
      fetchModels(msg.provider, msg.apiKey)
        .then(models => sendResponse({ success: true, models }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'EXECUTE_COMMAND':
      handleExecuteCommand(msg.command).then(sendResponse);
      return true;

    case 'STOP_EXECUTION':
      shouldStop = true;
      sendResponse({ success: true });
      return;

    case 'GET_CONVERSATION_HISTORY':
      sendResponse({
        history: aiClient?.conversationHistory || []
      });
      return;

    case 'CLEAR_HISTORY':
      aiClient?.clearHistory();
      sendResponse({ success: true });
      return;

    default:
      return;
  }
});

// ── API Key Validation ──

async function handleValidateKey(provider, apiKey, model) {
  const client = new AIClient(provider, apiKey, model);
  const result = await client.validateKey();
  if (result.success) {
    aiClient = client;
  }
  return result;
}

// ── Ensure AI Client ──

async function ensureClient() {
  // Always re-check storage to pick up model/provider changes
  const saved = await chrome.storage.local.get(['aiProvider', 'aiModel', 'aiApiKey']);
  if (!saved.aiApiKey) {
    throw new Error('No API key configured. Open the popup to set one.');
  }
  if (!saved.aiModel) {
    throw new Error('No model selected. Open the popup, load models, and pick one.');
  }

  // Rebuild client if settings changed or client doesn't exist
  if (!aiClient ||
      aiClient.provider !== (saved.aiProvider || 'groq') ||
      aiClient.model !== saved.aiModel ||
      aiClient.apiKey !== saved.aiApiKey) {
    aiClient = new AIClient(
      saved.aiProvider || 'groq',
      saved.aiApiKey,
      saved.aiModel
    );
  }
}

// ── Quiz Auto-Detection ──

function detectQuizMode(pageContext) {
  const map = pageContext.visualMap || '';
  const url = pageContext.url || '';
  const title = pageContext.title || '';

  const indicators = [
    { pattern: 'lrn_assess', weight: 3 },       // Learnosity assessment framework
    { pattern: 'mcq-input', weight: 3 },          // Multiple choice question inputs
    { pattern: '[radio]', weight: 1 },             // Radio buttons
    { pattern: '[checkbox]', weight: 1 },          // Checkboxes
    { pattern: 'Quick Check', weight: 2 },         // Common quiz title
    { pattern: 'Item ', weight: 1 },               // "Item 1 of 5" text
    { pattern: 'question', weight: 1 },            // Question-related text
    { pattern: '[unchecked]', weight: 1 },         // Unchecked options (multiple = quiz)
  ];

  let score = 0;
  for (const { pattern, weight } of indicators) {
    if (map.includes(pattern)) score += weight;
  }

  // Also check URL/title for quiz-related keywords
  const lowerUrl = url.toLowerCase();
  const lowerTitle = title.toLowerCase();
  for (const keyword of ['quiz', 'assessment', 'test', 'exam', 'survey']) {
    if (lowerUrl.includes(keyword) || lowerTitle.includes(keyword)) score += 2;
  }

  return score >= 4;
}

// ── Visual Map Diffing (token optimization for quiz mode) ──

function computeMapDiff(oldMap, newMap) {
  if (!oldMap) return newMap;

  // Extract element lines (lines starting with [) for comparison
  function getElementLines(text) {
    return text.split('\n').filter(l => l.trim().startsWith('['));
  }

  // Split map into sections by === headers
  function splitSections(map) {
    const sections = [];
    const lines = map.split('\n');
    let currentHeader = '';
    let currentBody = [];

    for (const line of lines) {
      if (line.startsWith('===')) {
        if (currentHeader) {
          sections.push({ header: currentHeader, body: currentBody.join('\n') });
        }
        currentHeader = line;
        currentBody = [];
      } else {
        currentBody.push(line);
      }
    }
    if (currentHeader) {
      sections.push({ header: currentHeader, body: currentBody.join('\n') });
    }
    return sections;
  }

  const oldSections = splitSections(oldMap);
  const newSections = splitSections(newMap);

  // Quick check: entire map unchanged
  const oldEls = getElementLines(oldMap).join('\n');
  const newEls = getElementLines(newMap).join('\n');
  if (oldEls === newEls) return '[Page unchanged]';

  const result = [];
  result.push('=== PAGE UPDATE (diff) ===');
  result.push('Unchanged sections omitted. Previous selectors still valid.');

  for (const newSec of newSections) {
    const isIframe = newSec.header.includes('IFRAME');

    // Find matching old section
    const oldSec = isIframe
      ? oldSections.find(s => s.header.includes('IFRAME'))
      : oldSections.find(s => s.header.includes('VISUAL PAGE MAP'));

    const newSecEls = getElementLines(newSec.body);
    const oldSecEls = oldSec ? getElementLines(oldSec.body) : [];

    if (oldSecEls.join('\n') === newSecEls.join('\n')) {
      // Unchanged section — compact summary
      if (!isIframe) {
        // Outer page: extract interactive element selectors as quick reference
        const refs = newSecEls
          .filter(l => l.includes('[*'))
          .map(line => {
            const sel = line.match(/sel="([^"]+)"/)?.[1];
            if (!sel) return null;
            const quotes = [...line.matchAll(/"([^"]+)"/g)].map(m => m[1]);
            const text = quotes.find(q =>
              q !== sel && !q.startsWith('http') && !q.startsWith('javascript:') && q.length < 50
            );
            return text ? `"${text}" sel="${sel}"` : `sel="${sel}"`;
          })
          .filter(Boolean);

        result.push('');
        result.push(`[Outer page: ${newSecEls.length} elements unchanged]`);
        if (refs.length > 0) {
          result.push('Key controls: ' + refs.join(' | '));
        }
      } else {
        result.push('');
        result.push(`[Iframe: ${newSecEls.length} elements unchanged]`);
      }
    } else {
      // Changed or new section — include full content
      result.push('');
      result.push(newSec.header);
      result.push(newSec.body.trim());
    }
  }

  return result.join('\n');
}

// ── Command Execution Pipeline ──

async function handleExecuteCommand(command) {
  if (isExecuting) {
    return { error: 'Already executing a command. Please wait or click Stop.' };
  }

  isExecuting = true;
  shouldStop = false;

  try {
    await ensureClient();
    broadcastExecutionState(true);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');

    const MAX_RETRIES = 3;
    let lastSummary = '';
    let executionMode = 'normal'; // AI can switch to 'quiz' dynamically
    let lastFullVisualMap = null; // For diff-based snapshots in quiz mode

    const maxSteps = () => executionMode === 'quiz' ? 25 : 15;

    for (let step = 0; step < maxSteps(); step++) {
      if (shouldStop) {
        broadcastLog('info', 'Stopped by user');
        break;
      }

      const isQuiz = executionMode === 'quiz';

      // In quiz mode, re-inject content scripts (iframes may have navigated)
      if (isQuiz) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content.js']
          });
        } catch { /* restricted page */ }
      }

      // Gather fresh page context each step
      broadcastStatus('busy', step === 0 ? 'Analyzing page...' : `Step ${step + 1}: Re-analyzing...`);
      const pageContext = await getPageContext(tab, executionMode);

      // In quiz mode (step > 0): compute diff to reduce tokens sent to the AI.
      // Store full map before diffing so next step's diff is against the full map.
      const fullVisualMap = pageContext.visualMap;
      if (executionMode === 'quiz' && step > 0 && lastFullVisualMap && fullVisualMap) {
        pageContext.visualMap = computeMapDiff(lastFullVisualMap, fullVisualMap);
      }
      lastFullVisualMap = fullVisualMap;

      // Auto-detect quiz mode from page content on first step
      if (step === 0 && executionMode === 'normal' && detectQuizMode(pageContext)) {
        executionMode = 'quiz';
        broadcastLog('info', 'Auto-detected quiz/assessment — switched to quiz mode');
      }

      // Build message — mode-specific continuation prompts
      let message;
      if (step === 0) {
        message = command;
      } else if (executionMode === 'quiz') {
        message = `Continue: ${command}\n\nStep ${step} done. Look at the IFRAME section for the current question.\n\nYou MUST:\n1) Read the question text carefully.\n2) In your "thinking" field, reason through the answer — state the question, consider each option, explain why one is correct.\n3) Click the CORRECT answer(s). Radio = one answer. Checkboxes = multiple correct.\n4) For drag-and-drop: use the "drag" action with fromSelector and toSelector — it will click the source item then click the drop target. Do ONE item at a time, then snapshot to verify before doing the next.\n5) Click Next, then snapshot.\n\nIf an answer is already selected, verify it. If wrong, fix it. If a modal appears, click Cancel and answer first. Set done=true ONLY when ALL items are complete.`;
      } else {
        message = `Continue: ${command}`;
      }

      let response = null;
      let gotActions = false;

      // Inner retry loop: if model returns prose/no actions, send corrective prompt
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (shouldStop) break;

        broadcastStatus('busy', step === 0 && attempt === 0
          ? 'Thinking...'
          : `Step ${step + 1}${attempt > 0 ? ` (retry ${attempt})` : ''}: Thinking...`);

        response = await aiClient.sendMessage(message, pageContext, executionMode);

        if (shouldStop) break;

        // Check if response has real executable actions
        const hasRealActions = response.actions?.some(a => a.type !== 'describe');
        if (response.actions && response.actions.length > 0 && hasRealActions) {
          gotActions = true;
          break;
        }

        // Model returned no actions or prose — retry with corrective prompt
        if (attempt < MAX_RETRIES - 1) {
          broadcastLog('info', `Model returned no actions (attempt ${attempt + 1}/${MAX_RETRIES}), re-prompting...`);
          if (aiClient.conversationHistory.length >= 2) {
            aiClient.conversationHistory.splice(-2, 2);
          }
          message = `IMPORTANT: You must output JSON with an "actions" array containing click/type/select actions. Do NOT answer questions yourself — click the answers on the page. Do NOT write prose or explanations.\n\nTask: ${command}\n\nLook at the Visual Page Map above and output actions.`;
        }
      }

      if (shouldStop) break;

      if (!gotActions) {
        broadcastLog('info', response?.summary || 'Model could not produce actions after retries.');
        if (aiClient.conversationHistory.length >= 2) {
          aiClient.conversationHistory.splice(-2, 2);
        }
        if (step === 0) {
          broadcastLog('error', 'Model failed to produce any actions. Try rephrasing the command or using a different model.');
          break;
        }
        continue;
      }

      // Check for mode switch from AI
      if (response.mode === 'quiz' && executionMode !== 'quiz') {
        executionMode = 'quiz';
        broadcastLog('info', 'Switched to quiz mode');
      }
      // Only allow exit from quiz mode when AI also says done=true
      // This prevents premature switching back to normal mid-quiz
      if (response.mode === 'normal' && executionMode === 'quiz') {
        const isDone = response.done === true || response.done === 'true';
        if (isDone) {
          executionMode = 'normal';
          broadcastLog('info', 'Quiz complete — switched back to normal mode');
        }
      }

      // Execute actions
      broadcastStatus('busy', step === 0
        ? `Executing ${response.actions.length} action(s)...`
        : `Step ${step + 1}: Executing ${response.actions.length} action(s)...`);
      broadcastLog('info', response.thinking || 'Planning actions...');

      let hitSnapshot = false;
      for (let i = 0; i < response.actions.length; i++) {
        if (shouldStop) break;

        const action = response.actions[i];
        broadcastLog('pending', `[${i + 1}/${response.actions.length}] ${action.type}: ${action.description || action.selector || action.url || ''}`);

        try {
          const result = await executeAction(action, tab, executionMode);
          broadcastLog('success', `[${i + 1}/${response.actions.length}] ${action.type}: Done`);

          if (result?.data) {
            broadcastLog('info', `Extracted: ${JSON.stringify(result.data).substring(0, 500)}`);
          }
          if (result?.text) {
            broadcastLog('info', result.text.substring(0, 2000));
          }
          if (result?.result) {
            broadcastLog('info', `Result: ${result.result.substring(0, 500)}`);
          }
        } catch (err) {
          broadcastLog('error', `[${i + 1}/${response.actions.length}] ${action.type} failed: ${err.message}`);
        }

        // In quiz mode: break at snapshot/screenshot boundaries so the model
        // sees updated page state before deciding next action.
        // Also break after drag actions so each drag can be verified.
        // In normal mode: execute all actions in the batch.
        if (executionMode === 'quiz') {
          if (action.type === 'snapshot' || action.type === 'screenshot') {
            if (i < response.actions.length - 1) {
              broadcastLog('info', `Pausing after ${action.type} to re-evaluate page state (${response.actions.length - i - 1} remaining actions deferred)`);
            }
            hitSnapshot = true;
            break;
          }
          // After a drag, pause to let the page process the drop, then break
          // so the next step re-scans and verifies the drag landed
          if (action.type === 'drag') {
            await new Promise(r => setTimeout(r, 800));
            if (i < response.actions.length - 1) {
              broadcastLog('info', `Pausing after drag to verify placement (${response.actions.length - i - 1} remaining actions deferred)`);
              hitSnapshot = true;  // treat like snapshot break so loop continues
              break;
            }
          }
        }
      }

      lastSummary = response.summary || 'Actions completed.';

      // Check if AI says the task is done
      // In quiz mode, ignore done=true if we broke at a snapshot (model assumed all actions ran)
      const isDone = response.done === true || response.done === 'true';
      if (isDone && !(hitSnapshot && executionMode === 'quiz')) {
        broadcastLog('info', `Complete: ${lastSummary}`);
        break;
      }

      // Pause between steps — longer in quiz mode after clicks
      const hadClicks = response.actions.some(a => a.type === 'click');
      const pauseMs = executionMode === 'quiz' && hadClicks ? 2500 : 800;
      await new Promise(r => setTimeout(r, pauseMs));
    }

    broadcastStatus('ready', 'Ready');
    broadcastExecutionState(false);

    return { result: lastSummary || 'Actions completed.' };
  } catch (err) {
    broadcastStatus('error', 'Error');
    broadcastExecutionState(false);
    return { error: err.message };
  } finally {
    isExecuting = false;
    shouldStop = false;
  }
}

// ── Page Context Gathering ──

async function getPageContext(tab, mode = 'normal') {
  const context = { url: tab.url, title: tab.title };

  // Ensure content script is injected in ALL frames (including cross-origin iframes)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content.js']
    });
  } catch { /* may fail on restricted pages, content_scripts manifest handles most cases */ }

  // Get DOM from top frame (frameId 0)
  try {
    const domResponse = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT' }, { frameId: 0 });
    if (domResponse) {
      context.dom = domResponse.dom;
    }
  } catch {
    context.dom = '[Could not inspect page DOM — may be a restricted page]';
  }

  // Collect visual maps from ALL frames (top + iframes)
  try {
    context.visualMap = await collectAllFrameVisualMaps(tab.id);

    // In quiz mode: retry if iframe content missing (iframe may still be loading after navigation)
    if (mode === 'quiz' && context.visualMap && !context.visualMap.includes('=== IFRAME CONTENT')) {
      for (let retry = 0; retry < 3; retry++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content.js']
          });
        } catch { /* ignore */ }
        context.visualMap = await collectAllFrameVisualMaps(tab.id);
        if (context.visualMap.includes('=== IFRAME CONTENT')) break;
      }
    }
  } catch {
    // Fall back to top frame only
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VISUAL_MAP' }, { frameId: 0 });
      context.visualMap = resp?.visualMap;
    } catch { /* no visual map */ }
  }

  try {
    context.screenshot = await captureScreenshot(tab.id);
  } catch {
    // Screenshot capture failed, continue without it
  }

  return context;
}

// ── Multi-Frame Visual Map Collection ──

// Send a message to a frame with a timeout to prevent hanging on non-responsive frames
function sendMessageWithTimeout(tabId, msg, opts, timeout = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    chrome.tabs.sendMessage(tabId, msg, opts)
      .then(resp => { clearTimeout(timer); resolve(resp); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

async function collectAllFrameVisualMaps(tabId) {
  // Use webNavigation.getAllFrames for reliable frame discovery
  // (more reliable than executeScript({allFrames}) after iframe navigation)
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }

  if (!frames || frames.length === 0) {
    // Fallback: just get top frame
    const resp = await sendMessageWithTimeout(tabId, { type: 'GET_VISUAL_MAP' }, { frameId: 0 });
    return resp?.visualMap || '';
  }

  // Filter to real content frames (skip about:blank, chrome-extension://, etc.)
  const contentFrames = frames.filter(f =>
    f.url && (f.url.startsWith('http://') || f.url.startsWith('https://'))
  );

  const maps = [];

  for (const frame of contentFrames) {
    // Ensure content script is injected in this frame
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        files: ['content.js']
      });
    } catch { /* may already be injected or frame is restricted */ }

    const resp = await sendMessageWithTimeout(
      tabId,
      { type: 'GET_VISUAL_MAP' },
      { frameId: frame.frameId },
      3000
    );

    if (resp?.visualMap) {
      maps.push({
        frameId: frame.frameId,
        url: frame.url,
        isTop: frame.parentFrameId === -1,
        map: resp.visualMap
      });
    }
  }

  if (maps.length === 0) return '';
  if (maps.length === 1) return maps[0].map;

  // Merge: top frame first, then child frames annotated with frameId
  let merged = '';
  // Top frame first
  const topFrame = maps.find(m => m.isTop);
  if (topFrame) {
    merged += topFrame.map + '\n\n';
  }
  // Child frames
  for (const m of maps) {
    if (m.isTop) continue;
    const header = `=== IFRAME CONTENT (frameId=${m.frameId}) ===`;
    const mapContent = m.map.replace('=== VISUAL PAGE MAP ===', header);
    merged += mapContent + '\n\n';
  }

  return merged.trim();
}

// ── Action Execution ──

async function executeAction(action, tab, mode = 'normal') {
  // Route DOM actions to the correct frame
  const sendOpts = {};
  if (action.frameId !== undefined && action.frameId !== null) {
    sendOpts.frameId = action.frameId;
  }

  switch (action.type) {
    case 'click':
    case 'type':
    case 'hover':
    case 'scroll':
    case 'extract':
    case 'evaluate':
    case 'keyboard':
    case 'select':
    case 'wait':
    case 'describe':
      return await chrome.tabs.sendMessage(tab.id, {
        type: 'EXECUTE_ACTION',
        action
      }, sendOpts);

    case 'drag':
      // Quiz mode: use click-click pattern (click source to select, click target to place)
      // Learnosity's accessibility mode supports this interaction model
      if (mode === 'quiz') {
        const fromSel = action.fromSelector || action.selector;
        const toSel = action.toSelector;
        broadcastLog('info', `Quiz drag: clicking source "${fromSel}" then target "${toSel}"`);

        // Click the draggable item to select it
        await chrome.tabs.sendMessage(tab.id, {
          type: 'EXECUTE_ACTION',
          action: { type: 'click', selector: fromSel, description: 'Select drag item' }
        }, sendOpts);

        // Brief pause to let the framework register the selection
        await new Promise(r => setTimeout(r, 500));

        // Click the drop target to place the item
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'EXECUTE_ACTION',
          action: { type: 'click', selector: toSel, description: 'Place in drop target' }
        }, sendOpts);

        const fromText = result?.text || fromSel;
        return { success: true, text: `Clicked "${fromSel}" → "${toSel}" (click-to-place)` };
      }

      // Normal mode: use CDP for trusted mouse events (synthetic events are ignored by most frameworks)
      try {
        return await executeDragViaCDP(action, tab, sendOpts);
      } catch (cdpErr) {
        // Fallback to content script synthetic events
        broadcastLog('info', `CDP drag failed (${cdpErr.message}), falling back to synthetic events`);
        return await chrome.tabs.sendMessage(tab.id, {
          type: 'EXECUTE_ACTION', action
        }, sendOpts);
      }

    case 'snapshot': {
      if (mode === 'quiz') {
        // Quiz mode: wait for iframes to load after page-changing actions
        await new Promise(r => setTimeout(r, 2000));

        // Re-inject content scripts into all frames (new iframes from navigation won't have it)
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content.js']
          });
        } catch { /* restricted page */ }

        let visualMap = await collectAllFrameVisualMaps(tab.id);

        // Retry if no iframe content found — during iframe navigation,
        // frame detection can fail even though the page has iframes
        if (!visualMap.includes('=== IFRAME CONTENT')) {
          for (let retry = 0; retry < 4; retry++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: ['content.js']
              });
            } catch { /* ignore */ }
            visualMap = await collectAllFrameVisualMaps(tab.id);
            if (visualMap.includes('=== IFRAME CONTENT')) break;
          }
        }

        return { success: true, text: visualMap };
      }

      // Normal mode: quick snapshot, no heavy retries
      const visualMap = await collectAllFrameVisualMaps(tab.id);
      return { success: true, text: visualMap };
    }

    case 'navigate':
      await chrome.tabs.update(tab.id, { url: action.url });
      await waitForTabLoad(tab.id);
      return { success: true };

    case 'screenshot': {
      const screenshot = await captureScreenshot(tab.id);
      // Also collect visual maps from all frames
      const visualMap = await collectAllFrameVisualMaps(tab.id);
      return { success: true, screenshot, text: visualMap };
    }

    case 'tab_new':
      const newTab = await chrome.tabs.create({ url: action.url || 'about:blank' });
      if (action.url) await waitForTabLoad(newTab.id);
      return { success: true, tabId: newTab.id };

    case 'tab_close':
      await chrome.tabs.remove(tab.id);
      return { success: true };

    case 'tab_switch':
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      if (action.index >= 0 && action.index < allTabs.length) {
        await chrome.tabs.update(allTabs[action.index].id, { active: true });
        return { success: true };
      }
      throw new Error(`Tab index ${action.index} out of range (0-${allTabs.length - 1})`);

    case 'tab_list':
      return await listTabsAndGroups();

    case 'tab_group_create':
      return await createTabGroup(action.name, action.color, action.tabIds);

    case 'tab_group_add':
      return await addTabsToGroup(action.groupId, action.tabIds);

    case 'tab_group_remove':
      return await removeTabGroup(action.groupId);

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

// ── CDP-Based Drag and Drop ──

async function executeDragViaCDP(action, tab, sendOpts) {
  const fromSelector = action.fromSelector || action.selector;
  const toSelector = action.toSelector;

  // Get element coordinates from the content script in the correct frame
  const coords = await chrome.tabs.sendMessage(tab.id, {
    type: 'EXECUTE_ACTION',
    action: { type: 'getDragCoords', fromSelector, toSelector }
  }, sendOpts);

  if (!coords?.success) {
    throw new Error(coords?.error || 'Could not get drag element coordinates');
  }

  let { fromX, fromY, toX, toY, fromText, toText } = coords;

  // If targeting an iframe, offset coords by the iframe's position in the page
  const frameId = action.frameId;
  if (frameId !== undefined && frameId !== null && frameId !== 0) {
    const offset = await getIframeOffset(tab.id);
    if (offset) {
      fromX += offset.left;
      fromY += offset.top;
      toX += offset.left;
      toY += offset.top;
    }
  }

  // Highlight the source element for visual feedback
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'HIGHLIGHT', selector: fromSelector, label: 'dragging'
    }, sendOpts);
  } catch { /* ignore */ }

  // Use CDP for trusted mouse events (event.isTrusted = true)
  await attachDebugger(tab.id);

  // Press on source
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(fromX), y: Math.round(fromY),
    button: 'left', clickCount: 1
  });
  await new Promise(r => setTimeout(r, 200));

  // Move smoothly to target in steps
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const x = fromX + (toX - fromX) * (i / steps);
    const y = fromY + (toY - fromY) * (i / steps);
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x), y: Math.round(y),
      button: 'left'
    });
    await new Promise(r => setTimeout(r, 40));
  }

  await new Promise(r => setTimeout(r, 100));

  // Release on target
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(toX), y: Math.round(toY),
    button: 'left', clickCount: 1
  });

  await new Promise(r => setTimeout(r, 300));

  // Hide highlight
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'HIDE_HIGHLIGHT' }, sendOpts);
  } catch { /* ignore */ }

  return { success: true, text: `Dragged "${fromText}" → "${toText}"` };
}

async function getIframeOffset(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          const rect = iframe.getBoundingClientRect();
          if (rect.width > 100 && rect.height > 100) {
            return { top: rect.top, left: rect.left };
          }
        }
        return null;
      }
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

// ── Chrome Debugger (CDP) Integration ──

async function attachDebugger(tabId) {
  if (debuggerAttachedTabs.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttachedTabs.add(tabId);
  } catch (err) {
    if (!err.message.includes('Already attached')) {
      throw err;
    }
    debuggerAttachedTabs.add(tabId);
  }
}

async function captureScreenshot(tabId) {
  await attachDebugger(tabId);

  const result = await chrome.debugger.sendCommand(
    { tabId },
    'Page.captureScreenshot',
    { format: 'png', quality: 80 }
  );

  return result.data;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttachedTabs.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerAttachedTabs.delete(source.tabId);
  }
});

// ── Tab Group Management ──

async function listTabsAndGroups() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });

  const groupMap = {};
  for (const group of groups) {
    groupMap[group.id] = {
      id: group.id,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
      tabs: []
    };
  }

  const ungrouped = [];

  for (const tab of tabs) {
    const tabInfo = {
      id: tab.id,
      index: tab.index,
      title: tab.title?.substring(0, 80),
      url: tab.url,
      active: tab.active
    };

    if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && groupMap[tab.groupId]) {
      groupMap[tab.groupId].tabs.push(tabInfo);
    } else {
      ungrouped.push(tabInfo);
    }
  }

  return {
    success: true,
    data: {
      groups: Object.values(groupMap),
      ungrouped
    },
    text: formatTabList(Object.values(groupMap), ungrouped)
  };
}

function formatTabList(groups, ungrouped) {
  let text = '';

  for (const group of groups) {
    text += `\n[Group: ${group.title || 'Untitled'} (${group.color})]${group.collapsed ? ' [collapsed]' : ''}\n`;
    for (const tab of group.tabs) {
      text += `  ${tab.active ? '>' : ' '} ${tab.index}: ${tab.title}\n`;
    }
  }

  if (ungrouped.length > 0) {
    text += '\n[Ungrouped]\n';
    for (const tab of ungrouped) {
      text += `  ${tab.active ? '>' : ' '} ${tab.index}: ${tab.title}\n`;
    }
  }

  return text.trim();
}

async function createTabGroup(name, color = 'blue', tabIds = []) {
  if (!tabIds || tabIds.length === 0) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabIds = [tab.id];
  }

  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, {
    title: name,
    color: color
  });

  return { success: true, groupId, text: `Created group "${name}" with ${tabIds.length} tab(s)` };
}

async function addTabsToGroup(groupId, tabIds) {
  if (!tabIds || tabIds.length === 0) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabIds = [tab.id];
  }

  await chrome.tabs.group({ tabIds, groupId });
  return { success: true, text: `Added ${tabIds.length} tab(s) to group` };
}

async function removeTabGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId });
  if (tabs.length > 0) {
    await chrome.tabs.ungroup(tabs.map(t => t.id));
  }
  return { success: true, text: 'Group removed' };
}

// ── Utilities ──

function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function broadcastStatus(status, text) {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status, text }).catch(() => {});
}

function broadcastLog(logType, text) {
  chrome.runtime.sendMessage({ type: 'ACTION_LOG', logType, text }).catch(() => {});
}

function broadcastExecutionState(running) {
  chrome.runtime.sendMessage({ type: 'EXECUTION_STATE', running }).catch(() => {});
}
