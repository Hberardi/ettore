// Page-side helpers for the browser driver.
//
// Every function here is serialized with `Function.prototype.toString()` and
// evaluated inside the page, so it must not close over module scope, import
// anything, or touch Node globals. `doc` and `win` are passed in explicitly
// rather than read from the page globals: it keeps ESLint honest and it makes
// the whole file unit-testable against a fake DOM.
//
// Why this exists: driving a login form by clicking the *visible text* used to
// send the password into whatever happened to be focused. "Password" on screen
// is a <label>, not the <input>; clicking it may focus nothing, and the text
// then landed in the email field — or nowhere. These helpers resolve a label
// to its control, refuse to type into a non-editable target, and report where
// the text actually went.

export function ettoreIsField(el) {
  if (!el || !el.tagName) return false;
  var tag = String(el.tagName).toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    var type = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
    return ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'hidden', 'range', 'color'].indexOf(type) === -1;
  }
  if (el.isContentEditable === true) return true;
  var editable = el.getAttribute && el.getAttribute('contenteditable');
  return editable === '' || editable === 'true';
}

export function ettoreIsClickable(el) {
  if (!el || !el.tagName) return false;
  var tag = String(el.tagName).toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'option') return true;
  if (tag === 'input') {
    var type = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
    return ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].indexOf(type) !== -1;
  }
  var role = el.getAttribute && el.getAttribute('role');
  if (role && ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio'].indexOf(String(role).toLowerCase()) !== -1) return true;
  return !!(el.getAttribute && el.getAttribute('onclick'));
}

export function ettoreVisible(el, win) {
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return false;
  if (!win || !win.getComputedStyle) return true;
  var style = win.getComputedStyle(el);
  if (!style) return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.display === 'none') return false;
  if (style.opacity !== undefined && style.opacity !== '' && Number(style.opacity) === 0) return false;
  return true;
}

// A short, value-free description of an element. Never includes `value`: on a
// login form that is the credential itself, and this string is shown to the
// model and written to the transcript.
export function ettoreDescribe(el) {
  if (!el || !el.tagName) return '(none)';
  var out = String(el.tagName).toLowerCase();
  var attr = function (name) { return (el.getAttribute && el.getAttribute(name)) || ''; };
  if (out === 'input' && attr('type')) out += '[type=' + attr('type') + ']';
  if (attr('name')) out += '[name=' + attr('name') + ']';
  else if (el.id) out += '#' + el.id;
  var hint = attr('aria-label') || attr('placeholder') || '';
  if (hint) return out + ' "' + String(hint).slice(0, 40) + '"';
  // Nameless wrappers are what covers a login form — "div" alone tells the
  // user nothing, so fall back to the class and the visible caption. Never
  // `value`: on a login form that is the credential.
  if (!attr('name') && !el.id) {
    var cls = el.classList && el.classList.length ? '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.') : '';
    if (cls) out += cls;
  }
  if (!ettoreIsField(el)) {
    var caption = String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    if (caption) out += ' "' + caption.slice(0, 40) + '"';
  }
  return out;
}

