// ai-client.js — Unified AI client supporting Groq and OpenRouter

// ── Normal mode: general-purpose browsing automation ──
const SYSTEM_PROMPT_NORMAL = `You are a browser automation bot. Output ONLY valid JSON.

You see a Visual Page Map of page elements. Each line:
[*TAG] @(x,y WxH) sel="CSS selector" "text" [state]
* = interactive | sel = CSS selector | [CHECKED]/[unchecked] | options=[...]

Sections marked === IFRAME CONTENT (frameId=N) === require "frameId":N on actions.

ACTIONS: click, type, select, extract, evaluate, snapshot, navigate, scroll, wait, keyboard, hover, screenshot, describe, drag, tab_new, tab_close, tab_switch, tab_list
Format: {"type":"click","selector":"sel","frameId":N}
type: add "text","clearFirst" | select: add "value" | navigate: add "url" | evaluate: add "expression"
drag: {"type":"drag","fromSelector":"sel","toSelector":"sel","frameId":N} — drag element from source to target

OUTPUT: {"thinking":"plan","actions":[...],"done":false,"summary":"what you did"}

MODE SWITCH: If you detect a quiz, test, assessment, survey, or form with multiple questions to complete, include "mode":"quiz" in your JSON to activate enhanced quiz mode.

A screenshot may be provided alongside the visual map. Use it to understand image-based content (diagrams, equations, figures, labels on drag-drop items) that cannot be captured as text.

RULES:
1. Output ONLY JSON. No markdown, no prose.
2. Use selectors from the Visual Page Map exactly.
3. For IFRAME elements, include "frameId":N on each action.
4. After page-changing actions, add a snapshot to see the new state.
5. Set "done":true when the task is complete.
6. "actions" array is REQUIRED.
7. Elements marked [draggable] can be dragged. Use drag action with fromSelector and toSelector.
8. When a screenshot is provided and IMG elements have no text, examine the screenshot to identify what images depict (equations, charts, diagrams) and use that understanding to choose the correct answer or drag target.`;

// ── Quiz mode: strict one-question-at-a-time for assessments ──
const SYSTEM_PROMPT_QUIZ = `You are a browser automation bot in QUIZ MODE. Output ONLY valid JSON.

You see a Visual Page Map of page elements. Each line:
[*TAG] @(x,y WxH) sel="CSS selector" "text" [state]
* = interactive | sel = CSS selector | [CHECKED]/[unchecked] | options=[...]

Sections marked === IFRAME CONTENT (frameId=N) === require "frameId":N on actions.

ACTIONS: click, type, select, extract, evaluate, snapshot, navigate, scroll, wait, keyboard, hover, screenshot, describe, drag
Format: {"type":"click","selector":"sel","frameId":N}
drag: {"type":"drag","fromSelector":"sel","toSelector":"sel","frameId":N} — drag element from source to target

OUTPUT: {"thinking":"plan","actions":[...],"done":false,"summary":"what you did"}

Include "mode":"normal" to exit quiz mode when the quiz/assessment is fully done.

A screenshot may be provided alongside the visual map. When IMG elements have no readable text (image-based equations, diagrams, labels on drag tiles), use the screenshot to identify what they depict before choosing an answer or drag target.

QUIZ RULES:
1. Output ONLY JSON. No markdown, no prose.
2. Use selectors from the Visual Page Map exactly.
3. For IFRAME elements, ALWAYS include "frameId":N on each action.
4. ONE ITEM PER RESPONSE: Handle ONLY the current visible question. Answer it, click Next, add a snapshot. STOP.
5. Set "done":false after each item. The system re-scans the page automatically.
6. Set "done":true ONLY when there are NO more items/questions remaining.
7. NEVER answer questions in text. ALWAYS click the correct answer on the page.
8. THINK BEFORE ANSWERING: In your "thinking" field, reason through the question step by step. State the question, consider each option, explain why one is correct and others wrong. Then click the correct answer. NEVER click Next without answering.
9. If an answer is already selected ([CHECKED]), verify it is correct. If wrong, click the correct option first.
10. If a modal says items are unanswered, click Cancel, then answer the current item.
11. MULTI-ANSWER (checkboxes): Check ONLY the correct options. Uncheck wrong ones that are [CHECKED].
12. SINGLE-ANSWER (radio): Select exactly ONE correct answer.
13. DRAG-AND-DROP: Drag ONE item at a time, then add a snapshot to verify it landed. The system pauses after each drag so you can verify. Do NOT batch multiple drags.
    TARGET SELECTORS: The correct drop zone selector is always [aria-label="Response input area, N out of M. Connected to X."] — NOT the answer text label. Use this exact pattern.
    SUCCESS CHECK: After the drag snapshot, a placed tile shows "Currently contains [text]" in the drop zone. A drop zone still showing "Response input area" or "Select to move" means the drag did not register — try again.
    TILE INDICES SHIFT: After each successful drag, remaining tiles shift up in the list. ALWAYS use fresh selectors from the snapshot for subsequent drags — do NOT reuse the same nth-of-type index from before.
14. DIFF SNAPSHOTS: After step 1, you may receive a PAGE UPDATE (diff). Unchanged sections are omitted but selectors still work. The "Key controls" line lists outer page buttons for reference.
15. IMAGE QUESTIONS: If the question or answer options appear as images in the screenshot (not as text in the visual map), describe what you see in your "thinking" field and use that to select the correct answer by its position/selector.
16. SEARCH RESULTS: If search results are provided (=== SEARCH RESULTS ===), they contain the verified correct answer from a web search. ALWAYS use them to select the correct answer. Trust the search results over your own knowledge.`;

