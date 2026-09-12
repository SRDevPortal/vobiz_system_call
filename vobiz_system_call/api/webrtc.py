from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from urllib.parse import urlencode
from xml.etree import ElementTree
from xml.sax.saxutils import escape, quoteattr

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit
from werkzeug.wrappers import Response

from vobiz_click_to_call.services.numbers import normalize_phone_number, provider_phone_number
from vobiz_click_to_call.services.settings import get_default_country_code
from vobiz_system_call.api import lifecycle
from vobiz_system_call.api.settings import (
    CALL_DEVICE_BROWSER_SOFTPHONE, CALL_DEVICE_MOBILE_BRIDGE, device_enabled, get_browser_softphone_registrar,
    get_browser_softphone_sdk_url, get_call_device, get_caller_id,
    get_inbound_callback_token, get_profile_endpoint_uri, get_profile_password,
    get_settings, get_system_call_profile, get_webhook_base_url, is_enabled,
)

ACTIVE_BROWSER_STATUSES = lifecycle.ACTIVE
TERMINAL_BROWSER_STATUSES = lifecycle.TERMINAL
TERMINAL_EVENTS = {"onCallTerminated", "onCallFailed", "hangup", "failed", "terminated"}


def _browser_enabled():
    settings = get_settings()
    return is_enabled(settings) and get_call_device(settings, get_system_call_profile()) == CALL_DEVICE_BROWSER_SOFTPHONE and device_enabled(CALL_DEVICE_BROWSER_SOFTPHONE, settings)


def _login():
    if frappe.session.user == "Guest":
        frappe.throw(_("Login required."))


@frappe.whitelist()
def get_browser_softphone_config():
    _login()
    settings = get_settings()
    profile = get_system_call_profile()
    enabled = _browser_enabled() and bool(profile and frappe.utils.cint(profile.get("browser_softphone_enabled")))
    if not enabled:
        return {"enabled": False, "configured": False, "call_device": get_call_device(settings, profile)}
    missing = []
    username = (profile.get("browser_softphone_username") or "").strip()
    password = get_profile_password(profile["name"])
    if not username:
        missing.append(_("Browser Softphone Username"))
    if not password:
        missing.append(_("Browser Softphone Password"))
    if not get_inbound_callback_token(settings):
        missing.append(_("Provider Callback Token"))
    if not settings.get("enable_cdr_sync"):
        missing.append(_("Vobiz CDR Sync"))
    return {
        "enabled": not missing, "configured": not missing, "missing": missing,
        "call_device": CALL_DEVICE_BROWSER_SOFTPHONE,
        "sdk_url": get_browser_softphone_sdk_url(settings),
        "registrar": get_browser_softphone_registrar(settings),
        "username": username if not missing else "",
        "password": password if not missing else "",
        "endpoint_uri": get_profile_endpoint_uri(profile, settings),
        "caller_id": get_caller_id(settings, profile),
        # Never disclose the shared provider callback credential to the browser.
    }


@frappe.whitelist()
def get_provider_answer_url():
    _login()
    frappe.only_for("System Manager")
    if not get_inbound_callback_token():
        frappe.throw(_("Configure a strong provider callback token first."))
    return browser_softphone_answer_url()


@frappe.whitelist(methods=["POST"])
def browser_presence(tab_id: str, registered: int = 1):
    _login()
    if not _browser_enabled() or not get_system_call_profile():
        frappe.throw(_("Browser calling is disabled."))
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", tab_id or ""):
        frappe.throw(_("Invalid browser tab ID."))
    user = frappe.session.user
    cache = frappe.cache()
    with cache.lock("vsc:presence-lock:" + user, timeout=5, blocking_timeout=2):
        current = lifecycle.presence(user)
        if not frappe.utils.cint(registered):
            if current == tab_id:
                cache.delete_value("vsc:presence:" + user)
        else:
            if current and current != tab_id:
                frappe.throw(_("Another browser tab is already registered for calling."))
            lifecycle.set_presence(user, tab_id)
    return {"registered": bool(frappe.utils.cint(registered))}


@frappe.whitelist(methods=["POST"])
def get_incoming_call(caller: str, tab_id: str):
    _login()
    if lifecycle.presence(frappe.session.user) != tab_id:
        frappe.throw(_("This browser is not registered for incoming calls."))
    profile = get_system_call_profile()
    name = (profile or {}).get("current_call_log")
    if not name:
        frappe.throw(_("No routed incoming call found."))
    mapping, row = lifecycle.lock_call(name)
    if not lifecycle.is_browser_call(row):
        frappe.throw(_("This call is routed to your mobile."))
    # The SIP leg presents the business DID; customer identity comes from the
    # authenticated provider's routed log, not the browser's displayed caller ID.
    if (row.user != frappe.session.user or row.direction != "Incoming"
            or row.status in lifecycle.TERMINAL
            or mapping.current_call_log != row.name
            or not row.did_number or _number(caller) != _number(row.did_number)
            or (not any(lifecycle.context(row).get(k) for k in ("fallback_origin_user", "incoming_mapping", "reference_route"))
                and _number(mapping.caller_id) != _number(row.did_number))):
        frappe.throw(_("Incoming call does not match the routed call."))
    frappe.db.commit()
    return {"call_log": row.name, "call_uuid": row.call_uuid, "customer_number": row.customer_number}


