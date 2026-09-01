frappe.provide('vobiz_system_call');

vobiz_system_call.open_console = function() {
	frappe.set_route('vobiz-agent-console');
};
