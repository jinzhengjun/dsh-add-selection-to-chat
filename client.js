/**
 * dsh-add-selection-to-chat — client half.
 *
 * Adds one item to the document-preview right-click menu: "添加到对话框" appends
 * the selected text to the composer that is on screen right now.
 *
 * Two rules this plugin follows deliberately:
 *
 * 1. The insertion target is the *rendered* composer, not "the session the
 *    Session catalog thinks is current". The conversation body carries
 *    `data-conversation-session`, the composer card `data-composer-card`, and
 *    the editable surface `data-composer-input`; if that card is absent,
 *    locked, or mid-submission the item is disabled with a reason instead of
 *    writing into some other Session's draft.
 *
 * 2. The append position never depends on a live caret. Right-clicking the
 *    preview blurs the composer, and its Lexical selection is whatever was
 *    left there earlier — possibly the middle of a paragraph. The text is
 *    therefore appended at the end of the draft (`projection.detectText`
 *    length), not at the stale caret.
 *
 * Why a renderer-side menu: the desktop shell builds its native context menu in
 * the main process (`app.asar/lib/main.js`, `webContents.on("context-menu")`),
 * where only edit roles exist. A DOM `contextmenu` listener that calls
 * `preventDefault()` stops Chromium from raising that native menu request at
 * all, so this bundle owns the menu inside the preview and nothing overlaps.
 */
