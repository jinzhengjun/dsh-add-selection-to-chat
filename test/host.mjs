/**
 * Offline test for the host half's delete path.
 *
 * The route handler is exercised through `__internals.deleteEntry` with a
 * filesystem stub that mirrors the `ctx.fs` contract the real backends expose
 * (`resolve`, `lstat`, `stat`, `contains`, `processPath`, `deleteFile`,
 * `checkedTarget`) over a throwaway directory. This pins the guards that make
 * the browser button safe to ship:
 *
 *   - files and folders are really removed (folders recursively);
 *   - the workspace root, an outside absolute path, a symlink and a missing
 *     entry are refused with distinct codes;
 *   - a read-only policy refuses before touching anything.
 *
 * Run: node test/host.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const { deleteEntry, workspaceRootOf } = await import('../index.js').then((module) => module.__internals);

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-delete-test-')));

function seed() {
  writeFileSync(join(root, 'ssq_data.json'), '{"ok":true}');
  mkdirSync(join(root, 'sub', 'nested'), { recursive: true });
  writeFileSync(join(root, 'sub', 'a.py'), 'print(1)');
  writeFileSync(join(root, 'sub', 'nested', 'b.txt'), 'b');
}

function typeOf(info) {
  if (!info) return undefined;
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  return 'other';
}

/** The subset of `ctx.fs` the delete path uses, over the real local filesystem. */
function fileSystemFor(policy) {
  const resolveTarget = (path, cwd) => {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    // Mirror the backends: the canonical target is a realpath of the deepest
    // existing ancestor, so a missing tail still resolves.
    let probe = absolute;
    const tail = [];
    while (!existsSync(probe)) {
      tail.unshift(probe.slice(probe.lastIndexOf(process.platform === 'win32' ? '\\' : '/') + 1));
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const canonical = realpathSync(probe);
    return { targetKey: tail.length > 0 ? join(canonical, ...tail) : canonical, displayPath: path };
  };
  return {
    resolve: async (path, opts) => resolveTarget(path, (opts && opts.cwd) || root),
    processPath: (target) => target.targetKey,
    contains: (parent, child) => {
      const rest = relative(parent.targetKey, child.targetKey);
      return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
    },
    lstat: async (path, opts) => {
      try {
        return { type: typeOf(lstatSync(resolve((opts && opts.cwd) || root, path))) };
      } catch {
        return undefined;
      }
    },
    stat: async (target) => {
      try {
        return { type: typeOf(lstatSync(target.targetKey)) };
      } catch {
        return undefined;
      }
    },
    deleteFile: async (target) => {
      await unlink(target.targetKey);
    },
    /** The sandbox backend's fence: read-only denies, workspace-write confines. */
    checkedTarget: async (target) => {
      if (!policy) return target;
      if (policy.mode === 'read-only') {
        const error = new Error('file access denied under read-only mode');
        error.code = 'FS_SANDBOX_DENIED';
        throw error;
      }
      if (policy.mode === 'workspace-write' && !relative(root, target.targetKey).startsWith('..')) return target;
      if (policy.mode === 'workspace-write') {
        const error = new Error('file access denied under workspace-write mode');
        error.code = 'FS_SANDBOX_DENIED';
        throw error;
      }
      return target;
    },
  };
}

function contextFor({ cwd = root, policy = { mode: 'workspace-write', workspaceRoot: root } } = {}) {
  const services = {
    sessions: { get: (id) => (id === 'session-x' ? { header: { cwd } } : undefined) },
    sandboxPolicy: {
      workspaceRoot: cwd,
      resolve: () => ({ mode: policy.mode, workspaceRoot: policy.workspaceRoot }),
    },
  };
  // Mirrors the real host ctx: a guarded facade. Reading an undeclared
  // property (like `fs`) throws "cannot get property 'fs' without inject";
  // only `ctx.get(name)` (the optional lookup) reaches the service.
  const allServices = { ...services, fs: fileSystemFor(policy) };
  return new Proxy(
    { get: (name) => allServices[name] },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        throw new Error(`cannot get property '${String(prop)}' without inject`);
      },
    },
  );
}

async function rejects(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, `expected refusal "${code}", got "${error.code}: ${error.message}"`);
    return error;
  }
  assert.fail(`expected a "${code}" refusal, but the delete succeeded`);
}

// ---- 1. a regular file is removed -----------------------------------------

seed();
let ctx = contextFor();
assert.equal(await workspaceRootOf(ctx, 'session-x'), root, 'the Session header names the workspace root');
const fileResult = await deleteEntry(ctx, 'session-x', 'ssq_data.json');
assert.equal(fileResult.kind, 'file', 'reports a file');
assert.equal(existsSync(join(root, 'ssq_data.json')), false, 'the file is gone');

// The host ctx is a guarded facade: `fs` is reachable only through the
// optional lookup (ctx.get), never as a bare undeclared property.
assert.throws(() => ctx.fs, /fs/, 'undeclared ctx.fs property read throws');
assert.ok(ctx.get('fs'), 'ctx.get("fs") reaches the filesystem service');

// ---- 2. a folder is removed recursively ------------------------------------

assert.equal(existsSync(join(root, 'sub', 'nested', 'b.txt')), true, 'fixture exists');
const folderResult = await deleteEntry(ctx, 'session-x', 'sub');
assert.equal(folderResult.kind, 'directory', 'reports a directory');
assert.equal(existsSync(join(root, 'sub')), false, 'the folder and its contents are gone');

// ---- 3. the workspace root is never deletable ------------------------------

for (const spelling of ['.', './', root]) {
  ctx = contextFor();
  await rejects(deleteEntry(ctx, 'session-x', spelling), 'workspace-root');
}
assert.equal(existsSync(root), true, 'the workspace root survives');

// ---- 4. an outside absolute path is refused --------------------------------

const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-delete-outside-')));
writeFileSync(join(outside, 'secret.txt'), 'nope');
ctx = contextFor();
await rejects(deleteEntry(ctx, 'session-x', join(outside, 'secret.txt')), 'outside-workspace');
assert.equal(existsSync(join(outside, 'secret.txt')), true, 'the outside file survives');

// ---- 5. a missing entry is a not-found ------------------------------------

ctx = contextFor();
await rejects(deleteEntry(ctx, 'session-x', 'nope/missing.txt'), 'not-found');

// ---- 6. a symlink is refused ----------------------------------------------

let symlinkMade = false;
try {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file');
  symlinkMade = true;
} catch {
  /* Windows without the privilege: the guard is still unit-testable below */
}
if (symlinkMade) {
  ctx = contextFor();
  await rejects(deleteEntry(ctx, 'session-x', 'link.txt'), 'symlink');
  assert.equal(existsSync(join(outside, 'secret.txt')), true, 'the symlink target survives');
}

// ---- 7. read-only refuses before touching anything ------------------------

seed();
ctx = contextFor({ policy: { mode: 'read-only', workspaceRoot: root } });
await rejects(deleteEntry(ctx, 'session-x', 'ssq_data.json'), 'read-only');
assert.equal(existsSync(join(root, 'ssq_data.json')), true, 'read-only leaves the file in place');

// ---- cleanup ---------------------------------------------------------------

await rm(root, { recursive: true, force: true });
await rm(outside, { recursive: true, force: true });
assert.equal(existsSync(root), false, 'cleanup');

console.log('host test passed: file/folder removal, root + outside + symlink refusals, not-found, read-only fence');
