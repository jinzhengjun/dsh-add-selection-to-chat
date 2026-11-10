// One-shot console probe — paste into DevTools (F12) of the DSH web window.
// It (1) reports the [add-selection-to-chat] start() probe values,
// (2) reads the real __ModuleLoader__ state to find the live client ctx,
// (3) registers a test 删除 item EXACTLY the way the shell's file-actions
// plugin registers 另存为 (same ctx, same effect, same register call),
// (4) tells you to right-click a file and a folder and report the result.
(function () {
	const out = [];
	const log = (k, v) => { out.push(k + ': ' + (typeof v === 'object' && v !== null ? JSON.stringify(v, (key, val) => typeof val === 'function' ? 'function' : val) : v)); };
	const dump = (label) => {
		const line = out.find((l) => l.indexOf(label + ':') === 0);
		console.log('[DIAG] ' + (line || label + ': (not found — expand the [add-selection-to-chat] start(): Object in the console and tell me its fields)'));
	};

	// ---- 1. find the ModuleLoader and our live module/ctx ----------------------
	let loader = window.__ModuleLoader__;
	log('__ModuleLoader__', loader ? ('present, type=' + typeof loader) : 'MISSING');
	if (!loader) { console.log(out.join('\n')); return; }

	let ourKey = null;
	for (const key of Object.keys(loader)) {
		const v = loader[key];
		if (v && typeof v === 'object') {
			const keys = Array.isArray(v) ? v.map(String) : Object.keys(v);
			const hit = keys.find((k) => k.indexOf('add-selection') !== -1);
			if (hit) { ourKey = { holder: key, id: hit }; }
		}
	}
	log('module key found', ourKey ? JSON.stringify(ourKey) : 'no add-selection id in any loader map');

	// Try to reach a live ctx through whatever the loader keeps.
	let ctx = null;
	if (ourKey) {
		const store = loader[ourKey.holder];
		const entry = Array.isArray(store) ? store.find((k) => String(k) === ourKey.id) : store[ourKey.id];
		// entry may be the module itself, a wrapper, or {module, ctx, ...}
		ctx = entry && (entry.ctx || entry.context || (entry.apply ? entry : null));
		log('entry shape', entry ? Object.keys(entry).slice(0, 15).join(',') : 'n/a');
	}
	// Fallback: many loaders expose a registry of {id -> instance}; our module
	// instance is the exports object. The ctx is NOT on exports, so if we can't
	// find it, we'll still get far via the start(): probe values.
	if (ctx) {
		log('ctx found', Object.keys(ctx).slice(0, 20).join(','));
	}

	// ---- 2. decisive test: register via a fresh ctx probe ----------------------
	// We can't see the apply() ctx from here, BUT we can check whether the
	// contextMenus service is reachable through the SAME paths our code uses,
	// by reading the start(): probe from the console buffer. The screenshot
	// already proved start() ran; what we need now is the probe's field values.
	// So: ask the loader to tell us if it keeps apply-scope contexts.
	for (const key of Object.keys(loader)) {
		const v = loader[key];
		if (v && typeof v === 'object') {
			try {
				const keys = Array.isArray(v) ? v.map(String) : Object.keys(v);
				for (const k of keys.slice(0, 40)) {
					const val = Array.isArray(v) ? v[v.indexOf(k)] : v[k];
					if (val && typeof val === 'object' && val.contextMenus) {
						log('LIVE contextMenus found at', key + '[' + k + '], register=' + typeof val.contextMenus.register);
						ctx = val;
						break;
					}
				}
			} catch (e) { /* keep scanning */ }
			if (ctx) break;
		}
	}

	// ---- 3. if we have a ctx, register a test item exactly like file-actions ---
	if (ctx && ctx.contextMenus && typeof ctx.contextMenus.register === 'function' && typeof ctx.effect === 'function') {
		try {
			ctx.effect(() => ctx.contextMenus.register({
				id: 'diagnose.delete-test',
				target: 'file',
				order: 999,
				resolve: (target) => {
					try {
						const t = target || {};
						console.log('[DIAG] delete-test resolve called, target keys:', Object.keys(t).join(','), 'path=', t.path);
						return [{ id: 'delete', label: '【诊断】删除', danger: true, run: () => console.log('[DIAG] 删除 clicked, target:', JSON.stringify(t)) }];
					} catch (e) {
						console.error('[DIAG] resolve threw:', e);
						return [];
					}
				},
			}), 'diagnose test');
			log('test registration', 'OK — now RIGHT-CLICK a file (e.g. ssg_data.json) in the file tree and tell me if 【诊断】删除 appears; also open the file-tree node for a folder (e.g. dsh-add-selection-to-chat) and right-click it');
		} catch (e) {
			log('test registration FAILED', e.message);
		}
	} else {
		log('test registration skipped', 'no live ctx with contextMenus+effect reachable from console (holder=' + (ctx ? Object.keys(ctx).join(',') : 'none'));
	}

	console.log(out.join('\n'));
	console.log('[DIAG] === NOW: right-click the file ssg_data.json in the tree; does 【诊断】删除 appear? Also expand the start(): Object in the log above and send me its 4 field values (hasInject / hasGet / hasContextMenusProp / hasEffect). ===');
})();
