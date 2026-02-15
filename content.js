// content.js — Content script for DOM interaction

(() => {
  // Prevent double-injection
  if (window.__geminiControllerInjected) return;
  window.__geminiControllerInjected = true;

  // Highlight overlay for showing which element is being targeted
  let highlightOverlay = null;
  let highlightLabel = null;

  function createHighlightOverlay() {
    if (highlightOverlay) return;

    highlightOverlay = document.createElement('div');
    highlightOverlay.id = '__gemini-highlight';
    highlightOverlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      border: 2px solid #4285F4;
      background: rgba(66, 133, 244, 0.1);
      border-radius: 3px;
      transition: all 0.15s ease;
      display: none;
    `;

    highlightLabel = document.createElement('div');
    highlightLabel.id = '__gemini-highlight-label';
    highlightLabel.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      background: #4285F4;
      color: white;
      font-size: 11px;
      font-family: monospace;
      padding: 2px 6px;
      border-radius: 3px;
      white-space: nowrap;
      display: none;
    `;

    document.documentElement.appendChild(highlightOverlay);
    document.documentElement.appendChild(highlightLabel);
  }

  function highlightElement(selector, label) {
    createHighlightOverlay();
    try {
      const el = document.querySelector(selector);
      if (!el) {
        hideHighlight();
        return false;
      }

      const rect = el.getBoundingClientRect();
      highlightOverlay.style.top = rect.top + 'px';
      highlightOverlay.style.left = rect.left + 'px';
      highlightOverlay.style.width = rect.width + 'px';
      highlightOverlay.style.height = rect.height + 'px';
      highlightOverlay.style.display = 'block';

      if (label) {
        highlightLabel.textContent = label;
        highlightLabel.style.top = Math.max(0, rect.top - 22) + 'px';
        highlightLabel.style.left = rect.left + 'px';
        highlightLabel.style.display = 'block';
      }

      return true;
    } catch {
      return false;
    }
  }

  function hideHighlight() {
    if (highlightOverlay) highlightOverlay.style.display = 'none';
    if (highlightLabel) highlightLabel.style.display = 'none';
  }

  // Get a simplified DOM representation for Gemini to understand the page
  function getSimplifiedDOM(maxDepth = 5, maxElements = 200) {
    let count = 0;

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' &&
             style.visibility !== 'hidden' &&
             style.opacity !== '0' &&
             el.offsetWidth > 0 &&
             el.offsetHeight > 0;
    }

    function getSelector(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;

      // Try unique class
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).filter(c => c.length > 0);
        for (const cls of classes) {
          const sel = `.${CSS.escape(cls)}`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }

      // Try aria-label
      if (el.getAttribute('aria-label')) {
        const sel = `[aria-label="${CSS.escape(el.getAttribute('aria-label'))}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }

      // Try data-testid
      if (el.dataset.testid) {
        return `[data-testid="${CSS.escape(el.dataset.testid)}"]`;
      }

      // Try name attribute
      if (el.name) {
        const sel = `[name="${CSS.escape(el.name)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }

      // Fall back to nth-child path
      const parts = [];
      let current = el;
      while (current && current !== document.body && parts.length < 4) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(current) + 1;
            parts.unshift(`${tag}:nth-of-type(${idx})`);
          } else {
            parts.unshift(tag);
          }
        } else {
          parts.unshift(tag);
        }
        current = parent;
      }
      return parts.join(' > ');
    }

    const INTERACTIVE_TAGS = new Set([
      'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
      'LABEL', 'OPTION', 'FORM'
    ]);

    const IMPORTANT_TAGS = new Set([
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH',
      'IMG', 'VIDEO', 'IFRAME', 'NAV', 'MAIN', 'HEADER', 'FOOTER',
      'ARTICLE', 'SECTION'
    ]);

    function processNode(el, depth) {
      if (count >= maxElements || depth > maxDepth) return null;
      if (el.nodeType !== Node.ELEMENT_NODE) return null;

      const tag = el.tagName;

      // Skip script/style/hidden elements
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH'].includes(tag)) return null;
      if (el.id === '__gemini-highlight' || el.id === '__gemini-highlight-label') return null;

      if (!isVisible(el)) return null;

      const isInteractive = INTERACTIVE_TAGS.has(tag) ||
                            el.getAttribute('role') === 'button' ||
                            el.getAttribute('role') === 'link' ||
                            el.getAttribute('role') === 'tab' ||
                            el.onclick !== null ||
                            el.getAttribute('tabindex') !== null;

      const isImportant = IMPORTANT_TAGS.has(tag);

      if (!isInteractive && !isImportant && depth > 3) {
        // Skip deeply nested non-interactive, non-important elements
        return null;
      }

      count++;

      const node = {
        tag: tag.toLowerCase(),
        selector: getSelector(el)
      };

      // Add relevant attributes
      if (el.id) node.id = el.id;
      if (isInteractive) {
        node.interactive = true;
        if (el.type) node.inputType = el.type;
        if (el.placeholder) node.placeholder = el.placeholder;
        if (el.value) node.value = el.value.substring(0, 100);
        if (el.href) node.href = el.href;
        if (el.disabled) node.disabled = true;
        if (el.getAttribute('aria-label')) node.ariaLabel = el.getAttribute('aria-label');
      }

      // Get text content (truncated)
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ')
        .substring(0, 150);

      if (directText) node.text = directText;

      // Process children
      const children = [];
      for (const child of el.children) {
        const childNode = processNode(child, depth + 1);
        if (childNode) children.push(childNode);
      }

      if (children.length > 0) node.children = children;

      return node;
    }

    const result = processNode(document.body, 0);
    return JSON.stringify(result, null, 2);
  }

  // Action executors
  async function clickElement(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    highlightElement(selector, 'clicking');

    // Scroll into view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300);

    // Dispatch mouse events for realistic clicking
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));

    await sleep(200);
    hideHighlight();

    return { success: true, text: el.textContent?.substring(0, 100) };
  }

  async function typeText(selector, text, clearFirst = true) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    highlightElement(selector, 'typing');
    el.focus();

    if (clearFirst) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Type character by character for realistic input
    for (const char of text) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.value += char;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(30 + Math.random() * 50);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    hideHighlight();

    return { success: true };
  }

  async function hoverElement(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    highlightElement(selector, 'hovering');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(200);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

    return { success: true };
  }

  async function scrollPage(direction, amount = 300, selector = null) {
    const target = selector ? document.querySelector(selector) : window;
    if (selector && !target) throw new Error(`Element not found: ${selector}`);

    const scrollTarget = selector ? target : document.documentElement;

    const scrollMap = {
      up: { top: -amount, left: 0 },
      down: { top: amount, left: 0 },
      left: { top: 0, left: -amount },
      right: { top: 0, left: amount }
    };

    const { top, left } = scrollMap[direction] || scrollMap.down;

    if (selector) {
      scrollTarget.scrollBy({ top, left, behavior: 'smooth' });
    } else {
      window.scrollBy({ top, left, behavior: 'smooth' });
    }

    await sleep(500);
    return { success: true };
  }

  function extractData(selector, attribute = 'textContent') {
    const elements = document.querySelectorAll(selector);
    if (elements.length === 0) throw new Error(`No elements found: ${selector}`);

    const results = Array.from(elements).map(el => {
      if (attribute === 'textContent') return el.textContent.trim();
      if (attribute === 'innerHTML') return el.innerHTML;
      return el.getAttribute(attribute);
    });

    return { success: true, data: results };
  }

  function evaluateExpression(expression) {
    try {
      const result = eval(expression);
      return { success: true, result: String(result).substring(0, 5000) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function pressKey(key) {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));

    if (key === 'Enter') {
      target.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
    }

    await sleep(100);
    return { success: true };
  }

  async function selectOption(selector, value) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    highlightElement(selector, 'selecting');
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));

    await sleep(200);
    hideHighlight();

    return { success: true };
  }

  async function waitForSelector(selector, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (document.querySelector(selector)) {
        return { success: true };
      }
      await sleep(200);
    }
    throw new Error(`Timeout waiting for: ${selector}`);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Message handler — receives commands from background script
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_PAGE_CONTEXT') {
      const context = {
        url: window.location.href,
        title: document.title,
        dom: getSimplifiedDOM()
      };
      sendResponse(context);
      return;
    }

    if (msg.type === 'EXECUTE_ACTION') {
      handleAction(msg.action).then(sendResponse).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // async response
    }

    if (msg.type === 'HIGHLIGHT') {
      highlightElement(msg.selector, msg.label);
      sendResponse({ success: true });
      return;
    }

    if (msg.type === 'HIDE_HIGHLIGHT') {
      hideHighlight();
      sendResponse({ success: true });
      return;
    }
  });

  async function handleAction(action) {
    switch (action.type) {
      case 'click':
        return clickElement(action.selector);
      case 'type':
        return typeText(action.selector, action.text, action.clearFirst !== false);
      case 'hover':
        return hoverElement(action.selector);
      case 'scroll':
        return scrollPage(action.direction, action.amount, action.selector);
      case 'extract':
        return extractData(action.selector, action.attribute);
      case 'evaluate':
        return evaluateExpression(action.expression);
      case 'keyboard':
        return pressKey(action.key);
      case 'select':
        return selectOption(action.selector, action.value);
      case 'wait':
        if (action.selector) {
          return waitForSelector(action.selector, action.timeout);
        }
        await sleep(action.milliseconds || 1000);
        return { success: true };
      case 'describe':
        return { success: true, text: action.text };
      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  }
})();
