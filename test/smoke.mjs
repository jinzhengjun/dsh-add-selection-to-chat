/**
 * Offline smoke test for the client bundle.
 *
 * Loads the real classic script against a minimal DOM stub and drives synthetic
 * right-clicks. It pins the three rules the plugin exists for:
 *
 *   1. the target is the composer rendered on screen (not a catalog guess),
 *   2. the text is appended at the end of the draft (never at a stale caret),
 *   3. the payload carries a provenance header — path, line count and the
 *      1-based source line range — before the selected text.
 *
 * Run: node test/smoke.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { Node, makeDocument, makeWindow } from './dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, '..', 'client.js'), 'utf8');

// ---- load the real bundle ---------------------------------------------------


const document = makeDocument();
const window = makeWindow(document);
let loaded = null;
window.__ModuleLoader__ = {
  load(entry) {
    loaded = entry;
  },
};
new Function('window', 'navigator', source)(window, { language: 'zh-CN' });
assert.equal(loaded?.id, 'dsh-add-selection-to-chat', 'bundle registers under its package id');
const exported = loaded.factory((name) => {
  throw new Error(`unexpected require(${name})`);
});
assert.deepEqual(exported.inject, ['sessions', 'conversation', 'contextMenus'], 'declares its client services');

// ---- fixtures ---------------------------------------------------------------

/**
 * Mirrors the real preview: the path label sits in a header that is a *sibling*
 * of the scroll body, both under the preview root. Looking for the label inside
 * the body alone therefore finds nothing.
 */
function previewPane(path) {
  const root = new Node('div');
  root.setAttribute('data-textpreview-state', 'text');
  const header = new Node('div');
  const label = new Node('div');
  label.setAttribute('data-textpreview-path', '');
  label.textContent = path;
  header.appendChild(label);
  root.appendChild(header);
  const body = new Node('div');
  body.setAttribute('data-textpreview-body', '');
  root.appendChild(body);
  document.body.appendChild(root);
  return body;
}

function textLine(parent, number, content) {
  const row = new Node('div');
  row.setAttribute('data-textpreview-line', String(number));
  const text = new Node('#text', 3);
  text.textContent = content;
  row.appendChild(text);
  parent.appendChild(row);
  return row;
}

// plain-text renderer: numbered rows, 1-based (the same space `#L24` links use)
const plainBody = previewPane('C:\\workspace\\campus.html');
const page = new Node('pre');
page.setAttribute('data-textpreview-page', '12');
plainBody.appendChild(page);
const row12 = textLine(page, 12, 'line twelve');
const row13 = textLine(page, 13, 'line thirteen');
const row14 = textLine(page, 14, 'line fourteen');

// code renderer: highlighted block, one span per source line
const codeBody = previewPane('C:\\workspace\\app.ts');
const codePreview = new Node('div');
codePreview.setAttribute('data-code-preview', 'true');
codeBody.appendChild(codePreview);
const codeContent = new Node('div');
codeContent.setAttribute('data-code-block-content', '');
codePreview.appendChild(codeContent);
const codeLines = ['const a = 1', 'const b = 2', 'const c = 3'].map((content) => {
  const span = new Node('span');
  span.className = 'line';
  const text = new Node('#text', 3);
  text.textContent = content;
  span.appendChild(text);
  codeContent.appendChild(span);
  return span;
});

// a file in a subfolder: the payload header must be root-relative, not the bare name
const nestedBody = previewPane('C:\\workspace\\sub\\dir\\deep.ts');
const nestedPage = new Node('pre');
nestedPage.setAttribute('data-textpreview-page', '1');
nestedBody.appendChild(nestedPage);
const row1 = textLine(nestedPage, 1, 'export const deep = 1;');
const row2 = textLine(nestedPage, 2, 'export const deeper = 2;');

// a renderer with no line markup at all (Markdown body)
const proseBody = previewPane('C:\\workspace\\notes.md');
const paragraph = new Node('p');
const proseText = new Node('#text', 3);
proseText.textContent = '第一段文字\n第二段文字';
paragraph.appendChild(proseText);
proseBody.appendChild(paragraph);

// ---- composer ---------------------------------------------------------------

const chatRegion = new Node('div');
chatRegion.setAttribute('data-conversation-region', 'chat');
chatRegion.setAttribute('data-conversation-session', 'session-on-screen');
document.body.appendChild(chatRegion);
const card = new Node('div');
card.setAttribute('data-composer-card', 'true');
chatRegion.appendChild(card);
const composerInput = new Node('div');
composerInput.setAttribute('data-composer-input', 'true');
composerInput.setAttribute('contenteditable', 'true');
card.appendChild(composerInput);

const insertions = [];
let composerFocused = false;
let stateSnapshot = { draft: 'hello', phase: 'plain' };
const shell = {
  state: { getSnapshot: () => stateSnapshot },
  projection: { detectText: 'hello' },
  actions: {
    captureInsertion: () => ({ start: 2, end: 2, draftRev: 5 }),
    insertText: (text, span) => {
      insertions.push({ text, span });
      stateSnapshot = { ...stateSnapshot, draft: stateSnapshot.draft + text };
      return true;
    },
  },
  focus: () => {
    composerFocused = true;
  },
};

