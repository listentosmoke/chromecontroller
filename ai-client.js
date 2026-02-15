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

// ── Provider definitions ──

export const PROVIDERS = {
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyPlaceholder: 'AIza...',
    keyHelp: 'https://aistudio.google.com/apikey',
    keyHelpText: 'aistudio.google.com',
    models: [
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', free: true },
      { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B', free: true },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', free: true },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', free: true },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', free: false },
      { id: 'gemini-2.5-flash-preview-05-20', name: 'Gemini 2.5 Flash Preview', free: false },
      { id: 'gemini-2.5-pro-preview-05-06', name: 'Gemini 2.5 Pro Preview', free: false },
    ],
    defaultModel: 'gemini-1.5-flash',
    supportsVision: true,
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-...',
    keyHelp: 'https://openrouter.ai/keys',
    keyHelpText: 'openrouter.ai/keys',
    models: [
      { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', free: false },
      { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', free: false },
      { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', free: false },
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', free: false },
      { id: 'anthropic/claude-haiku-4', name: 'Claude Haiku 4', free: false },
      { id: 'openai/gpt-4o', name: 'GPT-4o', free: false },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', free: false },
      { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', free: false },
      { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', free: false },
      { id: 'mistralai/mistral-small-3.2-24b-instruct', name: 'Mistral Small 3.2', free: false },
      { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', free: false },
      // Free models
      { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash Exp (Free)', free: true },
      { id: 'meta-llama/llama-4-maverick:free', name: 'Llama 4 Maverick (Free)', free: true },
      { id: 'deepseek/deepseek-chat-v3-0324:free', name: 'DeepSeek V3 (Free)', free: true },
      { id: 'qwen/qwen3-235b-a22b:free', name: 'Qwen3 235B (Free)', free: true },
      { id: 'mistralai/mistral-small-3.2-24b-instruct:free', name: 'Mistral Small 3.2 (Free)', free: true },
    ],
    defaultModel: 'google/gemini-2.0-flash-exp:free',
    supportsVision: true,
  },
};

// ── Unified AI Client ──

export class AIClient {
  constructor(provider, apiKey, model) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model || PROVIDERS[provider]?.defaultModel;
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

    // Add conversation history
    for (const entry of this.conversationHistory) {
      contents.push(entry);
    }

    // Build user message parts
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
      throw new Error(err.error?.message || `Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];

    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      throw new Error('No response from Gemini');
    }

    const responseText = candidate.content.parts[0].text;

    // Save to history (text only, no images)
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
    // Build messages array (OpenAI format)
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + '\n\nIMPORTANT: You MUST respond with ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON.' }
    ];

    // Add conversation history
    for (const entry of this.conversationHistory) {
      messages.push(entry);
    }

    // Build user message
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

    // Save to history (OpenAI format)
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
    // Strip markdown code fences if present
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