@frappe.whitelist(methods=["POST"])
def update_browser_softphone_call(call_log: str, event: str, status=None, reason=None, call_uuid=None):
    _login()
    mapping, row = lifecycle.lock_call(call_log)
    if row.user != frappe.session.user and "System Manager" not in frappe.get_roles():
        frappe.throw(_("Not permitted."))
    if not lifecycle.is_browser_call(row):
        frappe.throw(_("Browser events are not valid for a mobile call."))
    allowed = TERMINAL_EVENTS | {"browserCallStarted", "onCallRemoteRinging", "onCallAnswered"}
    if event not in allowed:
        frappe.throw(_("Unsupported browser event."))
    if row.status in lifecycle.TERMINAL:
        frappe.db.commit()
        return {"status": row.status}
    sdk_uuid = _provider_uuid({"CallUUID": call_uuid})
    # SDK IDs can identify a different leg; they must never overwrite the authenticated provider ID.
    if event in TERMINAL_EVENTS:
        if row.call_uuid:
            frappe.db.set_value("Vobiz Call Log", call_log, lifecycle.provider_pending_values(row, event, reason))
            lifecycle.enqueue_reconcile(call_log)
            result = row.status
        else:
            result = lifecycle.finish_locked(mapping, row, event, str(reason or ""))
    else:
        values = {"event": event, "call_status": event}
        if sdk_uuid and not row.call_uuid and not row.get("recording_call_uuid"):
            values["recording_call_uuid"] = sdk_uuid
        if event == "onCallRemoteRinging" and not row.answer_time:
            values["status"] = "Ringing"
        elif event == "onCallAnswered":
            values["call_status"] = "browser-audio-connected"
            if row.direction == "Outgoing":
                values["status"] = "Connected"
                if not row.answer_time:
                    values["answer_time"] = frappe.utils.now()
        frappe.db.set_value("Vobiz Call Log", call_log, values)
        if event == "onCallAnswered" and row.direction == "Outgoing" and (sdk_uuid or row.get("recording_call_uuid")):
            _enqueue_recording_start(call_log)
        result = values.get("status", row.status)
    _append_callback_if_enabled(call_log, event, {
        "event": event,
        "reason": str(reason or "")[:500],
        "call_uuid": sdk_uuid,
    })
    frappe.db.commit()
    return {"status": result}


@frappe.whitelist(methods=["POST"])
def cancel_browser_call(call_log: str):
    _login()
    mapping, row = lifecycle.lock_call(call_log)
    if row.user != frappe.session.user and "System Manager" not in frappe.get_roles():
        frappe.throw(_("Not permitted."))
    if row.status in lifecycle.TERMINAL:
        frappe.db.commit()
        return {"status": row.status}
    if lifecycle.has_browser_terminal_event(row):
        # End Call after a delivered SDK end event is a reconciliation request.
        # Preserve both the evidence and its original timestamp.
        lifecycle.enqueue_reconcile(call_log)
        frappe.db.commit()
        return {"status": row.status, "pending_provider": True}
    uuid = row.call_uuid
    context = lifecycle.context(row)
    context["agent_cancelled"] = True
    context.setdefault("agent_cancel_requested_at", frappe.utils.now())
    frappe.db.set_value("Vobiz Call Log", call_log, "request_json", json.dumps(context))
    frappe.db.set_value("Vobiz Call Log", call_log, "call_status", "cancellation-requested")
    frappe.db.commit()
    from vobiz_click_to_call.services.client import VobizClient
    # On a provider error keep the reservation. A queued reconciliation may still resolve it.
    try:
        if uuid:
            VobizClient(get_settings()).hangup_call(uuid, allow_missing=True)
    finally:
        lifecycle.enqueue_reconcile(call_log)
        frappe.db.commit()
    return {"status": row.status, "pending_provider": True}


@frappe.whitelist(allow_guest=True, methods=["GET", "POST"])
@rate_limit(limit=600, seconds=60)
def answer(token=None):
    if not _valid_public_token(token) or not is_enabled(get_settings()):
        return _plain_response("Not permitted.", 403)
    payload = _request_params()
    if str(payload.get("Event") or payload.get("event") or "").lower() == "hangup":
        return _xml_response(_hangup_xml())
    raw_from = str(payload.get("From") or payload.get("from") or "")
    raw_to = str(payload.get("To") or payload.get("to") or "")
    if raw_from.startswith("sip:"):
        return _answer_sdk_outbound(raw_from, raw_to, payload)
    # Serialize DID assignment across provider retries and round-robin updates.
    route_key = hashlib.sha256(str(_number(raw_to) or raw_to).encode()).hexdigest()
    caller_key = hashlib.sha256(str(_number(raw_from) or raw_from).encode()).hexdigest()
    with frappe.cache().lock("vsc:incoming-caller:" + caller_key, timeout=120, blocking_timeout=5):
        with frappe.cache().lock("vsc:incoming-route:" + route_key, timeout=120, blocking_timeout=5):
            return _answer_core_routed_pstn_inbound(payload)


