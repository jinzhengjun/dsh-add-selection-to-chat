/**
 * dsh-add-selection-to-chat — host half.
 *
 * Two responsibilities live here:
 *
 * 1. The client bundle. Every selection behaviour lives in `client.js`, which
 *    the web shell loads as the package's `./client` bundle; the `apply` below
 *    must exist so the package is a valid cordis plugin row (the Loader has to
 *    see it as enabled before `dsh-client-modules` publishes the bundle).
 *
 * 2. The delete endpoint used by the "删除" item this plugin adds to the file
 *    tree's right-click menu. The browser cannot remove a workspace file, and
 *    the read-only `workspaceFiles` Remote namespace has no mutation method, so
 *    the host half owns one small exact HTTP route:
 *
 *        POST /__dsh-add-selection-to-chat/delete
 *        { "sessionId": "session-…", "path": "sub/dir/file.py" | "C:\\…\\file.py" }
 *
 *    The path may be workspace-relative (document preview) or absolute (the
 *    file tree hands out absolute paths); it is resolved relative to the
 *    Session's workspace root, and every guard is re-checked on this side:
 *
 *      - the Session's workspace root itself can never be deleted;
 *      - the target must exist, must not be a symlink, and must resolve inside
 *        the workspace unless the effective policy is `danger-full-access`;
 *      - `read-only` refuses every delete;
 *      - the filesystem is reached through the guarded optional lookup
 *        (`ctx.get('fs')`), the same way every other host service is read: a
 *        bare undeclared property read throws on the shell's ctx facade;
 *      - regular files go through `ctx.fs.deleteFile`, so the same sandbox fence
 *        and version bookkeeping the model-facing file tools use applies here;
 *      - directories are removed recursively (there is no `ctx.fs` directory
 *        delete), after the same policy fence has re-canonicalized the target.
 *
 * The menu item asks the person first; this endpoint does not trust that — a
 * direct caller still hits every guard above.
 */
import { rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Exact route the Client half POSTs to. Kept in sync with `client.js`. */
const DELETE_ROUTE = '/__dsh-add-selection-to-chat/delete';
/** A delete request is a session id plus one path; anything larger is not ours. */
const MAX_BODY_BYTES = 64 * 1024;

/** One typed refusal: `status` is the HTTP status the route answers with. */
class DeleteFailure extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'DeleteFailure';
    this.code = code;
    this.status = status === undefined ? 500 : status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DeleteFailure('payload-too-large', '请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(new DeleteFailure('aborted', '请求已中断', 499)));
  });
}

