# Compatibility body for:
# Temporary Restore Complete Call - Agent Own Call
# API Method: vobiz_system_call.api.call.complete_call_log
# Apply ONLY after deploying the app, migrating the site and reloading workers.
# Keep Allow Guest OFF. The new app endpoint validates ownership and current call.

if frappe.request.method != "POST":
    frappe.throw("Use POST to complete a call.", frappe.PermissionError)

frappe.response["message"] = frappe.call(
    "vobiz_system_call.api.call.complete_call_from_button",
    call_log=frappe.form_dict.get("call_log"),
)