def browser_softphone_answer_url(settings=None):
    settings = settings or get_settings()
    query = urlencode({"token": get_inbound_callback_token(settings)})
    return f"{get_webhook_base_url(settings)}/api/method/vobiz_system_call.api.webrtc.answer?{query}"


def _answer_core_routed_pstn_inbound(payload):
    """Use the core inbound router, then upgrade mapped browser agents to SIP User XML."""
    from vobiz_click_to_call.api import inbound as core_inbound

    response = core_inbound.route()
    xml = response.get_data(as_text=True) if hasattr(response, "get_data") else ""
    if not xml or "<Number" not in xml:
        return response

    call_log = core_inbound.find_existing_inbound_call(payload)
    endpoint = _core_inbound_browser_endpoint(call_log)
    if not endpoint:
        return response

    upgraded = _replace_dial_number_with_user(xml, call_log, endpoint)
    if not upgraded:
        return response

    data = lifecycle.context(call_log)
    data.update({
        "source": "vobiz_system_call",
        "call_device": CALL_DEVICE_BROWSER_SOFTPHONE,
        "core_inbound_route": True,
    })
    frappe.db.set_value(
        "Vobiz Call Log",
        call_log.name,
        {
            "agent_number": endpoint,
            "request_json": json.dumps(data, indent=2, default=str),
        },
        update_modified=False,
    )
    frappe.db.commit()
    return _xml_response(upgraded)


def _core_inbound_browser_endpoint(call_log):
    if not call_log or not call_log.get("user"):
        return ""
    profile = get_system_call_profile(call_log.user)
    if not profile:
        return ""
    mapping = frappe.get_doc("Vobiz User Mapping", profile["name"])
    if mapping.get("current_call_log") != call_log.name:
        return ""
    settings = get_settings()
    if get_call_device(settings, mapping) != CALL_DEVICE_BROWSER_SOFTPHONE:
        return ""
    if not device_enabled(CALL_DEVICE_BROWSER_SOFTPHONE, settings):
        return ""
    if not frappe.utils.cint(mapping.get("browser_softphone_enabled")):
        return ""
    return get_profile_endpoint_uri(mapping.as_dict(), settings)


def _replace_dial_number_with_user(xml, call_log, endpoint):
    target = _number(call_log.get("agent_number")) or _number(call_log.get("user_mobile"))
    if not target:
        return ""
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError:
        return ""
    replaced = False
    for dial in root.iter("Dial"):
        children = list(dial)
        for idx, child in enumerate(children):
            if child.tag != "Number" or _number(child.text or "") != target:
                continue
            user = ElementTree.Element("User")
            user.text = endpoint
            dial.remove(child)
            dial.insert(idx, user)
            replaced = True
            break
        if replaced:
            break
    if not replaced:
        return ""
    return '<?xml version="1.0" encoding="UTF-8"?>' + ElementTree.tostring(root, encoding="unicode")


def _answer_sdk_outbound(raw_from, raw_to, payload):
    destination = _number(raw_to)
    uuid = _provider_uuid(payload)
    if not destination or not uuid:
        return _xml_response(_hangup_xml())
    profiles = frappe.get_all(
        "Vobiz User Mapping",
        filters={"browser_softphone_username": _sip_username(raw_from), "enabled": 1},
        fields=["name", "user"], limit_start=0, limit_page_length=2,
    )
    if len(profiles) != 1:
        return _xml_response(_hangup_xml())
    mapping = lifecycle.lock_mapping(profiles[0].user)
    if (not mapping.browser_softphone_enabled or not mapping.current_call_log
            or get_profile_endpoint_uri(mapping.as_dict()) != raw_from):
        frappe.db.rollback()
        return _xml_response(_hangup_xml())
    mapping, row = lifecycle.lock_call(mapping.current_call_log)
    if (not lifecycle.is_browser_call(row) or row.direction != "Outgoing" or destination != _number(row.customer_number)
            or row.status in lifecycle.TERMINAL
            or (row.call_uuid and row.call_uuid != uuid)
            or (not row.call_uuid and lifecycle.startup_expired(row))
            or lifecycle.context(row).get("agent_cancelled")
            or row.call_status in ("cancellation-requested", "browser-ended-pending-provider")):
        frappe.db.rollback()
        return _xml_response(_hangup_xml())
    # Only the provider-authenticated answer can claim a prepared call's UUID.
    frappe.db.set_value("Vobiz Call Log", row.name, {
        "call_uuid": uuid, "from_number": raw_from, "to_number": destination,
        "call_status": "provider-routed",
    })
    row.call_uuid = uuid
    _append_callback_if_enabled(row.name, "answer", {"CallUUID": uuid, "To": destination})
    xml = _dial_number_xml(destination, row.caller_id, row)
    frappe.db.commit()
    return _xml_response(xml)


