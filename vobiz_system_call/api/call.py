from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _

from vobiz_ai.api.call_log import sync_linked_summaries
from vobiz_click_to_call.api import call as core_call
from vobiz_click_to_call.services.call_log_update import save_doc_latest, snapshot_doc
from vobiz_click_to_call.services.debug_log import log_vobiz_event
from vobiz_click_to_call.services.disposition import update_reference_call_metrics
from vobiz_click_to_call.services.numbers import mask_phone, normalize_phone_number
from vobiz_click_to_call.services.safety import assert_call_allowed
from vobiz_click_to_call.services.settings import get_allowed_doctypes, get_default_country_code, get_settings as get_core_settings
from vobiz_system_call.api.settings import (
    CALL_DEVICE_BROWSER_SOFTPHONE,
    CALL_DEVICE_SYSTEM_DIALER,
    build_system_dialer_url,
    get_call_device,
    get_caller_id,
    get_profile_endpoint_uri,
    get_profile_password,
    get_settings,
    get_system_call_profile,
    is_enabled,
)


@frappe.whitelist()
def start_call(
    reference_doctype: str,
    reference_name: str,
    phone_field: str | None = None,
    phone_number: str | None = None,
    patient_phone_selected: int | str = 0,
    client_context: str | None = None,
) -> dict[str, Any]:
    if frappe.session.user == "Guest":
        frappe.throw(_("Login required."))

    system_settings = get_settings()
    if not is_enabled(system_settings):
        return core_call.start_call(reference_doctype, reference_name, phone_field, phone_number, patient_phone_selected)

    call_device = get_call_device(system_settings)
    if call_device not in {CALL_DEVICE_BROWSER_SOFTPHONE, CALL_DEVICE_SYSTEM_DIALER}:
        return core_call.start_call(reference_doctype, reference_name, phone_field, phone_number, patient_phone_selected)
    if client_context != "agent_console":
        return core_call.start_call(reference_doctype, reference_name, phone_field, phone_number, patient_phone_selected)

    core_settings = get_core_settings()
    if not core_settings.enabled:
        frappe.throw(_("Vobiz Click To Call is disabled."))

    allowed_doctypes = get_allowed_doctypes(core_settings)
    if reference_doctype not in allowed_doctypes:
        frappe.throw(_("Calling is not enabled for {0}.").format(reference_doctype))
    if not frappe.db.exists(reference_doctype, reference_name):
        frappe.throw(_("{0} {1} was not found.").format(reference_doctype, reference_name))

    doc = frappe.get_doc(reference_doctype, reference_name)
    if not doc.has_permission("read") and not core_call.has_mapped_patient_access(reference_doctype, reference_name):
        frappe.throw(_("You do not have permission to call from this document."))
    if reference_doctype == "Patient":
        choices = core_call._patient_primary_phone_candidates(doc, get_default_country_code(core_settings))
        if len(choices) > 1 and not frappe.utils.cint(patient_phone_selected):
            frappe.throw(_("Select the Patient number to call."))

    mapping = core_call.get_user_mapping(frappe.session.user)
    if not mapping:
        frappe.throw(_("No active Vobiz user mapping found for your user."))
    unavailable_reason = core_call.get_mapping_unavailable_reason(mapping)
    if unavailable_reason:
        frappe.throw(unavailable_reason)

    default_country_code = get_default_country_code(core_settings)
    raw_customer_number, resolved_phone_field = core_call.resolve_target_number(doc, phone_field, phone_number)
    customer_number = normalize_phone_number(raw_customer_number, default_country_code=default_country_code)
    user_mobile = normalize_phone_number(mapping.get("agent_mobile"), default_country_code=default_country_code)
    call_flow = core_settings.default_call_flow or "Customer First"
    profile = get_system_call_profile(frappe.session.user)
    caller_id = get_caller_id(system_settings, profile, mapping)
    default_caller_id = get_caller_id(system_settings, {}, {})

    if not customer_number:
        frappe.throw(_("Customer phone number is required."))
    if not caller_id:
        frappe.throw(_("Vobiz caller ID is not configured."))

    assert_call_allowed(
        customer_number=customer_number,
        reference_doctype=reference_doctype,
        reference_name=reference_name,
        user=frappe.session.user,
        mapping=mapping,
        settings=core_settings,
    )

    call_log = core_call.create_call_log(
        reference_doctype=reference_doctype,
        reference_name=reference_name,
        phone_field=resolved_phone_field,
        customer_number=customer_number,
        user_mobile=user_mobile,
        caller_id=caller_id,
        call_flow=call_flow,
    )

    if call_device == CALL_DEVICE_SYSTEM_DIALER:
        return start_system_dialer_call(
            call_log=call_log,
            settings=system_settings,
            reference_doctype=reference_doctype,
            reference_name=reference_name,
            customer_number=customer_number,
            raw_customer_number=raw_customer_number,
            user_mobile=user_mobile,
            call_flow=call_flow,
        )

    return start_browser_softphone_call(
        call_log=call_log,
        settings=system_settings,
        mapping=mapping,
        profile=profile,
        reference_doctype=reference_doctype,
        reference_name=reference_name,
        customer_number=customer_number,
        raw_customer_number=raw_customer_number,
        user_mobile=user_mobile,
        caller_id=caller_id or default_caller_id,
        call_flow=call_flow,
    )


