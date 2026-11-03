"""Bounded call diagnostics. No phone numbers, SIP headers, or error text."""
import json
import logging

import frappe

ORIGINS = {"manual_button", "manual_autodial_stop", "media_timeout", "startup_failure", "legacy_unspecified"}


def evidence(value):
    try:
        value = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return {}
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in ("online", "registered", "in_call", "media_connected"):
        if isinstance(value.get(key), bool):
            result[key] = value[key]
    for key in ("http_status", "media_lost_ms"):
        if isinstance(value.get(key), (int, float)) and not isinstance(value[key], bool):
            try:
                result[key] = min(86400000, max(0, int(value[key])))
            except (ValueError, OverflowError):
                pass
    if value.get("exception") in ("ValidationError", "AuthenticationError", "PermissionError",
                                   "SessionExpired", "TimestampMismatchError"):
        result["exception"] = value["exception"]
    return result


def cancellation_context(context, origin=None, details=None):
    data = dict(context)
    data["agent_cancelled"] = True  # Legacy compatibility; origin identifies automation.
    data.setdefault("agent_cancel_requested_at", frappe.utils.now())
    data.setdefault("cancel_origin", origin if isinstance(origin, str) and origin in ORIGINS else "legacy_unspecified")
    data.setdefault("cancel_diagnostics", evidence(details))
    return data


@frappe.whitelist(methods=["POST"])
def record_browser_diagnostic(call_log: str, event: str, details=None):
    if frappe.session.user == "Guest":
        frappe.throw("Login required.", frappe.AuthenticationError)
    if event not in ("heartbeat_rejected", "heartbeat_failed", "media_timeout"):
        frappe.throw("Unsupported diagnostic event.")
    owner = frappe.db.get_value("Vobiz Call Log", call_log, "user")
    if not owner or owner != frappe.session.user:
        frappe.throw("Not permitted.", frappe.PermissionError)
    # Atomic bound, including clients which ignore their own throttle.
    cache = frappe.cache()
    key = cache.make_key("vsc:diagnostic:" + owner + ":" + event)
    if not cache.set(key, "1", nx=True, ex=30):
        return {"recorded": False}
    logger = frappe.logger("vobiz_browser", allow_site=True, max_size=2_000_000, file_count=10)
    logger.setLevel(logging.INFO)
    logger.info(frappe.as_json({
        "event": event, "call_log": call_log, "user": owner,
        "at": frappe.utils.now(), "details": evidence(details),
    }))
    return {"recorded": True}