// The control a visible label points at. This is the fix for the login bug:
// "Email" / "Password" on screen belong to a <label> or a wrapper <div>, and
// text must go into the control they describe, not into the label itself.
export function ettoreFieldFor(el, doc) {
  if (!el) return null;
  if (ettoreIsField(el)) return el;
  var tag = String(el.tagName || '').toLowerCase();
  var selector = 'input,textarea,select,[contenteditable="true"],[contenteditable=""]';

  if (tag === 'label') {
    if (el.control && ettoreIsField(el.control)) return el.control;
    var forId = el.getAttribute && el.getAttribute('for');
    if (forId && doc && doc.getElementById) {
      var byId = doc.getElementById(forId);
      if (byId && ettoreIsField(byId)) return byId;
    }
  }
  // <label>Password <input></label>, or a form-group wrapper around one field.
  if (el.querySelector) {
    var inner = el.querySelector(selector);
    if (inner && ettoreIsField(inner)) return inner;
  }
  // <span>Password</span><input> — the field sits next to the text.
  var probe = el.nextElementSibling;
  var hops = 0;
  while (probe && hops < 3) {
    if (ettoreIsField(probe)) return probe;
    if (probe.querySelector) {
      var nested = probe.querySelector(selector);
      if (nested && ettoreIsField(nested)) return nested;
    }
    probe = probe.nextElementSibling;
    hops += 1;
  }
  // Last resort: the nearest ancestor that owns exactly one field.
  var parent = el.parentElement;
  var up = 0;
  while (parent && up < 3) {
    if (parent.querySelectorAll) {
      var all = parent.querySelectorAll(selector);
      if (all && all.length === 1 && ettoreIsField(all[0])) return all[0];
    }
    parent = parent.parentElement;
    up += 1;
  }
  return null;
}

// Text a user could plausibly use to name this element, weighted by how
// reliable the source is.
export function ettoreLabelSources(el) {
  var out = [];
  var attr = function (name) { return (el.getAttribute && el.getAttribute(name)) || ''; };
  var own = String(el.innerText || el.textContent || '').trim();
  if (own && own.length <= 300) out.push({ text: own, weight: 1 });
  var aria = attr('aria-label');
  if (aria) out.push({ text: String(aria).trim(), weight: 1 });
  var placeholder = attr('placeholder');
  if (placeholder) out.push({ text: String(placeholder).trim(), weight: 1 });
  var title = attr('title');
  if (title) out.push({ text: String(title).trim(), weight: 0.8 });
  var name = attr('name');
  if (name) out.push({ text: String(name).trim(), weight: 0.75 });
  if (el.id) out.push({ text: String(el.id).trim(), weight: 0.7 });
  // A button's label lives in its value attribute; a text input's value is
  // whatever the user typed, which must never be matched against.
  var tag = String(el.tagName || '').toLowerCase();
  if (tag === 'input') {
    var type = String(attr('type') || 'text').toLowerCase();
    if (['button', 'submit', 'reset'].indexOf(type) !== -1 && attr('value')) {
      out.push({ text: String(attr('value')).trim(), weight: 1 });
    }
  }
  return out;
}

// Higher is better; 0 means "not a match". The old locator kept the *last*
// substring match in document order, which is how `text=Email` ended up on a
// footer link instead of the login field.
export function ettoreMatchScore(el, needle, opts) {
  if (!el || !needle) return 0;
  var wantField = !!(opts && opts.field);
  var wantClickable = !!(opts && opts.clickable);
  var sources = ettoreLabelSources(el);
  var best = 0;
  for (var i = 0; i < sources.length; i++) {
    var text = String(sources[i].text || '').toLowerCase();
    if (!text) continue;
    var score = 0;
    if (text === needle) score = 100;
    else if (text.indexOf(needle) === 0) score = 70;
    else if (text.indexOf(needle) !== -1) score = 40;
    else continue;
    // A 2000-character <div> that happens to contain "password" is not a
    // match for "password"; the shorter the label, the tighter the fit.
    if (score < 100 && text.length > needle.length * 4) score -= 15;
    score *= sources[i].weight;
    if (score > best) best = score;
  }
  if (!best) return 0;
  if (wantField) best += ettoreIsField(el) ? 30 : 0;
  if (wantClickable) best += ettoreIsClickable(el) ? 30 : 0;
  // Prefer the innermost element that matches: a wrapper inherits the text of
  // everything inside it, so without this the container always wins.
  var children = el.querySelectorAll ? el.querySelectorAll('*').length : 0;
  best -= Math.min(children, 20);
  return best;
}