def _repeat_inbound(key, caller, did, depth=0):
    if depth >= 8:
        return _xml_response(_hangup_xml())
    mapping, row = lifecycle.lock_call(key)
    next_call = lifecycle.context(row).get("next_call_log")
    if next_call:
        frappe.db.commit()
        return _repeat_inbound(next_call, caller, did, depth + 1)
    valid = (row.status not in lifecycle.TERMINAL and mapping.current_call_log == key
             and row.user == mapping.user and row.direction == "Incoming"
             and row.customer_number == caller and row.did_number == did
             and row.call_status not in ("cancellation-requested", "browser-ended-pending-provider"))
    xml = _dial_agent_xml(row.agent_number, did, row) if valid else _hangup_xml()
    frappe.db.commit()
    return _xml_response(xml)


def _incoming_patient(number):
    """Return a unique Patient and ambiguity flag using existing phone indexes."""
    if not frappe.db.exists("DocType", "Patient"):
        return None, False
    fields = frappe.db.sql(
        "SELECT DISTINCT COLUMN_NAME FROM information_schema.STATISTICS "
        "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tabPatient' AND SEQ_IN_INDEX=1 "
        "AND COLUMN_NAME IN ('vobiz_mobile_last10','vobiz_phone_last10','vobiz_whatsapp_last10','vobiz_normalized_phone','mobile','phone')",
        pluck=True,
    )
    matches = set()
    for field in fields:
        # Last-ten indexes are only unambiguous for the site's Indian numbering plan.
        if field.endswith('_last10'):
            if not number.startswith('+91') or len(number) != 13:
                continue
            values = [number[-10:]]
        else:
            values = [number, number.lstrip('+')]
            if number.startswith('+91') and len(number) == 13:
                values.append(number[-10:])
        matches.update(frappe.get_all('Patient', filters={field: ['in', values]}, pluck='name', limit_page_length=2))
        if len(matches) > 1:
            return None, True
    return (frappe.get_doc('Patient', next(iter(matches))) if matches else None), False


def _select_inbound_agent(primary_user, patient=None, candidate_users=None, listed_only=False, excluded_users=None):
    from vobiz_click_to_call.api.inbound import _fallback_users
    from vobiz_click_to_call.services.safety import get_working_hours_block_reason
    from vobiz_click_to_call.services.patient_routing import patient_matches_mapping
    queue, seen = list(candidate_users) if candidate_users is not None else [primary_user], set(excluded_users or [])
    # The super administrator is never an incoming-call agent, including fallbacks.
    seen.add("Administrator")
    while queue and len(seen) < 16:
        user = queue.pop(0)
        if user in seen:
            continue
        seen.add(user)
        if user != primary_user and not get_system_call_profile(user):
            continue
        mapping = lifecycle.lock_mapping(user)
        if not listed_only:
            queue.extend(u for u in _fallback_users(mapping) if u not in seen)
        settings = get_settings()
        device = get_call_device(settings, mapping)
        browser = device == CALL_DEVICE_BROWSER_SOFTPHONE
        route_matches = (mapping.get("queue_source") in ("Patient", "CRM Lead and Patient")
                         and patient_matches_mapping(patient, mapping)) if patient is not None else mapping.get("queue_source") != "Patient"
        eligible = ((route_matches or listed_only) and device in (CALL_DEVICE_BROWSER_SOFTPHONE, CALL_DEVICE_MOBILE_BRIDGE)
                    and device_enabled(device, settings) and mapping.get("enabled") != 0
                    and not mapping.current_call_log and mapping.availability_status == "Available"
                    and mapping.accept_calls
                    and (not browser or (mapping.browser_softphone_enabled and lifecycle.presence(user))))
        if eligible and listed_only:
            from vobiz_click_to_call.api.console import is_agent_console_online
            eligible = is_agent_console_online(user)
        if eligible and not get_working_hours_block_reason(mapping.as_dict()):
            endpoint = get_profile_endpoint_uri(mapping.as_dict()) if browser else _number(mapping.agent_mobile)
            if endpoint:
                lifecycle.assert_available(mapping)
                return mapping, device, endpoint
        # Do not hold multiple agent locks while following reciprocal fallback chains.
        frappe.db.rollback()
    return None


def _incoming_lead(caller):
    from vobiz_click_to_call.api.inbound import find_latest_crm_lead_by_phone
    if not frappe.db.exists("DocType", "CRM Lead"):
        return None
    found = find_latest_crm_lead_by_phone(caller)
    return frappe.get_doc("CRM Lead", found.name) if found else None


def _unknown_incoming_candidates(incoming):
    from vobiz_click_to_call.api.inbound import _round_robin_order
    rows = [r for r in incoming.get("agents") or [] if frappe.utils.cint(r.get("enabled")) and r.get("agent_user")]
    rows.sort(key=lambda r: (frappe.utils.cint(r.get("priority")), frappe.utils.cint(r.get("idx"))))
    if incoming.get("routing_strategy") == "Load Balancing":
        rows.sort(key=lambda r: (bool(r.get("last_assigned_at")), str(r.get("last_assigned_at") or ""),
                                frappe.utils.cint(r.get("priority")), frappe.utils.cint(r.get("idx"))))
    else:
        rows = _round_robin_order(rows, incoming.get("last_assigned_agent"))
    return rows