// ── Vision-capable Groq models (support image_url content) ──
// These Llama 4 models accept image inputs via the same OpenAI-compatible API.
export const GROQ_VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
];

// Default fallback vision model for Groq when the selected model is text-only
export const GROQ_DEFAULT_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

export function isGroqVisionModel(modelId) {
  return GROQ_VISION_MODELS.includes(modelId);
}

// ── Provider definitions (static config only, models fetched dynamically) ──

export const PROVIDERS = {
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPlaceholder: 'gsk_...',
    keyHelp: 'https://console.groq.com/keys',
    keyHelpText: 'console.groq.com/keys',
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-...',
    keyHelp: 'https://openrouter.ai/keys',
    keyHelpText: 'openrouter.ai/keys',
  },
};

// ── Dynamic model fetching ──

export async function fetchModels(provider, apiKey) {
  if (provider === 'groq') {
    return await _fetchGroqModels(apiKey);
  } else if (provider === 'openrouter') {
    return await _fetchOpenRouterModels(apiKey);
  }
  throw new Error('Unknown provider: ' + provider);
}

async function _fetchGroqModels(apiKey) {
  const response = await fetch(
    `${PROVIDERS.groq.baseUrl}/models`,
    {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    }
  );
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Failed to fetch models');
  }

  const data = await response.json();
  const models = [];
  const seenIds = new Set();

  for (const m of (data.data || [])) {
    // Only include chat models (skip whisper, tts, guard, etc.)
    if (m.id.includes('whisper') || m.id.includes('tts') || m.id.includes('distil') ||
        m.id.includes('guard') || m.id.includes('tool-use')) continue;

    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);

    models.push({
      id: m.id,
      name: m.id,
      contextWindow: m.context_window,
      isVision: isGroqVisionModel(m.id),
    });
  }

  // Ensure the two Llama 4 vision models are always listed even if not in the API response
  for (const visionId of GROQ_VISION_MODELS) {
    if (!seenIds.has(visionId)) {
      models.push({
        id: visionId,
        name: `${visionId} [vision]`,
        contextWindow: 128000,
        isVision: true,
      });
    }
  }

  // Sort: vision models first, then alphabetically
  models.sort((a, b) => {
    if (a.isVision && !b.isVision) return -1;
    if (!a.isVision && b.isVision) return 1;
    return a.id.localeCompare(b.id);
  });

  return models;
}

async function _fetchOpenRouterModels(apiKey) {
  const response = await fetch(`${PROVIDERS.openrouter.baseUrl}/models`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    }
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Failed to fetch models');
  }

  const data = await response.json();
  const models = [];

  for (const m of (data.data || [])) {
    models.push({
      id: m.id,
      name: m.name || m.id,
      contextLength: m.context_length,
      pricing: m.pricing,
      isFree: m.pricing?.prompt === '0' && m.pricing?.completion === '0',
    });
  }

  // Sort: free models first, then by name
  models.sort((a, b) => {
    if (a.isFree && !b.isFree) return -1;
    if (!a.isFree && b.isFree) return 1;
    return a.name.localeCompare(b.name);
  });

  return models;
}

