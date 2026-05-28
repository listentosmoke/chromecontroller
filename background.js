// background.js — Service worker: orchestrates AI client, debugger, tab groups, and content scripts
import { AIClient, fetchModels, isGroqVisionModel, GROQ_DEFAULT_VISION_MODEL } from './ai-client.js';

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
  const saved = await chrome.storage.local.get([
    'groqVisionModel', 'searchEnabled', 'searchModel', 'searchProvider', 'searchApiKey'
  ]);
  const client = new AIClient(provider, apiKey, model, {
    groqVisionModel: saved.groqVisionModel || GROQ_DEFAULT_VISION_MODEL,
    searchEnabled:  !!saved.searchModel,
    searchModel:    saved.searchModel || '',
    searchProvider: saved.searchProvider || provider,
    searchApiKey:   apiKey,
  });
  const result = await client.validateKey();
  if (result.success) {
    aiClient = client;
  }
  return result;
}

// ── Ensure AI Client ──

async function ensureClient() {
  const saved = await chrome.storage.local.get([
    'aiProvider', 'aiModel', 'aiApiKey', 'groqVisionModel',
    'searchEnabled', 'searchModel', 'searchProvider', 'searchApiKey'
  ]);
  if (!saved.aiApiKey) {
    throw new Error('No API key configured. Open the popup to set one.');
  }
  if (!saved.aiModel) {
    throw new Error('No model selected. Open the popup, load models, and pick one.');
  }

  const groqVisionModel = saved.groqVisionModel || GROQ_DEFAULT_VISION_MODEL;
  const searchEnabled   = !!saved.searchModel;
  const searchModel     = saved.searchModel || '';
  const searchProvider  = saved.searchProvider || (saved.aiProvider || 'alibaba');
  const searchApiKey    = saved.aiApiKey;  // always uses primary API key

  // Rebuild if any relevant setting changed
  if (!aiClient ||
      aiClient.provider !== (saved.aiProvider || 'alibaba') ||
      aiClient.model !== saved.aiModel ||
      aiClient.apiKey !== saved.aiApiKey ||
      aiClient.groqVisionModel !== groqVisionModel ||
      aiClient.searchEnabled  !== searchEnabled  ||
      aiClient.searchModel    !== searchModel    ||
      aiClient.searchProvider !== searchProvider ||
      aiClient.searchApiKey   !== searchApiKey) {
    aiClient = new AIClient(
      saved.aiProvider || 'alibaba',
      saved.aiApiKey,
      saved.aiModel,
      { groqVisionModel, searchEnabled, searchModel, searchProvider, searchApiKey }
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

// ── Vision Need Detection ──
// Returns true ONLY when the IFRAME (quiz question area) contains large images
// with no readable text — i.e. image-based questions like equations or diagrams
// that the text model genuinely cannot understand from the visual map alone.
// Does NOT trigger for: draggable elements, outer-page images, small icons,
// or images that have alt text the text model can already read.
function detectNeedsVision(pageContext) {
  const map = pageContext.visualMap || '';

  // Only examine IFRAME content (where quiz questions live).
  // Outer-page images are navigation chrome — never worth a vision call.
  const iframeIdx = map.indexOf('=== IFRAME CONTENT');
  if (iframeIdx === -1) return false;

  const iframeContent = map.substring(iframeIdx);
  const lines = iframeContent.split('\n');

  for (const line of lines) {
    // Only care about IMG elements
    if (!line.includes('[IMG]') && !line.includes('[*IMG]')) continue;

    // Parse dimensions: @(x,y WxH) — skip small icons (< 50px either side)
    const dimMatch = line.match(/@\(\d+,\d+\s+(\d+)x(\d+)\)/);
    if (!dimMatch) continue;
    const w = parseInt(dimMatch[1], 10);
    const h = parseInt(dimMatch[2], 10);
    if (w < 50 || h < 50) continue;

    // Check for meaningful text after the selector.
    // Strip the sel="..." portion, then look for any remaining quoted text.
    const afterSel = line.replace(/sel="[^"]*"/, '');
    const textMatch = afterSel.match(/"([^"]*)"/);
    const textContent = textMatch ? textMatch[1].trim() : '';

    // Large image with no/minimal text → image-based question content
    if (textContent.length < 10) {
      return true;
    }
  }

  return false;
}

// ── Quiz Question Extraction (for automatic search) ──
// Parses the visual map's IFRAME section to extract the question text and answer
// options, which are then sent to the search model for automatic verification.
function extractQuizQuestion(visualMap) {
  if (!visualMap) return null;
  const iframeIdx = visualMap.indexOf('=== IFRAME CONTENT');
  if (iframeIdx === -1) return null;

  const iframeContent = visualMap.substring(iframeIdx);
  const lines = iframeContent.split('\n');
  const texts = [];

  for (const line of lines) {
    // Extract text content: the bare "text" that follows sel="selector"
    const match = line.match(/sel="[^"]*"\s+"([^"]+)"/);
    if (!match) continue;
    const text = match[1].trim();
    if (text.length < 3) continue;
    // Skip common UI button labels and "currently contains"/"select to move" Learnosity phrases
    if (/^(Next|Previous|Back|Submit|Cancel|Close|Save|Check Answer|Review|Finish|Done|OK|Item \d)$/i.test(text)) continue;
    if (/^(Currently contains|Select to move|Press enter)/i.test(text)) continue;
    texts.push(text);
  }

  if (texts.length === 0) return null;
  // First items are typically the question + answer options
  return texts.slice(0, 15).join(' | ');
}

// ── Stable Question Key (for search deduplication) ──
// Returns a stable identifier that does NOT change when drag tiles shift,
// i.e., based on the question number ("4 of 5") not the tile content.
// This prevents re-searching after each tile placement in drag-and-drop questions.
function extractQuestionKey(visualMap) {
  if (!visualMap) return null;
  // Match "N of M Items" pattern, which is stable across tile changes
  const itemMatch = visualMap.match(/\b(\d+) of (\d+) Items?\b/i);
  if (itemMatch) return `item:${itemMatch[1]}/${itemMatch[2]}`;
  // Fallback: use the first 80 chars of the iframe content header
  const idx = visualMap.indexOf('=== IFRAME CONTENT');
  if (idx !== -1) return visualMap.substring(idx, idx + 80);
  return null;
}

// ── Intent Guardrails ──

function commandAllowsLogin(command) {
  return /\b(log\s*in|sign\s*in|signin|authenticate|use (my|the) .{0,20}account|enter .{0,20}(credentials|password))\b/i.test(command || '');
}

function commandLooksLikePublicDiscovery(command) {
  if (commandAllowsLogin(command)) return false;
  return /\b(look up|find|search|research|list|collect|contractors?|businesses?|companies?|pages?|profiles?)\b/i.test(command || '');
}

function commandNeedsPublicDiscoveryBootstrap(command) {
  return commandLooksLikePublicDiscovery(command);
}

function buildPublicDiscoverySearchQuery(command) {
  const text = String(command || '').trim();

  const terms = text
    .replace(/\b(look up|find|search for|search|research|list|collect)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return (terms || text).replace(/\s+/g, ' ');
}

function getActionMapLine(action, visualMap) {
  if (!visualMap) return '';
  const selectors = [action.selector, action.fromSelector, action.toSelector, action.refId, action.fromRefId, action.toRefId]
    .filter(Boolean)
    .map(String);
  if (selectors.length === 0) return '';

  return visualMap
    .split('\n')
    .find(line => selectors.some(sel => line.includes(sel))) || '';
}

function pageLooksLikeAuthWall(pageContext) {
  const haystack = `${pageContext?.url || ''}\n${pageContext?.title || ''}\n${pageContext?.visualMap || ''}`.toLowerCase();
  const hasCredentialInput = haystack.includes('input[password]') ||
    /\b(password|email or mobile|email address|username)\b/.test(haystack);
  const hasAuthAction = /\b(log in|login|sign in|signin|create new account|forgot password)\b/.test(haystack);
  return hasCredentialInput && hasAuthAction;
}

function lineLooksLikeCredentialField(line) {
  const lower = (line || '').toLowerCase();
  return lower.includes('input[password]') ||
    /\b(password|email or mobile|email address|username|phone number)\b/.test(lower);
}

function lineLooksLikeTextEntry(line) {
  const lower = (line || '').toLowerCase();
  return lower.includes('[*input') || lower.includes('[input') || lower.includes('[*textarea') || lower.includes('[textarea');
}

function lineLooksLikeLoginSubmit(line) {
  const lower = (line || '').toLowerCase();
  if (!/\b(log in|login|sign in|signin)\b/.test(lower)) return false;
  return lower.includes('[*') || lower.includes('aria=') || lower.includes('role="button"');
}

function validateActionAgainstIntent(action, command, pageContext) {
  if (!action || commandAllowsLogin(command)) return null;

  if (commandLooksLikePublicDiscovery(command) && action.type === 'navigate') {
    const url = normalizeUrlForMemory(action.url);
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '');
      const label = host.split('.')[0];
      const isRoot = parsed.pathname === '/' || parsed.pathname === '';
      const commandNamesDomain = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(command || '');

      if (commandNamesDomain && isRoot) {
        return `Blocked direct ${host} homepage navigation for a public discovery task. Use web_search, then inspect specific result URLs.`;
      }

      if (commandNamesDomain && /\/(login|signin|auth|search)(\/|\?|$)/i.test(parsed.pathname + parsed.search)) {
        return `Blocked direct ${host} login/search navigation for a public discovery task. Use web_search, then inspect specific result URLs.`;
      }
    } catch { /* non-URL validation handled elsewhere */ }

    if (/\/(login|signin|auth)(\/|\?|$)/i.test(url)) {
      return 'Blocked auth-page navigation for a public research task. Use web_search, then inspect public result URLs.';
    }
    if (/^https:\/\/(www\.)?google\.com\/?(\?.*)?$/.test(url) ||
        /^https:\/\/(www\.)?bing\.com\/?(\?.*)?$/.test(url)) {
      return 'Blocked search-engine home navigation for a public research task. Use web_search with the query instead of opening Google/Bing and typing.';
    }
  }

  if (commandLooksLikePublicDiscovery(command) && action.type === 'type') {
    const currentUrl = normalizeUrlForMemory(pageContext?.url || '');
    if (/^https:\/\/(www\.)?(google|bing)\.com\//.test(currentUrl)) {
      return 'Blocked typing into a search-engine page for public research. Use web_search with the query so search does not depend on fragile DOM typing.';
    }
  }

  if (commandLooksLikePublicDiscovery(command) &&
      action.type === 'tab_switch' &&
      !/\b(tab|switch|current|open)\b/i.test(command || '')) {
    return 'Blocked tab switching during public discovery because existing tabs may be stale. Use web_search and inspect_urls unless the user explicitly asks to use open tabs.';
  }

  if (!pageLooksLikeAuthWall(pageContext)) return null;

  const line = getActionMapLine(action, pageContext?.visualMap);

  if (action.type === 'type' && (lineLooksLikeCredentialField(line) || lineLooksLikeTextEntry(line))) {
    return 'Blocked login-field typing because this command looks like public research, not a login task. Do not invent or enter credentials. Use public web search/site-specific Facebook search results instead.';
  }

  if (action.type === 'click' && lineLooksLikeLoginSubmit(line)) {
    return 'Blocked login submission because this command looks like public research, not a login task. Do not log in. Back out to public search results or search the web for public Facebook contractor pages.';
  }

  return null;
}

function validateActionShape(action) {
  if (!action || typeof action !== 'object') return 'Action must be an object.';
  if (!action.type) return 'Action is missing required "type".';

  const needsSelector = new Set(['click', 'type', 'hover', 'extract', 'select']);
  if (needsSelector.has(action.type) && !action.selector && !action.refId) {
    return `${action.type} action is missing required "selector" or "refId". Use a selector/ref from the current Visual Page Map or Accessibility Tree, or use web_search/navigate when no DOM target is needed.`;
  }

  if (action.type === 'type' && (action.text === undefined || action.text === null || String(action.text).length === 0)) {
    return 'type action is missing required "text". For search tasks, prefer web_search instead of typing into Google.';
  }

  if (action.type === 'navigate' && !action.url) return 'navigate action is missing required "url".';
  if (action.type === 'tab_new' && action.url !== undefined && typeof action.url !== 'string') return 'tab_new url must be a string.';
  if (action.type === 'keyboard' && !action.key) return 'keyboard action is missing required "key".';
  if (action.type === 'evaluate' && !action.expression) return 'evaluate action is missing required "expression".';
  if (action.type === 'select' && action.value === undefined) return 'select action is missing required "value".';
  if (action.type === 'web_search' && !action.query) return 'web_search action is missing required "query".';
  if (action.type === 'tab_switch' &&
      action.index === undefined &&
      !action.direction &&
      !action.query &&
      !action.title &&
      !action.urlContains &&
      !action.match) {
    return 'tab_switch requires "index", "direction", or "query". For public research, prefer web_search instead of switching tabs.';
  }
  if (action.type === 'inspect_urls' && (!Array.isArray(action.urls) || action.urls.length === 0)) {
    return 'inspect_urls action requires a non-empty "urls" array.';
  }
  if (action.type === 'export_data' && normalizeExportRows(action).length === 0) {
    return 'export_data action requires non-empty "rows" or "data".';
  }
  if (action.type === 'drag' && (!(action.fromSelector || action.selector || action.fromRefId || action.refId) || !(action.toSelector || action.toRefId))) {
    return 'drag action requires "fromSelector" or "fromRefId" (or selector/refId), and "toSelector" or "toRefId".';
  }

  return null;
}

function normalizeUrlForMemory(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname !== '/') {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString().toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function extractLineText(line) {
  if (!line) return '';
  const textMatch = line.match(/sel="[^"]*"\s+"([^"]+)"/);
  if (textMatch) return textMatch[1].trim();
  const ariaMatch = line.match(/aria="([^"]+)"/);
  return ariaMatch ? ariaMatch[1].trim() : '';
}

function extractLineHref(line) {
  return line?.match(/href="([^"]+)"/)?.[1] || '';
}

function getActionMemoryTarget(action, pageContext) {
  if (!action) return null;

  if (action.type === 'navigate' || action.type === 'tab_new') {
    const url = normalizeUrlForMemory(action.url);
    return url ? { kind: 'url', key: url, label: action.url } : null;
  }

  if (action.type === 'click') {
    const line = getActionMapLine(action, pageContext?.visualMap);
    const href = normalizeUrlForMemory(extractLineHref(line));
    if (href) return { kind: 'url', key: href, label: extractLineHref(line) };

    const text = extractLineText(line);
    if (text) {
      const pageUrl = normalizeUrlForMemory(pageContext?.url || '');
      return { kind: 'click', key: `${pageUrl}|${action.selector}|${text}`.toLowerCase(), label: text };
    }
  }

  return null;
}

function getActionDuplicateReason(action, pageContext, runMemory) {
  if (action?.type === 'web_search') {
    const query = String(action.query || '').trim().toLowerCase();
    if (!query) return null;
    const uninspected = getUninspectedCandidateUrls(runMemory, 5);
    if (uninspected.length >= 3) {
      action.type = 'inspect_urls';
      action.urls = uninspected;
      action.maxUrls = uninspected.length;
      delete action.query;
      delete action.engine;
      return null;
    }
    if (runMemory.inspectCount > 0 && runMemory.exportCount === 0) {
      return 'You have already inspected candidate URLs. Compile the findings into export_data rows before doing another web_search. Include fields like name, sourceUrl, platform, phone, website, email, address, notes, and confidence.';
    }
    if (runMemory.searches.has(query)) {
      return `Already searched for "${action.query}". Broaden or change the query instead of repeating it.`;
    }
    return null;
  }

  if (action?.type === 'inspect_urls') {
    const urls = Array.isArray(action.urls) ? action.urls : [];
    const freshUrls = [];
    const skippedUrls = [];

    for (const url of urls) {
      const key = normalizeUrlForMemory(url);
      if (!key) continue;
      if (runMemory.urls.has(key)) {
        skippedUrls.push(url);
      } else {
        freshUrls.push(url);
      }
    }

    action.urls = freshUrls;
    if (skippedUrls.length > 0) {
      runMemory.notes.push(`Skipped already-inspected URLs: ${skippedUrls.slice(0, 5).join(', ')}`);
    }
    if (freshUrls.length === 0 && urls.length > 0) {
      return 'All requested URLs were already tried in this run. Choose different contractor/page candidates or broaden the search query.';
    }
    return null;
  }

  const target = getActionMemoryTarget(action, pageContext);
  if (!target) return null;

  const seen = target.kind === 'url'
    ? runMemory.urls.has(target.key)
    : runMemory.clicks.has(target.key);

  if (!seen) return null;
  return `Already tried ${target.kind === 'url' ? 'URL' : 'target'} "${target.label}". Choose a new result instead of repeating it.`;
}

function recordActionTarget(action, pageContext, runMemory) {
  if (action?.type === 'web_search') {
    const query = String(action.query || '').trim().toLowerCase();
    if (query) runMemory.searches.add(query);
    return;
  }

  if (action?.type === 'inspect_urls' && Array.isArray(action.urls)) {
    for (const url of action.urls) {
      const key = normalizeUrlForMemory(url);
      if (key) runMemory.urls.add(key);
    }
    return;
  }

  const target = getActionMemoryTarget(action, pageContext);
  if (!target) return;
  if (target.kind === 'url') {
    runMemory.urls.add(target.key);
  } else {
    runMemory.clicks.add(target.key);
  }
}

function addCandidateLinks(links, runMemory) {
  if (!Array.isArray(links)) return;
  for (const link of links) {
    const key = normalizeUrlForMemory(link?.href);
    if (!key) continue;
    if (!runMemory.candidates.has(key)) {
      runMemory.candidates.set(key, {
        url: link.href,
        text: String(link.text || '').trim(),
      });
    }
  }
}

function getUninspectedCandidateUrls(runMemory, limit = 8) {
  const urls = [];
  for (const [key, candidate] of runMemory.candidates) {
    if (!runMemory.urls.has(key)) urls.push(candidate.url);
    if (urls.length >= limit) break;
  }
  return urls;
}

function addNamesFromRows(rows, runMemory) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    const name = row?.name || row?.business || row?.contractor || row?.company;
    if (name) runMemory.names.add(String(name).trim().toLowerCase());
  }
}

function getPlatformFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeLeadName(title, url) {
  let name = String(title || '').trim();
  name = name
    .replace(/\s*[\-|]\s*(Facebook|Instagram|LinkedIn|Yelp|TikTok).*$/i, '')
    .replace(/\s*-\s*About\s*$/i, '')
    .replace(/\s*\(@[^)]+\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (name) return name;

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return decodeURIComponent(parts[0] || parsed.hostname).replace(/[-_]/g, ' ');
  } catch {
    return '';
  }
}

function uniqueMatches(text, regex, limit = 5) {
  const seen = new Set();
  const results = [];
  for (const match of String(text || '').matchAll(regex)) {
    const value = (match[0] || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    results.push(value);
    if (results.length >= limit) break;
  }
  return results;
}

function extractAddress(text) {
  const withoutPhones = String(text || '').replace(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g, ' ');
  const match = withoutPhones.match(/\b\d{2,6}\s+[A-Za-z0-9.'#\- ]{3,80}\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Way|Ct|Court|Cir|Circle|Pkwy|Parkway)\b(?:[, ]+[A-Za-z .'-]{2,40})?(?:[, ]+[A-Z]{2})?(?:\s+\d{5}(?:-\d{4})?)?/i);
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}

function isLikelyExternalWebsite(href, sourceUrl) {
  if (!href || !/^https?:\/\//i.test(href)) return false;
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, '');
    const sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, '');
    if (host === sourceHost) return false;
    if (/(^|\.)facebook\.com$|(^|\.)m\.facebook\.com$|(^|\.)instagram\.com$|(^|\.)linkedin\.com$|(^|\.)tiktok\.com$|(^|\.)yelp\.com$/.test(host)) return false;
    if (/(^|\.)google\.com$|(^|\.)bing\.com$|(^|\.)duckduckgo\.com$|(^|\.)accounts\.google\.com$|(^|\.)support\.google\.com$|(^|\.)meta\.com$/.test(host)) return false;
    if (/\/(login|signin|signup|recover|privacy|terms)(\/|$)/i.test(url.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function extractWebsite(pageLinks, sourceUrl) {
  const link = (Array.isArray(pageLinks) ? pageLinks : []).find(l => isLikelyExternalWebsite(l.href, sourceUrl));
  return link?.href || '';
}

function extractLeadRowFromInspection(result) {
  if (!result?.success) return null;

  const sourceUrl = result.finalUrl || result.requestedUrl || '';
  const platform = getPlatformFromUrl(sourceUrl);
  const combinedText = [
    result.title,
    result.visualMap,
    result.dom,
    result.domContext?.text,
    ...(result.domContext?.headings || []).map(h => h.text),
    ...(result.domContext?.links || []).map(l => `${l.text || ''} ${l.href || ''}`),
    ...(result.domContext?.controls || []).map(c => `${c.text || ''} ${c.ariaLabel || ''} ${c.placeholder || ''}`),
    ...(Array.isArray(result.pageLinks) ? result.pageLinks.map(l => `${l.text || ''} ${l.href || ''}`) : [])
  ].join('\n');

  const phones = [...new Set([...(result.domContext?.contacts?.phones || []), ...uniqueMatches(combinedText, /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g, 3)])].slice(0, 3);
  const emails = [...new Set([...(result.domContext?.contacts?.emails || []), ...uniqueMatches(combinedText, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 3)])].slice(0, 3);
  const website = extractWebsite([...(result.domContext?.links || []), ...(result.pageLinks || [])], sourceUrl);
  const address = extractAddress(combinedText);
  const isAuthWall = /\b(Log In|Forgot Account|Email or phone|Password|See more on Facebook)\b/i.test(combinedText) ||
    combinedText.toLowerCase().includes('input[password]');

  const notes = [];
  if (!website) notes.push('No external website found/listed in inspected public content.');
  if (isAuthWall) notes.push('Page appears partially blocked by login wall; details may be incomplete.');
  if (!phones.length) notes.push('No phone found in inspected public content.');
  if (!emails.length) notes.push('No email found in inspected public content.');

  const confidence = website
    ? 'low'
    : (phones.length || emails.length || address ? (isAuthWall ? 'medium' : 'high') : 'medium');

  return {
    name: normalizeLeadName(result.title, sourceUrl),
    sourceUrl,
    platform,
    phone: phones.join('; '),
    website,
    email: emails.join('; '),
    address,
    notes: notes.join(' '),
    confidence,
  };
}

function addLeadRowsFromInspectionResults(results, runMemory) {
  if (!Array.isArray(results)) return [];
  const added = [];
  for (const result of results) {
    const row = extractLeadRowFromInspection(result);
    if (!row?.sourceUrl) continue;
    const key = normalizeUrlForMemory(row.sourceUrl);
    if (!key || runMemory.leadRowUrls.has(key)) continue;
    runMemory.leadRowUrls.add(key);
    runMemory.leadRows.push(row);
    added.push(row);
  }
  addNamesFromRows(added, runMemory);
  return added;
}

function slugForFilename(text) {
  return String(text || 'research')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'research';
}

function formatRunMemory(runMemory) {
  const urls = Array.from(runMemory.urls).slice(-12);
  const searches = Array.from(runMemory.searches).slice(-8);
  const candidates = Array.from(runMemory.candidates.values()).slice(-12);
  const names = Array.from(runMemory.names).slice(-12);
  const leadRows = runMemory.leadRows.slice(-8);
  const notes = runMemory.notes.slice(-6);
  const lines = ['=== RUN MEMORY ==='];
  if (searches.length > 0) lines.push(`Searches already tried: ${searches.join(' | ')}`);
  if (candidates.length > 0) {
    lines.push('Candidate result URLs: ' + candidates.map(c => `${c.text ? `${c.text} - ` : ''}${c.url}`).join(' | '));
  }
  if (urls.length > 0) lines.push(`Tried URLs: ${urls.join(' | ')}`);
  if (names.length > 0) lines.push(`Known names/leads: ${names.join(' | ')}`);
  if (leadRows.length > 0) {
    lines.push('Compiled lead rows: ' + leadRows.map(r => `${r.name || '(unnamed)'} | phone=${r.phone || ''} | website=${r.website || ''} | source=${r.sourceUrl}`).join(' || '));
  }
  if (runMemory.exports.length > 0) {
    lines.push('Artifacts exported: ' + runMemory.exports.map(e => e.filename).join(' | '));
  }
  if (notes.length > 0) lines.push(`Notes: ${notes.join(' | ')}`);
  if (runMemory.inspectCount > 0 && runMemory.exportCount === 0) {
    lines.push('Next expected step: compile inspected findings into export_data rows, or inspect fresh candidate URLs if required fields are still missing.');
  }
  lines.push('Avoid repeating these. Inspect fresh URLs or broaden the query when stuck.');
  lines.push('=== END RUN MEMORY ===');
  return lines.join('\n');
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

    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');

    const MAX_RETRIES = 3;
    let lastSummary = '';
    let executionMode = 'normal'; // AI can switch to 'quiz' dynamically
    let lastFullVisualMap = null; // For diff-based snapshots in quiz mode
    let lastSearchResults = null; // Injected into the next step when search fires
    let lastSearchedQuestion = null; // Track last searched question to avoid re-searching
    let lastGuardrailNotice = null; // Explains blocked unsafe actions to the next model turn
    let lastInspectionResults = null; // Injected into the next step after inspect_urls
    const runMemory = {
      searches: new Set(),
      urls: new Set(),
      clicks: new Set(),
      names: new Set(),
      notes: [],
      candidates: new Map(),
      leadRows: [],
      leadRowUrls: new Set(),
      exports: [],
      inspectCount: 0,
      exportCount: 0,
    };
    const bootstrapPublicDiscovery = commandNeedsPublicDiscoveryBootstrap(command);

    if (bootstrapPublicDiscovery) {
      const query = buildPublicDiscoverySearchQuery(command);
      broadcastStatus('busy', 'Searching public web results...');
      broadcastLog('info', `Starting with public web search instead of active-page browsing: "${query}"`);
      const searchResult = await webSearchInBackground({ type: 'web_search', query, maxResults: 15 });
      runMemory.searches.add(query.toLowerCase());
      if (searchResult?.text) {
        lastInspectionResults = searchResult.text;
        broadcastLog('info', searchResult.text.substring(0, 2000));
        lastSummary = 'Started with public web search results.';
      } else {
        lastGuardrailNotice = 'Initial public web search did not return usable results. Try a broader web_search query before using active-page navigation.';
      }
    }

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

      // Detect if this page needs vision (images, drag-drop, image-only questions).
      // When vision is needed: flag it so the AI client can route to a vision model,
      // and ensure a screenshot is always captured so the model can see the page.
      const needsVision = detectNeedsVision(pageContext);
      if (needsVision) {
        pageContext.needsVision = true;
        if (!pageContext.screenshot) {
          // Screenshot capture may have failed earlier — retry now
          try {
            pageContext.screenshot = await captureScreenshot(tab.id);
          } catch { /* non-fatal */ }
        }
        // Log the two-step vision handoff only on the first step
        if (step === 0 && aiClient.provider === 'groq' && !isGroqVisionModel(aiClient.model)) {
          broadcastLog('info', `Page has images/drag-drop — vision analyst (${aiClient.groqVisionModel}) will describe screenshot, then ${aiClient.model} decides actions`);
        }
      }

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

      // ── Automatic search: when in quiz mode with search enabled, extract the
      //    question from the iframe and call the search model BEFORE the AI acts.
      //    Uses a STABLE question key (item number) so re-search does NOT fire
      //    after each drag tile is placed (tile list changes but item number stays same).
      if (executionMode === 'quiz' && aiClient.searchEnabled) {
        const questionKey = extractQuestionKey(fullVisualMap);
        if (questionKey && questionKey !== lastSearchedQuestion) {
          lastSearchResults = null;  // clear old results before new question search
          lastSearchedQuestion = questionKey;  // set immediately — prevents re-firing even if search fails
          const question = extractQuizQuestion(fullVisualMap);
          if (question) {
            broadcastLog('info', `Auto-searching: "${question.substring(0, 120)}..."`);
            broadcastStatus('busy', 'Verifying answer via web search...');
            try {
              const searchResult = await aiClient.executeSearch(question, { ...pageContext, visualMap: fullVisualMap });
              if (searchResult) {
                lastSearchResults = searchResult;
                broadcastLog('info', `Search answer: ${searchResult.substring(0, 300)}`);
              }
            } catch (err) {
              broadcastLog('error', `Search failed: ${err.message}`);
            }
          }
        }
      }

      // Build message — mode-specific continuation prompts
      let message;
      if (step === 0) {
        message = `Command: ${command}\n\nController capabilities available now:\n- web_search(query): background web search for public discovery; use instead of typing into search engines.\n- inspect_urls(urls): inspect several candidate pages in inactive tabs without changing the active page.\n- export_data(rows, format): download structured findings for Excel/Sheets/JSON.\n- Active-page click/type/navigation: use only when a visible page interaction is necessary.\n\nChoose the highest-level reliable tool first.`;
        if (commandLooksLikePublicDiscovery(command)) {
          message += '\n\nIntent hint: This is a public discovery/research task. Do not log in or enter credentials. If a target site shows an auth wall, use public search results, site-specific search URLs, or already-visible public pages. Use web_search first if no WEB SEARCH RESULTS are provided. Do not navigate to a target-site home/login page or to google.com/bing.com to type a query. Collect several candidate URLs and use inspect_urls to inspect them in background tabs before opening any one result. Track unique leads and use export_data when you have useful rows.';
        }
        if (bootstrapPublicDiscovery) {
          message += '\n\nThe controller already performed the required public web_search before this first model turn. Use the provided WEB SEARCH RESULTS now. Do not navigate to target-site home/login/search pages, do not use active-page Google typing, and do not switch tabs looking for a search page.';
        }
      } else if (executionMode === 'quiz') {
        message = `Continue: ${command}\n\nStep ${step} done. Look at the IFRAME section for the current question. Navigation/lesson buttons (Next, Start Lesson, Check Answer, Submit) are on the OUTER PAGE — use NO frameId for them.\n\nYou MUST:\n1) Read the question text carefully.\n2) In your "thinking" field, reason through the answer — state the question, consider each option, explain why one is correct.\n3) Click the CORRECT answer(s). Radio = one answer. Checkboxes = multiple correct.\n4) For drag-and-drop: use the "drag" action with fromSelector and toSelector — it will click the source item then click the drop target. Do ONE item at a time, then snapshot to verify before doing the next.\n5) Click Next (outer page, no frameId), then snapshot.\n\nIf an answer is already selected, verify it. If wrong, fix it. If a modal appears, click Cancel and answer first. Set done=true ONLY when ALL items are complete.`;
      } else {
        message = `Continue: ${command}\n\nStep ${step} done. IMPORTANT: After opening a new tab or switching tabs, your first action MUST be a snapshot to see what is on that page before clicking anything. Outer-page buttons (navigation, "Start Lesson", "Next", lesson controls) need NO frameId — only elements inside === IFRAME CONTENT (frameId=N) === sections use frameId.`;
      }

      // Inject search results on EVERY step until the question changes.
      // Drag-and-drop questions need the answer mapping on each step (one tile per step).
      if (lastSearchResults) {
        message += `\n\n=== SEARCH RESULTS ===\n${lastSearchResults}\n=== END SEARCH RESULTS ===\n\nUse the search results above to select the correct answer. For drag-and-drop, match EACH tile to the correct zone based on these results.`;
      }
      if (lastInspectionResults) {
        message += `\n\n${lastInspectionResults}\n\nUse these URL/search inspection results to extract facts. For lead/research tasks, compile rows with fields: name, sourceUrl, platform, phone, website, email, address, notes, confidence. Use export_data once you have inspected candidates; use empty strings for unknown fields and notes for blocked or partial pages.`;
        lastInspectionResults = null;
      }
      if (lastGuardrailNotice) {
        message += `\n\n=== BLOCKED ACTION FEEDBACK ===\n${lastGuardrailNotice}\nChoose a different public-discovery strategy. Do not repeat the blocked login action.\n=== END BLOCKED ACTION FEEDBACK ===`;
        lastGuardrailNotice = null;
      }
      if (runMemory.searches.size > 0 || runMemory.urls.size > 0 || runMemory.names.size > 0 ||
          runMemory.notes.length > 0 || runMemory.candidates.size > 0 || runMemory.inspectCount > 0 ||
          runMemory.leadRows.length > 0 || runMemory.exports.length > 0) {
        message += `\n\n${formatRunMemory(runMemory)}`;
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
          message = `IMPORTANT: You must output JSON with an "actions" array containing executable actions. Do NOT answer questions yourself — click the answers on the page. Do NOT write prose or explanations. If this is a public research task, use web_search instead of typing into Google. If the page is a login/auth wall, do NOT type credentials or click Log In; use public search/navigation instead.\n\nTask: ${command}\n\nLook at the Visual Page Map above and output actions.`;
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
      let blockedAction = false;
      for (let i = 0; i < response.actions.length; i++) {
        if (shouldStop) break;

        const action = response.actions[i];
        broadcastLog('pending', `[${i + 1}/${response.actions.length}] ${action.type}: ${action.description || action.selector || action.url || ''}`);

        try {
          const shapeReason = validateActionShape(action);
          if (shapeReason) {
            lastGuardrailNotice = `Invalid action: ${shapeReason}`;
            blockedAction = true;
            broadcastLog('error', `[${i + 1}/${response.actions.length}] ${action.type || 'action'} invalid: ${shapeReason}`);
            hitSnapshot = true;
            break;
          }

          const blockedReason = validateActionAgainstIntent(action, command, pageContext);
          if (blockedReason) {
            lastGuardrailNotice = blockedReason;
            blockedAction = true;
            broadcastLog('error', `[${i + 1}/${response.actions.length}] ${action.type} blocked: ${blockedReason}`);
            hitSnapshot = true;
            break;
          }

          const duplicateReason = getActionDuplicateReason(action, pageContext, runMemory);
          if (duplicateReason) {
            lastGuardrailNotice = duplicateReason;
            blockedAction = true;
            broadcastLog('error', `[${i + 1}/${response.actions.length}] ${action.type} skipped: ${duplicateReason}`);
            hitSnapshot = true;
            break;
          }

          recordActionTarget(action, pageContext, runMemory);
          if (action.type === 'export_data') {
            addNamesFromRows(normalizeExportRows(action), runMemory);
          }

          const result = await executeAction(action, tab, executionMode);
          const ok = result?.success !== false;
          broadcastLog(ok ? 'success' : 'error',
            `[${i + 1}/${response.actions.length}] ${action.type}: ${ok ? 'Done' : (result?.text || 'Failed')}`);

          if (result?.data) {
            broadcastLog('info', `Extracted: ${JSON.stringify(result.data).substring(0, 500)}`);
          }
          // For search results: store them so the NEXT step injects them into the AI message
          if (action.type === 'search' && result?.text) {
            lastSearchResults = result.text;
            broadcastLog('info', `Search answer: ${result.text.substring(0, 600)}`);
          } else if (action.type === 'web_search' && result?.text) {
            addCandidateLinks(result.data?.links, runMemory);
            lastInspectionResults = result.text;
            broadcastLog('info', result.text.substring(0, 2000));
          } else if (action.type === 'inspect_urls' && result?.text) {
            runMemory.inspectCount++;
            const addedRows = commandLooksLikePublicDiscovery(command)
              ? addLeadRowsFromInspectionResults(result.fullResults, runMemory)
              : [];
            if (addedRows.length > 0) {
              broadcastLog('info', `Compiled ${addedRows.length} lead row(s) from inspected pages.`);
              if (runMemory.exportCount === 0) {
                const exportResult = await exportDataFile({
                  type: 'export_data',
                  filename: `${slugForFilename(command)}-leads.csv`,
                  format: 'csv',
                  rows: runMemory.leadRows,
                });
                if (exportResult?.success !== false) {
                  runMemory.exportCount++;
                  runMemory.exports.push(exportResult.data);
                  broadcastLog('success', exportResult.text);
                  broadcastArtifact(exportResult.data);
                }
              }
            }
            lastInspectionResults = result.text;
            broadcastLog('info', result.text.substring(0, 2000));
          } else if (action.type === 'export_data' && result?.success !== false) {
            runMemory.exportCount++;
            if (result.data) {
              runMemory.exports.push(result.data);
              broadcastArtifact(result.data);
            }
          } else if (result?.text && action.type !== 'search') {
            broadcastLog('info', result.text.substring(0, 2000));
          }
          if (result?.result) {
            broadcastLog('info', `Result: ${result.result.substring(0, 500)}`);
          }

          // After opening a new tab, shift execution context to it so subsequent
          // clicks/snapshots/etc. operate on the new tab instead of the old one.
          if (action.type === 'tab_new' && result?.tabId) {
            try {
              tab = await chrome.tabs.get(result.tabId);
              broadcastLog('info', `Execution context → new tab (${tab.url || 'about:blank'})`);
            } catch { /* tab may have been closed */ }
          }
          // After switching tabs, update context to whichever tab is now active.
          if (action.type === 'tab_switch' && result?.success) {
            try {
              const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (active) {
                tab = active;
                broadcastLog('info', `Execution context → tab[${action.index}]: ${tab.title || tab.url}`);
              }
            } catch { /* ignore */ }
          }
        } catch (err) {
          lastGuardrailNotice = `Action failed: ${action.type} ${action.selector || action.url || action.query || ''} - ${err.message}. Do not repeat the same failed action. If this was search typing, use web_search instead.`;
          blockedAction = true;
          hitSnapshot = true;
          broadcastLog('error', `[${i + 1}/${response.actions.length}] ${action.type} failed: ${err.message}`);
          break;
        }

        // Break the action batch at boundaries that require the AI to re-evaluate:
        //   snapshot / screenshot — page state changed
        //   search               — results need to be injected into the next message
        //   tab_new / tab_switch — new page loaded; must snapshot before clicking anything
        //   drag (quiz only)     — verify placement before next drag
        const isBreakPoint = action.type === 'snapshot' || action.type === 'screenshot' || action.type === 'search'
          || action.type === 'web_search' || action.type === 'inspect_urls' || action.type === 'export_data'
          || action.type === 'tab_new' || action.type === 'tab_switch';
        if (isBreakPoint) {
          if (i < response.actions.length - 1) {
            broadcastLog('info', `Pausing after ${action.type} to re-evaluate (${response.actions.length - i - 1} remaining actions deferred)`);
          }
          hitSnapshot = true;
          break;
        }
        if (executionMode === 'quiz' && action.type === 'drag') {
          await new Promise(r => setTimeout(r, 800));
          if (i < response.actions.length - 1) {
            broadcastLog('info', `Pausing after drag to verify placement (${response.actions.length - i - 1} remaining actions deferred)`);
            hitSnapshot = true;
            break;
          }
        }
      }

      lastSummary = response.summary || 'Actions completed.';

      // Check if AI says the task is done
      // In quiz mode, ignore done=true if we broke at a snapshot (model assumed all actions ran)
      const isDone = response.done === true || response.done === 'true';
      if (isDone && commandLooksLikePublicDiscovery(command) && runMemory.inspectCount > 0 && runMemory.exportCount === 0) {
        lastGuardrailNotice = runMemory.leadRows.length > 0
          ? 'Lead rows have been compiled but not exported. Use export_data now.'
          : 'Do not mark a lead/research task done after inspection without compiling results. Use export_data with rows containing name, sourceUrl, platform, phone, website, email, address, notes, and confidence. Use empty strings for unknown fields and notes for blocked/partial pages.';
        broadcastLog('info', 'Continuing so inspected findings can be exported.');
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      if (isDone && !blockedAction && !(hitSnapshot && executionMode === 'quiz')) {
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

    const artifactSummary = runMemory?.exports?.length
      ? `\n\nArtifacts: ${runMemory.exports.map(e => e.filename).join(', ')}`
      : '';
    const rowSummary = runMemory?.leadRows?.length
      ? `\nCompiled ${runMemory.leadRows.length} lead row(s).`
      : '';
    return { result: `${lastSummary || 'Actions completed.'}${rowSummary}${artifactSummary}` };
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

  try {
    context.domContext = await extractDomIntelligence(tab.id, true);
  } catch {
    // Structured DOM extraction is best effort; visual map still carries the page.
  }

  try {
    context.accessibilityTree = await collectAllFrameAccessibilityTrees(tab.id);
  } catch {
    // Accessibility tree is best effort. DOM intelligence and visual map still carry context.
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

  // Append open-tab list so the AI can use tab_switch with the correct index
  // and knows which URLs are already open.
  try {
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    const tabLines = allTabs.map((t, i) => {
      const marker = t.id === tab.id ? ' ← CURRENT' : '';
      return `  [${i}] "${t.title || ''}" — ${t.url || 'about:blank'}${marker}`;
    });
    const tabSection = `\n=== OPEN TABS ===\n${tabLines.join('\n')}\n=== END OPEN TABS ===`;
    context.visualMap = (context.visualMap || '') + tabSection;
  } catch { /* ignore */ }

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

async function collectAllFrameAccessibilityTrees(tabId) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }

  if (!frames || frames.length === 0) {
    const resp = await sendMessageWithTimeout(
      tabId,
      { type: 'GET_ACCESSIBILITY_TREE', options: { viewportOnly: false, maxChars: 14000 } },
      { frameId: 0 },
      3000
    );
    return resp?.tree || '';
  }

  const contentFrames = frames.filter(f =>
    f.url && (f.url.startsWith('http://') || f.url.startsWith('https://'))
  );

  const trees = [];

  for (const frame of contentFrames) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        files: ['content.js']
      });
    } catch { /* restricted or already injected */ }

    const resp = await sendMessageWithTimeout(
      tabId,
      { type: 'GET_ACCESSIBILITY_TREE', options: { viewportOnly: false, maxChars: 14000 } },
      { frameId: frame.frameId },
      3000
    );

    if (resp?.tree) {
      trees.push({
        frameId: frame.frameId,
        url: frame.url,
        isTop: frame.parentFrameId === -1,
        tree: resp.tree
      });
    }
  }

  if (trees.length === 0) return '';
  if (trees.length === 1) return trees[0].tree;

  const parts = [];
  const topFrame = trees.find(t => t.isTop);
  if (topFrame) {
    parts.push(`=== ACCESSIBILITY TREE ===\n${topFrame.tree}`);
  }
  for (const tree of trees) {
    if (tree.isTop) continue;
    parts.push(`=== IFRAME ACCESSIBILITY TREE (frameId=${tree.frameId}) ===\nURL: ${tree.url}\n${tree.tree}`);
  }
  return parts.join('\n\n');
}

async function extractDomIntelligence(tabId, allFrames = false) {
  const injectedResults = await chrome.scripting.executeScript({
    target: allFrames ? { tabId, allFrames: true } : { tabId },
    func: () => {
      const clean = (value, max = 500) => String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, max);

      const selectorFor = (el) => {
        if (!el || !el.tagName) return '';
        if (el.id) return `#${CSS.escape(el.id)}`;
        const aria = el.getAttribute('aria-label');
        if (aria) {
          const sel = `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
          try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
        }
        const testId = el.getAttribute('data-testid');
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const name = el.getAttribute('name');
        if (name) {
          const sel = `[name="${CSS.escape(name)}"]`;
          try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
        }
        const parts = [];
        let node = el;
        while (node && node !== document.body && parts.length < 4) {
          const tag = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (!parent) break;
          const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
          parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
          node = parent;
        }
        return parts.join(' > ');
      };

      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0;
      };

      const meta = {};
      for (const m of document.querySelectorAll('meta[name], meta[property]')) {
        const key = m.getAttribute('name') || m.getAttribute('property');
        if (key) meta[key] = clean(m.getAttribute('content'), 300);
      }

      const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
        .filter(visible)
        .slice(0, 40)
        .map(h => ({ level: h.tagName.toLowerCase(), text: clean(h.innerText || h.textContent, 250), selector: selectorFor(h) }))
        .filter(h => h.text);

      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(visible)
        .slice(0, 250)
        .map(a => ({ text: clean(a.innerText || a.textContent || a.getAttribute('aria-label'), 250), href: a.href, selector: selectorFor(a) }))
        .filter(a => a.href);

      const controls = Array.from(document.querySelectorAll('input,textarea,select,button,[role="button"],[role="link"],[contenteditable="true"]'))
        .filter(visible)
        .slice(0, 120)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          role: el.getAttribute('role') || '',
          text: clean(el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label'), 250),
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          selector: selectorFor(el),
          disabled: !!el.disabled,
        }));

      const forms = Array.from(document.querySelectorAll('form'))
        .filter(visible)
        .slice(0, 20)
        .map(form => ({
          selector: selectorFor(form),
          action: form.action || '',
          method: form.method || '',
          controls: Array.from(form.querySelectorAll('input,textarea,select,button')).slice(0, 40).map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            name: el.getAttribute('name') || '',
            placeholder: el.getAttribute('placeholder') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            text: clean(el.innerText || el.textContent || el.value, 150),
            selector: selectorFor(el),
          })),
        }));

      const bodyText = clean(document.body?.innerText || document.body?.textContent || '', 12000);
      const phoneMatches = [...bodyText.matchAll(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g)].map(m => m[0]);
      const emailMatches = [...bodyText.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)].map(m => m[0]);

      return {
        url: location.href,
        title: document.title,
        lang: document.documentElement.lang || '',
        meta,
        headings,
        links,
        controls,
        forms,
        contacts: {
          phones: [...new Set(phoneMatches)].slice(0, 10),
          emails: [...new Set(emailMatches)].slice(0, 10),
        },
        text: bodyText,
      };
    }
  });

  const frames = injectedResults
    .filter(item => item?.result)
    .map(item => ({ ...item.result, frameId: item.frameId }));

  if (frames.length === 0) return null;

  const topFrame = frames.find(frame => frame.frameId === 0) || frames[0];
  if (!allFrames) return topFrame;

  const mergedPhones = new Set(topFrame.contacts?.phones || []);
  const mergedEmails = new Set(topFrame.contacts?.emails || []);
  const mergedLinks = [...(topFrame.links || [])];
  const mergedHeadings = [...(topFrame.headings || [])];

  for (const frame of frames) {
    if (frame === topFrame) continue;
    (frame.contacts?.phones || []).forEach(phone => mergedPhones.add(phone));
    (frame.contacts?.emails || []).forEach(email => mergedEmails.add(email));
    mergedLinks.push(...(frame.links || []).map(link => ({ ...link, frameId: frame.frameId, frameUrl: frame.url })));
    mergedHeadings.push(...(frame.headings || []).map(heading => ({ ...heading, frameId: frame.frameId, frameUrl: frame.url })));
  }

  return {
    ...topFrame,
    headings: mergedHeadings.slice(0, 80),
    links: mergedLinks.slice(0, 350),
    contacts: {
      phones: Array.from(mergedPhones).slice(0, 20),
      emails: Array.from(mergedEmails).slice(0, 20),
    },
    frames: frames.map(frame => ({
      frameId: frame.frameId,
      url: frame.url,
      title: frame.title,
      headings: (frame.headings || []).slice(0, 15),
      contacts: frame.contacts,
      controls: (frame.controls || []).slice(0, 20),
      forms: (frame.forms || []).slice(0, 5),
      links: (frame.links || []).slice(0, 25),
      text: frame.text?.substring(0, 2500),
    })),
  };
}

// ── Background URL Inspection and Exports ──

function uniqueUrls(urls, maxUrls = 5) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    if (!raw) continue;
    let normalized;
    try {
      normalized = new URL(raw).toString();
    } catch {
      continue;
    }
    const key = normalizeUrlForMemory(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxUrls) break;
  }
  return result;
}

async function inspectOneUrlInBackground(url, index) {
  let createdTab = null;
  try {
    createdTab = await chrome.tabs.create({ url, active: false });
    await waitForTabLoad(createdTab.id, 20000);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: createdTab.id, allFrames: true },
        files: ['content.js']
      });
    } catch { /* restricted page */ }

    const tabInfo = await chrome.tabs.get(createdTab.id);
    let visualMap = '';
    let dom = '';
    let domContext = null;
    let accessibilityTree = '';

    try {
      visualMap = await collectAllFrameVisualMaps(createdTab.id);
    } catch (err) {
      visualMap = `[Could not collect visual map: ${err.message}]`;
    }

    try {
      const domResponse = await chrome.tabs.sendMessage(
        createdTab.id,
        { type: 'GET_PAGE_CONTEXT' },
        { frameId: 0 }
      );
      dom = domResponse?.dom || '';
    } catch { /* not every page allows DOM inspection */ }

    try {
      domContext = await extractDomIntelligence(createdTab.id, true);
    } catch { /* structured DOM extraction is best effort */ }

    try {
      accessibilityTree = await collectAllFrameAccessibilityTrees(createdTab.id);
    } catch { /* accessibility extraction is best effort */ }

    let pageLinks = [];
    try {
      const [{ result: extractedLinks }] = await chrome.scripting.executeScript({
        target: { tabId: createdTab.id },
        func: () => Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map(a => ({
          text: (a.innerText || a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          href: a.href,
          ariaLabel: a.getAttribute('aria-label') || '',
        }))
      });
      pageLinks = Array.isArray(extractedLinks) ? extractedLinks : [];
    } catch { /* link extraction is best effort */ }

    return {
      success: true,
      index,
      requestedUrl: url,
      finalUrl: tabInfo.url || url,
      title: tabInfo.title || '',
      visualMap,
      dom,
      domContext,
      accessibilityTree,
      pageLinks,
    };
  } catch (err) {
    return {
      success: false,
      index,
      requestedUrl: url,
      error: err.message,
    };
  } finally {
    if (createdTab?.id) {
      await chrome.tabs.remove(createdTab.id).catch(() => {});
    }
  }
}

async function inspectUrlsInBackground(urls, maxUrls = 5) {
  const candidates = uniqueUrls(urls, Math.min(Math.max(maxUrls || 5, 1), 10));
  if (candidates.length === 0) {
    return { success: false, text: 'No valid URLs provided for inspection.' };
  }

  const concurrency = Math.min(3, candidates.length);
  const results = new Array(candidates.length);
  let next = 0;

  async function worker() {
    while (next < candidates.length) {
      const index = next++;
      results[index] = await inspectOneUrlInBackground(candidates[index], index + 1);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const lines = ['=== URL INSPECTION RESULTS ==='];
  for (const result of results) {
    lines.push('');
    lines.push(`[${result.index}] ${result.requestedUrl}`);
    if (!result.success) {
      lines.push(`ERROR: ${result.error}`);
      continue;
    }
    lines.push(`Final URL: ${result.finalUrl}`);
    lines.push(`Title: ${result.title}`);
    if (result.visualMap) {
      lines.push('Visual map:');
      lines.push(result.visualMap.substring(0, 5000));
    }
    if (result.accessibilityTree) {
      lines.push('Accessibility tree:');
      lines.push(result.accessibilityTree.substring(0, 7000));
    }
    if (result.domContext) {
      lines.push('DOM intelligence:');
      lines.push(JSON.stringify({
        title: result.domContext.title,
        url: result.domContext.url,
        meta: result.domContext.meta,
        headings: result.domContext.headings?.slice(0, 20),
        contacts: result.domContext.contacts,
        controls: result.domContext.controls?.slice(0, 30),
        forms: result.domContext.forms?.slice(0, 10),
        links: result.domContext.links?.slice(0, 40),
        frames: result.domContext.frames?.slice(0, 6),
        text: result.domContext.text?.substring(0, 5000),
      }, null, 2));
    }
    if (result.dom) {
      lines.push('DOM snippet:');
      lines.push(result.dom.substring(0, 2500));
    }
  }
  lines.push('');
  lines.push('=== END URL INSPECTION RESULTS ===');

  return {
    success: true,
    text: lines.join('\n'),
    fullResults: results,
    data: results.map(r => ({
      success: r.success,
      requestedUrl: r.requestedUrl,
      finalUrl: r.finalUrl,
      title: r.title,
      error: r.error,
    })),
  };
}

function buildSearchUrl(query, engine = 'google') {
  const encoded = encodeURIComponent(query || '');
  if ((engine || '').toLowerCase() === 'bing') {
    return `https://www.bing.com/search?q=${encoded}`;
  }
  if ((engine || '').toLowerCase() === 'duckduckgo') {
    return `https://duckduckgo.com/html/?q=${encoded}`;
  }
  return `https://www.google.com/search?q=${encoded}&udm=14`;
}

function getSearchEngines(engine) {
  if (engine) return [engine];
  return ['google', 'bing', 'duckduckgo'];
}

function unwrapSearchResultUrl(href) {
  if (!href) return '';
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, '');

    if (host.endsWith('google.com') && url.pathname === '/url' && url.searchParams.get('q')) {
      return url.searchParams.get('q');
    }

    if (host.endsWith('duckduckgo.com') && url.searchParams.get('uddg')) {
      return url.searchParams.get('uddg');
    }

    if (host.endsWith('bing.com') && url.searchParams.get('u')) {
      try {
        let decoded = atob(url.searchParams.get('u'));
        decoded = decoded.replace(/^a1/, '');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch { /* use original */ }
    }

    return href;
  } catch {
    return href;
  }
}

function isSearchChromeUrl(href, searchUrl) {
  try {
    const url = new URL(href);
    const search = new URL(searchUrl);
    const host = url.hostname.replace(/^www\./, '');
    const searchHost = search.hostname.replace(/^www\./, '');

    if (host === searchHost) return true;
    if (/(^|\.)google\.com$/.test(host) && !url.pathname.startsWith('/maps')) return true;
    if (/(^|\.)bing\.com$/.test(host)) return true;
    if (/(^|\.)duckduckgo\.com$/.test(host)) return true;
    if (/(^|\.)accounts\.google\.com$/.test(host)) return true;
    if (/(^|\.)support\.google\.com$/.test(host)) return true;
    if (/(^|\.)labs\.google\.com$/.test(host)) return true;
    if (/(^|\.)microsoft\.com$/.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

function normalizeSearchResultLinks(rawLinks, searchUrl, maxLinks = 20) {
  const links = [];
  const seen = new Set();

  for (const raw of Array.isArray(rawLinks) ? rawLinks : []) {
    const href = unwrapSearchResultUrl(raw.href);
    if (!href || !/^https?:\/\//i.test(href)) continue;
    if (isSearchChromeUrl(href, searchUrl)) continue;

    const key = normalizeUrlForMemory(href);
    if (!key || seen.has(key)) continue;

    const text = String(raw.text || raw.ariaLabel || '').replace(/\s+/g, ' ').trim();
    links.push({ text, href });
    seen.add(key);
    if (links.length >= maxLinks) break;
  }

  return links;
}

async function webSearchInBackground(action) {
  const query = action.query || '';
  const engines = getSearchEngines(action.engine);
  const attempts = [];
  let chosen = null;

  for (const engine of engines) {
    const url = buildSearchUrl(query, engine);
    const result = await inspectOneUrlInBackground(url, attempts.length + 1);
    const links = result.success
      ? normalizeSearchResultLinks(result.pageLinks, url, action.maxResults || 20)
      : [];
    attempts.push({ engine, url, result, links });

    if (links.length > 0 || action.engine) {
      chosen = attempts[attempts.length - 1];
      break;
    }
  }

  if (!chosen) chosen = attempts[attempts.length - 1];
  if (!chosen?.result?.success) {
    return { success: false, text: `Search failed for "${query}": ${chosen?.result?.error || 'no search engines returned a page'}` };
  }

  const { result, links, url, engine } = chosen;
  const lines = ['=== WEB SEARCH RESULTS ==='];
  lines.push(`Query: ${query}`);
  lines.push(`Engine: ${engine}`);
  lines.push(`Search URL: ${url}`);
  lines.push(`Title: ${result.title}`);
  if (attempts.length > 1) {
    lines.push(`Engines tried: ${attempts.map(a => `${a.engine} (${a.links.length} result links)`).join(', ')}`);
  }
  if (links.length > 0) {
    lines.push('Links:');
    for (const [index, link] of links.entries()) {
      lines.push(`[${index + 1}] ${link.text || '(no title)'} - ${link.href}`);
    }
  } else {
    lines.push('Links: none found after filtering search-engine UI links.');
  }
  lines.push('Visual map:');
  lines.push((result.visualMap || '').substring(0, 6000));
  if (result.accessibilityTree) {
    lines.push('Accessibility tree:');
    lines.push(result.accessibilityTree.substring(0, 7000));
  }
  if (result.domContext) {
    lines.push('DOM intelligence:');
    lines.push(JSON.stringify({
      title: result.domContext.title,
      meta: result.domContext.meta,
      headings: result.domContext.headings?.slice(0, 15),
      contacts: result.domContext.contacts,
      links: result.domContext.links?.slice(0, 30),
      frames: result.domContext.frames?.slice(0, 4),
      text: result.domContext.text?.substring(0, 4000),
    }, null, 2));
  }
  if (result.dom) {
    lines.push('DOM snippet:');
    lines.push(result.dom.substring(0, 2500));
  }
  lines.push('=== END WEB SEARCH RESULTS ===');

  return {
    success: true,
    text: lines.join('\n'),
    data: { query, engine, url, links, attempts: attempts.map(a => ({ engine: a.engine, url: a.url, linkCount: a.links.length })) },
  };
}

function normalizeExportRows(action) {
  if (Array.isArray(action.rows)) return action.rows;
  if (Array.isArray(action.data)) return action.data;
  if (action.data && typeof action.data === 'object') return [action.data];
  return [];
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(rows) {
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row || {}).forEach(k => set.add(k));
    return set;
  }, new Set()));
  const lines = [headers.map(escapeCsvValue).join(',')];
  for (const row of rows) {
    lines.push(headers.map(header => escapeCsvValue(row?.[header])).join(','));
  }
  return lines.join('\r\n');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildExcelHtml(rows) {
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row || {}).forEach(k => set.add(k));
    return set;
  }, new Set()));
  const head = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows.map(row =>
    `<tr>${headers.map(h => `<td>${escapeHtml(typeof row?.[h] === 'object' ? JSON.stringify(row[h]) : row?.[h])}</td>`).join('')}</tr>`
  ).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

async function exportDataFile(action) {
  const rows = normalizeExportRows(action);
  if (rows.length === 0) {
    return { success: false, text: 'No rows provided to export.' };
  }

  const format = (action.format || 'csv').toLowerCase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = format === 'json' ? 'json' : (format === 'xls' || format === 'excel' ? 'xls' : 'csv');
  const filename = action.filename || `ai-browser-export-${timestamp}.${extension}`;

  let content;
  let mime;
  if (format === 'json') {
    content = JSON.stringify(rows, null, 2);
    mime = 'application/json';
  } else if (format === 'xls' || format === 'excel') {
    content = buildExcelHtml(rows);
    mime = 'application/vnd.ms-excel';
  } else {
    content = buildCsv(rows);
    mime = 'text/csv';
  }

  const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: action.saveAs === true,
    conflictAction: 'uniquify',
  });

  return {
    success: true,
    text: `Exported ${rows.length} row(s) to ${filename}`,
    data: { downloadId, filename, rows: rows.length },
  };
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

    case 'drag': {
      // Forward to content script's dragElement() which dispatches the full
      // PointerEvent + MouseEvent + HTML5 DragEvent sequence. This works with
      // Learnosity, SortableJS, jQuery UI, and custom drag-and-drop frameworks.
      const fromSel = action.fromSelector || action.selector;
      const fromRefId = action.fromRefId || action.refId;
      const toSel = action.toSelector;
      const toRefId = action.toRefId;
      broadcastLog('info', `Drag: "${fromSel}" → "${toSel}"`);
      const dragAction = { type: 'drag', fromSelector: fromSel, fromRefId, toSelector: toSel, toRefId };

      // Try the specified frame first (sendOpts has frameId if action included it)
      let dragResult = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXECUTE_ACTION', action: dragAction
      }, sendOpts).catch(e => ({ success: false, error: e.message }));

      // If element not found and no frameId was given, auto-scan all child frames
      // (AI sometimes omits frameId on drag actions even for iframe content)
      if (!dragResult?.success && !action.frameId) {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
        for (const frame of frames) {
          if (frame.frameId === 0) continue; // already tried top frame
          try {
            const r = await chrome.tabs.sendMessage(
              tab.id, { type: 'EXECUTE_ACTION', action: dragAction },
              { frameId: frame.frameId }
            );
            if (r?.success) { dragResult = r; break; }
            if (!r?.error?.toLowerCase().includes('not found')) { dragResult = r; break; }
          } catch { /* frame may not have content script, try next */ }
        }
      }

      return dragResult;
    }

    case 'search': {
      // Call the configured search/answer-verification model with the query.
      // The result is returned as text so the calling loop can inject it into
      // the next AI message (same mechanism as snapshot results).
      if (!aiClient.searchEnabled || !aiClient.searchModel) {
        return {
          success: false,
          text: 'Search not configured. Enable it in Settings and select a search model (e.g. compound).'
        };
      }
      broadcastLog('info', `Searching: "${action.query}" via ${aiClient.searchModel}`);
      const pageContext = await getPageContext(tab, mode).catch(() => ({}));
      const answer = await aiClient.executeSearch(action.query, pageContext);
      if (!answer) {
        return { success: false, text: 'Search returned no results.' };
      }
      return { success: true, text: answer };
    }

    case 'web_search': {
      broadcastLog('info', `Searching web in a background tab: "${action.query}"`);
      return await webSearchInBackground(action);
    }

    case 'inspect_urls': {
      broadcastLog('info', `Inspecting ${Array.isArray(action.urls) ? action.urls.length : 0} URL(s) in background tabs`);
      return await inspectUrlsInBackground(action.urls || [], action.maxUrls || action.limit || 5);
    }

    case 'export_data':
      return await exportDataFile(action);

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

        const accessibilityTree = await collectAllFrameAccessibilityTrees(tab.id).catch(() => '');
        return {
          success: true,
          text: accessibilityTree
            ? `${visualMap}\n\n=== ACCESSIBILITY TREE ===\n${accessibilityTree}`
            : visualMap
        };
      }

      // Normal mode: quick snapshot, no heavy retries
      const visualMap = await collectAllFrameVisualMaps(tab.id);
      const accessibilityTree = await collectAllFrameAccessibilityTrees(tab.id).catch(() => '');
      return {
        success: true,
        text: accessibilityTree
          ? `${visualMap}\n\n=== ACCESSIBILITY TREE ===\n${accessibilityTree}`
          : visualMap
      };
    }

    case 'navigate':
      await chrome.tabs.update(tab.id, { url: action.url });
      await waitForTabLoad(tab.id);
      return { success: true };

    case 'screenshot': {
      const screenshot = await captureScreenshot(tab.id);
      // Also collect visual maps from all frames
      const visualMap = await collectAllFrameVisualMaps(tab.id);
      const accessibilityTree = await collectAllFrameAccessibilityTrees(tab.id).catch(() => '');
      return {
        success: true,
        screenshot,
        text: accessibilityTree
          ? `${visualMap}\n\n=== ACCESSIBILITY TREE ===\n${accessibilityTree}`
          : visualMap
      };
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
      const currentIndex = allTabs.findIndex(t => t.active);
      const normalize = (v) => String(v || '').toLowerCase();
      const query = normalize(action.query || action.title || action.urlContains || action.match);

      let targetIndex = Number.isInteger(action.index) ? action.index : null;
      if (targetIndex === null && typeof action.index === 'string' && action.index.trim() !== '') {
        const parsed = Number.parseInt(action.index, 10);
        if (Number.isInteger(parsed)) targetIndex = parsed;
      }

      // If model/user provided a destination query (e.g. "facebook"), match title/URL.
      if (targetIndex === null && query) {
        const start = currentIndex >= 0 ? currentIndex + 1 : 0;
        for (let step = 0; step < allTabs.length; step++) {
          const i = (start + step) % allTabs.length;
          const t = allTabs[i];
          if (normalize(t.title).includes(query) || normalize(t.url).includes(query)) {
            targetIndex = i;
            break;
          }
        }
      }

      if (targetIndex === null) {
        const dir = (action.direction || '').toLowerCase();
        if (dir === 'prev' || dir === 'previous' || dir === 'back') {
          targetIndex = currentIndex <= 0 ? allTabs.length - 1 : currentIndex - 1;
        } else {
          // default "another tab" behavior: move to next tab cyclically
          targetIndex = currentIndex >= allTabs.length - 1 ? 0 : currentIndex + 1;
        }
      }

      if (targetIndex >= 0 && targetIndex < allTabs.length) {
        await chrome.tabs.update(allTabs[targetIndex].id, { active: true });
        return { success: true };
      }
      throw new Error(`Tab index ${targetIndex} out of range (0-${allTabs.length - 1})`);

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

function broadcastArtifact(artifact) {
  if (!artifact) return;
  chrome.runtime.sendMessage({ type: 'ARTIFACT_CREATED', artifact }).catch(() => {});
}

function broadcastExecutionState(running) {
  chrome.runtime.sendMessage({ type: 'EXECUTION_STATE', running }).catch(() => {});
}
