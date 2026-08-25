import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el, FakeDocument, makeWindow } from './helpers/fake-dom.js';
import {
  ettoreCursorClear,
  ettoreCursorEnsure,
  ettoreCursorShow,
  ettoreDescribe,
  ettoreDescribeActive,
  ettoreEnsureFocus,
  ettoreFieldFor,
  ettoreIsField,
  ettoreLocate,
  ettoreProbe,
  ettoreProbeAll,
  ettoreReadState,
  ettoreSetValue,
  ettoreSnapshot,
} from '../src/tools/browser-page.js';

// A login page shaped like the ones the CLI kept mis-filling: every visible
// caption is a <label>, never the input itself.
function loginPage() {
  const emailLabel = el('label', { for: 'email' }, 'Email');
  const emailInput = el('input', { id: 'email', type: 'email', name: 'email' });
  const emailRow = el('div', { class: 'field' }).append(emailLabel, emailInput);

  const passLabel = el('label', { for: 'pass' }, 'Password');
  const passInput = el('input', { id: 'pass', type: 'password', name: 'password' });
  const passRow = el('div', { class: 'field' }).append(passLabel, passInput);

  // Caption and control share no name: only the label can find this field.
  const taxLabel = el('label', { for: 'cf' }, 'Codice fiscale');
  const taxInput = el('input', { id: 'cf', type: 'text', name: 'taxcode' });
  const taxRow = el('div', { class: 'field' }).append(taxLabel, taxInput);

  const submit = el('button', { type: 'submit' }, 'Sign in');
  const form = el('form').append(emailRow, passRow, taxRow, submit);
  const footerLink = el('a', { href: '/contact' }, 'Email us');
  const footer = el('footer').append(footerLink);
  const root = el('body').append(form, footer);

  let top = 0;
  for (const node of [emailLabel, emailInput, passLabel, passInput, taxLabel, taxInput, submit, footerLink]) {
    node.rect = { left: 10, top, width: 200, height: 20 };
    top += 40;
  }

  const doc = new FakeDocument(root);
  const win = makeWindow(doc);
  return { doc, win, emailInput, passInput, taxInput, passLabel, submit, footerLink, passRow };
}

test('typing at a label resolves to the control it names', () => {
  const { doc, win, taxInput } = loginPage();
  const found = ettoreLocate('text=Codice fiscale', { field: true }, doc, win);
  assert.equal(found.error, undefined);
  assert.equal(found.field, true);
  assert.match(found.describe, /input\[type=text\]\[name=taxcode\]/);
  assert.match(found.resolvedFrom, /label/);
  assert.equal(doc.querySelector('input[name="taxcode"]'), taxInput);
});

test('a field locator never returns a label or a wrapper', () => {
  const { doc, win } = loginPage();
  for (const locator of ['text=Password', 'label=Email', 'text=Codice fiscale']) {
    const found = ettoreLocate(locator, { field: true }, doc, win);
    assert.equal(found.error, undefined, locator);
    assert.equal(found.tag, 'input', `${locator} resolved to <${found.tag}>`);
    assert.equal(found.field, true, locator);
  }
});

test('the password box wins over same-worded text elsewhere on the page', () => {
  const { doc, win } = loginPage();
  const found = ettoreLocate('text=Password', { field: true }, doc, win);
  assert.match(found.describe, /type=password/);
});

test('"Email" picks the login field, not the footer link', () => {
  const { doc, win } = loginPage();
  const found = ettoreLocate('text=Email', { field: true }, doc, win);
  assert.match(found.describe, /name=email/);
  assert.equal(found.tag, 'input');
});

test('a click locator still targets the clickable element', () => {
  const { doc, win } = loginPage();
  const found = ettoreLocate('text=Sign in', { clickable: true }, doc, win);
  assert.equal(found.tag, 'button');
});

test('an overlay covering the field is reported instead of clicked through', () => {
  const { doc, win, passInput } = loginPage();
  const banner = el('div', { class: 'cookie-banner', overlay: true }, 'We use cookies');
  banner.rect = { ...passInput.rect };
  doc.root.append(banner);

  const found = ettoreLocate('input[type="password"]', { field: true }, doc, win);
  assert.match(found.occluder, /div/);
  assert.match(found.occluder, /cookie|We use cookies/i);
});

test('hidden and zero-sized candidates are skipped', () => {
  const { doc, win, passInput } = loginPage();
  passInput.style = { visibility: 'hidden', display: 'block', opacity: '1' };
  const found = ettoreLocate('text=Password', { field: true }, doc, win);
  // The label is still visible, but its control is not: the caller gets an
  // error rather than a click at coordinates nothing occupies.
  assert.ok(found.error || found.visible === false, JSON.stringify(found));
});