const shellCalls = [];
const ctx = {
  sessions: {
    list: {
      // Deliberately a different Session than the one the composer renders,
      // but it carries the workspace root (header.cwd) the payload header
      // relativizes against.
      getSnapshot: () => ({
        byId: {
          'session-catalog': {
            sessionId: 'session-catalog',
            header: { cwd: 'C:\\workspace' },
            retainedBy: { mainView: 1 },
          },
          // The rendered Session also carries a workspace root, so the payload
          // header can relativize against the Session it is inserting into.
          'session-on-screen': {
            sessionId: 'session-on-screen',
            header: { cwd: 'C:\\workspace' },
            retainedBy: {},
          },
        },
      }),
    },
  },
  conversation: {
    input: {
      shell: (id) => {
        shellCalls.push(id);
        return id === 'session-on-screen' || id === 'session-catalog' ? shell : undefined;
      },
    },
  },
  effects: [],
  effect(fn) {
    const dispose = fn();
    this.effects.push(dispose);
    return dispose;
  },
  // Mirrors the shell: contextMenus is declared in exports.inject, so the
  // guarded facade answers it as a plain property (the path our code now takes).
  contextMenus: {
    registrations: [],
    register(input) { this.registrations.push(input); return () => {}; },
    notify() {},
  },
};

exported.apply(ctx);
// The preview menu registers one effect; each of the two delete providers
// (file + directory) registers one more — 3 total, no retry timer needed.
assert.equal(ctx.effects.length, 3, 'registers one disposable effect per capability');
assert.equal(ctx.contextMenus.registrations.length, 2, 'registers the file and directory delete providers');
assert.deepEqual(
  ctx.contextMenus.registrations.map((r) => r.target).sort(),
  ['directory', 'file'],
  'delete providers target file and directory',
);

function rightClick(target) {
  const event = {
    target,
    clientX: 40,
    clientY: 40,
    preventDefault() { event.prevented = (event.prevented ?? 0) + 1; },
    stopPropagation() {},
  };
  window.dispatch('contextmenu', event);
  return event;
}
const menu = () => document.body.children.find((child) => child.className === 'dsh-selchat-menu');
const item = () => menu()?.children.find((child) => child.className === 'dsh-selchat-item');
const hint = () => menu()?.children.find((child) => child.className === 'dsh-selchat-hint');
const metaText = () => menu()?.children.find((child) => child.className === 'dsh-selchat-meta')?.textContent ?? '';

function select({ text, startNode, endNode, ancestor }) {
  window.selection = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({
      commonAncestorContainer: ancestor,
      startContainer: startNode,
      endContainer: endNode,
    }),
  };
}

// 1. no selection: native menu untouched
window.selection = { isCollapsed: true, rangeCount: 0, toString: () => '' };
let event = rightClick(row12);
assert.equal(event.prevented, undefined, 'no selection: native menu untouched');
assert.equal(menu(), undefined, 'no selection: no menu');

// 2. plain text, 3 lines: header carries path, count and the 1-based range
select({ text: 'line twelve\nline thirteen\nline fourteen\n', startNode: row12.children[0], endNode: row14.children[0], ancestor: page });
event = rightClick(row12);
assert.equal(event.prevented, 1, 'preventDefault stops the native menu');
assert.ok(menu(), 'menu rendered');
assert.equal(item().getAttribute('aria-disabled'), null, 'item is enabled');
assert.deepEqual(shellCalls, ['session-on-screen'], 'availability only resolves the rendered Session');
assert.equal(metaText(), 'campus.html · 第 12-14 行', 'menu meta names the file and the resolved range');

item().dispatch('click', {});
assert.deepEqual(shellCalls.at(-1), 'session-on-screen', 'inserts into the Session the composer renders, not the catalog default');
assert.equal(insertions.length, 1, 'one insertion');
assert.equal(
  insertions[0].text,
  '\ncampus.html（第 12-14 行）\nline twelve\nline thirteen\nline fourteen',
  'payload = separator + root-relative path + (第 a-b 行) + selected text',
);
assert.deepEqual(insertions[0].span, { start: 5, end: 5, draftRev: 5 }, 'appends at the end of the draft, ignoring the stale caret at 2');
assert.equal(composerFocused, true, 'composer is focused after insertion');
assert.equal(menu(), undefined, 'menu closes after a pick');

// 3. code renderer: lines come from the highlighted block, 1-based
stateSnapshot = { draft: 'hello', phase: 'plain' };
select({ text: 'const a = 1\nconst b = 2', startNode: codeLines[0].children[0], endNode: codeLines[1].children[0], ancestor: codeContent });
rightClick(codePreview);
assert.equal(metaText(), 'app.ts · 第 1-2 行', 'code preview resolves lines from .line spans');
item().dispatch('click', {});
assert.equal(
  insertions.at(-1).text,
  '\napp.ts（第 1-2 行）\nconst a = 1\nconst b = 2',
  'code payload carries the code range',
);

