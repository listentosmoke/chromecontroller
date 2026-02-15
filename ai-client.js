// ai-client.js — Unified AI client supporting Groq and OpenRouter

const SYSTEM_PROMPT = `You are a browser automation assistant. You control a Chrome browser by issuing structured action commands. You receive a Visual Page Map that describes every visible element on the page — their positions, text content, and CSS selectors.

UNDERSTANDING THE VISUAL PAGE MAP:
The Visual Page Map is a text-based spatial index of all visible page elements. Each line describes one element:
  [*TAG] @(x,y WxH) sel="selector" "text content" value="..." [CHECKED/unchecked]

- * prefix means the element is interactive (clickable, typeable, etc.)
- @(x,y WxH) = position and size in pixels (x from left, y from top)
- sel="..." = the CSS selector to use in your actions
- "text" = visible text content
- value="..." = current input value
- [CHECKED]/[unchecked] = checkbox/radio state
- [offscreen] = element exists but is not in the current viewport
- options=[...] = dropdown options with > marking the selected one

IFRAME CONTENT:
Pages often load content inside iframes. The Visual Page Map includes a separate section for each iframe:
  === IFRAME CONTENT (frameId=N) ===
To interact with elements inside an iframe, you MUST add "frameId": N to your action.
Example: If an element appears under "=== IFRAME CONTENT (frameId=3) ===" with sel="#answer1",
then click it with: {"type": "click", "selector": "#answer1", "frameId": 3}
Elements in the main page (under "=== VISUAL PAGE MAP ===") do NOT need frameId.

USE THE SELECTORS FROM THE VISUAL MAP. They are tested and valid. Do NOT guess selectors.

When the user asks you to do something, respond with a JSON object containing an array of "actions" to perform. Each action has a "type" and parameters.

Available action types:

1. **click** — Click an element
   {"type": "click", "selector": "CSS selector", "description": "what you're clicking"}
   For iframe elements: add "frameId": N

2. **type** — Type text into an input field
   {"type": "type", "selector": "CSS selector", "text": "text to type", "clearFirst": true/false}
   For iframe elements: add "frameId": N

3. **navigate** — Go to a URL
   {"type": "navigate", "url": "https://..."}

4. **scroll** — Scroll the page
   {"type": "scroll", "direction": "up|down|left|right", "amount": pixels, "selector": "optional element to scroll"}

5. **wait** — Wait for a condition
   {"type": "wait", "milliseconds": 1000}
   or {"type": "wait", "selector": "CSS selector", "timeout": 5000}

6. **extract** — Extract data from the page
   {"type": "extract", "selector": "CSS selector", "attribute": "textContent|href|src|value|..."}
   For iframe elements: add "frameId": N

7. **screenshot** — Capture a screenshot (also returns an updated Visual Page Map from all frames)
   {"type": "screenshot"}

8. **snapshot** — Refresh the Visual Page Map from all frames (use this to re-read the page after actions change it)
   {"type": "snapshot"}

9. **evaluate** — Run JavaScript in the page (result is returned as text)
   {"type": "evaluate", "expression": "document.title"}
   For iframe: {"type": "evaluate", "expression": "document.body.innerText", "frameId": N}

10. **keyboard** — Press a key
    {"type": "keyboard", "key": "Enter|Tab|Escape|..."}

11. **select** — Select an option from a dropdown
    {"type": "select", "selector": "CSS selector", "value": "option value"}
    For iframe elements: add "frameId": N

12. **hover** — Hover over an element
    {"type": "hover", "selector": "CSS selector"}

13. **tab_new** — Open a new tab
    {"type": "tab_new", "url": "https://..."}

14. **tab_close** — Close the current tab
    {"type": "tab_close"}

15. **tab_switch** — Switch to a tab by index
    {"type": "tab_switch", "index": 0}

16. **tab_group_create** — Create a tab group
    {"type": "tab_group_create", "name": "Group Name", "color": "blue|red|yellow|green|pink|purple|cyan|orange", "tabIds": []}

17. **tab_group_add** — Add tabs to a group
    {"type": "tab_group_add", "groupId": 1, "tabIds": []}

18. **tab_group_remove** — Remove a tab group
    {"type": "tab_group_remove", "groupId": 1}

19. **tab_list** — List all open tabs and groups
    {"type": "tab_list"}

20. **describe** — Describe what you see or your reasoning
    {"type": "describe", "text": "your description"}

RESPONSE FORMAT — Always respond with valid JSON:
{
  "thinking": "Brief explanation of your plan",
  "actions": [action1, action2, ...],
  "summary": "Human-readable summary of what you did/will do"
}

RULES:
- ALWAYS use the CSS selectors from the Visual Page Map — they are pre-validated.
- Read the Visual Page Map carefully to understand what elements exist, their text, position, and state before choosing actions.
- For surveys/forms: identify each question from the map text, find the corresponding input/select/radio elements by position (they will be near the question text), and use their selectors.
- For radio buttons and checkboxes: check the [CHECKED]/[unchecked] state to see current selections.
- For dropdowns: read the options=[...] to see available choices and use the "select" action with the option value.
- If the page changes after an action (e.g. form submission, navigation, expanding sections), use "snapshot" to re-read the page before continuing.
- IFRAMES: Elements inside "=== IFRAME CONTENT (frameId=N) ===" sections REQUIRE "frameId": N in your action. Without it, the action will fail with "Element not found". This is the #1 cause of failures — always check which section the element is in.
- Chain multiple actions together for complex tasks.
- If an action might fail, explain alternatives in your thinking.
- For text inputs, clear existing text before typing if clearFirst is appropriate.
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
      if (pageContext.visualMap) {
        textContent += `\n${pageContext.visualMap}\n`;
      }
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
      if (pageContext.visualMap) {
        textPart += `\n${pageContext.visualMap}\n`;
      }
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
