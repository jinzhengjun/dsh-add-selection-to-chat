/**
 * Offline test for the file-tree 删除 item.
 *
 * Loads the real client bundle against the shared DOM stub, drives the menu
 * provider the shell's `contextMenus` service would own, and clicks through the
 * confirmation dialog with a stubbed `fetch`. It pins what the feature promises:
 *
 *   1. a provider exists for both `file` and `directory` targets, ordered after
 *      the built-in 另存为… item and marked dangerous;
 *   2. the item is withheld for anything that is not a workspace-relative path
 *      (the pane header's own `cwd` row must not offer a delete);
 *   3. confirming posts `{ sessionId, path }` to the host route, closes the
 *      dialog and reports success;
 *   4. a refused delete keeps the dialog open with the host's message and does
 *      not report success;
 *   5. Escape and 取消 dismiss without calling the host.
 *
 * Run: node test/delete.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { makeDocument, makeWindow } from './dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, '..', 'client.js'), 'utf8');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
const { isDeletableTargetPath, DELETE_ROUTE } = exported.__internals;

// ---- shell stub: contextMenus + a recording effect scope --------------------

const registrations = [];
const notifications = [];
const contextMenus = {
  register(input) {
    registrations.push(input);
    return () => {};
  },
  notify(text, success) {
    notifications.push({ text, success });
  },
};

const effects = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    effects.push(dispose);
    return dispose;
  },
  inject(deps, callback) {
    assert.deepEqual(deps, ['contextMenus'], 'the delete menu waits only on the menu service');
    callback({ contextMenus, effect: this.effect.bind(this) });
  },
};

exported.apply(ctx);

// ---- 1. one provider per target kind ---------------------------------------

assert.equal(registrations.length, 2, 'registers one provider per target kind');
assert.deepEqual(
  registrations.map((item) => item.target).sort(),
  ['directory', 'file'],
  'covers files and folders',
);
for (const registration of registrations) {
  assert.equal(registration.order, 400, 'sorts after the built-in 另存为… provider (order 200)');
}

const fileMenu = registrations.find((item) => item.target === 'file');
const folderMenu = registrations.find((item) => item.target === 'directory');

// ---- 2. path gating ---------------------------------------------------------
// The file tree hands out ABSOLUTE paths; previews can carry workspace-relative
// ones. The client shows the item for either — the host (index.js) is the only
// authority on whether the path actually resolves inside the workspace.

assert.equal(isDeletableTargetPath('ssq_data.json'), true, 'plain file name is deletable');
assert.equal(isDeletableTargetPath('sub/dir/ssq_model.py'), true, 'nested relative path is deletable');
assert.equal(isDeletableTargetPath('sub\\dir\\ssq_model.py'), true, 'backslash spelling is deletable');
assert.equal(isDeletableTargetPath('C:\\work\\a.py'), true, 'absolute Windows path is deletable (host decides)');
assert.equal(isDeletableTargetPath('/etc/hosts'), true, 'absolute POSIX path is deletable (host decides)');
assert.equal(isDeletableTargetPath('\\\\server\\share\\a.txt'), true, 'UNC path is deletable (host decides)');
assert.equal(isDeletableTargetPath(''), false, 'empty path is refused');
assert.equal(isDeletableTargetPath('.'), false, 'a bare root marker is refused');
assert.equal(isDeletableTargetPath('../outside.txt'), false, 'an escaping relative path is refused');

assert.deepEqual(fileMenu.resolve({ sessionId: '', path: 'ssq_data.json' }), [], 'no item without a Session');
assert.deepEqual(fileMenu.resolve({ sessionId: 'session-x', path: '' }), [], 'no item without a path');
assert.deepEqual(fileMenu.resolve({ sessionId: 'session-x', path: '.' }), [], 'no item for a bare root marker');

// Absolute paths — exactly what the file tree sends — must yield an item.
const absActions = fileMenu.resolve({ sessionId: 'session-x', path: 'C:\\Users\\jinzhengjun\\Desktop\\电脑配置\\ssq_model.py', paneId: 'p1' });
assert.equal(absActions.length, 1, 'an absolute file-tree path yields one action');

const fileActions = fileMenu.resolve({ sessionId: 'session-x', path: 'ssq_data.json' });
assert.equal(fileActions.length, 1, 'a file target yields one action');
const fileAction = fileActions[0];
assert.equal(fileAction.label, '删除文件', 'label names the file action');
assert.equal(fileAction.danger, true, 'rendered as a dangerous item');
assert.equal(fileAction.separatorBefore, true, 'separated from 另存为…');
assert.equal(fileAction.failureLabel, '删除失败', 'failure label is localized');
assert.equal(typeof fileAction.run, 'function', 'action runs');

const folderActions = folderMenu.resolve({ sessionId: 'session-x', path: 'sub/dir' });
assert.equal(folderActions[0].label, '删除文件夹', 'folder target yields the folder wording');
assert.equal(folderActions[0].separatorBefore, false, 'a lone folder item starts without a separator');

// ---- 3. confirm deletes and reports ----------------------------------------

const calls = [];
let nextResponse = { ok: true, status: 200, body: { ok: true, value: { path: 'ssq_data.json', kind: 'file' } } };
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return {
    ok: nextResponse.ok,
    status: nextResponse.status,
    json: async () => nextResponse.body,
  };
};

const backdrop = () => document.body.children.find((child) => child.className === 'dsh-selchat-backdrop');

fileAction.run();
assert.ok(backdrop(), 'run opens the confirmation dialog');
const dialog = backdrop().children[0];
assert.equal(dialog.getAttribute('role'), 'alertdialog', 'dialog is announced');
assert.ok(dialog.textContent.includes('ssq_data.json'), 'dialog names the target');
assert.ok(dialog.textContent.includes('不可恢复'), 'dialog warns that the delete is permanent');

let buttons = backdrop().querySelectorAll('button');
assert.equal(buttons.length, 2, 'cancel + confirm');
assert.equal(buttons[0].textContent, '取消', 'cancel first');
assert.equal(buttons[1].textContent, '删除', 'confirm second');
assert.equal(buttons[0].focused, true, 'focus starts on the safe action');

buttons[1].dispatch('click', {});
await tick();

assert.equal(calls.length, 1, 'one host request');
assert.equal(calls[0].url, DELETE_ROUTE, 'posts to the plugin route');
assert.equal(calls[0].init.method, 'POST', 'POST only');
assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 'session-x', path: 'ssq_data.json' }, 'body carries the Session and the workspace-relative path');
assert.equal(backdrop(), undefined, 'dialog closes after success');
assert.deepEqual(notifications.at(-1), { text: '已删除「ssq_data.json」', success: true }, 'success is reported');

// ---- 4. a refusal keeps the dialog and its reason --------------------------

nextResponse = {
  ok: false,
  status: 403,
  body: { ok: false, error: { code: 'outside-workspace', message: '只能删除工作区内的文件或文件夹' } },
};
notifications.length = 0;
fileAction.run();
buttons = backdrop().querySelectorAll('button');
buttons[1].dispatch('click', {});
await tick();

assert.ok(backdrop(), 'a refused delete keeps the dialog open');
assert.ok(
  backdrop().textContent.includes('只能删除工作区内的文件或文件夹'),
  'the host message is shown inline',
);
assert.equal(notifications.length, 0, 'no success toast on failure');
const retry = backdrop().querySelectorAll('button')[1];
assert.equal(retry.disabled, false, 'the confirm button is usable again');
assert.equal(retry.textContent, '删除', 'label is restored');
retry.dispatch('click', {});
await tick();
await tick();
assert.equal(calls.length, 3, 'a retry posts again');

// ---- 5. cancel and Escape dismiss without calling the host -----------------

const before = calls.length;
buttons = backdrop().querySelectorAll('button');
buttons[0].dispatch('click', {});
assert.equal(backdrop(), undefined, 'cancel dismisses');
assert.equal(calls.length, before, 'cancel does not call the host');

fileAction.run();
assert.ok(backdrop(), 'dialog reopened');
document.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
assert.equal(backdrop(), undefined, 'Escape dismisses');
assert.equal(calls.length, before, 'Escape does not call the host');

// ---- 6. dispose removes the providers --------------------------------------

for (const dispose of effects) dispose();
assert.equal(effects.length, 3, 'one effect for the preview menu plus one per target kind');

console.log('delete test passed: per-kind menu providers, path gating, confirm → host POST, refusal feedback, cancel/Escape');
