"""Validation for global capabilities and each agent's selected device."""
import frappe
from frappe import _
from vobiz_system_call.api.settings import (
    get_settings, get_call_device, assert_device_enabled,
    CALL_DEVICE_BROWSER_SOFTPHONE, CALL_DEVICE_MOBILE_BRIDGE,
)


def validate_mapping(doc, method=None):
    if frappe.flags.in_install or frappe.flags.in_migrate:
        return
    previous = doc.get_doc_before_save()
    changed = not previous or any(doc.get(f) != previous.get(f) for f in (
        "agent_call_device", "enabled", "browser_softphone_enabled", "agent_mobile",
        "browser_softphone_username", "browser_softphone_password", "browser_softphone_endpoint_uri"))
    if not changed:
        return
    if not doc.is_new():
        current = frappe.db.sql("SELECT current_call_log FROM `tabVobiz User Mapping` WHERE name=%s FOR UPDATE", (doc.name,))
        if current and current[0][0]:
            frappe.throw(_("End the active call before changing the agent's call device or connection settings."))
    if not doc.enabled:
        return
    settings = get_settings()
    validate_profile(doc, settings)


def validate_profile(doc, settings):
    device = get_call_device(settings, doc)
    assert_device_enabled(device, settings)
    if device == CALL_DEVICE_MOBILE_BRIDGE:
        from vobiz_click_to_call.services.numbers import normalize_phone_number
        from vobiz_click_to_call.services.settings import get_default_country_code
        if not normalize_phone_number(doc.get("agent_mobile"), default_country_code=get_default_country_code(settings)):
            frappe.throw(_("Agent Mobile is required for Mobile Bridge."))
    elif device == CALL_DEVICE_BROWSER_SOFTPHONE:
        if not doc.get("browser_softphone_enabled") or not doc.get("browser_softphone_username"):
            frappe.throw(_("Enable Browser Softphone and configure its username for this agent."))
        if not doc.get_password("browser_softphone_password", raise_exception=False):
            frappe.throw(_("Browser Softphone Password is required for this agent."))


def validate_settings(doc, method=None):
    if frappe.flags.in_install or frappe.flags.in_migrate:
        return
    previous = doc.get_doc_before_save()
    if previous and all(doc.get(f) == previous.get(f) for f in (
        "agent_call_device", "enable_browser_softphone", "enable_mobile_bridge")):
        return
    if not doc.get("agent_call_device"):
        frappe.throw(_("Select an enabled Default Agent Call Device."))
    assert_device_enabled(get_call_device(doc), doc)
    # Use the same mapping locks as call creation; settings changes cannot reroute an active call.
    names = frappe.get_all("Vobiz User Mapping", filters={"enabled": 1}, pluck="name", order_by="name asc")
    for name in names:
        mapping = frappe.get_doc("Vobiz User Mapping", name, for_update=True)
        device = get_call_device(doc, mapping)
        assert_device_enabled(device, doc)
        if previous and get_call_device(previous, mapping) != device:
            if mapping.current_call_log:
                frappe.throw(_("End active calls before changing their default device."))
            validate_profile(mapping, doc)


@frappe.whitelist()
def get_device_options():
    if frappe.session.user == "Guest":
        frappe.throw(_("Login required."))
    from vobiz_system_call.api.settings import device_enabled
    settings = get_settings()
    return {"options": ["Use Default"] + [d for d in (CALL_DEVICE_BROWSER_SOFTPHONE, CALL_DEVICE_MOBILE_BRIDGE)
                                            if device_enabled(d, settings)],
            "default": get_call_device(settings)}
