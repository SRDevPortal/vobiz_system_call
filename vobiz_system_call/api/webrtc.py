from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode
from xml.sax.saxutils import escape, quoteattr

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit
from werkzeug.wrappers import Response

from vobiz_ai.api.call_log import sync_linked_summaries
from vobiz_click_to_call.api.call import get_user_mapping, mark_mapping_busy, restore_mapping_after_call
from vobiz_click_to_call.services.debug_log import log_vobiz_event
from vobiz_click_to_call.services.disposition import update_reference_call_metrics
from vobiz_click_to_call.services.numbers import normalize_phone_number, provider_phone_number
from vobiz_click_to_call.services.settings import get_default_country_code, get_settings as get_core_settings
from vobiz_system_call.api.settings import (
    CALL_DEVICE_BROWSER_SOFTPHONE,
    get_browser_softphone_registrar,
    get_browser_softphone_sdk_url,
    get_call_device,
    get_caller_id,
    get_inbound_callback_token,
    get_profile_endpoint_uri,
    get_profile_password,
    get_settings,
    get_system_call_profile,
    get_webhook_base_url,
    is_enabled,
)

ACTIVE_BROWSER_STATUSES = ("Initiated", "Queued", "Ringing", "Customer Answered", "Connected", "In Progress")
TERMINAL_EVENTS = {"onCallTerminated", "onCallFailed", "hangup", "failed", "terminated"}
TERMINAL_BROWSER_STATUSES = {"Completed", "Failed", "Busy", "No Answer", "Cancelled", "Canceled"}


@frappe.whitelist()
def get_browser_softphone_config() -> dict[str, Any]:
    if frappe.session.user == "Guest":
        frappe.throw(_("Login required."))

    settings = get_settings()
    profile = get_system_call_profile(frappe.session.user)
    core_mapping = get_user_mapping(frappe.session.user) or {}
    if not profile:
        return {"enabled": False, "reason": _("No active Vobiz user mapping found.")}

    enabled = is_enabled(settings) and get_call_device(settings) == CALL_DEVICE_BROWSER_SOFTPHONE
    username = (profile.get("browser_softphone_username") or "").strip()
    endpoint_uri = get_profile_endpoint_uri(profile, settings)
    password = get_profile_password(profile.get("name"))

    missing = []
    if enabled and not frappe.utils.cint(profile.get("browser_softphone_enabled", 1)):
        missing.append(_("Browser Softphone Enabled"))
    if enabled and not username:
        missing.append(_("Browser Softphone Username"))
    if enabled and not password:
        missing.append(_("Browser Softphone Password"))

    return {
        "enabled": enabled and not missing,
        "configured": not missing,
        "missing": missing,
        "call_device": get_call_device(settings),
        "sdk_url": get_browser_softphone_sdk_url(settings),
        "registrar": get_browser_softphone_registrar(settings),
        "username": username,
        "password": password,
        "endpoint_uri": endpoint_uri,
        "caller_id": get_caller_id(settings, profile, core_mapping),
        "answer_url": browser_softphone_answer_url(settings),
    }


@frappe.whitelist()
def update_browser_softphone_call(
    call_log: str,
    event: str,
    status: str | None = None,
    reason: str | None = None,
    call_uuid: str | None = None,
) -> dict[str, Any]:
    if frappe.session.user == "Guest":
        frappe.throw(_("Login required."))
    if not call_log:
        frappe.throw(_("Call log not found."))

    row = frappe.db.get_value(
        "Vobiz Call Log",
        call_log,
        ["name", "user", "status", "reference_doctype", "reference_name"],
        as_dict=True,
    )
    if not row:
        frappe.throw(_("Call log not found."))
    if "System Manager" not in frappe.get_roles() and row.user != frappe.session.user:
        frappe.throw(_("Not permitted."))

    event = (event or "").strip()
    status = (status or "").strip()
    reason = (reason or "").strip()
    now = frappe.utils.now()
    updates = {}
    is_terminal_event = event in TERMINAL_EVENTS
    if call_uuid:
        updates["call_uuid"] = call_uuid
    if event:
        updates["event"] = event
    if status or event:
        updates["call_status"] = status or event
    if event == "onCallRemoteRinging":
        updates["status"] = "Ringing"
    elif event == "onCallAnswered":
        updates["status"] = "Connected"
        if not frappe.db.get_value("Vobiz Call Log", call_log, "answer_time"):
            updates["answer_time"] = now
    elif is_terminal_event:
        if not frappe.db.get_value("Vobiz Call Log", call_log, "end_time"):
            updates["end_time"] = now
        if reason:
            updates["hangup_cause"] = reason
        updates["status"] = _terminal_status(row.status, event, reason)
    if reason and event == "onCallFailed":
        updates["error_message"] = reason

    if updates:
        _set_call_log_values(call_log, updates, skip_if_terminal=not is_terminal_event)
    _append_callback_if_enabled(
        call_log,
        f"vobiz_system_call:{event or status or 'event'}",
        {"event": event, "status": status, "reason": reason, "call_uuid": call_uuid},
    )
    latest_status = frappe.db.get_value("Vobiz Call Log", call_log, "status") or updates.get("status") or row.status
    if latest_status in TERMINAL_BROWSER_STATUSES:
        restore_mapping_after_call(call_log)
        update_reference_call_metrics(row.reference_doctype, row.reference_name)
        doc = frappe.get_doc("Vobiz Call Log", call_log)
        sync_linked_summaries(doc)
    else:
        mapping = get_user_mapping(row.user)
        if mapping:
            mark_mapping_busy(mapping["name"], call_log)
    frappe.db.commit()
    return {"status": latest_status}