def _reject_incoming(reason, uuid="", details=None):
    from vobiz_click_to_call.services.debug_log import log_vobiz_event
    log_vobiz_event("Incoming routing rejected: " + reason, severity="Warning",
                   payload={"provider_uuid": uuid, "reason": reason, "details": details or []})
    frappe.db.commit()
    return _xml_response(_hangup_xml())


def _answer_pstn_inbound(raw_from, raw_to, payload):
    caller, did, uuid = _number(raw_from), _number(raw_to), _provider_uuid(payload)
    if not caller or not did or not uuid:
        return _reject_incoming("Invalid caller, DID or provider UUID", uuid)
    key = "VSC-IN-" + hashlib.sha256(uuid.encode()).hexdigest()[:40]
    if frappe.db.exists("Vobiz Call Log", key):
        return _repeat_inbound(key, caller, did)
    from vobiz_click_to_call.api.inbound import find_incoming_mapping
    incoming = find_incoming_mapping(did)
    profiles = frappe.get_all(
        "Vobiz User Mapping", filters={"caller_id": did, "enabled": 1},
        fields=["name", "user"], limit_start=0, limit_page_length=2,
    )
    if not incoming and len(profiles) != 1:
        return _reject_incoming("No unambiguous enabled DID mapping", uuid)
    origin = profiles[0].user if len(profiles) == 1 else ""
    patient, ambiguous = _incoming_patient(caller)
    lead, agent_rows, route = None, [], "patient"
    if ambiguous:
        return _reject_incoming("Ambiguous Patient phone match", uuid)
    if patient:
        from vobiz_click_to_call.api.inbound import patient_route_mappings
        candidates = [m["user"] for m in patient_route_mappings(patient) if m.get("user")]
        selected = _select_inbound_agent(origin, patient=patient, candidate_users=candidates)
    else:
        lead = _incoming_lead(caller)
        if lead:
            origin = str(lead.get("lead_owner") or "").strip()
            route = "crm_lead"
            selected = _select_inbound_agent(origin) if origin and get_system_call_profile(origin) else None
        elif incoming:
            route = "unknown"
            agent_rows = _unknown_incoming_candidates(incoming)
            selected = _select_inbound_agent("", candidate_users=[r.agent_user for r in agent_rows], listed_only=True)
        else:
            return _reject_incoming("Unknown caller has no Incoming Mapping", uuid)
    if not selected:
        return _reject_incoming("No eligible agent for " + route, uuid)
    mapping, device, endpoint = selected
    # Another request may have prepared this UUID while we waited for the agent.
    if frappe.db.exists("Vobiz Call Log", key):
        frappe.db.rollback()
        return _repeat_inbound(key, caller, did)
    if route == "unknown":
        from vobiz_click_to_call.api.inbound import create_unknown_inbound_lead
        # The caller lock covers lookup, creation and commit across all DIDs.
        lead = create_unknown_inbound_lead(caller, did, incoming, {"user": mapping.user})
    browser = device == CALL_DEVICE_BROWSER_SOFTPHONE
    data = {
        "doctype": "Vobiz Call Log", "call_key": key, "source_app": "vobiz_click_to_call",
        "user": mapping.user, "direction": "Incoming", "status": "Ringing",
        "call_status": "provider-routed", "call_uuid": uuid, "callback_token": secrets.token_urlsafe(32),
        "customer_number": caller, "normalized_customer_number": caller,
        "caller_id": did, "did_number": did, "normalized_did": did,
        "agent_number": endpoint, "user_mobile": mapping.agent_mobile,
        "from_number": caller, "to_number": did, "start_time": frappe.utils.now(),
        "request_json": json.dumps({"source": "vobiz_system_call", "call_device": device, "incoming_mobile_bridge": not browser,
                                    "fallback_origin_user": origin if mapping.user != origin else "",
                                    "incoming_mapping": incoming.name if route == "unknown" else "",
                                    "reference_route": route if route != "unknown" else ""}),
        "recording_status": "Not Started", "cdr_sync_status": "Not Synced",
    }
    if patient:
        data.update(reference_doctype="Patient", reference_name=patient.name, patient=patient.name)
    elif lead:
        data.update(reference_doctype="CRM Lead", reference_name=lead.name, crm_lead=lead.name)
    # The Patient identity is established from indexed phone matching before routing.
    row = frappe.get_doc(data).insert(ignore_permissions=True)
    from vobiz_click_to_call.api.call import mark_mapping_busy
    mark_mapping_busy(mapping.name, row.name)
    if route == "unknown":
        from vobiz_click_to_call.api.inbound import update_incoming_assignment
        agent_row = next(r for r in agent_rows if r.agent_user == mapping.user)
        update_incoming_assignment(incoming, {"user": mapping.user, "agent_row": agent_row.name})
    xml = _dial_agent_xml(endpoint, did, row)
    frappe.db.commit()
    return _xml_response(xml)


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=600, seconds=60)
def provider_event(call_log: str, token: str, final: str = "0"):
    # Per-call credential is sent only to the provider through Dial XML.
    auth_row = frappe.db.get_value("Vobiz Call Log", call_log, ["name", "call_uuid"], as_dict=True)
    secret = _provider_call_token(auth_row) if auth_row else ""
    if not secret or not hmac.compare_digest(str(secret), str(token or "")):
        return _plain_response("Not permitted.", 403)
    mapping, row = lifecycle.lock_call(call_log)
    payload = _request_params()
    # The Dial token is specific to this call and authorizes B-leg callbacks too.
    state = str(payload.get("DialCallStatus") or payload.get("DialStatus") or
                payload.get("DialAction") or payload.get("DialBLegStatus") or payload.get("Event") or "").lower()
    if row.status not in lifecycle.TERMINAL:
        if state in ("answer", "answered", "connected", "in-progress", "in progress"):
            frappe.db.set_value("Vobiz Call Log", row.name, {
                "status": "Connected", "answer_time": row.answer_time or frappe.utils.now(),
            })
            frappe.enqueue(
                "vobiz_click_to_call.services.recording.start_recording_if_needed",
                call_log=row.name, queue="short", timeout=180, enqueue_after_commit=True,
                job_id="vsc-record-" + row.name, deduplicate=True,
            )
        elif state in ("completed", "hangup", "busy", "no-answer", "failed", "timeout", "cancel") or final == "1":
            outcome = {"busy": "Busy", "no-answer": "No Answer", "timeout": "No Answer",
                       "failed": "Failed"}.get(state)
            lifecycle.finish_locked(mapping, row, "terminated", state, status=(
                outcome or ("Completed" if row.answer_time or _billable_seconds(payload) > 0
                            or (state == "completed" and payload.get("DialBLegUUID")) else "Cancelled")
            ))
    _append_callback_if_enabled(row.name, "provider-event", {
        k: v for k, v in payload.items() if k not in ("token", "cmd")
    })
    if row.status in lifecycle.TERMINAL:
        lifecycle.release_locked(mapping, row)
    lifecycle.enqueue_reconcile(row.name)
    frappe.db.commit()
    return _xml_response(_empty_xml())


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=600, seconds=60)
def incoming_action(call_log: str, token: str):
    auth = frappe.db.get_value("Vobiz Call Log", call_log, ["name", "call_uuid"], as_dict=True)
    if not auth or not hmac.compare_digest(_provider_call_token(auth), str(token or "")) or not token:
        return _plain_response("Not permitted.", 403)
    with frappe.cache().lock("vsc:dial-action:" + call_log, timeout=120, blocking_timeout=5):
        existing = frappe.db.get_value("Vobiz Call Log", call_log, "request_json")
        context = lifecycle.context({"request_json": existing})
        if context.get("next_call_log"):
            child = frappe.get_doc("Vobiz Call Log", context["next_call_log"])
            return _repeat_inbound(child.name, child.customer_number, child.did_number)
        if context.get("fallback_processed") or context.get("agent_cancelled"):
            return _xml_response(_empty_xml())
        provider_event(call_log, token, final="1")
        row = frappe.get_doc("Vobiz Call Log", call_log)
        payload = _request_params()
        state = str(payload.get("DialStatus") or payload.get("DialCallStatus") or "").lower()
        if (lifecycle.context(row).get("agent_cancelled")
                or row.direction != "Incoming" or row.answer_time or row.status == "Completed"
                or state not in ("no-answer", "timeout", "busy")
                or row.call_status == "cancellation-requested"):
            return _xml_response(_empty_xml())
        return _retry_incoming_agent(row)


