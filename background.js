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

    const MAX_STEPS = 15;
    const MAX_RETRIES = 3; // retries per step when model fails to produce actions
    let lastSummary = '';

    for (let step = 0; step < MAX_STEPS; step++) {
      if (shouldStop) {
        broadcastLog('info', 'Stopped by user');
        break;
      }

      // Re-inject content scripts (iframes may have navigated between steps)
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        });
      } catch { /* restricted page */ }

      // Gather fresh page context each step
      broadcastStatus('busy', step === 0 ? 'Analyzing page...' : `Step ${step + 1}: Re-analyzing...`);
      const pageContext = await getPageContext(tab);

      // Build message — first step gets original command, continuations remind about remaining work
      let message = step === 0
        ? command
        : `Continue the task: ${command}\n\nYou just completed step ${step}. Check the Visual Page Map carefully — look inside IFRAME sections for quiz items, questions, or forms that still need to be answered. If you see items remaining, answer them and click Next. Only set done=true when there are truly NO more items left.`;

      let response = null;
      let gotActions = false;

      // Inner retry loop: if model returns prose/no actions, send corrective prompt
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (shouldStop) break;

        broadcastStatus('busy', step === 0 && attempt === 0
          ? 'Thinking...'
          : `Step ${step + 1}${attempt > 0 ? ` (retry ${attempt})` : ''}: Thinking...`);

        response = await aiClient.sendMessage(message, pageContext);

        if (shouldStop) break;

        // Check if response has real executable actions
        const hasRealActions = response.actions?.some(a => a.type !== 'describe');
        if (response.actions && response.actions.length > 0 && hasRealActions) {
          gotActions = true;
          break; // Good response, proceed to execute
        }

        // Model returned no actions or prose — retry with corrective prompt
        if (attempt < MAX_RETRIES - 1) {
          broadcastLog('info', `Model returned no actions (attempt ${attempt + 1}/${MAX_RETRIES}), re-prompting...`);

          // Remove the failed exchange from conversation history so it doesn't reinforce bad behavior
          if (aiClient.conversationHistory.length >= 2) {
            aiClient.conversationHistory.splice(-2, 2);
          }

          // Send corrective prompt that explicitly demands JSON with actions
          message = `IMPORTANT: You must output JSON with an "actions" array containing click/type/select actions. Do NOT answer questions yourself — click the answers on the page. Do NOT write prose or explanations.\n\nTask: ${command}\n\nLook at the Visual Page Map above. Find the correct answer and output a click action for it.`;
        }
      }

      if (shouldStop) break;

      // After all retries, if still no actions, log and continue to next step (don't break the whole loop)
      if (!gotActions) {
        broadcastLog('info', response?.summary || 'Model could not produce actions after retries.');
        // Remove failed history entries
        if (aiClient.conversationHistory.length >= 2) {
          aiClient.conversationHistory.splice(-2, 2);
        }
        // On step 0 with no actions at all, we can't continue — break
        if (step === 0) {
          broadcastLog('error', 'Model failed to produce any actions. Try rephrasing the command or using a different model.');
          break;
        }
        // On later steps, the task may already be partially done — try one more re-scan
        continue;
      }

      // Execute actions
      broadcastStatus('busy', step === 0
        ? `Executing ${response.actions.length} action(s)...`
        : `Step ${step + 1}: Executing ${response.actions.length} action(s)...`);
      broadcastLog('info', response.thinking || 'Planning actions...');

      for (let i = 0; i < response.actions.length; i++) {
        if (shouldStop) break;

        const action = response.actions[i];
        broadcastLog('pending', `[${i + 1}/${response.actions.length}] ${action.type}: ${action.description || action.selector || action.url || ''}`);

        try {
          const result = await executeAction(action, tab);
          broadcastLog('success', `[${i + 1}/${response.actions.length}] ${action.type}: Done`);

          if (result?.data) {
            broadcastLog('info', `Extracted: ${JSON.stringify(result.data).substring(0, 200)}`);
          }
          if (result?.text) {
            broadcastLog('info', result.text.substring(0, 500));
          }
          if (result?.result) {
            broadcastLog('info', `Result: ${result.result.substring(0, 500)}`);
          }
        } catch (err) {
          broadcastLog('error', `[${i + 1}/${response.actions.length}] ${action.type} failed: ${err.message}`);
        }
      }

      lastSummary = response.summary || 'Actions completed.';

      // Check if AI says the task is done
      if (response.done === true || response.done === 'true') {
        broadcastLog('info', `Complete: ${lastSummary}`);
        break;
      }

      // Longer pause if actions included clicks (page/iframe may need to reload)
      const hadClicks = response.actions.some(a => a.type === 'click');
      const pauseMs = hadClicks ? 2500 : 800;
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

async function getPageContext(tab) {
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

async function collectAllFrameVisualMaps(tabId) {
  // Discover all frames by running a lightweight script in each
  let frameInfos;
  try {
    frameInfos = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        url: location.href,
        isTop: window === window.top,
      })
    });
  } catch {
    // Fall back to top frame only
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'GET_VISUAL_MAP' }, { frameId: 0 });
    return resp?.visualMap || '';
  }

  const maps = [];

  for (const frame of frameInfos) {
    try {
      const resp = await chrome.tabs.sendMessage(
        tabId,
        { type: 'GET_VISUAL_MAP' },
        { frameId: frame.frameId }
      );
      if (resp?.visualMap) {
        maps.push({
          frameId: frame.frameId,
          url: frame.result.url,
          isTop: frame.result.isTop,
          map: resp.visualMap
        });
      }
    } catch { /* frame may not have content script or may be restricted */ }
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

async function executeAction(action, tab) {
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

    case 'snapshot': {
      // Wait for iframes to load after page-changing actions (e.g. clicking Next)
      await new Promise(r => setTimeout(r, 1500));

      // Re-inject content scripts into all frames (new iframes from navigation won't have it)
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        });
      } catch { /* restricted page */ }

      let visualMap = await collectAllFrameVisualMaps(tab.id);

      // If page has child iframes but snapshot didn't capture them, wait and retry
      if (!visualMap.includes('=== IFRAME CONTENT')) {
        try {
          const frameCheck = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: () => window !== window.top
          });
          const hasChildFrames = frameCheck.some(f => f.result === true);
          if (hasChildFrames) {
            for (let retry = 0; retry < 3; retry++) {
              await new Promise(r => setTimeout(r, 2000));
              // Re-inject in case iframe just finished loading
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
        } catch { /* ignore */ }
      }

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