@frappe.whitelist(allow_guest=True, methods=["GET", "POST"])
@rate_limit(limit=600, seconds=60)
def answer(token: str | None = None):
    if not _valid_public_token(token):
        return _plain_response("Not permitted.", status=403)

    payload = _request_params()
    event = payload.get("Event") or payload.get("event") or ""
    if event == "Hangup":
        return _xml_response(_empty_xml())

    raw_from = payload.get("From") or payload.get("from") or ""
    raw_to = payload.get("To") or payload.get("to") or ""
    route_type = (payload.get("RouteType") or payload.get("routeType") or "").lower()
    is_sdk_call = raw_from.startswith("sip:") or route_type == "sip"

    if is_sdk_call:
        return _answer_sdk_outbound(raw_from, raw_to, payload)
    return _answer_pstn_inbound(raw_from, raw_to, payload)


def browser_softphone_answer_url(settings=None) -> str:
    settings = settings or get_settings()
    params = {}
    token = get_inbound_callback_token(settings)
    if token:
        params["token"] = token
    query = f"?{urlencode(params)}" if params else ""
    return f"{get_webhook_base_url(settings)}/api/method/vobiz_click_to_call.api.webrtc.answer{query}"


def _answer_sdk_outbound(raw_from: str, raw_to: str, payload: dict[str, Any]):
    username = _sip_username(raw_from)
    destination = _destination_number(raw_to)
    if not destination:
        return _xml_response(_hangup_xml())

    call_log = _find_prepared_browser_call(username, destination)
    caller_id = ""
    if call_log:
        row = frappe.db.get_value("Vobiz Call Log", call_log, ["caller_id", "did_number"], as_dict=True) or {}
        caller_id = row.get("caller_id") or row.get("did_number") or ""
        _set_call_log_values(
            call_log,
            {
                "status": "Ringing",
                "call_status": "vobiz-system-call-answer-url",
                "to_number": destination,
                "from_number": raw_from,
            },
            skip_if_terminal=True,
        )
        _append_callback_if_enabled(call_log, "vobiz_system_call_answer", payload)
        frappe.db.commit()
    if not caller_id:
        caller_id = _caller_id_for_endpoint(username)

    log_vobiz_event(
        "Vobiz System Call answer URL bridged outbound call",
        call_log=call_log,
        payload={"username": username, "destination": destination, "caller_id": caller_id},
    )
    return _xml_response(_dial_number_xml(destination, caller_id))


def _answer_pstn_inbound(raw_from: str, raw_to: str, payload: dict[str, Any]):
    endpoint_uri = _endpoint_for_did(raw_to)
    caller_id = provider_phone_number(raw_to) if raw_to else ""
    if not endpoint_uri:
        return _xml_response(_hangup_xml())
    log_vobiz_event(
        "Vobiz System Call answer URL routed inbound call",
        payload={"from": raw_from, "to": raw_to, "endpoint_uri": endpoint_uri},
    )
    return _xml_response(_dial_user_xml(endpoint_uri, caller_id))


def _find_prepared_browser_call(username: str, destination: str) -> str | None:
    if not username:
        return None
    user = frappe.db.get_value(
        "Vobiz User Mapping",
        {"browser_softphone_username": username, "enabled": 1},
        "user",
    )
    if not user:
        return None
    default_country_code = get_default_country_code(get_core_settings())
    normalized_destination = normalize_phone_number(destination, default_country_code=default_country_code)
    destination_candidates = {
        value
        for value in (normalized_destination, provider_phone_number(normalized_destination), destination)
        if value
    }
    filters = {
        "source_app": "vobiz_click_to_call",
        "user": user,
        "direction": "Outgoing",
        "status": ["in", ACTIVE_BROWSER_STATUSES],
    }
    if destination_candidates:
        filters["normalized_customer_number"] = ["in", list(destination_candidates)]
    rows = frappe.get_all("Vobiz Call Log", filters=filters, fields=["name"], order_by="creation desc", limit=1)
    return rows[0].name if rows else None