def _retry_incoming_agent(row):
    from vobiz_click_to_call.api.inbound import _fallback_users, patient_route_mappings
    context = lifecycle.context(row)
    attempted = list(dict.fromkeys(context.get("attempted_users", []) + [row.user]))
    if len(attempted) >= 8:
        context["fallback_processed"] = True
        frappe.db.set_value("Vobiz Call Log", row.name, "request_json", json.dumps(context))
        return _reject_incoming("Unanswered fallback limit reached", row.call_uuid)
    incoming = None
    if context.get("incoming_mapping"):
        incoming = frappe.get_doc("Vobiz Incoming Mapping", context["incoming_mapping"])
        users = [r.agent_user for r in _unknown_incoming_candidates(incoming)] if incoming.enabled else []
        selected = _select_inbound_agent("", candidate_users=users, listed_only=True, excluded_users=attempted)
    elif row.reference_doctype == "Patient":
        patient = frappe.get_doc("Patient", row.reference_name)
        users = [m["user"] for m in patient_route_mappings(patient) if m.get("user")]
        selected = _select_inbound_agent("", patient=patient, candidate_users=users, excluded_users=attempted)
    else:
        mapping = get_system_call_profile(row.user)
        users = _fallback_users(mapping)
        selected = _select_inbound_agent("", candidate_users=users, excluded_users=attempted)
    if not selected:
        context["fallback_processed"] = True
        frappe.db.set_value("Vobiz Call Log", row.name, "request_json", json.dumps(context))
        return _reject_incoming("No eligible agent after unanswered call", row.call_uuid)
    mapping, device, endpoint = selected
    key = "VSC-IN-" + hashlib.sha256((row.name + ":retry").encode()).hexdigest()[:40]
    child_context = dict(context, call_device=device, incoming_mobile_bridge=device == CALL_DEVICE_MOBILE_BRIDGE,
                         attempted_users=attempted + [mapping.user], previous_call_log=row.name,
                         fallback_origin_user=context.get("fallback_origin_user") or row.user)
    child_context.pop("next_call_log", None)
    child_context.pop("fallback_processed", None)
    data = {"doctype": "Vobiz Call Log", "call_key": key, "source_app": "vobiz_click_to_call",
            "user": mapping.user, "direction": "Incoming", "status": "Ringing", "call_status": "provider-routed",
            "callback_token": secrets.token_urlsafe(32), "agent_number": endpoint, "user_mobile": mapping.agent_mobile,
            "request_json": json.dumps(child_context), "start_time": frappe.utils.now(),
            "recording_status": "Not Started", "cdr_sync_status": "Not Synced"}
    for field in ("call_uuid", "customer_number", "normalized_customer_number", "caller_id", "did_number",
                  "normalized_did", "from_number", "to_number", "reference_doctype", "reference_name", "patient", "crm_lead"):
        data[field] = row.get(field)
    child = frappe.get_doc(data).insert(ignore_permissions=True)
    from vobiz_click_to_call.api.call import mark_mapping_busy
    mark_mapping_busy(mapping.name, child.name)
    context.update(next_call_log=child.name, fallback_processed=True)
    frappe.db.set_value("Vobiz Call Log", row.name, "request_json", json.dumps(context))
    if incoming:
        from vobiz_click_to_call.api.inbound import update_incoming_assignment
        match = next(r for r in incoming.agents if r.agent_user == mapping.user and r.enabled)
        update_incoming_assignment(incoming, {"user": mapping.user, "agent_row": match.name})
    frappe.db.commit()
    return _xml_response(_dial_agent_xml(endpoint, row.did_number, child))