export function ettoreLocate(locator, opts, doc, win) {
  var options = opts || {};
  var loc = String(locator || '');
  var el = null;
  var needle = '';
  var byText = false;

  if (loc.slice(0, 5) === 'text=') { needle = loc.slice(5).trim().toLowerCase(); byText = true; }
  else if (loc.slice(0, 6) === 'label=') { needle = loc.slice(6).trim().toLowerCase(); byText = true; }
  else if (loc.slice(0, 12) === 'placeholder=') { needle = loc.slice(12).trim().toLowerCase(); byText = true; }

  if (byText) {
    if (!needle) return { error: 'empty text locator: ' + loc };
    var nodes = doc.querySelectorAll(
      'input,textarea,select,button,a,label,summary,[role],[onclick],[contenteditable="true"],li,td,th,span,div,p,h1,h2,h3',
    );
    var bestScore = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!ettoreVisible(node, win)) continue;
      var score = ettoreMatchScore(node, needle, options);
      if (score > bestScore) { bestScore = score; el = node; }
    }
  } else {
    try { el = doc.querySelector(loc); } catch (e) { return { error: 'invalid selector: ' + e.message }; }
  }

  if (!el) return { error: 'no element matches ' + loc };

  // Typing targets a control, never the text that names it.
  var resolvedFrom = '';
  if (options.field && !ettoreIsField(el)) {
    var field = ettoreFieldFor(el, doc);
    if (!field) {
      return {
        error: 'matched ' + ettoreDescribe(el) + ' for ' + loc
          + ', but it is not an input and no field is associated with it',
      };
    }
    resolvedFrom = ettoreDescribe(el);
    el = field;
  }

  // `behavior: instant` matters: a page with `scroll-behavior: smooth` would
  // otherwise still be scrolling when the rect below is measured, and the
  // click would land on whatever was at those coordinates mid-animation.
  if (el.scrollIntoView) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    catch (e) { el.scrollIntoView(true); }
  }

  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2;
  var y = r.top + r.height / 2;

  // Cookie banners and sticky headers sit on top of login forms constantly.
  // Clicking blind would dismiss the banner and report success.
  var occluder = '';
  if (doc.elementFromPoint) {
    var top = doc.elementFromPoint(x, y);
    if (top && top !== el) {
      var related = (el.contains && el.contains(top)) || (top.contains && top.contains(el));
      if (!related) occluder = ettoreDescribe(top);
    }
  }

  if (options.mark && el.setAttribute) el.setAttribute('data-ettore-target', String(options.mark));

  return {
    x: x,
    y: y,
    width: r.width,
    height: r.height,
    visible: ettoreVisible(el, win),
    tag: String(el.tagName || '').toLowerCase(),
    type: String((el.getAttribute && el.getAttribute('type')) || ''),
    describe: ettoreDescribe(el),
    resolvedFrom: resolvedFrom,
    field: ettoreIsField(el),
    occluder: occluder,
    disabled: !!el.disabled,
    readOnly: !!el.readOnly,
    text: String(el.innerText || (el.getAttribute && el.getAttribute('aria-label')) || '').trim().slice(0, 120),
  };
}

function ettoreMarked(token, doc) {
  return doc.querySelector('[data-ettore-target="' + String(token) + '"]');
}