// ── Unified AI Client ──

export class AIClient {
  constructor(provider, apiKey, model, options = {}) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model;
    this.conversationHistory = [];
    // For Groq: model to use when vision is needed and the primary model is text-only
    this.groqVisionModel = options.groqVisionModel || GROQ_DEFAULT_VISION_MODEL;
    this._lastVisionModelUsed = null;
    // Search / answer-verification model (optional)
    this.searchEnabled  = options.searchEnabled  || false;
    this.searchModel    = options.searchModel    || '';
    this.searchProvider = options.searchProvider || provider;  // defaults to same provider
    this.searchApiKey   = options.searchApiKey   || apiKey;    // defaults to same key
  }

  // ── Search analyst: call the configured search model with a query and return
  //    the answer as plain text.  The primary model receives this as context.
  // Supports:
  //   • Groq compound / compound-mini — auto-searches the web natively
  //   • Any other model               — uses training knowledge to answer
  async executeSearch(query, pageContext) {
    if (!this.searchEnabled || !this.searchModel) return null;

    const provider = this.searchProvider;
    const apiKey   = this.searchApiKey;
    const baseUrl  = provider === 'groq'
      ? PROVIDERS.groq.baseUrl
      : PROVIDERS.openrouter.baseUrl;

    // Strip provider prefix if using Groq API directly (e.g. "groq/compound-beta" → "compound-beta")
    const modelId = provider === 'groq'
      ? this.searchModel.replace(/^groq\//, '')
      : this.searchModel;

    const systemPrompt =
`You are a factual web search assistant for a quiz/assessment automation bot.
Your ONLY job: find the correct answer to the question provided.

Return plain text (NOT JSON) with:
1. CORRECT ANSWER: State the correct answer clearly and directly.
2. EXPLANATION: 1-3 sentences explaining why it is correct.
3. WHY OTHERS WRONG: Briefly note why the other options are incorrect (if options are provided).

Be concise, factual, and confident. Do not hedge or add disclaimers.`;

    // Extract just the iframe/question section to keep the query focused
    const map = pageContext?.visualMap || '';
    const iframeIdx = map.indexOf('=== IFRAME CONTENT');
    const relevantMap = iframeIdx !== -1
      ? map.substring(iframeIdx, iframeIdx + 4000)
      : map.substring(0, 4000);

    const userContent =
`Search query / question to answer: ${query}

Page context (current quiz question):
${relevantMap}

Search the web and return the correct factual answer.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent  }
    ];

    const headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'chrome-extension://ai-browser-controller';
      headers['X-Title']      = 'AI Browser Controller';
    }

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model:       modelId,
          messages,
          temperature: 0.1,
          max_tokens:  700,
          // Note: do NOT set response_format:json — we want plain text from the analyst
        })
      });

      if (!response.ok) return null;
      const data = await response.json();

      // Compound models may return structured tool-result content — just extract text
      const msg = data.choices?.[0]?.message;
      if (!msg) return null;

      // If the model returned tool_calls (e.g. GPT-OSS with browser), its final
      // text content (if any) is still useful; otherwise return null so we fall back
      return typeof msg.content === 'string' && msg.content.trim()
        ? msg.content.trim()
        : null;
    } catch {
      return null;
    }
  }

  async validateKey() {
    try {
      if (this.provider === 'groq') {
        return await this._validateGroqKey();
      } else if (this.provider === 'openrouter') {
        return await this._validateOpenRouterKey();
      }
      return { success: false, error: 'Unknown provider' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async sendMessage(userMessage, pageContext = null, mode = 'normal') {
    if (this.provider === 'groq') {
      return await this._sendGroq(userMessage, pageContext, mode);
    } else if (this.provider === 'openrouter') {
      return await this._sendOpenRouter(userMessage, pageContext, mode);
    }
    throw new Error('Unknown provider: ' + this.provider);
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  // ── Groq Implementation ──

  async _validateGroqKey() {
    const response = await fetch(`${PROVIDERS.groq.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      }
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Invalid API key');
    }
    return { success: true };
  }

  // ── Vision analyst: call vision model to describe screenshot, return text summary ──
  // The analysis is free-text so the normal model can read it as context.
  async _getVisionAnalysis(userMessage, pageContext) {
    const visionModel = this.groqVisionModel || GROQ_DEFAULT_VISION_MODEL;

    const systemPrompt = `You are a visual analysis assistant helping a browser automation bot.
Examine the screenshot and describe what you see relevant to the task. Be specific and concise.

Focus on:
1. QUESTION TEXT: Exact text of any question shown (including text inside images).
2. ANSWER OPTIONS: Each option visible (text, images, equations, diagrams). Note which are images vs text.
3. DRAG-AND-DROP: What each draggable tile depicts (label, image content, value). What each drop zone is labeled.
4. IMAGE CONTENT: Describe any diagrams, charts, equations, or figures — read any embedded text/symbols.
5. ELEMENT POSITIONS: Approximate position of key elements (e.g. "top-left", "second column", "right panel").
6. CORRECT ANSWER HINTS: Note any visual indicators (highlights, checks, arrows) suggesting correct answers.

Output plain text. Do NOT output JSON. Do NOT decide actions — only describe what you see.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Task: ${userMessage}\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n\nAnalyze this screenshot and describe everything relevant to completing the task above.`
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${pageContext.screenshot}` }
          }
        ]
      }
    ];

    try {
      const response = await fetch(`${PROVIDERS.groq.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: visionModel,
          messages,
          temperature: 0.1,
          max_tokens: 900,  // Keep analysis concise — it's injected into the next call
        })
      });

      if (!response.ok) return null;

      const data = await response.json();
      return data.choices?.[0]?.message?.content || null;
    } catch {
      return null;
    }
  }

  async _sendGroq(userMessage, pageContext, mode = 'normal') {
    const systemPrompt = mode === 'quiz' ? SYSTEM_PROMPT_QUIZ : SYSTEM_PROMPT_NORMAL;

    const hasScreenshot = !!(pageContext?.screenshot);
    const needsVision = hasScreenshot || !!(pageContext?.needsVision);
    const primaryIsVision = isGroqVisionModel(this.model);

    // ── Two-step vision handoff (text-only primary model) ──
    // When the page has images/screenshots but the selected model can't see them,
    // first call the vision model as an "analyst" to describe the screenshot in
    // plain text, then pass that analysis to the normal text model as context.
    // This way the normal model makes all action decisions with full visual context.
    let visionAnalysis = null;
    if (needsVision && hasScreenshot && !primaryIsVision) {
      visionAnalysis = await this._getVisionAnalysis(userMessage, pageContext);
      if (visionAnalysis) {
        this._lastVisionModelUsed = this.groqVisionModel || GROQ_DEFAULT_VISION_MODEL;
      }
    }

    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    const recentHistory = this.conversationHistory.slice(-6);
    for (const entry of recentHistory) {
      messages.push(entry);
    }

    // Build the text payload for the primary model
    let textContent = `Command: ${userMessage}`;
    if (pageContext) {
      textContent += `\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n`;
      if (pageContext.visualMap) {
        textContent += `\n${pageContext.visualMap}\n`;
      }
    }

    // Inject vision analysis if we got one from the analyst step
    if (visionAnalysis) {
      textContent += `\n\n=== VISION ANALYSIS (from screenshot) ===\n${visionAnalysis}\n=== END VISION ANALYSIS ===\n\nUse the vision analysis above to understand image content, identify correct answers, and determine drag-and-drop targets.`;
    }

    // If the primary model IS a vision model, send the screenshot inline (single step)
    if (primaryIsVision && hasScreenshot) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: textContent },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pageContext.screenshot}` } }
        ]
      });
    } else {
      // Text-only path: either no screenshot, or we already ran the vision analyst above
      messages.push({ role: 'user', content: textContent });
    }

    const requestBody = {
      model: this.model,  // always use the user's chosen model for action decisions
      messages,
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    };

    const response = await fetch(`${PROVIDERS.groq.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const err = await response.json();
      const msg = err.error?.message || `Groq API error: ${response.status}`;
      if (msg.includes('does not exist') || msg.includes('not found')) {
        throw new Error(`Model "${this.model}" is not available. Go to Settings, click Load Models, and pick a valid one.`);
      }
      // JSON generation failure: context is too long or model is confused.
      // Clear history and retry ONCE with a minimal prompt so the request has fewer tokens.
      if (err.error?.code === 'json_validate_failed' ||
          msg.toLowerCase().includes('failed to generate json') ||
          msg.toLowerCase().includes('failed to validate json')) {
        this.conversationHistory = [];  // clear history to shrink context
        const retryBody = {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: `Command: ${userMessage}\n\n(Context cleared to fix JSON error — proceed with the task based on the command alone)` }
          ],
          temperature: 0.1,
          max_tokens: 2048,
          response_format: { type: 'json_object' },
        };
        const retryResp = await fetch(`${PROVIDERS.groq.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
          body: JSON.stringify(retryBody)
        });
        if (retryResp.ok) {
          const retryData = await retryResp.json();
          const retryText = retryData.choices?.[0]?.message?.content;
          if (retryText) {
            this.conversationHistory.push({ role: 'user', content: userMessage });
            this.conversationHistory.push({ role: 'assistant', content: retryText });
            return this._parseResponse(retryText);
          }
        }
      }
      throw new Error(msg);
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content;

    if (!responseText) {
      throw new Error('No response from Groq');
    }

    this.conversationHistory.push({ role: 'user', content: userMessage });
    this.conversationHistory.push({ role: 'assistant', content: responseText });
    this._trimHistory();

    return this._parseResponse(responseText);
  }

  // ── OpenRouter Implementation (OpenAI-compatible) ──

  async _validateOpenRouterKey() {
    const response = await fetch(`${PROVIDERS.openrouter.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      }
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Invalid API key');
    }
    return { success: true };
  }

  async _sendOpenRouter(userMessage, pageContext, mode = 'normal') {
    const systemPrompt = mode === 'quiz' ? SYSTEM_PROMPT_QUIZ : SYSTEM_PROMPT_NORMAL;
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    const recentHistory = this.conversationHistory.slice(-6);
    for (const entry of recentHistory) {
      messages.push(entry);
    }

    if (pageContext) {
      const content = [];

      let textPart = `Command: ${userMessage}\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n`;
      if (pageContext.visualMap) {
        textPart += `\n${pageContext.visualMap}\n`;
      }
      content.push({ type: 'text', text: textPart });

      if (pageContext.screenshot) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${pageContext.screenshot}` }
        });
      }

      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    const requestBody = {
      model: this.model,
      messages,
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    };

    const response = await fetch(`${PROVIDERS.openrouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'chrome-extension://ai-browser-controller',
        'X-Title': 'AI Browser Controller',
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content;

    if (!responseText) {
      throw new Error('No response from OpenRouter');
    }

    this.conversationHistory.push({ role: 'user', content: userMessage });
    this.conversationHistory.push({ role: 'assistant', content: responseText });
    this._trimHistory();

    return this._parseResponse(responseText);
  }

  // ── Helpers ──

  _trimHistory() {
    if (this.conversationHistory.length > 12) {
      this.conversationHistory = this.conversationHistory.slice(-6);
    }
  }

  _parseResponse(responseText) {
    let cleaned = responseText.trim();

    // Strip markdown code fences
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Try direct parse — but only accept if it has an actions array
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.actions)) return parsed;
      // Valid JSON but no actions array — model answered in prose JSON
    } catch { /* not valid JSON, continue */ }

    // Try to find a JSON object with "actions" in the text
    const jsonMatch = cleaned.match(/\{[\s\S]*"actions"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.actions)) return parsed;
      } catch { /* continue */ }
    }

    // Try to find any JSON object with actions
    const anyJson = cleaned.match(/\{[\s\S]*\}/);
    if (anyJson) {
      try {
        const parsed = JSON.parse(anyJson[0]);
        if (Array.isArray(parsed.actions)) return parsed;
      } catch { /* continue */ }
    }

    // Fallback: return empty actions so the retry loop can re-prompt
    return {
      thinking: 'Model returned prose instead of JSON — will retry',
      actions: [],
      summary: responseText.substring(0, 200),
      done: false
    };
  }
}