def _terminal_status(previous, event, reason):
    return lifecycle.terminal_status(previous, event, reason)


def _request_params():
    params = dict(frappe.form_dict or {})
    if frappe.request and frappe.request.is_json:
        data = frappe.request.get_json(silent=True)
        if isinstance(data, dict):
            params.update(data)
    return params


def _valid_public_token(token):
    expected = get_inbound_callback_token(get_settings())
    received = token or frappe.form_dict.get("token") or ""
    return bool(expected and received) and hmac.compare_digest(str(expected), str(received))


def _append_callback_if_enabled(call_log, event, payload):
    if not get_settings().store_raw_payloads:
        return
    safe = {k: v for k, v in payload.items() if k not in ("token", "cmd")}
    if len(json.dumps(safe, default=str)) > 16384:
        safe = {"truncated": True, "event": event}
    try:
        frappe.enqueue(
            "vobiz_click_to_call.services.callback_logging.append_callback_job", queue="short", timeout=120,
            enqueue_after_commit=True, call_log=call_log, event_type=event, payload=safe,
        )
    except Exception:
        # Telemetry availability must not roll back a successful call transition.
        frappe.log_error(title="Vobiz callback logging unavailable", message=frappe.get_traceback())


def _enqueue_recording_start(call_log: str) -> None:
    try:
        frappe.enqueue(
            "vobiz_click_to_call.services.recording.start_recording_if_needed",
            call_log=call_log, queue="short", timeout=180, enqueue_after_commit=True,
            job_id="vsc-record-" + call_log, deduplicate=True,
        )
    except Exception:
        # Recording must not interrupt the live browser call state update.
        frappe.log_error(title="Vobiz browser recording start unavailable", message=frappe.get_traceback())


def _sip_username(value):
    return str(value or "").removeprefix("sip:").split("@", 1)[0].strip()


def _number(value):
    value = str(value or "").strip()
    # The SDK can omit the sip: scheme from incoming caller addresses.
    address = re.fullmatch(r"(?:sips?:)?(\+?[0-9]{7,15})@[A-Za-z0-9.-]+(?::[0-9]{1,5})?", value)
    if address:
        value = address.group(1)
    if not re.fullmatch(r"\+?[0-9]{7,15}", value):
        return ""
    return normalize_phone_number(value, default_country_code=get_default_country_code())


def _provider_uuid(payload):
    value = str(payload.get("CallUUID") or payload.get("call_uuid") or "")
    return value if re.fullmatch(r"[A-Za-z0-9_-]{8,128}", value) else ""


def _billable_seconds(payload):
    try:
        return max(0, int(payload.get("DialBLegBillDuration") or payload.get("BillDuration") or 0))
    except (TypeError, ValueError):
        return 0