// After the real mouse click, confirm the field we aimed at is the one that
// took focus — this is the check whose absence let a password be typed into
// the email box. Falls back to a programmatic focus before giving up.
export function ettoreEnsureFocus(token, doc) {
  var el = ettoreMarked(token, doc);
  if (!el) return { error: 'target element disappeared from the page' };
  if (doc.activeElement === el) {
    return { focused: true, via: 'click', describe: ettoreDescribe(el) };
  }
  if (el.focus) {
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  if (doc.activeElement === el) {
    return { focused: true, via: 'focus()', describe: ettoreDescribe(el) };
  }
  return {
    focused: false,
    describe: ettoreDescribe(el),
    activeDescribe: ettoreDescribe(doc.activeElement),
  };
}

// Clearing through the prototype setter is what makes React/Vue notice: their
// value tracker ignores a plain `el.value = ''`, so the framework state — and
// the value actually submitted — would keep the old text.
export function ettoreSetValue(token, value, append, doc, win) {
  var el = ettoreMarked(token, doc);
  if (!el) return { error: 'target element disappeared from the page' };
  var text = String(value == null ? '' : value);
  if (append) {
    // Appending happens in the page so the existing content — a half-typed
    // password, say — never crosses back over the protocol.
    var current = el.isContentEditable === true
      ? String(el.textContent == null ? '' : el.textContent)
      : String(el.value == null ? '' : el.value);
    text = current + text;
  }
  if (ettoreIsField(el) && el.isContentEditable === true) {
    el.textContent = text;
  } else {
    var proto = String(el.tagName).toLowerCase() === 'textarea' ? win.HTMLTextAreaElement : win.HTMLInputElement;
    var descriptor = proto && proto.prototype
      ? Object.getOwnPropertyDescriptor(proto.prototype, 'value')
      : null;
    if (descriptor && descriptor.set) descriptor.set.call(el, text);
    else el.value = text;
  }
  if (el.dispatchEvent && win.Event) {
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  return { ok: true, length: text.length };
}

// Reports lengths, never contents: the value here can be a password.
export function ettoreReadState(token, doc) {
  var el = ettoreMarked(token, doc);
  if (!el) return { error: 'target element disappeared from the page' };
  var raw = el.isContentEditable === true
    ? String(el.textContent == null ? '' : el.textContent)
    : String(el.value == null ? '' : el.value);
  return {
    length: raw.length,
    empty: raw.length === 0,
    describe: ettoreDescribe(el),
    focused: doc.activeElement === el,
  };
}

export function ettoreUnmark(token, doc) {
  var el = ettoreMarked(token, doc);
  if (el && el.removeAttribute) el.removeAttribute('data-ettore-target');
  return true;
}

export function ettoreDescribeActive(doc) {
  var el = doc.activeElement;
  return {
    describe: ettoreDescribe(el),
    field: ettoreIsField(el),
    tag: el && el.tagName ? String(el.tagName).toLowerCase() : '',
  };
}

// The text a human reads next to a field. The model picks its target from the
// snapshot, so a field listed without its visible label is a field it will
// address by guesswork — which is how the wrong box gets filled.
export function ettoreFieldLabel(el, doc) {
  if (!el || !el.getAttribute) return '';
  var direct = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  if (direct) return String(direct).trim().slice(0, 60);
  var labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy && doc.getElementById) {
    var ref = doc.getElementById(labelledBy);
    if (ref) return String(ref.innerText || ref.textContent || '').trim().slice(0, 60);
  }
  if (el.labels && el.labels.length) {
    return String(el.labels[0].innerText || el.labels[0].textContent || '').trim().slice(0, 60);
  }
  if (el.id && doc.querySelector) {
    var forLabel = null;
    try { forLabel = doc.querySelector('label[for="' + el.id + '"]'); } catch (e) { forLabel = null; }
    if (forLabel) return String(forLabel.innerText || forLabel.textContent || '').trim().slice(0, 60);
  }
  if (el.closest) {
    var wrapper = el.closest('label');
    if (wrapper) return String(wrapper.innerText || wrapper.textContent || '').trim().slice(0, 60);
  }
  // <span>Password</span><input>: the caption is a sibling, not a <label>.
  // Typing already resolves this shape, but a field listed without its name is
  // a field the model has to guess at.
  var prev = el.previousElementSibling;
  var hops = 0;
  while (prev && hops < 2) {
    if (!ettoreIsField(prev)) {
      var siblingText = String(prev.innerText || prev.textContent || '').trim();
      if (siblingText && siblingText.length <= 60) return siblingText.slice(0, 60);
    }
    prev = prev.previousElementSibling;
    hops += 1;
  }
  var parent = el.parentElement;
  if (parent) {
    var wrapperText = String(parent.innerText || parent.textContent || '').trim();
    if (wrapperText && wrapperText.length <= 60) return wrapperText.slice(0, 60);
  }
  return '';
}

export function ettoreSelectorFor(el) {
  if (!el || !el.tagName) return '';
  var tag = String(el.tagName).toLowerCase();
  if (el.id) return '#' + el.id;
  var attr = function (name) { return (el.getAttribute && el.getAttribute(name)) || ''; };
  if (attr('data-testid')) return '[data-testid="' + attr('data-testid') + '"]';
  if (attr('name')) return tag + '[name="' + attr('name') + '"]';
  if (tag === 'input' && attr('type')) return 'input[type="' + attr('type') + '"]';
  var path = [];
  var node = el;
  while (node && node.nodeType === 1 && path.length < 4) {
    var part = String(node.tagName).toLowerCase();
    if (node.classList && node.classList.length) {
      part += '.' + Array.prototype.slice.call(node.classList, 0, 2).join('.');
    }
    var parent = node.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    path.unshift(part);
    node = node.parentElement;
  }
  return path.join(' > ');
}

export function ettoreSnapshot(limit, doc, win) {
  var max = Math.max(1, Math.min(Number(limit) || 40, 200));
  var out = [];
  var nodes = doc.querySelectorAll(
    'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[onclick],[contenteditable="true"]',
  );
  for (var i = 0; i < nodes.length && out.length < max; i++) {
    var el = nodes[i];
    if (!ettoreVisible(el, win)) continue;
    var isField = ettoreIsField(el);
    out.push({
      tag: String(el.tagName).toLowerCase(),
      type: String((el.getAttribute && el.getAttribute('type')) || ''),
      field: isField,
      label: isField
        ? ettoreFieldLabel(el, doc)
        : String(el.innerText || (el.getAttribute && el.getAttribute('aria-label')) || '').trim().slice(0, 80),
      selector: ettoreSelectorFor(el),
      required: !!(el.getAttribute && el.getAttribute('required') !== null && el.getAttribute('required') !== undefined),
      disabled: !!el.disabled,
    });
  }
  return { title: doc.title, url: win.location ? win.location.href : '', elements: out };
}

// ── Visible pointer ───────────────────────────────────────────────────────
// CDP dispatches mouse events straight into the renderer: the OS cursor never
// moves, so watching the browser window showed a page reacting to clicks with
// nothing visibly clicking it. This layer draws the agent's pointer — a ring
// that travels to the target, a box around the element it is about to touch,
// and a caption naming the action — so the run can actually be followed.
// Everything is pointer-events:none, so it can never intercept a real click,
// and it is rebuilt lazily after every navigation.

export function ettoreCursorEnsure(doc) {
  if (!doc || !doc.createElement || !doc.body) return { ok: false, reason: 'no document body' };
  var existing = doc.getElementById('ettore-ui-layer');
  if (existing) return { ok: true, created: false };

  var layer = doc.createElement('div');
  layer.setAttribute('id', 'ettore-ui-layer');
  layer.setAttribute('data-ettore-ui', '1');
  layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';

  var style = doc.createElement('style');
  style.textContent = '@keyframes ettore-pulse{0%{transform:scale(.4);opacity:.9}100%{transform:scale(2.4);opacity:0}}'
    + '#ettore-cursor-pulse.on{animation:ettore-pulse .45s ease-out}';
  layer.appendChild(style);

  var box = doc.createElement('div');
  box.setAttribute('id', 'ettore-highlight');
  box.style.cssText = 'position:fixed;border:2px solid #38bdf8;border-radius:6px;'
    + 'box-shadow:0 0 0 9999px rgba(15,23,42,.18);transition:all .18s ease-out;opacity:0;pointer-events:none;';
  layer.appendChild(box);

  var chip = doc.createElement('div');
  chip.setAttribute('id', 'ettore-chip');
  chip.style.cssText = 'position:fixed;padding:2px 8px;border-radius:999px;background:#0f172a;color:#e2e8f0;'
    + 'font:600 11px/1.6 ui-sans-serif,system-ui,sans-serif;transition:all .18s ease-out;opacity:0;pointer-events:none;';
  layer.appendChild(chip);

  var pulse = doc.createElement('div');
  pulse.setAttribute('id', 'ettore-cursor-pulse');
  pulse.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;'
    + 'border-radius:50%;background:#38bdf8;opacity:0;pointer-events:none;';
  layer.appendChild(pulse);

  var dot = doc.createElement('div');
  dot.setAttribute('id', 'ettore-cursor');
  dot.style.cssText = 'position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;'
    + 'border-radius:50%;background:#38bdf8;border:2px solid #f8fafc;'
    + 'box-shadow:0 2px 8px rgba(2,6,23,.45);transition:transform .24s cubic-bezier(.22,.61,.36,1);'
    + 'pointer-events:none;';
  layer.appendChild(dot);

  doc.body.appendChild(layer);
  return { ok: true, created: true };
}

// One round-trip per action: move the pointer, frame the element, name what is
// about to happen.
export function ettoreCursorShow(payload, doc) {
  var data = payload || {};
  var ready = ettoreCursorEnsure(doc);
  if (!ready.ok) return ready;

  var x = Number(data.x) || 0;
  var y = Number(data.y) || 0;
  var dot = doc.getElementById('ettore-cursor');
  var pulse = doc.getElementById('ettore-cursor-pulse');
  var box = doc.getElementById('ettore-highlight');
  var chip = doc.getElementById('ettore-chip');

  if (dot) dot.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  if (pulse) pulse.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';

  var rect = data.rect;
  if (box && rect) {
    box.style.left = (Number(rect.left) || 0) + 'px';
    box.style.top = (Number(rect.top) || 0) + 'px';
    box.style.width = (Number(rect.width) || 0) + 'px';
    box.style.height = (Number(rect.height) || 0) + 'px';
    box.style.opacity = '1';
  } else if (box) {
    box.style.opacity = '0';
  }

  if (chip) {
    chip.textContent = String(data.label || '');
    if (data.label) {
      var chipTop = rect ? (Number(rect.top) || 0) - 22 : y - 22;
      chip.style.left = (rect ? Number(rect.left) || 0 : x) + 'px';
      chip.style.top = (chipTop < 4 ? 4 : chipTop) + 'px';
      chip.style.opacity = '1';
    } else {
      chip.style.opacity = '0';
    }
  }
  return { ok: true, x: x, y: y };
}

export function ettoreCursorPulse(doc) {
  var pulse = doc.getElementById('ettore-cursor-pulse');
  if (!pulse) return { ok: false };
  pulse.style.opacity = '1';
  if (pulse.classList && pulse.classList.remove) {
    pulse.classList.remove('on');
    if (pulse.offsetWidth !== undefined) { void pulse.offsetWidth; }
    pulse.classList.add('on');
  }
  return { ok: true };
}

export function ettoreCursorClear(doc) {
  var layer = doc.getElementById('ettore-ui-layer');
  if (layer && layer.parentElement && layer.parentElement.removeChild) {
    layer.parentElement.removeChild(layer);
    return { ok: true, removed: true };
  }
  return { ok: true, removed: false };
}

// ── Element probe ─────────────────────────────────────────────────────────
// "Is this element actually usable?" — answered without touching it. Opening a
// page and reporting that a field is there says nothing about whether it can
// be filled; this is what turns that into a real check.
export function ettoreProbeElement(el, opts, doc, win) {
  var options = opts || {};
  if (!el) return { ok: false, problem: 'element not found' };
  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2;
  var y = r.top + r.height / 2;
  var problems = [];

  if (!ettoreVisible(el, win)) problems.push('not visible');
  if (el.disabled) problems.push('disabled');
  if (el.readOnly) problems.push('read-only');
  if (options.field && !ettoreIsField(el)) problems.push('not an input field');

  if (doc.elementFromPoint && r.width > 0 && r.height > 0) {
    var top = doc.elementFromPoint(x, y);
    if (top && top !== el) {
      var related = (el.contains && el.contains(top)) || (top.contains && top.contains(el));
      if (!related) problems.push('covered by ' + ettoreDescribe(top));
    }
  }

  return {
    ok: problems.length === 0,
    describe: ettoreDescribe(el),
    field: ettoreIsField(el),
    tag: String(el.tagName || '').toLowerCase(),
    type: String((el.getAttribute && el.getAttribute('type')) || ''),
    x: Math.round(x),
    y: Math.round(y),
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    problem: problems.join('; '),
  };
}

export function ettoreProbe(locator, opts, doc, win) {
  var found = ettoreLocate(locator, opts || {}, doc, win);
  if (found.error) return { locator: locator, ok: false, describe: '', problem: found.error };
  // ettoreLocate already scrolled the element into view and measured it there,
  // so reuse its numbers rather than measuring a second time.
  var problems = [];
  if (!found.visible) problems.push('not visible');
  if (found.disabled) problems.push('disabled');
  if (found.readOnly) problems.push('read-only');
  if (found.occluder) problems.push('covered by ' + found.occluder);
  if (opts && opts.field && !found.field) problems.push('not an input field');
  return {
    locator: locator,
    ok: problems.length === 0,
    describe: found.describe,
    resolvedFrom: found.resolvedFrom,
    field: found.field,
    tag: found.tag,
    type: found.type,
    x: Math.round(found.x),
    y: Math.round(found.y),
    rect: { left: found.x - found.width / 2, top: found.y - found.height / 2, width: found.width, height: found.height },
    problem: problems.join('; '),
  };
}

// Every interactive element on the page, each with the same verdict. The nodes
// are inspected in place: re-resolving each one through the selector printed
// in the report would judge whatever that selector happens to hit, which is
// not necessarily the element that was listed.
export function ettoreProbeAll(limit, doc, win) {
  var max = Math.max(1, Math.min(Number(limit) || 40, 200));
  var out = [];
  var nodes = doc.querySelectorAll(
    'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[onclick],[contenteditable="true"]',
  );
  for (var i = 0; i < nodes.length && out.length < max; i++) {
    var el = nodes[i];
    if (!ettoreVisible(el, win)) continue;
    var probe = ettoreProbeElement(el, { field: ettoreIsField(el) }, doc, win);
    probe.label = ettoreIsField(el)
      ? ettoreFieldLabel(el, doc)
      : String(el.innerText || (el.getAttribute && el.getAttribute('aria-label')) || '').trim().slice(0, 80);
    probe.selector = ettoreSelectorFor(el);
    out.push(probe);
  }
  return { title: doc.title, url: win.location ? win.location.href : '', elements: out };
}

// Everything the page needs, in dependency order, as one source blob.
export const PAGE_HELPERS = [
  ettoreIsField,
  ettoreIsClickable,
  ettoreVisible,
  ettoreDescribe,
  ettoreFieldFor,
  ettoreLabelSources,
  ettoreMatchScore,
  ettoreLocate,
  ettoreMarked,
  ettoreEnsureFocus,
  ettoreSetValue,
  ettoreReadState,
  ettoreUnmark,
  ettoreDescribeActive,
  ettoreFieldLabel,
  ettoreSelectorFor,
  ettoreSnapshot,
  ettoreCursorEnsure,
  ettoreCursorShow,
  ettoreCursorPulse,
  ettoreCursorClear,
  ettoreProbeElement,
  ettoreProbe,
  ettoreProbeAll,
];
