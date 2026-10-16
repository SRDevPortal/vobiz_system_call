# Server Script type: API
# API Method: vobiz_system_call.api.call.complete_call_log
# Allow Guest: OFF
# Temporary override. Disable after deploying the restored app method.
# Log-only completion; this does not hang up a provider call.
user = frappe.session.user
call_name = frappe.form_dict.get("call_log")
if user == "Guest" or not call_name:
    frappe.throw("Login and a call log are required.")

mapping_name = frappe.db.get_value(
    "Vobiz User Mapping", {"user": user, "enabled": 1}, "name"
)
if not mapping_name:
    frappe.throw("No active Vobiz user mapping found.")

# Use the same lock order as call startup: mapping, then call log.
mapping = frappe.get_doc("Vobiz User Mapping", mapping_name, for_update=True)
if mapping.user != user or not mapping.enabled:
    frappe.throw("No active Vobiz user mapping found.")
doc = frappe.get_doc("Vobiz Call Log", call_name, for_update=True)
if doc.user != user:
    frappe.throw("Not permitted.")

terminal = ("Completed", "Failed", "Busy", "No Answer", "Cancelled", "Canceled")
if doc.status not in terminal:
    if mapping.current_call_log != doc.name:
        frappe.throw("This is no longer your current call. Refresh and try again.")
    doc.status = "Completed"
    doc.save(ignore_permissions=True)

if mapping.current_call_log == doc.name:
    # The normal availability API schedules final-log recovery. Its worker checks
    # browser presence, auto-availability and the exact current-call reservation.
    # Keep Busy until that worker decides; never overwrite Offline/Break here.
    frappe.call("vobiz_click_to_call.api.call.get_my_availability")

frappe.response["message"] = {"name": doc.name, "status": doc.status}