def _provider_call_token(row):
    secret = get_inbound_callback_token()
    if not secret or not row.get("call_uuid"):
        return ""
    message = str(row.name) + ":" + str(row.call_uuid)
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def _dial_attrs(caller_id, row=None):
    attrs = [("callerId", provider_phone_number(caller_id)), ("timeout", "30"),
             ("timeLimit", str(int(get_settings().get("max_call_duration") or 3600)))]
    if row:
        base = get_webhook_base_url() + "/api/method/vobiz_system_call.api.webrtc.provider_event?"
        query = {"call_log": row.name, "token": _provider_call_token(row)}
        action_base = (get_webhook_base_url() + "/api/method/vobiz_system_call.api.webrtc.incoming_action?"
                       if row.get("direction") == "Incoming" else base)
        attrs += [("action", action_base + urlencode({**query, "final": "1"})), ("method", "POST"),
                  ("callbackUrl", base + urlencode(query)), ("callbackMethod", "POST")]
    return " ".join(f"{key}={quoteattr(str(value))}" for key, value in attrs)


def _dial_number_xml(destination, caller_id, row=None):
    return ('<?xml version="1.0" encoding="UTF-8"?><Response>'
            f'<Dial {_dial_attrs(caller_id, row)}><Number>{escape(provider_phone_number(destination))}</Number>'
            '</Dial></Response>')


def _dial_agent_xml(endpoint, caller_id, row):
    if lifecycle.context(row).get("call_device") == CALL_DEVICE_MOBILE_BRIDGE:
        return ('<?xml version="1.0" encoding="UTF-8"?><Response>'
                f'<Dial {_dial_attrs(caller_id, row)}><Number>{escape(provider_phone_number(endpoint))}</Number></Dial></Response>')
    return _dial_user_xml(endpoint, caller_id, row)


def _dial_user_xml(endpoint_uri, caller_id, row=None):
    return ('<?xml version="1.0" encoding="UTF-8"?><Response>'
            f'<Dial {_dial_attrs(caller_id, row)}><User>{escape(endpoint_uri)}</User></Dial></Response>')


def _hangup_xml():
    return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>'


def _empty_xml():
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'


def _xml_response(xml):
    return Response(xml, content_type="text/xml; charset=utf-8")


def _plain_response(text, status=200):
    return Response(text, status=status, content_type="text/plain; charset=utf-8")


def _unique_incoming_lead(customer_number, selected_name=None):
    """Use indexed phone columns only, and never choose among ambiguous matches."""
    number = _number(customer_number)
    if not number or not number.startswith("+91") or len(number) != 13:
        return None
    if not frappe.db.exists("DocType", "CRM Lead"):
        return None
    fields = frappe.db.sql(
        "SELECT DISTINCT COLUMN_NAME FROM information_schema.STATISTICS "
        "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tabCRM Lead' AND SEQ_IN_INDEX=1 "
        "AND COLUMN_NAME IN ('sr_mobile_norm','vobiz_mobile_last10','vobiz_phone_last10','vobiz_whatsapp_last10')",
        pluck=True,
    )
    meta = frappe.get_meta("CRM Lead")
    canonical = {field: 0 for field in ("sr_is_archived", "sr_is_duplicate") if meta.has_field(field)}
    if selected_name:
        canonical["name"] = selected_name
    matches = set()
    for field in fields:
        # Get all candidate identities before checking access: hidden duplicates
        # must not turn an ambiguous number into an apparent unique match.
        matches.update(frappe.get_all("CRM Lead", filters={field: number[-10:], **canonical},
                                      pluck="name", limit_page_length=2))
        if len(matches) > 1:
            return None
    if len(matches) != 1:
        return None
    name = next(iter(matches))
    if not frappe.has_permission("CRM Lead", "read", doc=name):
        return None
    return name


@frappe.whitelist(methods=["POST"])
def prepare_incoming_disposition(call_log: str, reference_name: str | None = None):
    _login()
    doc = frappe.get_doc("Vobiz Call Log", call_log)
    if doc.user != frappe.session.user and "System Manager" not in frappe.get_roles():
        frappe.throw(_("Not permitted."))
    if doc.direction != "Incoming" or doc.status not in lifecycle.TERMINAL:
        frappe.throw(_("The incoming call has not ended yet."))
    if not doc.reference_doctype and not doc.reference_name:
        name = _unique_incoming_lead(doc.customer_number, reference_name)
        if reference_name and not name:
            frappe.throw(_("Select an accessible CRM Lead matching this caller?s phone number."))
        if name:
            # Recheck under lock in case another request attached a reference.
            mapping, locked = lifecycle.lock_call(call_log)
            if not locked.reference_doctype and not locked.reference_name:
                frappe.db.set_value("Vobiz Call Log", call_log,
                                    {"reference_doctype": "CRM Lead", "reference_name": name})
            frappe.db.commit()
    from vobiz_click_to_call.api.call import get_call_status
    return get_call_status(call_log, sync_provider=0)
