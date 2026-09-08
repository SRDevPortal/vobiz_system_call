from __future__ import annotations

from urllib.parse import quote, urlsplit

import frappe
from frappe import _

from vobiz_click_to_call.services.numbers import normalize_phone_number
from vobiz_click_to_call.services.settings import get_caller_id as get_core_caller_id
from vobiz_click_to_call.services.settings import get_default_country_code, get_settings as get_core_settings

CALL_DEVICE_MOBILE_BRIDGE = "Mobile Bridge"
CALL_DEVICE_BROWSER_SOFTPHONE = "Browser Softphone"
CALL_DEVICE_SYSTEM_DIALER = "System Dialer"
DEFAULT_BROWSER_SOFTPHONE_REGISTRAR = "registrar.vobiz.ai"
DEFAULT_BROWSER_SOFTPHONE_SDK_URL = "/assets/vobiz_system_call/vendor/vobiz-webrtc-sdk-1.0.3/vobiz-webrtc-sdk.min.js"
DEFAULT_SYSTEM_DIALER_URL_TEMPLATE = "sip:{number}@{sip_domain}"
SYSTEM_DIALER_ALLOWED_SCHEMES = {"tel", "sip", "sips", "callto"}


def get_settings():
    return get_core_settings()


def is_enabled(settings=None) -> bool:
    settings = settings or get_settings()
    return bool(frappe.utils.cint(settings.get("enabled")))


def get_call_device(settings=None) -> str:
    settings = settings or get_settings()
    value = (settings.get("agent_call_device") or CALL_DEVICE_MOBILE_BRIDGE).strip()
    options = {CALL_DEVICE_MOBILE_BRIDGE, CALL_DEVICE_BROWSER_SOFTPHONE, CALL_DEVICE_SYSTEM_DIALER}
    return value if value in options else CALL_DEVICE_MOBILE_BRIDGE


def get_browser_softphone_registrar(settings=None) -> str:
    settings = settings or get_settings()
    return (settings.get("browser_softphone_registrar") or DEFAULT_BROWSER_SOFTPHONE_REGISTRAR).strip()


def get_browser_softphone_sdk_url(settings=None) -> str:
    settings = settings or get_settings()
    return (settings.get("browser_softphone_sdk_url") or DEFAULT_BROWSER_SOFTPHONE_SDK_URL).strip()


def get_inbound_callback_token(settings=None) -> str:
    settings = settings or get_settings()
    token = ""
    if settings.meta.has_field("inbound_callback_token"):
        try:
            token = settings.get_password("inbound_callback_token") or ""
        except Exception:
            token = ""
    return (token or frappe.conf.get("vobiz_system_call_inbound_token") or "").strip()


def get_webhook_base_url(settings=None) -> str:
    settings = settings or get_settings()
    return (
        settings.get("webhook_base_url")
        or frappe.conf.get("vobiz_system_call_webhook_base_url")
        or frappe.utils.get_url()
    ).strip().rstrip("/")


def get_system_call_profile(user: str | None = None) -> dict | None:
    user = user or frappe.session.user
    if not frappe.db.exists("DocType", "Vobiz User Mapping"):
        return None
    meta = frappe.get_meta("Vobiz User Mapping")
    fields = [
        "name",
        "user",
        "agent_mobile",
        "caller_id",
        "accept_calls",
        "availability_status",
        "current_call_log",
    ]
    for fieldname in (
        "browser_softphone_enabled",
        "browser_softphone_username",
        "browser_softphone_endpoint_uri",
    ):
        if meta.has_field(fieldname):
            fields.append(fieldname)
    rows = frappe.get_all(
        "Vobiz User Mapping",
        filters={"user": user, "enabled": 1},
        fields=fields,
        limit=1,
    )
    return rows[0] if rows else None


def get_profile_password(profile_name: str) -> str:
    if not profile_name:
        return ""
    try:
        doc = frappe.get_doc("Vobiz User Mapping", profile_name)
        if doc.meta.has_field("browser_softphone_password"):
            return doc.get_password("browser_softphone_password") or ""
    except Exception:
        return ""
    return ""


def get_profile_endpoint_uri(profile: dict, settings=None) -> str:
    settings = settings or get_settings()
    endpoint_uri = (profile.get("browser_softphone_endpoint_uri") or "").strip()
    username = (profile.get("browser_softphone_username") or "").strip()
    if endpoint_uri:
        return endpoint_uri
    registrar = get_browser_softphone_registrar(settings)
    return f"sip:{username}@{registrar}" if username else ""


def get_caller_id(settings=None, profile: dict | None = None, core_mapping: dict | None = None) -> str:
    core_settings = get_settings()
    caller_id = (profile or {}).get("caller_id") or ""
    if caller_id:
        return normalize_phone_number(caller_id, default_country_code=get_default_country_code(core_settings))
    return get_core_caller_id(core_settings, core_mapping or {})


def build_system_dialer_url(
    *,
    settings=None,
    number: str,
    raw_number: str | None = None,
    reference_doctype: str | None = None,
    reference_name: str | None = None,
) -> str:
    settings = settings or get_settings()
    sip_domain = (settings.get("system_dialer_sip_domain") or "").strip()
    template = (settings.get("system_dialer_url_template") or DEFAULT_SYSTEM_DIALER_URL_TEMPLATE).strip()
    values = {
        "number": number or "",
        "raw_number": raw_number or number or "",
        "reference_doctype": reference_doctype or "",
        "reference_name": reference_name or "",
        "sip_domain": sip_domain,
    }
    if "{sip_domain}" in template and not sip_domain:
        frappe.throw(_("System Dialer SIP Domain is required for system calls."))

    url = template
    for key, value in values.items():
        url = url.replace("{" + key + "}", quote(str(value), safe="+@._-:"))
    if "://" not in url and ":" not in url:
        url = f"tel:{quote(str(number or ''), safe='+')}"

    scheme = urlsplit(url).scheme or url.split(":", 1)[0].lower()
    if scheme not in SYSTEM_DIALER_ALLOWED_SCHEMES:
        frappe.throw(_("System Dialer URL Template must use tel:, sip:, sips:, or callto:."))
    return url
