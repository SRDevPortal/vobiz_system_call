frappe.provide('vobiz_system_call');

// Frappe also caches Page source in localStorage across browser reloads.
try {
	const key = 'vobiz_system_call_console_version';
	const version = '20260914.4';
	if (window.localStorage.getItem(key) !== version) {
		window.localStorage.removeItem('_page:vobiz-agent-console');
		window.localStorage.setItem(key, version);
	}
} catch (_) {}

vobiz_system_call.open_console = function() {
	frappe.set_route('vobiz-agent-console');
};