test('ettoreIsField separates text entry from buttons and checkboxes', () => {
  assert.equal(ettoreIsField(el('input', { type: 'password' })), true);
  assert.equal(ettoreIsField(el('textarea')), true);
  assert.equal(ettoreIsField(el('div', { contenteditable: 'true' })), true);
  assert.equal(ettoreIsField(el('input', { type: 'checkbox' })), false);
  assert.equal(ettoreIsField(el('input', { type: 'submit' })), false);
  assert.equal(ettoreIsField(el('button')), false);
  assert.equal(ettoreIsField(el('label')), false);
});

test('ettoreFieldFor walks label, wrapper and sibling layouts', () => {
  const { doc, passLabel, passInput, passRow } = loginPage();
  assert.equal(ettoreFieldFor(passLabel, doc), passInput);
  assert.equal(ettoreFieldFor(passRow, doc), passInput);

  const span = el('span', {}, 'Codice');
  const input = el('input', { type: 'text', name: 'sibling' });
  const wrapper = el('div').append(span, input);
  const localDoc = new FakeDocument(el('body').append(wrapper));
  assert.equal(ettoreFieldFor(span, localDoc), input);
});

test('focus is verified after the click and repaired when it missed', () => {
  const { doc, win, passInput, emailInput } = loginPage();
  ettoreLocate('input[type="password"]', { field: true, mark: 'tok1' }, doc, win);

  // The click landed on the label: focus stayed on the email box, which is
  // exactly how the password used to end up in the wrong field.
  doc.activeElement = emailInput;
  const repaired = ettoreEnsureFocus('tok1', doc);
  assert.equal(repaired.focused, true);
  assert.equal(repaired.via, 'focus()');
  assert.equal(doc.activeElement, passInput);
});

test('an unfocusable target is reported, not typed into', () => {
  const { doc, win, passInput, emailInput } = loginPage();
  ettoreLocate('input[type="password"]', { field: true, mark: 'tok2' }, doc, win);
  passInput.focusable = false;
  doc.activeElement = emailInput;

  const result = ettoreEnsureFocus('tok2', doc);
  assert.equal(result.focused, false);
  assert.match(result.describe, /type=password/);
  assert.match(result.activeDescribe, /name=email/);
});

test('values are set through the prototype setter so frameworks notice', () => {
  const seen = [];
  const { doc } = loginPage();
  const win = makeWindow(doc, { valueSetterSpy: (node, value) => seen.push([node.getAttribute('name'), value.length]) });
  ettoreLocate('input[type="password"]', { field: true, mark: 'tok3' }, doc, win);

  const result = ettoreSetValue('tok3', 'hunter2!', false, doc, win);
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [['password', 8]]);
  const marked = doc.querySelector('[data-ettore-target="tok3"]');
  assert.deepEqual(marked.events, ['input', 'change']);
});

test('append mode keeps the existing content inside the page', () => {
  const { doc, win, passInput } = loginPage();
  ettoreLocate('input[type="password"]', { field: true, mark: 'tok4' }, doc, win);
  ettoreSetValue('tok4', 'abc', false, doc, win);
  ettoreSetValue('tok4', 'def', true, doc, win);
  assert.equal(passInput.value, 'abcdef');
});

test('state and descriptions report lengths, never the secret itself', () => {
  const { doc, win, passInput } = loginPage();
  ettoreLocate('input[type="password"]', { field: true, mark: 'tok5' }, doc, win);
  ettoreSetValue('tok5', 'sup3rs3cret', false, doc, win);

  const state = ettoreReadState('tok5', doc);
  assert.equal(state.length, 11);
  assert.equal(state.empty, false);
  assert.equal(JSON.stringify(state).includes('sup3rs3cret'), false);
  assert.equal(ettoreDescribe(passInput).includes('sup3rs3cret'), false);

  doc.activeElement = passInput;
  assert.equal(JSON.stringify(ettoreDescribeActive(doc)).includes('sup3rs3cret'), false);
});

