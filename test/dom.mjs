/**
 * Minimal DOM stub shared by the offline tests.
 *
 * It is deliberately small: just enough structure for the real bundle to run
 * against (element tree, attribute/class selectors, event listeners, focus and
 * a selection holder) without pulling in jsdom.
 */

/** Attribute and `.class` selector matcher: `[a]`, `[a="v"]`, `tag[a="v"]`, `.cls`. */
export function matches(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  let rest = String(selector).trim();
  if (rest.startsWith('.')) {
    const classes = String(node.className || '').split(/\s+/);
    return classes.includes(rest.slice(1));
  }
  const tag = /^([a-zA-Z][\w-]*)/.exec(rest);
  if (tag) {
    if (node.tagName.toLowerCase() !== tag[1].toLowerCase()) return false;
    rest = rest.slice(tag[1].length);
  }
  const parts = rest.match(/\[[^\]]*\]/g) || [];
  for (const part of parts) {
    const body = part.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) {
      if (!(body in node.attrs)) return false;
      continue;
    }
    const name = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (node.attrs[name] !== value) return false;
  }
  return true;
}

export class Node {
  constructor(tag, nodeType = 1) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = nodeType;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.style = {};
    this.className = '';
    this.listeners = new Map();
    this._text = '';
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get textContent() {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  removeAttribute(name) {
    delete this.attrs[name];
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type, event) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  querySelector(selector) {
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) return child;
        const nested = walk(child);
        if (nested) return nested;
      }
      return null;
    };
    return walk(this);
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matches(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return { width: 220, height: 64 };
  }

  focus() {
    this.focused = true;
  }
}

export function makeDocument() {
  return {
    nodeType: 9,
    head: new Node('head'),
    body: new Node('body'),
    listeners: new Map(),
    createElement(tag) {
      return new Node(tag);
    },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this.listeners.get(type);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    },
    querySelector(selector) {
      return this.head.querySelector(selector) || this.body.querySelector(selector);
    },
  };
}

export function makeWindow(document) {
  return {
    document,
    innerWidth: 1200,
    innerHeight: 800,
    listeners: new Map(),
    timers: [],
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this.listeners.get(type);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    },
    setTimeout(fn, ms) {
      this.timers.push({ fn, ms });
      return this.timers.length;
    },
    setInterval(fn, ms) {
      this.timers.push({ fn, ms, interval: true });
      return this.timers.length;
    },
    clearTimeout() {
      // The stub does not actually run timers, so clearing is a no-op.
    },
    clearInterval() {
      // The stub does not actually run timers, so clearing is a no-op.
    },
    getSelection() {
      return this.selection ?? null;
    },
  };
}
