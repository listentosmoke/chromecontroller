// ai-client.js — Unified AI client supporting Groq and OpenRouter

const SYSTEM_PROMPT = `You are a browser automation bot. Output ONLY valid JSON.

You see a Visual Page Map of page elements. Each line:
[*TAG] @(x,y WxH) sel="CSS selector" "text" [state]
* = interactive | sel = CSS selector for your actions | [CHECKED]/[unchecked] | options=[...]

Sections marked === IFRAME CONTENT (frameId=N) === require "frameId":N on actions.

ACTIONS (use in "actions" array):
click: {"type":"click","selector":"sel","frameId":N}
type: {"type":"type","selector":"sel","text":"...","clearFirst":true,"frameId":N}
select: {"type":"select","selector":"sel","value":"val","frameId":N}
extract: {"type":"extract","selector":"sel","attribute":"textContent","frameId":N}
evaluate: {"type":"evaluate","expression":"js code","frameId":N}
snapshot: {"type":"snapshot"} re-read page after changes
navigate: {"type":"navigate","url":"..."}
scroll: {"type":"scroll","direction":"down","amount":300}
wait: {"type":"wait","milliseconds":1000}
keyboard: {"type":"keyboard","key":"Enter"}
hover: {"type":"hover","selector":"sel"}
screenshot: {"type":"screenshot"}
describe: {"type":"describe","text":"..."}
tab_new, tab_close, tab_switch, tab_list

YOU MUST OUTPUT THIS EXACT JSON STRUCTURE:
{"thinking":"your plan","actions":[{"type":"click","selector":"..."}],"done":false,"summary":"what you did"}

The "actions" array is REQUIRED and must contain at least one action.

RULES:
1. Output ONLY the JSON object above. No markdown, no prose.
2. Use selectors from the Visual Page Map exactly.
3. For IFRAME elements, ALWAYS include "frameId":N on each action.
4. ONE ITEM PER RESPONSE: Handle only the CURRENT visible item. Click the answer, click Next, then add a snapshot. Do NOT try to answer multiple items in one response.
5. For multi-step tasks: set "done":false after each item. The system will re-scan the page for you.
6. Set "done":true ONLY when there are NO more items/questions remaining.
7. NEVER answer questions in text. ALWAYS click the correct answer on the page.
8. Your response MUST have an "actions" array or it will be rejected.
9. BEFORE clicking Next: ALWAYS select an answer first. Read the question, read ALL options, pick the correct one, click it. NEVER click Next without answering.
10. If an answer is already selected ([CHECKED]), verify it is correct. If wrong, click the correct option to change it.
11. If a modal/dialog says items are unanswered, click Cancel/Go Back, then answer the current item.`;

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

  for (const m of (data.data || [])) {
    // Only include chat models (skip whisper, tts, etc.)
    if (m.id.includes('whisper') || m.id.includes('tts') || m.id.includes('distil')) continue;

    models.push({
      id: m.id,
      name: m.id,
      contextWindow: m.context_window,
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

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
  constructor(provider, apiKey, model) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model;
    this.conversationHistory = [];
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

  async sendMessage(userMessage, pageContext = null) {
    if (this.provider === 'groq') {
      return await this._sendGroq(userMessage, pageContext);
    } else if (this.provider === 'openrouter') {
      return await this._sendOpenRouter(userMessage, pageContext);
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

  async _sendGroq(userMessage, pageContext) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT }
    ];

    // Add recent history only (keep small for small models)
    const recentHistory = this.conversationHistory.slice(-6);
    for (const entry of recentHistory) {
      messages.push(entry);
    }

    let textContent = `Command: ${userMessage}`;
    if (pageContext) {
      textContent += `\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n`;
      if (pageContext.visualMap) {
        textContent += `\n${pageContext.visualMap}\n`;
      }
    }

    messages.push({ role: 'user', content: textContent });

    const requestBody = {
      model: this.model,
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

  async _sendOpenRouter(userMessage, pageContext) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT }
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
    // Keep history small for small models
    if (this.conversationHistory.length > 10) {
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
