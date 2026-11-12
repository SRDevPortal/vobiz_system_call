"""Button-requested hangup and local reset, independent of provider confirmation."""
import json
from functools import partial

import frappe
from frappe import _
from vobiz_system_call.api import lifecycle


def ready(row):
    data = lifecycle.context(row)
    return bool(row.status in lifecycle.TERMINAL and
                (data.get("manual_local_reset") or (row.get("end_time") and data.get("complete_verified_end"))))


def own_call(name):
    if frappe.session.user == "Guest":
        frappe.throw(_("Login required."))
    mapping = lifecycle.lock_mapping(frappe.session.user)
    row = frappe.get_doc("Vobiz Call Log", name, for_update=True)
    if row.user != frappe.session.user:
        frappe.throw(_("Not permitted."))
    if not lifecycle.is_browser_call(row):
        frappe.throw(_("Local reset is only available for browser calls."))
    if mapping.current_call_log and mapping.current_call_log != row.name:
        frappe.throw(_("Another call is now active. Refresh before continuing."))
    if row.status not in lifecycle.TERMINAL and mapping.current_call_log != row.name:
        frappe.throw(_("This is no longer your current call. Refresh and try again."))
    return mapping, row


def check_completion(name):
    """Attempt hangup once, then release locally without awaiting confirmation."""
    from vobiz_system_call.api import completion_provider as provider
    mapping, row = own_call(name)
    if provider.prepare(row):
        snapshot = dict(row)
        frappe.db.commit()  # Keep the reservation, but no locks over network I/O.
        outcome = provider.attempt_inline(snapshot)
        # Callbacks or another tab may have changed the mapping while we waited.
        mapping, row = own_call(name)
        provider.record_inline(row, outcome)
    data = lifecycle.context(row)
    if not data.get("manual_local_reset"):
        data["manual_local_reset"] = {"at": frappe.utils.now(), "user": frappe.session.user}
        data["agent_cancelled"] = True
        data.setdefault("agent_cancel_requested_at", frappe.utils.now())
        # Keep real final outcomes; an unfinished attempt is locally cancelled.
        # Do not fabricate provider end_time, answer_time, billing, or hangup cause.
        status = row.status if row.status in lifecycle.TERMINAL else "Cancelled"
        values = {"request_json": json.dumps(data), "status": status, "call_status": "agent-local-reset"}
        frappe.db.set_value("Vobiz Call Log", row.name, values)
        row.update(values)
    if mapping.current_call_log == row.name:
        values = {"current_call_log": ""}
        # Explicit reset releases Busy even if auto-availability/presence is stale.
        # An intentional break/offline choice is preserved.
        if mapping.availability_status == "Busy":
            values.update(availability_status="Available", accept_calls=1, last_status_at=frappe.utils.now_datetime())
        frappe.db.set_value("Vobiz User Mapping", mapping.name, values)
    from vobiz_click_to_call.services.realtime import publish_call_disconnected
    publish_call_disconnected(row)
    provider_status = row.get("completion_provider_status") or "Pending"
    result = {"name": row.name, "status": row.status, "end_time": row.get("end_time"),
              "local_reset": True, "verified_end": provider_status == "Confirmed", "pending_provider": False,
              "provider_confirmation": provider_status,
              "provider_hangup": provider.state(row).get("inline_result", "unconfirmed"),
              "retry_allowed": bool(row.direction == "Outgoing" and not data.get("retry_of")
                                    and not data.get("retry_call_log")),
              "reference_doctype": row.reference_doctype, "reference_name": row.reference_name}
    if provider_status == "Pending":
        frappe.db.after_commit.add(partial(provider.enqueue, row.name))
    frappe.db.commit()
    return result


def verify_completion(call_log):
    from vobiz_system_call.api.completion_provider import verify
    return verify(call_log)


def lock_retry(name, doctype, reference, number):
    # start_call holds the agent mapping lock through linking and commit.
    row = frappe.get_doc("Vobiz Call Log", name, for_update=True)
    data = lifecycle.context(row)
    if row.user != frappe.session.user:
        frappe.throw(_("Not permitted."))
    if not ready(row) or not lifecycle.is_browser_call(row) or row.direction != "Outgoing":
        frappe.throw(_("Reset the previous call before retrying."))
    if data.get("retry_of") or data.get("retry_call_log"):
        frappe.throw(_("The single retry for this call has already been used."))
    if (row.reference_doctype != doctype or row.reference_name != reference
            or row.customer_number != number):
        frappe.throw(_("Retry must use the original customer and number."))
    return row


def link_retry(previous, new_call):
    data = lifecycle.context(previous)
    data["retry_call_log"] = new_call.name
    frappe.db.set_value("Vobiz Call Log", previous.name, "request_json", json.dumps(data))
    data = lifecycle.context(new_call)
    data["retry_of"] = previous.name
    new_call.request_json = json.dumps(data)