def start_system_dialer_call(
    *,
    call_log,
    settings,
    reference_doctype: str,
    reference_name: str,
    customer_number: str,
    raw_customer_number: str | None,
    user_mobile: str,
    call_flow: str,
) -> dict[str, Any]:
    dial_url = build_system_dialer_url(
        settings=settings,
        number=customer_number,
        raw_number=raw_customer_number,
        reference_doctype=reference_doctype,
        reference_name=reference_name,
    )
    before = snapshot_doc(call_log)
    call_log.status = "Initiated"
    call_log.call_status = "system-dialer-opened"
    call_log.start_time = call_log.start_time or frappe.utils.now()
    call_log.request_json = json.dumps(
        {
            "call_device": CALL_DEVICE_SYSTEM_DIALER,
            "dial_url": dial_url,
            "customer_number": customer_number,
            "call_flow": call_flow,
            "source": "vobiz_system_call",
        },
        indent=2,
        default=str,
    )
    call_log.response_json = json.dumps(
        {"system_dialer": True, "message": "System dialer URL returned to browser."},
        indent=2,
        default=str,
    )
    call_log = save_doc_latest(call_log, before)
    update_reference_call_metrics(reference_doctype, reference_name)
    sync_linked_summaries(call_log)
    log_vobiz_event("Vobiz System Call dialer prepared", call_log=call_log.name)
    frappe.db.commit()

    return {
        "call_log": call_log.name,
        "status": call_log.status,
        "call_device": CALL_DEVICE_SYSTEM_DIALER,
        "system_dialer": True,
        "dial_url": dial_url,
        "call_flow": call_flow,
        "customer_number": customer_number,
        "agent_mobile_display": mask_phone(user_mobile),
        "message": _("System dialer opened."),
    }


def start_browser_softphone_call(
    *,
    call_log,
    settings,
    mapping: dict[str, Any],
    profile: dict[str, Any] | None,
    reference_doctype: str,
    reference_name: str,
    customer_number: str,
    raw_customer_number: str | None,
    user_mobile: str,
    caller_id: str,
    call_flow: str,
) -> dict[str, Any]:
    if not profile:
        frappe.throw(_("No active Vobiz user mapping found for your user."))
    if not frappe.utils.cint(profile.get("browser_softphone_enabled", 1)):
        frappe.throw(_("Browser Softphone is not enabled on your Vobiz User Mapping."))

    endpoint_username = (profile.get("browser_softphone_username") or "").strip()
    endpoint_uri = get_profile_endpoint_uri(profile, settings)
    endpoint_password = get_profile_password(profile.get("name"))
    if not endpoint_username:
        frappe.throw(_("Browser Softphone Username is missing on your Vobiz User Mapping."))
    if not endpoint_password:
        frappe.throw(_("Browser Softphone Password is missing on your Vobiz User Mapping."))
    if not endpoint_uri:
        frappe.throw(_("Browser Softphone Endpoint URI is missing on your Vobiz User Mapping."))

    core_call.mark_mapping_busy(mapping["name"], call_log.name)
    updates = {
        "status": "Initiated",
        "call_status": "browser-softphone-starting",
        "start_time": call_log.start_time or frappe.utils.now(),
        "user_mobile": user_mobile or endpoint_uri,
        "agent_number": endpoint_uri,
        "from_number": endpoint_uri,
        "to_number": customer_number,
        "request_json": json.dumps(
            {
                "call_device": CALL_DEVICE_BROWSER_SOFTPHONE,
                "endpoint_username": endpoint_username,
                "endpoint_uri": endpoint_uri,
                "customer_number": customer_number,
                "raw_customer_number": raw_customer_number,
                "caller_id": caller_id,
                "call_flow": call_flow,
                "source": "vobiz_system_call",
            },
            indent=2,
            default=str,
        ),
        "response_json": json.dumps(
            {"browser_softphone": True, "message": "Browser softphone call prepared for Vobiz WebRTC SDK."},
            indent=2,
            default=str,
        ),
    }
    frappe.db.set_value("Vobiz Call Log", call_log.name, updates, update_modified=True)
    call_log.reload()
    update_reference_call_metrics(reference_doctype, reference_name)
    sync_linked_summaries(call_log)
    log_vobiz_event(
        "Vobiz System Call browser softphone prepared",
        call_log=call_log.name,
        payload={
            "reference_doctype": reference_doctype,
            "reference_name": reference_name,
            "customer_number": customer_number,
            "endpoint_username": endpoint_username,
        },
    )
    frappe.db.commit()

    return {
        "call_log": call_log.name,
        "status": call_log.status,
        "call_device": CALL_DEVICE_BROWSER_SOFTPHONE,
        "browser_softphone": True,
        "destination": customer_number,
        "call_flow": call_flow,
        "customer_number": customer_number,
        "agent_mobile_display": mask_phone(user_mobile) if user_mobile else endpoint_username,
        "message": _("Browser softphone call prepared."),
    }
