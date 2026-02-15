// ai-client.js — Unified AI client supporting Gemini and OpenRouter

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
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyPlaceholder: 'AIza...',
    keyHelp: 'https://aistudio.google.com/apikey',
    keyHelpText: 'aistudio.google.com',
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
  if (provider === 'gemini') {
    return await _fetchGeminiModels(apiKey);
  } else if (provider === 'openrouter') {
    return await _fetchOpenRouterModels(apiKey);
  }
  throw new Error('Unknown provider: ' + provider);
}

async function _fetchGeminiModels(apiKey) {
  const response = await fetch(
    `${PROVIDERS.gemini.baseUrl}/models?key=${apiKey}`
  );
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Failed to fetch models');
  }

  const data = await response.json();
  const models = [];

  for (const m of (data.models || [])) {
    // Only include models that support generateContent
    const methods = m.supportedGenerationMethods || [];
    if (!methods.includes('generateContent')) continue;

    // Model name is like "models/gemini-2.0-flash" — extract the ID
    const id = m.name.replace('models/', '');
    const displayName = m.displayName || id;

    models.push({
      id,
      name: displayName,
      description: m.description || '',
      inputTokenLimit: m.inputTokenLimit,
      outputTokenLimit: m.outputTokenLimit,
    });
  }

  // Sort: shorter names / newer versions first for readability
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
      if (this.provider === 'gemini') {
        return await this._validateGeminiKey();
      } else if (this.provider === 'openrouter') {
        return await this._validateOpenRouterKey();
      }
      return { success: false, error: 'Unknown provider' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async sendMessage(userMessage, pageContext = null) {
    if (this.provider === 'gemini') {
      return await this._sendGemini(userMessage, pageContext);
    } else if (this.provider === 'openrouter') {
      return await this._sendOpenRouter(userMessage, pageContext);
    }
    throw new Error('Unknown provider: ' + this.provider);
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  // ── Gemini Implementation ──

  async _validateGeminiKey() {
    const response = await fetch(
      `${PROVIDERS.gemini.baseUrl}/models?key=${this.apiKey}`
    );
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Invalid API key');
    }
    return { success: true };
  }

  async _sendGemini(userMessage, pageContext) {
    const contents = [];

    for (const entry of this.conversationHistory) {
      contents.push(entry);
    }

    const parts = [];

    if (pageContext) {
      let contextText = `\n\n[Current Page Context]\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n`;
      if (pageContext.dom) {
        contextText += `\nSimplified DOM:\n${pageContext.dom}\n`;
      }
      parts.push({ text: userMessage + contextText });

      if (pageContext.screenshot) {
        parts.push({
          inline_data: {
            mime_type: 'image/png',
            data: pageContext.screenshot
          }
        });
      }
    } else {
      parts.push({ text: userMessage });
    }

    contents.push({ role: 'user', parts });

    const requestBody = {
      contents,
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json'
      }
    };

    const response = await fetch(
      `${PROVIDERS.gemini.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const err = await response.json();
      const msg = err.error?.message || `Gemini API error: ${response.status}`;
      // Detect stale/invalid model and give actionable error
      if (msg.includes('is not found') || msg.includes('not supported')) {
        throw new Error(`Model "${this.model}" is not available. Go to Settings, click Load Models, and pick a valid one.`);
      }
      throw new Error(msg);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];

    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      throw new Error('No response from Gemini');
    }

    const responseText = candidate.content.parts[0].text;

    this.conversationHistory.push({ role: 'user', parts: [{ text: userMessage }] });
    this.conversationHistory.push({ role: 'model', parts: [{ text: responseText }] });
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
        'HTTP-Referer': 'chrome-extension://gemini-browser-controller',
        'X-Title': 'Gemini Browser Controller',
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
