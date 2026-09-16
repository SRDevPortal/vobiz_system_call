frappe.provide('vobiz_system_call');

// A tab keeps its identity in sessionStorage. Duplicate Tab copies that storage,
// so reserve the identity with a document-lifetime Web Lock before using it.
// Reload releases the old document's lock; a second live tab gets a new identity.
if (!vobiz_system_call.get_softphone_window) {
	const windows = Object.create(null);
	vobiz_system_call.get_softphone_window = function() {
		const user = (frappe.session || {}).user || ((frappe.boot || {}).user || {}).name || 'Guest';
		if (windows[user]) return windows[user];
		const state = windows[user] = {id: null};
		const key = 'vobiz-softphone-window-id:' + user;
		const ticketKey = key + ':reload';
		const uuid = () => window.crypto && window.crypto.randomUUID
			? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const valid = value => /^[A-Za-z0-9_-]{8,100}$/.test(value || '');
		let saved, ticket, legacy, reload = false;
		try {
			saved = window.sessionStorage.getItem(key);
			ticket = window.sessionStorage.getItem(ticketKey);
			window.sessionStorage.removeItem(ticketKey);
			legacy = window.sessionStorage.getItem('vobiz_agent_console_tab_id');
			reload = window.performance.getEntriesByType('navigation')[0].type === 'reload';
		} catch (_) {}
		const remember = id => {
			state.id = id;
			try { window.sessionStorage.setItem(key, id); } catch (_) {}
		};
		const locks = window.navigator && window.navigator.locks;
		const reserve = id => new Promise((resolve, reject) => {
			locks.request(key + ':' + id, {ifAvailable: true}, lock => {
				if (!lock) { resolve(false); return; }
				remember(id);
				resolve(true);
				return new Promise(release => { state.release = release; });
			}).catch(reject);
		});
		state.ready = (async () => {
			if (locks && typeof locks.request === 'function') {
				let candidate = valid(saved) ? saved : (reload && valid(legacy) ? legacy : uuid());
				if (!await reserve(candidate)) {
					candidate = uuid();
					if (!await reserve(candidate)) throw new Error('Could not reserve a unique softphone window.');
				}
			} else {
				// Without Web Locks, only an exiting document can leave a reload
				// ticket. A live duplicated tab cannot copy a reusable ticket.
				remember(reload && valid(saved) && ticket === saved ? saved : uuid());
				window.addEventListener('pagehide', event => {
					if (event.persisted) return;
					try { window.sessionStorage.setItem(ticketKey, state.id); } catch (_) {}
				});
				window.addEventListener('pageshow', () => {
					try { window.sessionStorage.removeItem(ticketKey); } catch (_) {}
				});
			}
			return state.id;
		})();
		return state;
	};
}

// Frappe also caches Page source in localStorage across browser reloads.
try {
	const key = 'vobiz_system_call_console_version';
	const version = '20260916.5';
	if (window.localStorage.getItem(key) !== version) {
		window.localStorage.removeItem('_page:vobiz-agent-console');
		window.localStorage.setItem(key, version);
	}
} catch (_) {}

vobiz_system_call.open_console = function() {
	frappe.set_route('vobiz-agent-console');
};