// 4. renderer without line markup: header keeps the file name, no invented range
select({ text: '第一段文字\n第二段文字', startNode: proseText, endNode: proseText, ancestor: paragraph });
rightClick(paragraph);
assert.equal(metaText(), 'notes.md · 2 行', 'no line markup: meta falls back to the count');
item().dispatch('click', {});
assert.equal(
  insertions.at(-1).text,
  '\nnotes.md\n第一段文字\n第二段文字',
  'no line range is invented',
);

// 4b. nested file: the payload header is relative to the project root, not the bare name
select({ text: 'export const deep = 1;\nexport const deeper = 2;', startNode: row1.children[0], endNode: row2.children[0], ancestor: nestedPage });
rightClick(row1);
assert.equal(metaText(), 'deep.ts · 第 1-2 行', 'menu meta keeps the short file name');
item().dispatch('click', {});
assert.equal(
  insertions.at(-1).text,
  '\nsub/dir/deep.ts（第 1-2 行）\nexport const deep = 1;\nexport const deeper = 2;',
  'nested file payload carries the path relative to the project root',
);

// workspaceRelativePath unit behavior: no root / outside root are no-ops
const { workspaceRelativePath, workspaceRootOf } = exported.__internals;
assert.equal(workspaceRelativePath('C:\\workspace\\a\\b.ts', 'C:\\workspace'), 'a/b.ts', 'absolute under root becomes relative');
assert.equal(workspaceRelativePath('c:/workspace/a/b.ts', 'C:\\workspace'), 'a/b.ts', 'prefix match is case-insensitive');
assert.equal(workspaceRelativePath('already/relative.ts', 'C:\\workspace'), 'already/relative.ts', 'a path not under the root is left unchanged');
assert.equal(workspaceRelativePath('C:\\workspace\\a.ts', ''), 'C:\\workspace\\a.ts', 'an unknown root is a no-op');
assert.equal(workspaceRootOf(ctx.sessions, 'session-catalog'), 'C:\\workspace', 'the catalog row carries the workspace root');
assert.equal(workspaceRootOf(ctx.sessions, 'nope'), undefined, 'an unknown Session has no root');

// 5. draft already ends with a newline: no doubled separator
stateSnapshot = { draft: 'hello\n', phase: 'plain' };
select({ text: 'x = 1', startNode: row12.children[0], endNode: row12.children[0], ancestor: row12 });
rightClick(row12);
item().dispatch('click', {});
assert.equal(insertions.at(-1).text.startsWith('campus.html'), true, 'no extra leading newline');

// 6. composer submitting: disabled with a reason, and clicking does nothing
stateSnapshot = { draft: 'hello', phase: 'submitting' };
const before = insertions.length;
select({ text: 'x = 1', startNode: row12.children[0], endNode: row12.children[0], ancestor: row12 });
rightClick(row12);
assert.equal(item().getAttribute('aria-disabled'), 'true', 'busy composer disables the item');
assert.ok(hint()?.textContent.includes('发送'), 'hint explains why');
item().dispatch('click', {});
assert.equal(insertions.length, before, 'disabled item inserts nothing');
assert.equal(menu(), undefined, 'disabled item still closes the menu');

// 7. locked composer
stateSnapshot = { draft: 'hello', phase: 'plain' };
composerInput.setAttribute('contenteditable', 'false');
rightClick(row12);
assert.equal(item().getAttribute('aria-disabled'), 'true', 'locked composer disables the item');
composerInput.setAttribute('contenteditable', 'true');

// 8. no composer at all
chatRegion.removeChild(card);
assert.equal(exported.__internals.composerTarget(document), null, 'no composer is detected');
rightClick(row12);
assert.equal(item().getAttribute('aria-disabled'), 'true', 'missing composer disables the item');
assert.ok(hint(), 'missing composer explains itself');
chatRegion.appendChild(card);

// 9. outside a preview the plugin stays out of the way
const outside = new Node('div');
document.body.appendChild(outside);
const outsideText = new Node('#text', 3);
outsideText.textContent = 'hello';
outside.appendChild(outsideText);
select({ text: 'hello', startNode: outsideText, endNode: outsideText, ancestor: outside });
event = rightClick(outside);
assert.equal(event.prevented, undefined, 'chat transcript keeps the native menu');

// 10. dispose removes the listeners
ctx.effects[0]();
select({ text: 'x', startNode: row12.children[0], endNode: row12.children[0], ancestor: row12 });
event = rightClick(row12);
assert.equal(event.prevented, undefined, 'disposed plugin is inert');

console.log('smoke test passed: payload header (file name + line range), composer targeting, end-of-draft append, disabled states, gating and dispose');