/** `ctx.get(name)` when the service is optional and may be absent. */
function serviceOf(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Session's workspace root, mirroring what `workspaceFiles` uses: a live
 * Session's header first, then the persisted header, then the deployment
 * fallback. Resolution is never guessed from the process cwd.
 *
 * @param {object} ctx - host context.
 * @param {string} sessionId - Session the menu target belongs to.
 * @returns {Promise<string|undefined>} absolute workspace root, or `undefined`
 *   when no Session header and no deployment root exist.
 */
async function workspaceRootOf(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions');
  if (sessions && typeof sessions.get === 'function') {
    try {
      const live = sessions.get(sessionId);
      const cwd = live && ((live.header && live.header.cwd) || live.cwd);
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    } catch {
      /* fall through to the persisted header */
    }
  }
  const persistence = serviceOf(ctx, 'sessionPersistence');
  if (persistence && typeof persistence.stat === 'function') {
    try {
      const stored = await persistence.stat(sessionId);
      const cwd = stored && stored.header && stored.header.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    } catch {
      /* fall through to the deployment root */
    }
  }
  const policy = serviceOf(ctx, 'sandboxPolicy');
  if (policy && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot;
  return undefined;
}

/**
 * The effective sandbox policy for this delete. A live Session carries its own
 * mode override and cwd; a cold one falls back to the deployment default with
 * the persisted cwd stamped in as the writable root.
 *
 * @returns {object|undefined} a policy the filesystem fence understands, or
 *   `undefined` when this composition has no sandbox policy at all.
 */
function policyFor(ctx, sessionId, workspaceRoot) {
  const policy = serviceOf(ctx, 'sandboxPolicy');
  if (!policy || typeof policy.resolve !== 'function') return undefined;
  const sessions = serviceOf(ctx, 'sessions');
  let live;
  if (sessions && typeof sessions.get === 'function') {
    try {
      live = sessions.get(sessionId);
    } catch {
      live = undefined;
    }
  }
  if (live && live.header) return policy.resolve({ session: live });
  const base = policy.resolve();
  return { ...base, workspaceRoot };
}

/**
 * True when `path` is an absolute spelling. `ctx.fs.resolve` follows the final
 * component, so an absolute path would still be fenced — this only produces the
 * clearer "outside the workspace" refusal for the common case.
 */
function isAbsolutePath(path) {
  return isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Resolve one entry to its filesystem target and metadata, with typed refusals. */
async function inspectTarget(fs, rootPath, path) {
  let target;
  try {
    target = await fs.resolve(path, { cwd: rootPath });
  } catch (error) {
    throw new DeleteFailure('resolve-failed', `无法解析路径「${path}」：${String((error && error.message) || error)}`, 400);
  }
  let entry;
  try {
    entry = typeof fs.lstat === 'function' ? await fs.lstat(path, { cwd: rootPath }) : await fs.stat(target);
  } catch (error) {
    throw new DeleteFailure('resolve-failed', `无法读取「${path}」：${String((error && error.message) || error)}`, 400);
  }
  if (!entry) throw new DeleteFailure('not-found', '文件或文件夹不存在，可能已被删除', 404);
  return { target, entry };
}

/** Map an `FsError` code onto the person-facing message the dialog shows. */
function messageOfFsError(error) {
  const message = String((error && error.message) || error);
  switch (error && error.code) {
    case 'FS_NOT_FOUND':
      return '文件或文件夹不存在，可能已被删除';
    case 'FS_SANDBOX_DENIED':
      return `文件访问被沙箱策略拒绝：${message}`;
    case 'FS_PERMISSION_DENIED':
      return `没有权限删除它：${message}`;
    case 'FS_NOT_REGULAR_FILE':
      return `目标不是普通文件，无法删除：${message}`;
    case 'FS_STALE_VERSION':
      return '文件刚刚被改动或已被删除，请刷新文件树后重试';
    case 'FS_ABORTED':
      return '删除已取消';
    case 'FS_IO_ERROR':
      return `删除失败：${message}`;
    default:
      return message;
  }
}

/**
 * Delete one file or one directory (recursively) inside the Session workspace.
 *
 * @param {object} ctx - host context.
 * @param {string} sessionId - Session the menu target belongs to.
 * @param {string} path - workspace-relative path (`sub/dir/file.py`).
 * @returns {Promise<{ path: string, absolutePath: string, kind: 'file'|'directory' }>}
 */
async function deleteEntry(ctx, sessionId, path) {
  // The host ctx is the same guarded facade as the client ctx: an undeclared
  // property read throws "cannot get property 'fs' without inject". `ctx.get`
  // is the optional lookup that bypasses the declaration gate (the same way
  // `workspaceRootOf` and `policyFor` read their services), and still returns
  // the real service when it is provided.
  const fs = serviceOf(ctx, 'fs');
  if (!fs || typeof fs.resolve !== 'function') {
    throw new DeleteFailure('filesystem-unavailable', '当前环境没有可用的文件系统服务', 503);
  }
  const rootPath = await workspaceRootOf(ctx, sessionId);
  if (!rootPath) {
    throw new DeleteFailure('unknown-workspace', '找不到该会话的工作区，无法确定删除范围', 409);
  }
  const root = await fs.resolve(rootPath);
  const { target, entry } = await inspectTarget(fs, rootPath, path);

  // Defence in depth: the client hides the item for absolute paths, but the
  // workspace root (or anything outside it) must never be reachable from here.
  const targetKey = fs.processPath(target);
  if (targetKey === fs.processPath(root)) {
    throw new DeleteFailure('workspace-root', '不能删除工作区根目录', 403);
  }
  if (isAbsolutePath(path) && !fs.contains(root, target)) {
    throw new DeleteFailure('outside-workspace', '只能删除工作区内的文件或文件夹', 403);
  }
  if (entry.type === 'symlink') {
    throw new DeleteFailure('symlink', '不支持删除符号链接', 400);
  }

  const policy = policyFor(ctx, sessionId, rootPath);
  if (policy && policy.mode === 'read-only') {
    throw new DeleteFailure('read-only', '当前文件策略为只读，不能删除', 403);
  }

  const contained = typeof fs.contains === 'function' ? fs.contains(root, target) : true;
  if (!contained && policy && policy.mode !== 'danger-full-access') {
    throw new DeleteFailure('outside-workspace', '只能删除工作区内的文件或文件夹', 403);
  }

  const isDirectory = entry.type === 'directory';
  try {
    if (isDirectory) {
      // No `ctx.fs` directory delete: fence the target the same way the file
      // path does, then recurse over the canonical path it returns.
      const checked = typeof fs.checkedTarget === 'function' ? await fs.checkedTarget(target, policy) : target;
      await rm(fs.processPath(checked), { recursive: true, force: false, maxRetries: 2, retryDelay: 120 });
    } else {
      await fs.deleteFile(target, undefined, undefined, policy);
    }
  } catch (error) {
    if (error instanceof DeleteFailure) throw error;
    throw new DeleteFailure('delete-failed', messageOfFsError(error), 500);
  }

  return { path, absolutePath: targetKey, kind: isDirectory ? 'directory' : 'file' };
}

/**
 * Answer one delete request. The response is always JSON:
 * `{ ok: true, value: { path, absolutePath, kind } }` or
 * `{ ok: false, error: { code, message } }`.
 */
async function handleDelete(ctx, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只接受 POST' } });
    return;
  }
  let request;
  try {
    const raw = await readBody(req);
    request = raw ? JSON.parse(raw) : {};
  } catch (error) {
    const status = error instanceof DeleteFailure ? error.status : 400;
    sendJson(res, status, {
      ok: false,
      error: {
        code: error instanceof DeleteFailure ? error.code : 'bad-request',
        message: error instanceof DeleteFailure ? error.message : '请求体不是合法的 JSON',
      },
    });
    return;
  }
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
  const path = typeof request.path === 'string' ? request.path : '';
  if (!sessionId) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-session', message: '缺少 sessionId' } });
    return;
  }
  if (!path.trim()) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-path', message: '缺少 path' } });
    return;
  }
  try {
    const value = await deleteEntry(ctx, sessionId, path);
    sendJson(res, 200, { ok: true, value });
  } catch (error) {
    const failure =
      error instanceof DeleteFailure
        ? error
        : new DeleteFailure('delete-failed', String((error && error.message) || error), 500);
    sendJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } });
  }
}

/**
 * Cordis host plugin entry.
 *
 * `webServer` is optional (a headless composition has none), so the route is
 * registered through `ctx.inject` and withdraws with the plugin.
 *
 * @param ctx - host root context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: DELETE_ROUTE,
          handler: (req, res) => {
            handleDelete(ctx, req, res).catch((error) => {
              if (!res.headersSent) {
                sendJson(res, 500, {
                  ok: false,
                  error: { code: 'internal', message: String((error && error.message) || error) },
                });
              } else if (!res.writableEnded) {
                res.end();
              }
            });
          },
        }),
      'add-selection-to-chat: file delete route',
    );
  });
}

/** Exported for the offline host test; unused by the shell. */
export const __internals = { deleteEntry, workspaceRootOf, policyFor, DELETE_ROUTE };