test('the snapshot names each input with the label a human reads', () => {
  const { doc, win } = loginPage();
  const snap = ettoreSnapshot(40, doc, win);
  const password = snap.elements.find(item => item.type === 'password');
  assert.ok(password, 'password field missing from the snapshot');
  assert.equal(password.field, true);
  assert.equal(password.label, 'Password');
  assert.match(password.selector, /#pass|name="password"/);

  const button = snap.elements.find(item => item.tag === 'button');
  assert.equal(button.field, false);
  assert.equal(button.label, 'Sign in');
});

test('an unmatched locator returns an explicit error', () => {
  const { doc, win } = loginPage();
  assert.match(ettoreLocate('text=Nothing here', { field: true }, doc, win).error, /no element matches/);
  assert.match(ettoreLocate('text=Sign in', { field: true }, doc, win).error, /not an input|no field/);
});

test('the pointer layer is created once and reused', () => {
  const { doc } = loginPage();
  assert.deepEqual(ettoreCursorEnsure(doc), { ok: true, created: true });
  assert.deepEqual(ettoreCursorEnsure(doc), { ok: true, created: false });
  assert.ok(doc.getElementById('ettore-cursor'), 'pointer dot missing');
  assert.ok(doc.getElementById('ettore-highlight'), 'highlight box missing');
});

test('the pointer travels to the element and frames it', () => {
  const { doc, win } = loginPage();
  const box = ettoreLocate('input[type="password"]', { field: true }, doc, win);
  const shown = ettoreCursorShow({
    x: box.x,
    y: box.y,
    label: 'type into password',
    rect: { left: box.x - box.width / 2, top: box.y - box.height / 2, width: box.width, height: box.height },
  }, doc);

  assert.equal(shown.ok, true);
  const dot = doc.getElementById('ettore-cursor');
  assert.equal(dot.style.transform, `translate3d(${box.x}px,${box.y}px,0)`);

  const highlight = doc.getElementById('ettore-highlight');
  assert.equal(highlight.style.width, `${box.width}px`);
  assert.equal(highlight.style.opacity, '1');
  assert.equal(doc.getElementById('ettore-chip').textContent, 'type into password');
});

test('the pointer never intercepts the page', () => {
  const { doc } = loginPage();
  ettoreCursorEnsure(doc);
  for (const id of ['ettore-ui-layer', 'ettore-cursor', 'ettore-highlight', 'ettore-chip', 'ettore-cursor-pulse']) {
    assert.match(
      String(doc.getElementById(id).style.cssText),
      /pointer-events:none/,
      `${id} would swallow real clicks`,
    );
  }
});

test('the pointer layer can be removed again', () => {
  const { doc } = loginPage();
  ettoreCursorEnsure(doc);
  assert.deepEqual(ettoreCursorClear(doc), { ok: true, removed: true });
  assert.equal(doc.getElementById('ettore-ui-layer'), null);
});

test('probing a usable field reports coordinates instead of guessing', () => {
  const { doc, win } = loginPage();
  const result = ettoreProbe('text=Password', { field: true }, doc, win);
  assert.equal(result.ok, true);
  assert.equal(result.problem, '');
  assert.match(result.describe, /type=password/);
  assert.equal(Number.isFinite(result.x) && Number.isFinite(result.y), true);
});

test('probing names the real obstacle instead of clicking through it', () => {
  const { doc, win, passInput } = loginPage();
  const banner = el('div', { class: 'cookie-banner', overlay: true }, 'We use cookies');
  banner.rect = { ...passInput.rect };
  doc.root.append(banner);

  const result = ettoreProbe('input[type="password"]', { field: true }, doc, win);
  assert.equal(result.ok, false);
  assert.match(result.problem, /covered by .*cookie/i);
});

test('probing flags disabled and read-only controls', () => {
  const { doc, win, submit, taxInput } = loginPage();
  submit.disabled = true;
  taxInput.readOnly = true;

  assert.match(ettoreProbe('button', {}, doc, win).problem, /disabled/);
  assert.match(ettoreProbe('input[name="taxcode"]', { field: true }, doc, win).problem, /read-only/);
});

test('probing the whole page returns a verdict per element', () => {
  const { doc, win, submit } = loginPage();
  submit.disabled = true;
  const report = ettoreProbeAll(40, doc, win);

  assert.ok(report.elements.length >= 4);
  assert.equal(report.elements.every(item => typeof item.ok === 'boolean'), true);
  assert.equal(report.elements.filter(item => !item.ok).length, 1);
  assert.equal(report.elements.filter(item => item.field).length, 3);
});

test('a field captioned by a plain span is still named in the snapshot', () => {
  const caption = el('span', {}, 'Password');
  const input = el('input', { type: 'password', name: 'secret' });
  const row = el('div', { class: 'field' }).append(caption, input);
  const doc = new FakeDocument(el('body').append(row));
  const win = makeWindow(doc);

  const snap = ettoreSnapshot(10, doc, win);
  const field = snap.elements.find(item => item.type === 'password');
  assert.equal(field.label, 'Password');
});
