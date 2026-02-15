// gemini-api.js — Gemini API client for browser control

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

export class GeminiClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.conversationHistory = [];
    this.model = 'gemini-2.0-flash';
  }

  async validateKey() {
    try {
      const response = await fetch(
        `${GEMINI_BASE_URL}/models?key=${this.apiKey}`
      );
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'Invalid API key');
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async sendMessage(userMessage, pageContext = null) {
    // Build contents with conversation history
    const contents = [];

    // Add conversation history
    for (const entry of this.conversationHistory) {
      contents.push(entry);
    }

    // Build user message parts
    const parts = [];

    if (pageContext) {
      // Add page context as text
      let contextText = `\n\n[Current Page Context]\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n`;

      if (pageContext.dom) {
        contextText += `\nSimplified DOM:\n${pageContext.dom}\n`;
      }

      parts.push({ text: userMessage + contextText });

      // Add screenshot if available
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
      `${GEMINI_BASE_URL}/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];

    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      throw new Error('No response from Gemini');
    }

    const responseText = candidate.content.parts[0].text;

    // Save to conversation history
    this.conversationHistory.push({ role: 'user', parts: [{ text: userMessage }] });
    this.conversationHistory.push({ role: 'model', parts: [{ text: responseText }] });

    // Keep history manageable (last 20 turns)
    if (this.conversationHistory.length > 40) {
      this.conversationHistory = this.conversationHistory.slice(-20);
    }

    // Parse JSON response
    try {
      return JSON.parse(responseText);
    } catch {
      // If Gemini didn't return valid JSON, wrap it
      return {
        thinking: 'Response was not structured JSON',
        actions: [{ type: 'describe', text: responseText }],
        summary: responseText
      };
    }
  }

  clearHistory() {
    this.conversationHistory = [];
  }
}
