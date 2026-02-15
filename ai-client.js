// ai-client.js — Unified AI client supporting Groq and OpenRouter

const SYSTEM_PROMPT = `You are a browser automation assistant. You control a Chrome browser by issuing structured action commands. You can see the page DOM and screenshots.

When the user asks you to do something, respond with a JSON object containing an array of "actions" to perform. Each action has a "type" and parameters.

Available action types:

1. **click** — Click an element
   {"type": "click", "selector": "CSS selector", "description": "what you're clicking"}

2. **type** — Type text into an input field
   {"type": "type", "selector": "CSS selector", "text": "text to type", "clearFirst": true/false}

3. **navigate** — Go to a URL
   {"type": "navigate", "url": "https://..."}

4. **scroll** — Scroll the page
   {"type": "scroll", "direction": "up|down|left|right", "amount": pixels, "selector": "optional element to scroll"}

5. **wait** — Wait for a condition
   {"type": "wait", "milliseconds": 1000}
   or {"type": "wait", "selector": "CSS selector", "timeout": 5000}

6. **extract** — Extract data from the page
   {"type": "extract", "selector": "CSS selector", "attribute": "textContent|href|src|value|..."}

7. **screenshot** — Capture a screenshot
   {"type": "screenshot"}

8. **evaluate** — Run JavaScript in the page
   {"type": "evaluate", "expression": "document.title"}

9. **keyboard** — Press a key
   {"type": "keyboard", "key": "Enter|Tab|Escape|..."}

10. **select** — Select an option from a dropdown
    {"type": "select", "selector": "CSS selector", "value": "option value"}

11. **hover** — Hover over an element
    {"type": "hover", "selector": "CSS selector"}

12. **tab_new** — Open a new tab
    {"type": "tab_new", "url": "https://..."}

13. **tab_close** — Close the current tab
    {"type": "tab_close"}

14. **tab_switch** — Switch to a tab by index
    {"type": "tab_switch", "index": 0}

15. **tab_group_create** — Create a tab group
    {"type": "tab_group_create", "name": "Group Name", "color": "blue|red|yellow|green|pink|purple|cyan|orange", "tabIds": []}

16. **tab_group_add** — Add tabs to a group
    {"type": "tab_group_add", "groupId": 1, "tabIds": []}

17. **tab_group_remove** — Remove a tab group
    {"type": "tab_group_remove", "groupId": 1}

18. **tab_list** — List all open tabs and groups
    {"type": "tab_list"}

19. **describe** — Describe what you see (use after screenshot or DOM inspection)
    {"type": "describe", "text": "your description of the page"}

RESPONSE FORMAT — Always respond with valid JSON:
{
  "thinking": "Brief explanation of your plan",
  "actions": [action1, action2, ...],
  "summary": "Human-readable summary of what you did/will do"
}

RULES:
- Use specific CSS selectors. Prefer IDs, then data attributes, then unique class names.
- If you need to see the page first before acting, start with a screenshot action.
- Chain multiple actions together for complex tasks.
- If an action might fail, explain alternatives in your thinking.
- For forms, clear existing text before typing if clearFirst is appropriate.
- Always include a summary for the user.`;

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
      { role: 'system', content: SYSTEM_PROMPT + '\n\nIMPORTANT: You MUST respond with ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON.' }
    ];

    for (const entry of this.conversationHistory) {
      messages.push(entry);
    }

    let textContent = userMessage;
    if (pageContext) {
      textContent += `\n\n[Current Page Context]\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n`;
      if (pageContext.dom) {
        textContent += `\nSimplified DOM:\n${pageContext.dom}\n`;
      }
    }

    messages.push({ role: 'user', content: textContent });

    const requestBody = {
      model: this.model,
      messages,
      temperature: 0.2,
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
      { role: 'system', content: SYSTEM_PROMPT + '\n\nIMPORTANT: You MUST respond with ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON.' }
    ];

    for (const entry of this.conversationHistory) {
      messages.push(entry);
    }

    if (pageContext) {
      const content = [];

      let textPart = userMessage + `\n\n[Current Page Context]\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n`;
      if (pageContext.dom) {
        textPart += `\nSimplified DOM:\n${pageContext.dom}\n`;
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
    if (this.conversationHistory.length > 40) {
      this.conversationHistory = this.conversationHistory.slice(-20);
    }
  }

  _parseResponse(responseText) {
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    try {
      return JSON.parse(cleaned);
    } catch {
      return {
        thinking: 'Response was not structured JSON',
        actions: [{ type: 'describe', text: responseText }],
        summary: responseText
      };
    }
  }
}
