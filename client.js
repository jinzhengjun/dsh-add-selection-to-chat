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
}`;

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
		 *     campus.html（第 11-17 行）
		 *     <selected text>
		 *
		 * The header names the file and its 1-based source range. Without a name
		 * (no preview header) or without line markup (Markdown bodies) the header
		 * degrades field by field; a header that would carry no information at all
		 * is dropped rather than emitting a bare fragment.
		 */
		function composePayload(path, text, lineRange) {
			const name = fileNameOf(path);
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
				const outcome = insertSelection(ctx, doc, composePayload(path, text, lineRange));
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
		}

		/** Required client services: the Session catalog and the composer action face. */
		const inject = ["sessions", "conversation"];

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
		exports.__internals = { composerTarget, probeComposer, insertSelection, cleanText, previewBodyOf, composePayload, lineRangeOf };
		return module.exports;
	},
});