window.__ModuleLoader__.load({
	id: 'dsh-add-selection-to-chat',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Every inline-rendered preview body (text, code, markdown, office) carries this marker. */
		const PREVIEW_SELECTOR = '[data-textpreview-body]';
		/** The chat region, its Session id, the composer card, and the editable surface. */
		const CHAT_REGION_SELECTOR = '[data-conversation-region="chat"]';
		const SESSION_ATTR = 'data-conversation-session';
		const COMPOSER_CARD_SELECTOR = '[data-composer-card]';
		const COMPOSER_INPUT_SELECTOR = '[data-composer-input]';
		/** A collapsed selection still offers the last text picked in the same preview for this long. */
		const SELECTION_TTL_MS = 10 * 60 * 1000;
		const STYLE_ATTR = 'data-dsh-plugin-css';
		const STYLE_KEY = 'dsh-add-selection-to-chat';

		const COPY = {
			zh: {
				insert: '添加到对话框',
				lines: (n) => `${n} 行`,
				chars: (n) => `${n} 字符`,
				done: '已添加到对话框',
				reason: {
					'no-session': '当前没有打开的会话',
					'no-composer': '当前会话没有可用的输入框',
					locked: '输入框目前不可编辑',
					busy: '输入框正在发送消息，请稍后再试',
					stale: '草稿刚被改动，请重试',
				},
				// File-tree delete item (see `installDeleteMenus`).
				delete: '删除',
				deleteFile: '删除文件',
				deleteFolder: '删除文件夹',
				deleteFileBody: (name) => `将永久删除「${name}」，此操作不可恢复。`,
				deleteFolderBody: (name) => `将永久删除文件夹「${name}」以及其中的全部内容，此操作不可恢复。`,
				deleting: '正在删除…',
				deleted: (name) => `已删除「${name}」`,
				deleteFailed: '删除失败',
				cancel: '取消',
			},
			en: {
				insert: 'Add to chat',
				lines: (n) => `${n} ${n === 1 ? 'line' : 'lines'}`,
				chars: (n) => `${n} ${n === 1 ? 'char' : 'chars'}`,
				done: 'Added to chat',
				reason: {
					'no-session': 'No Session is open',
					'no-composer': 'This Session has no composer',
					locked: 'The composer is not editable right now',
					busy: 'The composer is still submitting',
					stale: 'The draft changed, try again',
				},
				delete: 'Delete',
				deleteFile: 'Delete file',
				deleteFolder: 'Delete folder',
				deleteFileBody: (name) => `This permanently deletes “${name}”. This cannot be undone.`,
				deleteFolderBody: (name) => `This permanently deletes the folder “${name}” and everything inside it. This cannot be undone.`,
				deleting: 'Deleting…',
				deleted: (name) => `Deleted “${name}”`,
				deleteFailed: 'Delete failed',
				cancel: 'Cancel',
			},
		};

		function copy() {
			const language = typeof navigator !== 'undefined' && navigator.language ? String(navigator.language) : 'zh';
			return language.toLowerCase().indexOf('zh') === 0 ? COPY.zh : COPY.en;
		}

		// ---- styles ---------------------------------------------------------------

		const CSS = `
.dsh-selchat-menu{
  position:fixed;z-index:2147483000;box-sizing:border-box;min-width:200px;max-width:340px;
  padding:4px;border-radius:10px;
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-layer-1,#fff);
  color:var(--dsw-alias-label-primary,#1f1f1f);
  box-shadow:0 10px 32px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08);
  font-size:13px;line-height:1.4;font-family:inherit;outline:none;
}
.dsh-selchat-meta{
  padding:4px 10px 6px;margin-bottom:4px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#6b6b6b);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));
}
.dsh-selchat-item{
  display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;
  cursor:pointer;user-select:none;outline:none;
}
.dsh-selchat-item[data-active="true"]{
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
}
.dsh-selchat-item[aria-disabled="true"]{opacity:.5;cursor:default;background:0 0;}
.dsh-selchat-plus{opacity:.65;font-weight:600;font-size:13px;}
.dsh-selchat-key{margin-left:auto;font-size:11px;opacity:.45;}
.dsh-selchat-hint{
  padding:0 10px 4px 30px;font-size:11.5px;line-height:1.35;white-space:normal;
  color:var(--dsw-alias-label-tertiary,#8a8a8a);
}
.dsh-selchat-toast{
  position:fixed;z-index:2147483001;padding:6px 12px;border-radius:8px;font-size:12.5px;
  background:var(--dsw-alias-bg-layer-1,#fff);
  color:var(--dsw-alias-label-primary,#1f1f1f);
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));
  box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:none;
  opacity:1;transition:opacity .18s ease;
}
.dsh-selchat-backdrop{
  position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.36);
}
.dsh-selchat-dialog{
  box-sizing:border-box;width:min(420px,calc(100vw - 40px));
  display:flex;flex-direction:column;gap:10px;padding:16px 18px;border-radius:12px;
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-layer-1,#fff);
  color:var(--dsw-alias-label-primary,#1f1f1f);
  box-shadow:0 18px 48px rgba(0,0,0,.28);
  font-size:13px;line-height:1.5;font-family:inherit;
}
.dsh-selchat-dialog h3{margin:0;font-size:14px;font-weight:600;word-break:break-all;}
.dsh-selchat-dialog p{margin:0;color:var(--dsw-alias-label-secondary,#6b6b6b);word-break:break-word;}
.dsh-selchat-dialog .dsh-selchat-name{
  color:var(--dsw-alias-label-primary,#1f1f1f);font-weight:500;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;
}
.dsh-selchat-error{
  min-height:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-state-error-primary,#e5484d);
  white-space:pre-wrap;word-break:break-word;
}
.dsh-selchat-error:empty{display:none;}
.dsh-selchat-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px;}
.dsh-selchat-btn{
  font:inherit;font-size:12.5px;line-height:1.2;padding:6px 14px;border-radius:8px;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4));
  background:transparent;color:var(--dsw-alias-label-primary,inherit);
}
.dsh-selchat-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}
.dsh-selchat-btn[disabled]{opacity:.5;cursor:default;}
.dsh-selchat-btn-danger{
  color:#fff;background:#e5484d;border-color:#e5484d;
}
.dsh-selchat-btn-danger:hover{background:#d13b40;border-color:#d13b40;}`;

		function ensureStyle(doc) {
			if (!doc || !doc.head) return;
			if (typeof doc.querySelector === 'function' && doc.querySelector(`style[${STYLE_ATTR}="${STYLE_KEY}"]`)) return;
			const style = doc.createElement('style');
			style.setAttribute(STYLE_ATTR, STYLE_KEY);
			style.textContent = CSS;
			doc.head.appendChild(style);
		}

		// ---- DOM helpers ----------------------------------------------------------

		function elementOf(node) {
			if (!node) return null;
			if (node.nodeType === 1) return node;
			return node.parentElement || null;
		}

		/** The preview body owning `node`, or null when the node is outside a preview. */
		function previewBodyOf(node) {
			const element = elementOf(node);
			if (!element || typeof element.closest !== 'function') return null;
			return element.closest(PREVIEW_SELECTOR);
		}

		/** Normalize a selection for the draft: LF newlines, no trailing blank tail. */
		function cleanText(text) {
			return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/[ \t\u00a0]+$/, '').replace(/\n+$/, '');
		}

		/**
		 * The path shown by the preview header. The label is a sibling of the body
		 * (both live under the preview root), not a descendant of it, so walk up.
		 */
		function previewLabel(body) {
			let scope = body;
			for (let depth = 0; scope && depth < 4; depth += 1) {
				const label = typeof scope.querySelector === 'function' ? scope.querySelector('[data-textpreview-path]') : null;
				const text = label && label.textContent ? String(label.textContent).trim() : '';
				if (text) return text;
				scope = scope.parentElement || null;
			}
			return '';
		}

		/** Last segment of a Windows or POSIX path. */
		function fileNameOf(path) {
			const value = String(path == null ? '' : path).trim();
			if (!value) return '';
			const parts = value.split(/[\\/]/).filter((part) => part.length > 0);
			return parts.length > 0 ? parts[parts.length - 1] : value;
		}

		// ---- source line numbers ----------------------------------------------------

		/** 1-based source line of one range endpoint, or null when the renderer exposes none. */
		function lineNumberOf(node, body) {
			const element = elementOf(node);
			if (!element || typeof element.closest !== 'function') return null;
			// Plain-text renderer: every line is a numbered row (1-based, same space `#L24` uses).
			const row = element.closest('[data-textpreview-line]');
			if (row && body.contains(row)) {
				const number = Number(row.getAttribute('data-textpreview-line'));
				return Number.isFinite(number) ? number : null;
			}
			// Code renderer: the highlighted block splits source into `.line` spans.
			const code = element.closest('[data-code-preview]');
			if (code && body.contains(code)) {
				const content = (typeof code.querySelector === 'function' && code.querySelector('[data-code-block-content]')) || code;
				if (typeof content.querySelectorAll !== 'function') return null;
				const lines = Array.prototype.slice.call(content.querySelectorAll('.line'));
				const line = element.closest('.line');
				const index = lines.indexOf(line);
				return index >= 0 ? index + 1 : null;
			}
			return null;
		}

		/** Inclusive 1-based line range of a selection, or null when it cannot be resolved. */
		function lineRangeOf(range, body) {
			const start = lineNumberOf(range.startContainer, body);
			const end = lineNumberOf(range.endContainer, body);
			if (start === null || end === null) return null;
			return { start: Math.min(start, end), end: Math.max(start, end) };
		}

		/**
		 * Read a live selection inside `body`.
		 * @returns {{ text: string, lineRange: ({start:number,end:number}|null) } | null}
		 */
		function readSelection(body, win) {
			const selection = win.getSelection ? win.getSelection() : null;
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
			const range = selection.getRangeAt(0);
			const container = range.commonAncestorContainer;
			if (!body.contains(container) && !body.contains(elementOf(container))) return null;
			const text = cleanText(selection.toString());
			if (!text) return null;
			return { text, lineRange: lineRangeOf(range, body) };
		}

		// ---- inserted payload -------------------------------------------------------

		/**
		 * The block this plugin types into the composer:
		 *
		 *     sub/dir/campus.html（第 11-17 行）
		 *     <selected text>
		 *
		 * The header names the file **relative to the project root** (the
		 * Session's `cwd`) and its 1-based source range. Without a path (no
		 * preview header) or without line markup (Markdown bodies) the header
		 * degrades field by field; a header that would carry no information at
		 * all is dropped rather than emitting a bare fragment.
		 */
		function composePayload(path, text, lineRange, workspaceRoot) {
			const relative = workspaceRelativePath(path, workspaceRoot);
			const name = relative || fileNameOf(path);
			const range = lineRange ? `（第 ${lineRange.start}-${lineRange.end} 行）` : '';
			if (!name) return range ? `${range}\n${text}` : text;
			return `${name}${range}\n${text}`;
		}

		// ---- the composer that is actually on screen --------------------------------

		/**
		 * Read the rendered composer: which Session it belongs to, whether it is
		 * editable, and its card node.
		 * @returns {{ sessionId?: string, editable: boolean, card: Element } | null} null when no composer is rendered.
		 */
		function composerTarget(doc) {
			if (!doc || typeof doc.querySelector !== 'function') return null;
			const region = doc.querySelector(CHAT_REGION_SELECTOR) || doc.querySelector(`[${SESSION_ATTR}]`);
			const card = (region && region.querySelector ? region.querySelector(COMPOSER_CARD_SELECTOR) : null)
				|| doc.querySelector(COMPOSER_CARD_SELECTOR);
			if (!card) return null;
			const host = typeof card.closest === 'function' ? card.closest(`[${SESSION_ATTR}]`) : null;
			const owner = host || region;
			const sessionId = owner && typeof owner.getAttribute === 'function' ? owner.getAttribute(SESSION_ATTR) : null;
			const input = typeof card.querySelector === 'function' ? card.querySelector(COMPOSER_INPUT_SELECTOR) : null;
			const editableAttr = input && typeof input.getAttribute === 'function' ? input.getAttribute('contenteditable') : null;
			return {
				...(sessionId ? { sessionId } : {}),
				editable: editableAttr === 'true' || editableAttr === '',
				card,
			};
		}

		/** The Session currently rendered in the main view (fallback when the DOM carries no id). */
		function catalogSessionId(sessions) {
			try {
				const snapshot = sessions.list.getSnapshot();
				const rows = Object.keys(snapshot.byId || {}).map((id) => snapshot.byId[id]);
				const row = rows.find((candidate) => candidate && candidate.retainedBy && (candidate.retainedBy.mainView || 0) > 0);
				return row ? row.sessionId : undefined;
			} catch (error) {
				return undefined;
			}
		}

		/**
		 * One Session row from the catalog snapshot, by id (or the main-view row
		 * when no id is given). Null-safe: any missing shape yields undefined.
		 */
		function catalogSessionRow(sessions, sessionId) {
			try {
				const snapshot = sessions.list.getSnapshot();
				const byId = snapshot.byId || {};
				if (sessionId) {
					const row = byId[sessionId];
					return row || undefined;
				}
				const rows = Object.keys(byId).map((id) => byId[id]);
				const row = rows.find((candidate) => candidate && candidate.retainedBy && (candidate.retainedBy.mainView || 0) > 0);
				return row || undefined;
			} catch (error) {
				return undefined;
			}
		}

		/**
		 * The Session's workspace root (project root). The catalog row carries
		 * `header.cwd` or a bare `cwd`; anything else is unknown, and an unknown
		 * root means "cannot relativize" rather than a guess.
		 */
		function workspaceRootOf(sessions, sessionId) {
			const row = catalogSessionRow(sessions, sessionId);
			if (!row) return undefined;
			const cwd = (row.header && row.header.cwd) || row.cwd;
			return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
		}

		/**
		 * Express `path` against the project root when possible. The preview
		 * header hands out absolute paths (`C:\...\campus.html`); relative to the
		 * Session's `cwd` that becomes `campus.html` or `sub/dir/campus.html`.
		 * A path that does not sit under the root is left unchanged, and an
		 * unknown root is a no-op — the header degrades to whatever it had.
		 * Case-insensitive on the prefix (Windows volumes).
		 */
		function workspaceRelativePath(path, root) {
			const value = String(path == null ? '' : path).trim();
			const base = String(root == null ? '' : root).trim();
			if (!value || !base) return value;
			const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
			const v = norm(value);
			const r = norm(base);
			if (!r || !v) return value;
			if (v.toLowerCase() === r.toLowerCase()) return '';
			// The root is compared as a whole path segment: `C:\workspace` is a
			// prefix of `C:\workspace\a\b.ts` but not of `C:\workspace2\a.ts`.
			const prefix = r + '/';
			if (v.toLowerCase().startsWith(prefix.toLowerCase())) {
				return v.slice(r.length + 1);
			}
			return value;
		}

		function readInputState(shell) {
			try {
				const store = shell && shell.state;
				return store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined;
			} catch (error) {
				return undefined;
			}
		}

		/**
		 * Decide whether this click can insert anything, and resolve the shell it
		 * would insert into. Pure read: no input is created for an absent composer.
		 * @returns {{ ok: true, shell, target, draft: string } | { ok: false, reason: string }}
		 */
		function probeComposer(ctx, doc) {
			const target = composerTarget(doc);
			if (!target) return { ok: false, reason: 'no-composer' };
			if (!target.editable) return { ok: false, reason: 'locked' };
			const sessionId = target.sessionId || (ctx.sessions ? catalogSessionId(ctx.sessions) : undefined);
			if (!sessionId) return { ok: false, reason: 'no-session' };
			let shell;
			try {
				shell = ctx.conversation.input.shell(sessionId);
			} catch (error) {
				return { ok: false, reason: 'no-composer' };
			}
			if (!shell || !shell.actions) return { ok: false, reason: 'no-composer' };
			const state = readInputState(shell);
			if (state && typeof state.phase === 'string' && state.phase !== 'plain') return { ok: false, reason: 'busy' };
			return { ok: true, shell, target, draft: state && typeof state.draft === 'string' ? state.draft : '' };
		}

		/** Detect-coordinate end of the draft; falls back to the captured span when unavailable. */
		function draftEndOffset(shell, captured) {
			const projection = shell && shell.projection;
			if (projection && typeof projection.detectText === 'string') return projection.detectText.length;
			return captured.start;
		}

		/**
		 * Append `text` to the rendered composer as one undoable edit.
		 * @returns {{ ok: boolean, reason?: string }}
		 */
		function insertSelection(ctx, doc, text) {
			const probe = probeComposer(ctx, doc);
			if (!probe.ok) return { ok: false, reason: probe.reason };
			const { shell, draft } = probe;
			let captured;
			try {
				captured = shell.actions.captureInsertion();
			} catch (error) {
				return { ok: false, reason: 'no-composer' };
			}
			const end = draftEndOffset(shell, captured);
			// Separate the block from whatever the draft already holds.
			const payload = end > 0 && !draft.endsWith('\n') ? '\n' + text : text;
			let applied = false;
			try {
				applied = shell.actions.insertText(payload, { start: end, end, draftRev: captured.draftRev }) === true;
			} catch (error) {
				applied = false;
			}
			if (!applied) return { ok: false, reason: 'stale' };
			try {
				if (typeof shell.focus === 'function') shell.focus();
			} catch (error) {
				/* focus is a nicety; the insertion already happened */
			}
			return { ok: true };
		}

		// ---- menu -----------------------------------------------------------------

		function closeMenu(state) {
			if (state.menu && state.menu.parentNode) state.menu.parentNode.removeChild(state.menu);
			state.menu = null;
			if (state.offMenuKeys) {
				state.offMenuKeys();
				state.offMenuKeys = null;
			}
		}

		function toast(doc, win, x, y, message) {
			if (!doc.body) return;
			const node = doc.createElement('div');
			node.className = 'dsh-selchat-toast';
			node.textContent = message;
			node.style.left = `${Math.max(8, Math.min(x, (win.innerWidth || 1024) - 180))}px`;
			node.style.top = `${Math.max(8, y)}px`;
			doc.body.appendChild(node);
			if (win.setTimeout) {
				win.setTimeout(() => {
					node.style.opacity = '0';
					win.setTimeout(() => {
						if (node.parentNode) node.parentNode.removeChild(node);
					}, 220);
				}, 1300);
			}
		}

		function reasonText(t, reason) {
			return (t.reason && t.reason[reason]) || t.reason['no-composer'];
		}

		function openMenu(state, ctx, win, doc, event, selection, path) {
			closeMenu(state);
			ensureStyle(doc);
			const t = copy();
			const probe = probeComposer(ctx, doc);
			const { text, lineRange } = selection;
			// The payload header is relative to the project root; the menu meta
			// stays short (file name only). The root comes from the Session the
			// composer renders — the same row the catalog uses for the fallback.
			// Prefer the rendered Session's own root; fall back to any mainView
			// row when the composer's Session does not carry a cwd.
			const workspaceRoot =
				(probe.ok && probe.target
					? workspaceRootOf(ctx.sessions, probe.target.sessionId)
					: undefined) || workspaceRootOf(ctx.sessions, undefined);
			const lineCount = text.split('\n').length;
			const meta = [fileNameOf(path), lineRange ? `第 ${lineRange.start}-${lineRange.end} 行` : t.lines(lineCount)].filter(Boolean).join(' · ');

			const menu = doc.createElement('div');
			menu.className = 'dsh-selchat-menu';
			menu.setAttribute('role', 'menu');
			menu.setAttribute('tabindex', '-1');
			menu.setAttribute('aria-label', t.insert);

			const metaNode = doc.createElement('div');
			metaNode.className = 'dsh-selchat-meta';
			metaNode.textContent = meta;
			metaNode.title = meta;
			menu.appendChild(metaNode);

			const item = doc.createElement('div');
			item.className = 'dsh-selchat-item';
			item.setAttribute('role', 'menuitem');
			item.setAttribute('data-active', 'true');

			const plus = doc.createElement('span');
			plus.className = 'dsh-selchat-plus';
			plus.textContent = '＋';
			item.appendChild(plus);

			const label = doc.createElement('span');
			label.textContent = t.insert;
			item.appendChild(label);

			if (probe.ok) {
				const key = doc.createElement('span');
				key.className = 'dsh-selchat-key';
				key.textContent = '↵';
				item.appendChild(key);
			} else {
				item.setAttribute('aria-disabled', 'true');
				item.removeAttribute('data-active');
			}
			menu.appendChild(item);

			if (!probe.ok) {
				const hint = doc.createElement('div');
				hint.className = 'dsh-selchat-hint';
				hint.textContent = reasonText(t, probe.reason);
				menu.appendChild(hint);
			}

			const activate = () => {
				if (!probe.ok) {
					closeMenu(state);
					return;
				}
				const anchorX = event.clientX || 0;
				const anchorY = (event.clientY || 0) + 22;
				const outcome = insertSelection(ctx, doc, composePayload(path, text, lineRange, workspaceRoot));
				closeMenu(state);
				toast(doc, win, anchorX, anchorY, outcome.ok ? copy().done : reasonText(copy(), outcome.reason));
			};

			item.addEventListener('mousedown', (pointerEvent) => {
				// Keep the preview selection intact until the click settles.
				if (pointerEvent.preventDefault) pointerEvent.preventDefault();
			});
			if (probe.ok) item.addEventListener('click', activate);
			else item.addEventListener('click', () => closeMenu(state));

			menu.addEventListener('keydown', (keyboardEvent) => {
				if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
					keyboardEvent.preventDefault();
					activate();
				}
			});

			doc.body.appendChild(menu);

			// Place at the pointer, flipping and clamping to the viewport.
			const rect = typeof menu.getBoundingClientRect === 'function' ? menu.getBoundingClientRect() : { width: 220, height: 64 };
			const width = rect.width || 220;
			const height = rect.height || 64;
			const viewWidth = win.innerWidth || 1024;
			const viewHeight = win.innerHeight || 768;
			const left = Math.max(8, Math.min(event.clientX || 0, viewWidth - width - 8));
			const top = (event.clientY || 0) + height + 8 > viewHeight
				? Math.max(8, (event.clientY || 0) - height - 4)
				: (event.clientY || 0) + 2;
			menu.style.left = `${left}px`;
			menu.style.top = `${top}px`;

			if (typeof menu.focus === 'function') menu.focus();

			state.menu = menu;

			const onKeyDown = (keyboardEvent) => {
				if (keyboardEvent.key === 'Escape') {
					keyboardEvent.preventDefault();
					closeMenu(state);
				}
			};
			const onPointerDown = (pointerEvent) => {
				if (state.menu && !state.menu.contains(pointerEvent.target)) closeMenu(state);
			};
			const onScroll = () => closeMenu(state);
			const onResize = () => closeMenu(state);

			doc.addEventListener('keydown', onKeyDown, true);
			doc.addEventListener('pointerdown', onPointerDown, true);
			win.addEventListener('scroll', onScroll, true);
			win.addEventListener('resize', onResize);

			state.offMenuKeys = () => {
				doc.removeEventListener('keydown', onKeyDown, true);
				doc.removeEventListener('pointerdown', onPointerDown, true);
				win.removeEventListener('scroll', onScroll, true);
				win.removeEventListener('resize', onResize);
			};
		}

		// ---- file-tree delete -------------------------------------------------------
		//
		// The file navigator (`dsh-client-ui-sidebar-files`) opens the shared context
		// menu with `kind: "file"` for files and `kind: "directory"` for folders and
		// the values `{ sessionId, path }` (path workspace-relative). `file-actions`
		// contributes 另存为… to the `file` kind; nothing offers a deletion, so this
		// plugin registers one more provider per kind and posts the deletion to the
		// host half (`index.js`), which owns every filesystem guard.

		/** Exact host route; kept in sync with `index.js`. */
		const DELETE_ROUTE = '/__dsh-add-selection-to-chat/delete';
		const DELETE_MENU_ORDER = 400;

		/**
		 * The file tree hands out absolute paths (e.g. `C:\...\ssq_model.py`),
		 * while previews can carry workspace-relative ones. Either is deletable:
		 * the host half (`index.js`) re-checks everything — workspace-root 403,
		 * outside-workspace 403, symlink 400, read-only 403 — so this gate only
		 * keeps obviously non-target rows (empty, `.`, `..`) off the menu.
		 */
		function isDeletableTargetPath(path) {
			const value = String(path == null ? '' : path).trim();
			if (!value) return false;
			// Windows absolute (drive or UNC) and POSIX absolute are fine: the host
			// decides whether they resolve into the workspace.
			const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
			if (!normalized || normalized === '.' || normalized === '..') return false;
			if (normalized.startsWith('../')) return false;
			return true;
		}

		/** @deprecated use isDeletableTargetPath; kept for the offline tests. */
		function isWorkspaceRelativePath(path) {
			const value = String(path == null ? '' : path).trim();
			if (!value) return false;
			if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
			if (value.startsWith('\\')) return false;
			if (value.startsWith('/')) return false;
			const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
			if (!normalized || normalized === '.' || normalized === '..') return false;
			return !normalized.startsWith('../') && !normalized.includes('/../');
		}

		/** POST one deletion to the host; resolves with its `value`, throws a message otherwise. */
		function deletePath(sessionId, path) {
			return fetch(DELETE_ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, path }),
			}).then(async (response) => {
				let data = {};
				try {
					data = await response.json();
				} catch (error) {
					data = {};
				}
				if (!response.ok || !data || data.ok !== true) {
					if (response.status === 404) {
						throw new Error('删除端点不可用（HTTP 404）：请确认插件宿主半侧已加载并重启 DSH');
					}
					const message = data && data.error && data.error.message ? data.error.message : `HTTP ${response.status}`;
					throw new Error(message);
				}
				return data.value;
			});
		}

		/**
		 * The shell's contextMenus service, once it appears. Set the moment
		 * acquireContextMenus finds it; null until then. Every consumer of the
		 * shell toast (the delete dialog, future features) reads this single
		 * reference instead of reaching into a possibly-guarded ctx.
		 */
		let shellMenus = null;

		/**
		 * Look up the contextMenus service the way the loader will actually
		 * deliver it to us. Because `contextMenus` is declared in
		 * exports.inject, path 1 (direct property access on the guarded facade)
		 * is the one that works — exactly how file-actions reads it. Paths 2 and
		 * 3 remain as fallbacks. Every attempt records its outcome in
		 * `lastAcquireTrace` so a failure is never invisible.
		 */
		let lastAcquireTrace = null;

		function acquireContextMenus(ctx) {
			if (shellMenus) return shellMenus;
			if (!ctx) return null;
			const trace = [];
			let service = null;
			// Path 1: direct property — works once the loader has declared and
			// injected `contextMenus` on our fiber (the normal case now).
			try {
				service = ctx.contextMenus;
				trace.push('prop=' + (service && typeof service.register === 'function' ? 'ok' : 'no-register'));
			} catch (error) {
				trace.push('prop=throw:' + (error && error.message ? error.message : error));
			}
			if (service && typeof service.register === 'function') {
				shellMenus = service;
				lastAcquireTrace = 'prop:' + trace.join(' | ');
				return service;
			}
			// Path 2: optional lookup — bypasses the declaration gate.
			if (typeof ctx.get === 'function') {
				try {
					const viaGet = ctx.get('contextMenus');
					trace.push('get=' + (viaGet && typeof viaGet.register === 'function' ? 'ok' : 'empty'));
					if (viaGet && typeof viaGet.register === 'function') {
						shellMenus = viaGet;
						lastAcquireTrace = 'get:' + trace.join(' | ');
						return viaGet;
					}
				} catch (error) {
					trace.push('get=throw:' + (error && error.message ? error.message : error));
				}
			}
			// Path 3: child-fiber injection.
			if (typeof ctx.inject === 'function') {
				try {
					let viaInject = null;
					ctx.inject(['contextMenus'], (scope) => {
						const candidate = scope && scope.contextMenus;
						if (candidate && typeof candidate.register === 'function') viaInject = candidate;
					});
					trace.push('inject=' + (viaInject ? 'ok' : 'empty'));
					if (viaInject) {
						shellMenus = viaInject;
						lastAcquireTrace = 'inject:' + trace.join(' | ');
						return viaInject;
					}
				} catch (error) {
					trace.push('inject=throw:' + (error && error.message ? error.message : error));
				}
			}
			lastAcquireTrace = 'all-failed: ' + trace.join(' | ');
			return null;
		}

		/** Prefer the shell's toast; fall back to this plugin's own when it is absent. */
		function notify(doc, win, text, success) {
			try {
				if (shellMenus && typeof shellMenus.notify === 'function') {
					shellMenus.notify(text, success === true);
					return;
				}
			} catch (error) {
				/* fall through to the local toast */
			}
			toast(doc, win, 24, 24, text);
		}

		/**
		 * Confirm, then delete. The shared menu is already gone by the time `run()`
		 * fires, so this owns its own dialog: Escape or 取消 dismisses, a failed
		 * request stays on screen with the reason and leaves the entry in place.
		 */
		function openDeleteDialog(target, kind) {
			const win = window;
			const doc = win.document;
			if (!doc || !doc.body) return;
			ensureStyle(doc);
			const t = copy();
			const path = String(target.path);
			const name = fileNameOf(path) || path;
			const isDirectory = kind === 'directory';

			const backdrop = doc.createElement('div');
			backdrop.className = 'dsh-selchat-backdrop';
			backdrop.setAttribute('data-dsh-selchat-delete', '');

			const dialog = doc.createElement('div');
			dialog.className = 'dsh-selchat-dialog';
			dialog.setAttribute('role', 'alertdialog');
			dialog.setAttribute('aria-modal', 'true');
			dialog.setAttribute('aria-label', isDirectory ? t.deleteFolder : t.deleteFile);
			backdrop.appendChild(dialog);

			const title = doc.createElement('h3');
			title.textContent = isDirectory ? t.deleteFolder : t.deleteFile;
			dialog.appendChild(title);

			const nameNode = doc.createElement('span');
			nameNode.className = 'dsh-selchat-name';
			nameNode.textContent = name;
			nameNode.title = path;
			dialog.appendChild(nameNode);

			const body = doc.createElement('p');
			body.textContent = isDirectory ? t.deleteFolderBody(name) : t.deleteFileBody(name);
			dialog.appendChild(body);

			const errorNode = doc.createElement('div');
			errorNode.className = 'dsh-selchat-error';
			errorNode.setAttribute('role', 'alert');
			dialog.appendChild(errorNode);

			const actions = doc.createElement('div');
			actions.className = 'dsh-selchat-actions';
			dialog.appendChild(actions);

			const cancel = doc.createElement('button');
			cancel.type = 'button';
			cancel.className = 'dsh-selchat-btn';
			cancel.textContent = t.cancel;
			const confirm = doc.createElement('button');
			confirm.type = 'button';
			confirm.className = 'dsh-selchat-btn dsh-selchat-btn-danger';
			confirm.textContent = t.delete;
			actions.appendChild(cancel);
			actions.appendChild(confirm);

			let busy = false;
			const onKeyDown = (event) => {
				if (busy) return;
				if (event.key === 'Escape') {
					if (event.preventDefault) event.preventDefault();
					if (event.stopPropagation) event.stopPropagation();
					close();
				}
			};
			const close = () => {
				if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKeyDown, true);
				if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
			};

			cancel.addEventListener('click', () => {
				if (!busy) close();
			});
			backdrop.addEventListener('pointerdown', (event) => {
				if (event.target === backdrop && !busy) close();
			});
			confirm.addEventListener('click', async () => {
				if (busy) return;
				busy = true;
				confirm.disabled = true;
				cancel.disabled = true;
				confirm.textContent = t.deleting;
				errorNode.textContent = '';
				try {
					await deletePath(target.sessionId, path);
					close();
					notify(doc, win, t.deleted(name), true);
				} catch (error) {
					busy = false;
					confirm.disabled = false;
					cancel.disabled = false;
					confirm.textContent = t.delete;
					const message = String((error && error.message) || error);
					errorNode.textContent = `${t.deleteFailed}：${message}`;
				}
			});

			doc.addEventListener('keydown', onKeyDown, true);
			doc.body.appendChild(backdrop);
			if (typeof cancel.focus === 'function') cancel.focus();
		}

		/**
		 * Register the 删除 provider for one menu target kind. The item only appears
		 * for a workspace-relative path owned by a Session; everything else (the
		 * root row, an unresolvable target) yields no action at all.
		 */
		function registerDeleteMenu(ctx, kind) {
			const menus = acquireContextMenus(ctx);
			if (!menus) return null;
			const disposer = ctx.effect(
				() =>
					menus.register({
						id: `add-selection-to-chat.delete-${kind}`,
						target: kind,
						order: DELETE_MENU_ORDER,
						// The registry may re-resolve on its own observation signals; a
						// throw here would be swallowed and the item would simply vanish.
						resolve: (target) => {
							try {
								return resolveDeleteActions(target, kind);
							} catch (error) {
								if (typeof console !== 'undefined') {
									console.error(`[add-selection-to-chat] delete ${kind} resolve failed:`, error);
								}
								return [];
							}
						},
					}),
				`add-selection-to-chat: delete ${kind} menu`,
			);
			if (typeof console !== 'undefined') {
				console.info(`[add-selection-to-chat] delete ${kind} registered (disposer=${typeof disposer})`);
			}
			return disposer;
		}

		/**
		 * The actual item list for one delete target. Sync and total: a failure must
		 * cost the item, never the rest of the menu or a toast from inside resolve.
		 */
		function resolveDeleteActions(target, kind) {
			const value = target || {};
			const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
			const path = typeof value.path === 'string' ? value.path : '';
			if (!sessionId || !isDeletableTargetPath(path)) return [];
			const t = copy();
			return [
				{
					id: 'delete',
					label: kind === 'directory' ? t.deleteFolder : t.deleteFile,
					danger: true,
					// Files sit under the built-in 另存为… and need a divider;
					// folders have no built-in item, so a leading one would be noise.
					separatorBefore: kind === 'file',
					failureLabel: t.deleteFailed,
					run: () => openDeleteDialog(value, kind),
				},
			];
		}

		/**
		 * Register both delete providers against the shell's contextMenus service.
		 * The ctx argument may be any scope that already carries the service (a
		 * plain cordis Context, a guarded facade, or the root ctx after acquire).
		 * Returns true when at least one provider was registered.
		 */
		function installDeleteMenus(ctx) {
			const menus = acquireContextMenus(ctx);
			if (!menus) return false;
			try {
				registerDeleteMenu(ctx, 'file');
			} catch (error) {
				// Keep going: one failed provider must not cost the other.
				try {
					if (typeof console !== 'undefined') console.error('[add-selection-to-chat] delete file provider failed:', error);
				} catch (inner) { /* ignore */ }
			}
			try {
				registerDeleteMenu(ctx, 'directory');
			} catch (error) {
				try {
					if (typeof console !== 'undefined') console.error('[add-selection-to-chat] delete directory provider failed:', error);
				} catch (inner) { /* ignore */ }
			}
			return true;
		}

		/**
		 * Wire up the delete providers. acquireContextMenus tries, in order:
		 *   1. direct property access on ctx (plain cordis Context);
		 *   2. ctx.get('contextMenus') (bypasses a guarded facade's gate);
		 *   3. ctx.inject(['contextMenus'], cb) (child-fiber routing).
		 * If none succeed, a retry loop (every 500 ms for up to 20 s) covers
		 * shells that provide contextMenus after our apply() ran. Every failed
		 * path logs to console.error so a missing item is never invisible.
		 */
		function installDeleteMenuContribution(ctx) {
			const win = window;
			const fail = (detail) => {
				if (typeof console !== 'undefined') {
					console.error('[add-selection-to-chat] delete menu: ' + detail);
				}
			};
			if (installDeleteMenus(ctx)) return;
			// The context-menu plugin may not have provided its service yet.
			// Retry every 500 ms for up to 20 s, then give up loudly.
			if (typeof win.setInterval !== 'function' || typeof win.clearInterval !== 'function') {
				fail('contextMenus not available and no setInterval on window to retry.');
				return;
			}
			const STEP_MS = 500;
			const MAX_MS = 20000;
			let waited = 0;
			const timer = win.setInterval(() => {
				waited += STEP_MS;
				try {
					if (installDeleteMenus(ctx)) {
						win.clearInterval(timer);
						return;
					}
				} catch (error) {
					fail('retry registration threw: ' + (error && error.message ? error.message : error));
				}
				if (waited >= MAX_MS) {
					win.clearInterval(timer);
					fail('giving up: contextMenus never became available after ' + (MAX_MS / 1000) + ' s of retries (tried ctx.inject, ctx.contextMenus, ctx.get). If the shell provides it via a different name, the delete item will not appear.');
				}
			}, STEP_MS);
			if (typeof ctx.effect === 'function') {
				ctx.effect(() => win.clearInterval(timer), 'add-selection-to-chat: delete menu cleanup');
			}
			fail('contextMenus not available yet; retrying every ' + (STEP_MS / 1000) + ' s for up to ' + (MAX_MS / 1000) + ' s.');
		}

		// ---- wiring ---------------------------------------------------------------

		function contextMenuHandler(state, ctx, win, doc) {
			return function onContextMenu(event) {
				if (state.menu) closeMenu(state);
				const body = previewBodyOf(event.target);
				if (!body) return;

				const read = readSelection(body, win);
				const fresh = read || (
					state.cached && state.cached.body === body && Date.now() - state.cached.at < SELECTION_TTL_MS
						? state.cached
						: null
				);
				if (!fresh) return;
				const path = read ? previewLabel(body) : fresh.path || '';

				// Stop Chromium from raising Electron's native menu for this click.
				if (event.preventDefault) event.preventDefault();
				if (event.stopPropagation) event.stopPropagation();
				openMenu(state, ctx, win, doc, event, { text: fresh.text, lineRange: fresh.lineRange || null }, path);
			};
		}

		function selectionChangeHandler(state, win) {
			return function onSelectionChange() {
				const selection = win.getSelection ? win.getSelection() : null;
				if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);
				const container = range.commonAncestorContainer;
				const body = previewBodyOf(container) || (container && container.nodeType === 1 ? previewBodyOf(container) : null);
				if (!body) return;
				const read = readSelection(body, win);
				if (!read) return;
				state.cached = { body, ...read, path: previewLabel(body), at: Date.now() };
			};
		}

		function start(ctx) {
			const win = window;
			const doc = win.document;
			// Boot probe: tells us (a) the new bundle is actually loaded, (b)
			// apply() reached start(), and (c) which service surface the host
			// gave us. Remove once the delete menu is confirmed working.
			if (typeof console !== 'undefined') {
				try {
					console.info('[add-selection-to-chat] start():', {
						hasInject: typeof ctx.inject === 'function',
						hasGet: typeof ctx.get === 'function',
						hasContextMenusProp: (function () {
							try { return typeof ctx.contextMenus; } catch (e) { return 'throw:' + e.message; }
						})(),
						hasEffect: typeof ctx.effect === 'function',
					});
				} catch (probeError) { /* never let the probe break the menu */ }
			}
			if (!doc || typeof doc.addEventListener !== 'function') return;
			if (win.__dshAddSelectionToChat) return;
			win.__dshAddSelectionToChat = true;

			const state = { menu: null, cached: null, offMenuKeys: null };
			const onContextMenu = contextMenuHandler(state, ctx, win, doc);
			const onSelectionChange = selectionChangeHandler(state, win);

			const dispose = () => {
				closeMenu(state);
				win.removeEventListener('contextmenu', onContextMenu, true);
				doc.removeEventListener('selectionchange', onSelectionChange, true);
			};

			win.addEventListener('contextmenu', onContextMenu, true);
			doc.addEventListener('selectionchange', onSelectionChange, true);

			if (typeof ctx.effect === 'function') {
				ctx.effect(() => dispose, 'add-selection-to-chat: preview menu');
			}

			// The file-tree menu is a separate capability: it dies with this plugin,
			// and its absence must not cost the preview menu above.
			try {
				installDeleteMenuContribution(ctx);
			} catch (error) {
				if (typeof console !== 'undefined') console.error('[add-selection-to-chat] delete menu failed:', error);
			}

			// Second boot log: how the contextMenus acquire actually went.
			// lastAcquireTrace is set by acquireContextMenus on its last attempt.
			if (typeof console !== 'undefined') {
				try {
					console.info('[add-selection-to-chat] contextMenus acquire:', lastAcquireTrace || '(not attempted)');
				} catch (probeError) { /* never let the probe break the menu */ }
			}
		}

		/**
		 * Required client services: the Session catalog, the composer action
		 * face, and the contextMenus service (shell-provided by
		 * @deepseek-ai/dsh-client-ui-context-menu). Declaring `contextMenus`
		 * here is what lets the guarded facade answer `ctx.contextMenus` —
		 * without it the property read throws "cannot get property
		 * 'contextMenus' without inject" and no delete item can register.
		 * file-actions does exactly this for its 另存为… items.
		 */
		const inject = ["sessions", "conversation", "contextMenus"];

		/**
		 * Client plugin body. Never throws into the shell: a failure here should
		 * cost the menu, not the UI.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			try {
				start(ctx);
			} catch (error) {
				if (typeof console !== 'undefined') console.error('[add-selection-to-chat] apply failed:', error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		// Exposed for the offline smoke test; unused by the shell.
		exports.__internals = {
			composerTarget,
			probeComposer,
			insertSelection,
			cleanText,
			previewBodyOf,
			composePayload,
			lineRangeOf,
			workspaceRootOf,
			workspaceRelativePath,
			isDeletableTargetPath,
			deletePath,
			openDeleteDialog,
			installDeleteMenus,
			DELETE_ROUTE,
		};
		return module.exports;
	},
});
