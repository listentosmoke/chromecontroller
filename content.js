// content.js — Content script for DOM interaction

(() => {
  // Prevent double-injection
  if (window.__aiControllerInjected) return;
  window.__aiControllerInjected = true;

  // Highlight overlay for showing which element is being targeted
  let highlightOverlay = null;
  let highlightLabel = null;

  function createHighlightOverlay() {
    if (highlightOverlay) return;

    highlightOverlay = document.createElement('div');
    highlightOverlay.id = '__ai-highlight';
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
    highlightLabel.id = '__ai-highlight-label';
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

  // Get a simplified DOM representation for the AI to understand the page
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
      if (el.id === '__ai-highlight' || el.id === '__ai-highlight-label') return null;

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

  // Build a text-based visual map of the page for non-vision AI models.
  // Scans all visible elements, records bounding boxes and text, then
  // produces a screenreader-like spatial index sorted top-to-bottom.
  function getVisualPageMap() {
    const entries = [];
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    const INTERACTIVE_TAGS = new Set([
      'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
      'LABEL', 'OPTION'
    ]);

    const SKIP_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK', 'BR', 'HR'
    ]);

    function getSelector(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).filter(c => c.length > 0);
        for (const cls of classes) {
          const sel = `.${CSS.escape(cls)}`;
          try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* skip */ }
        }
      }
      if (el.getAttribute('aria-label')) {
        const sel = `[aria-label="${CSS.escape(el.getAttribute('aria-label'))}"]`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* skip */ }
      }
      if (el.dataset && el.dataset.testid) {
        return `[data-testid="${CSS.escape(el.dataset.testid)}"]`;
      }
      if (el.name) {
        const sel = `[name="${CSS.escape(el.name)}"]`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* skip */ }
      }
      // nth-child fallback
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

    function directText(el) {
      let text = '';
      for (const n of el.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          text += n.textContent;
        }
      }
      return text.replace(/[\t\n\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }

    // Walk the visible DOM and collect entries
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(el) {
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          if (el.id === '__ai-highlight' || el.id === '__ai-highlight-label') return NodeFilter.FILTER_REJECT;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      if (entries.length >= 500) break;

      const tag = node.tagName;
      const rect = node.getBoundingClientRect();

      // Skip zero-size or fully off-screen elements
      if (rect.width === 0 && rect.height === 0) continue;

      const isDraggable = node.draggable === true || node.getAttribute('draggable') === 'true';

      const isInteractive = INTERACTIVE_TAGS.has(tag) ||
        node.getAttribute('role') === 'button' ||
        node.getAttribute('role') === 'link' ||
        node.getAttribute('role') === 'tab' ||
        node.getAttribute('role') === 'checkbox' ||
        node.getAttribute('role') === 'radio' ||
        node.getAttribute('role') === 'option' ||
        node.getAttribute('role') === 'menuitem' ||
        node.onclick !== null ||
        node.getAttribute('tabindex') !== null ||
        isDraggable;

      const text = directText(node);

      // Only record elements that have text content or are interactive
      if (!text && !isInteractive) continue;

      const entry = {
        tag: tag.toLowerCase(),
        selector: getSelector(node),
        x: Math.round(rect.left + scrollX),
        y: Math.round(rect.top + scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        visible: rect.top < vpH && rect.bottom > 0 && rect.left < vpW && rect.right > 0,
      };

      if (text) entry.text = text.substring(0, 200);
      if (isInteractive) entry.interactive = true;

      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        entry.inputType = node.type || 'text';
        if (node.value) entry.value = node.value.substring(0, 100);
        if (node.placeholder) entry.placeholder = node.placeholder;
        if (tag === 'INPUT' && (node.type === 'checkbox' || node.type === 'radio')) {
          entry.checked = node.checked;
        }
        if (tag === 'SELECT') {
          entry.options = Array.from(node.options).slice(0, 20).map(o => ({
            value: o.value,
            text: o.textContent.trim().substring(0, 80),
            selected: o.selected
          }));
        }
      }

      if (tag === 'A' && node.href) entry.href = node.href;
      if (node.getAttribute('aria-label')) entry.ariaLabel = node.getAttribute('aria-label');
      if (node.disabled) entry.disabled = true;
      if (isDraggable) entry.draggable = true;
      // Mark drop targets (elements with ondragover/ondrop or role=list/group that accept drops)
      if (node.ondragover !== null || node.ondrop !== null ||
          node.getAttribute('dropzone') || node.classList.contains('drop-target') ||
          node.classList.contains('dropzone') || node.classList.contains('droppable')) {
        entry.droptarget = true;
      }

      entries.push(entry);
    }

    // Sort by vertical position (top-to-bottom), then left-to-right
    entries.sort((a, b) => a.y - b.y || a.x - b.x);

    // Build text output grouped into visual rows
    const lines = [];
    lines.push(`=== VISUAL PAGE MAP ===`);
    lines.push(`Viewport: ${vpW}x${vpH} | Scroll: ${Math.round(scrollX)},${Math.round(scrollY)} | Total elements: ${entries.length}`);
    lines.push('');

    for (const e of entries) {
      const parts = [];

      // Tag + type info
      let label = e.tag.toUpperCase();
      if (e.inputType) label += `[${e.inputType}]`;
      if (e.interactive) label = `*${label}`;

      parts.push(`[${label}]`);

      // Position
      parts.push(`@(${e.x},${e.y} ${e.w}x${e.h})`);

      // Visibility marker
      if (!e.visible) parts.push('[offscreen]');

      // Selector
      parts.push(`sel="${e.selector}"`);

      // Text content
      if (e.text) parts.push(`"${e.text}"`);

      // Extra attributes
      if (e.value) parts.push(`value="${e.value}"`);
      if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`);
      if (e.ariaLabel) parts.push(`aria="${e.ariaLabel}"`);
      if (e.checked !== undefined) parts.push(e.checked ? '[CHECKED]' : '[unchecked]');
      if (e.draggable) parts.push('[draggable]');
      if (e.droptarget) parts.push('[droptarget]');
      if (e.disabled) parts.push('[disabled]');
      if (e.href) parts.push(`href="${e.href}"`);

      // Select options
      if (e.options) {
        const optText = e.options.map(o => `${o.selected ? '>' : ' '}${o.value}="${o.text}"`).join(', ');
        parts.push(`options=[${optText}]`);
      }

      lines.push(parts.join(' '));
    }

    return lines.join('\n');
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
      return { success: true, text: String(result).substring(0, 5000) };
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

  async function dragElement(fromSelector, toSelector) {
    const from = document.querySelector(fromSelector);
    const to = document.querySelector(toSelector);
    if (!from) throw new Error(`Source element not found: ${fromSelector}`);
    if (!to) throw new Error(`Target element not found: ${toSelector}`);

    highlightElement(fromSelector, 'dragging');

    from.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);

    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const fromX = fromRect.left + fromRect.width / 2;
    const fromY = fromRect.top + fromRect.height / 2;
    const toX = toRect.left + toRect.width / 2;
    const toY = toRect.top + toRect.height / 2;
    const evtOpts = { bubbles: true, cancelable: true, view: window };

    // Phase 1: Mouse + Pointer events (works with jQuery UI, SortableJS, Learnosity, custom libs)
    from.dispatchEvent(new PointerEvent('pointerdown', { ...evtOpts, clientX: fromX, clientY: fromY, pointerId: 1 }));
    from.dispatchEvent(new MouseEvent('mousedown', { ...evtOpts, clientX: fromX, clientY: fromY }));
    await sleep(150);

    // Simulate smooth movement in 10 steps
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = fromX + (toX - fromX) * (i / steps);
      const y = fromY + (toY - fromY) * (i / steps);
      document.dispatchEvent(new PointerEvent('pointermove', { ...evtOpts, clientX: x, clientY: y, pointerId: 1 }));
      document.dispatchEvent(new MouseEvent('mousemove', { ...evtOpts, clientX: x, clientY: y }));
      await sleep(50);
    }

    // Fire enter/over on the target
    to.dispatchEvent(new MouseEvent('mouseenter', { ...evtOpts, clientX: toX, clientY: toY }));
    to.dispatchEvent(new MouseEvent('mouseover', { ...evtOpts, clientX: toX, clientY: toY }));
    await sleep(100);

    // Release
    to.dispatchEvent(new PointerEvent('pointerup', { ...evtOpts, clientX: toX, clientY: toY, pointerId: 1 }));
    to.dispatchEvent(new MouseEvent('mouseup', { ...evtOpts, clientX: toX, clientY: toY }));
    await sleep(200);

    // Phase 2: HTML5 DragEvent as secondary (native drag-and-drop support)
    try {
      const dataTransfer = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { ...evtOpts, clientX: fromX, clientY: fromY, dataTransfer }));
      await sleep(100);
      to.dispatchEvent(new DragEvent('dragenter', { ...evtOpts, clientX: toX, clientY: toY, dataTransfer }));
      to.dispatchEvent(new DragEvent('dragover', { ...evtOpts, clientX: toX, clientY: toY, dataTransfer }));
      await sleep(100);
      to.dispatchEvent(new DragEvent('drop', { ...evtOpts, clientX: toX, clientY: toY, dataTransfer }));
      from.dispatchEvent(new DragEvent('dragend', { ...evtOpts, clientX: toX, clientY: toY, dataTransfer }));
    } catch { /* DragEvent may not be supported in all contexts */ }

    await sleep(400);
    hideHighlight();

    const fromText = from.textContent?.trim().substring(0, 50) || fromSelector;
    const toText = to.textContent?.trim().substring(0, 50) || toSelector;
    return { success: true, text: `Dragged "${fromText}" → "${toText}"` };
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
        dom: getSimplifiedDOM(),
        visualMap: getVisualPageMap()
      };
      sendResponse(context);
      return;
    }

    if (msg.type === 'GET_VISUAL_MAP') {
      sendResponse({ visualMap: getVisualPageMap() });
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
      case 'drag':
        return dragElement(action.fromSelector || action.selector, action.toSelector);
      case 'getDragCoords': {
        const from = document.querySelector(action.fromSelector);
        const to = document.querySelector(action.toSelector);
        if (!from) throw new Error(`Source not found: ${action.fromSelector}`);
        if (!to) throw new Error(`Target not found: ${action.toSelector}`);
        from.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);
        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();
        return {
          success: true,
          fromX: fromRect.left + fromRect.width / 2,
          fromY: fromRect.top + fromRect.height / 2,
          toX: toRect.left + toRect.width / 2,
          toY: toRect.top + toRect.height / 2,
          fromText: from.textContent?.trim().substring(0, 50) || action.fromSelector,
          toText: to.textContent?.trim().substring(0, 50) || action.toSelector
        };
      }
      case 'wait':
        if (action.selector) {
          return waitForSelector(action.selector, action.timeout);
        }
        await sleep(action.milliseconds || 1000);
        return { success: true };
      case 'describe':
        return { success: true, text: action.text };
      case 'snapshot':
        return { success: true, text: getVisualPageMap() };
      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  }
})();
