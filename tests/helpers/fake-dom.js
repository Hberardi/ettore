// A DOM small enough to read, real enough to test the browser page helpers
// against. Supports the handful of selector shapes those helpers actually use:
// comma lists, `*`, bare tags, [attr], [attr="value"] and tag[attr="value"].

let autoId = 0;

class DomTokenList extends Array {
  add(token) {
    if (!this.includes(token)) this.push(token);
    if (this.owner) this.owner.attributes.class = this.join(' ');
  }
  remove(token) {
    const at = this.indexOf(token);
    if (at !== -1) this.splice(at, 1);
    if (this.owner) this.owner.attributes.class = this.join(' ');
  }
  contains(token) { return this.includes(token); }
}

function parseSimple(part) {
  const trimmed = part.trim();
  const attrs = [];
  let tag = '';
  let rest = trimmed;
  const tagMatch = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (tagMatch) {
    tag = tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[1].length);
  }
  const attrRe = /\[([\w-]+)(?:=("?)([^\]"]*)\2)?\]/g;
  let m;
  while ((m = attrRe.exec(rest)) !== null) {
    attrs.push({ name: m[1], value: m[3] === undefined ? null : m[3] });
  }
  return { tag, attrs };
}

function matchesSimple(node, simple) {
  if (simple.tag && simple.tag !== '*' && node.tagName.toLowerCase() !== simple.tag) return false;
  for (const attr of simple.attrs) {
    const actual = node.getAttribute(attr.name);
    if (actual === null || actual === undefined) return false;
    if (attr.value !== null && String(actual) !== attr.value) return false;
  }
  return true;
}

export function matches(node, selector) {
  return String(selector)
    .split(',')
    .some(part => matchesSimple(node, parseSimple(part)));
}

export class FakeElement {
  constructor(tag, attributes = {}, text = '') {
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.parentElement = null;
    this.ownText = text;
    this.value = attributes.value === undefined ? '' : attributes.value;
    this.disabled = attributes.disabled === true || attributes.disabled === '';
    this.readOnly = attributes.readonly === true || attributes.readonly === '';
    this.isContentEditable = attributes.contenteditable === 'true';
    this.rect = { left: 0, top: 0, width: 120, height: 24 };
    this.style = { visibility: 'visible', display: 'block', opacity: '1' };
    this.events = [];
    this.focusCalls = 0;
    this.focusable = true;
    this.scrolled = false;
    this.nodeType = 1;
    this._uid = ++autoId;
  }

  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = v; }
  get classList() {
    const owner = this;
    const list = new DomTokenList();
    list.push(...String(owner.attributes.class || '').split(/\s+/).filter(Boolean));
    list.owner = owner;
    return list;
  }
  get innerText() {
    const own = this.ownText || '';
    const kids = this.children.map(c => c.innerText).filter(Boolean).join(' ');
    return [own, kids].filter(Boolean).join(' ');
  }
  get textContent() { return this.innerText; }
  set textContent(v) { this.ownText = v; this.children = []; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    const at = siblings.indexOf(this);
    return at > 0 ? siblings[at - 1] : null;
  }

  appendChild(node) {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at !== -1) this.children.splice(at, 1);
    node.parentElement = null;
    return node;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  getAttribute(name) {
    const v = this.attributes[name];
    return v === undefined ? null : (v === true ? '' : v);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { ...this.rect }; }
  scrollIntoView() { this.scrolled = true; }
  focus() { this.focusCalls += 1; if (this.focusable) this.ownerDocument.activeElement = this; }
  dispatchEvent(event) { this.events.push(event && event.type ? event.type : String(event)); return true; }

  get ownerDocument() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node._document || { activeElement: null };
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  contains(other) {
    if (other === this) return true;
    return this.descendants().includes(other);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector === '*') return this.descendants();
    return this.descendants().filter(node => matches(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

export class FakeDocument {
  constructor(root, { title = 'Test page' } = {}) {
    this.root = root;
    this.title = title;
    this.activeElement = null;
    root._document = this;
  }

  get all() { return [this.root, ...this.root.descendants()]; }
  get body() {
    if (String(this.root.tagName).toLowerCase() === 'body') return this.root;
    return this.querySelector('body');
  }
  createElement(tag) {
    const node = new FakeElement(tag);
    node._document = this;
    return node;
  }
  querySelectorAll(selector) {
    if (selector === '*') return this.all;
    return this.all.filter(node => matches(node, selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return this.all.find(node => node.getAttribute('id') === id) || null; }
  elementFromPoint(x, y) {
    // Topmost wins: later elements in document order, and anything flagged as
    // an overlay, sit above what came before.
    const hits = this.all.filter((node) => {
      const r = node.getBoundingClientRect();
      return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    });
    const overlay = hits.find(node => node.attributes.overlay === true);
    return overlay || hits[hits.length - 1] || null;
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
  }
}

export function makeWindow(doc, { valueSetterSpy = null } = {}) {
  function HTMLInputElement() {}
  function HTMLTextAreaElement() {}
  const define = (ctor) => {
    Object.defineProperty(ctor.prototype, 'value', {
      configurable: true,
      get() { return this._value || ''; },
      set(v) {
        if (valueSetterSpy) valueSetterSpy(this, v);
        this._value = v;
        this.value = v;
      },
    });
  };
  define(HTMLInputElement);
  define(HTMLTextAreaElement);
  return {
    getComputedStyle: (el) => el.style,
    location: { href: 'https://example.test/login' },
    Event: FakeEvent,
    HTMLInputElement,
    HTMLTextAreaElement,
    document: doc,
  };
}

export function el(tag, attributes = {}, text = '') {
  return new FakeElement(tag, attributes, text);
}