def _caller_id_for_endpoint(username: str) -> str:
    if not username:
        return ""
    profile_name = frappe.db.get_value(
        "Vobiz User Mapping",
        {"browser_softphone_username": username, "enabled": 1},
        "name",
    )
    settings = get_settings()
    if not profile_name:
        return get_caller_id(settings, {}, {})
    profile = frappe.db.get_value("Vobiz User Mapping", profile_name, ["caller_id"], as_dict=True) or {}
    mapping = get_user_mapping(frappe.db.get_value("Vobiz User Mapping", profile_name, "user")) or {}
    return get_caller_id(settings, profile, mapping)


def _endpoint_for_did(did: str) -> str:
    normalized_did = normalize_phone_number(did, default_country_code=get_default_country_code(get_core_settings()))
    filters = {"enabled": 1, "browser_softphone_enabled": 1}
    if normalized_did:
        filters["caller_id"] = normalized_did
    rows = frappe.get_all(
        "Vobiz User Mapping",
        filters=filters,
        fields=["name", "browser_softphone_endpoint_uri", "browser_softphone_username"],
        order_by="modified desc",
        limit=1,
    )
    if not rows:
        return ""
    return get_profile_endpoint_uri(rows[0], get_settings())


def _terminal_status(previous: str, event: str, reason: str) -> str:
    if event == "onCallFailed":
        text = (reason or "").lower()
        if "busy" in text:
            return "Busy"
        if "no answer" in text or "timeout" in text:
            return "No Answer"
        return "Failed"
    if previous == "Connected":
        return "Completed"
    return "Cancelled"


def _request_params() -> dict[str, Any]:
    params = dict(frappe.form_dict or {})
    try:
        if frappe.request and frappe.request.is_json:
            params.update(frappe.request.get_json(silent=True) or {})
    except Exception:
        pass
    return params


def _valid_public_token(token: str | None) -> bool:
    expected = get_inbound_callback_token(get_settings())
    return not expected or expected == (token or frappe.form_dict.get("token") or "")


def _append_callback_if_enabled(call_log: str, event: str, payload: dict[str, Any]) -> None:
    try:
        if not get_core_settings().store_raw_payloads:
            return
        frappe.enqueue(
            "vobiz_ai.api.call_log.append_callback",
            queue="short",
            timeout=120,
            enqueue_after_commit=True,
            kwargs={"call_log": call_log, "event": event, "payload": payload},
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "Vobiz System Call callback append failed")


def _set_call_log_values(call_log: str, values: dict[str, Any], *, skip_if_terminal: bool) -> None:
    if not values:
        return
    if not skip_if_terminal:
        frappe.db.set_value("Vobiz Call Log", call_log, values, update_modified=True)
        return

    values = dict(values)
    values["modified"] = frappe.utils.now()
    values["modified_by"] = frappe.session.user or "Guest"
    assignments = ", ".join(f"`{field}` = %s" for field in values)
    terminal_placeholders = ", ".join(["%s"] * len(TERMINAL_BROWSER_STATUSES))
    frappe.db.sql(
        f"""
        update `tabVobiz Call Log`
        set {assignments}
        where name = %s
            and ifnull(status, '') not in ({terminal_placeholders})
        """,
        [*values.values(), call_log, *TERMINAL_BROWSER_STATUSES],
    )


def _sip_username(value: str) -> str:
    value = (value or "").strip()
    if value.startswith("sip:"):
        value = value[4:]
    return value.split("@", 1)[0].strip()


def _destination_number(value: str) -> str:
    value = (value or "").strip()
    if value.startswith("sip:"):
        value = value[4:].split("@", 1)[0]
    return value if value.startswith("+") else f"+{value}" if value else ""


def _dial_number_xml(destination: str, caller_id: str) -> str:
    caller_attr = f" callerId={quoteattr(provider_phone_number(caller_id))}" if caller_id else ""
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<Response>"
        f"<Dial{caller_attr}>"
        f"<Number>{escape(provider_phone_number(destination))}</Number>"
        "</Dial>"
        "</Response>"
    )


def _dial_user_xml(endpoint_uri: str, caller_id: str) -> str:
    caller_attr = f" callerId={quoteattr(provider_phone_number(caller_id))}" if caller_id else ""
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<Response>"
        f"<Dial{caller_attr} timeout=\"30\">"
        f"<User>{escape(endpoint_uri)}</User>"
        "</Dial>"
        "</Response>"
    )


def _hangup_xml() -> str:
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup /></Response>"


def _empty_xml() -> str:
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>"


def _xml_response(xml: str):
    return Response(xml, content_type="text/xml; charset=utf-8")


def _plain_response(text: str, status: int = 200):
    return Response(text, status=status, content_type="text/plain; charset=utf-8")
