from __future__ import annotations

import os

import frappe
from frappe import _
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def after_install():
    ensure_dependencies()
    ensure_patch_fields()
    ensure_console()
    ensure_indexes()
    ensure_defaults()


def after_migrate():
    ensure_dependencies()
    ensure_patch_fields()
    ensure_console()
    ensure_indexes()
    ensure_defaults()


def ensure_dependencies():
    installed_apps = set(frappe.get_installed_apps())
    if "vobiz_click_to_call" not in installed_apps:
        frappe.throw(_("Install Vobiz Click To Call before installing Vobiz System Call."))


def ensure_patch_fields():
    if not frappe.db.exists("DocType", "Vobiz Settings") or not frappe.db.exists("DocType", "Vobiz User Mapping"):
        return

    create_custom_fields(
        {
            "Vobiz Settings": [
                {"fieldname": "enable_browser_softphone", "label": "Enable Browser Softphone",
                 "fieldtype": "Check", "default": "1", "insert_after": "enable_mobile_bridge"},
                {"fieldname": "enable_mobile_bridge", "label": "Enable Mobile Bridge",
                 "fieldtype": "Check", "default": "1", "insert_after": "vsc_call_section"},
                {
                    "fieldname": "vsc_call_section",
                    "label": "System Call",
                    "fieldtype": "Section Break",
                    "insert_after": "default_call_flow",
                    "collapsible": 1,
                },
                {
                    "fieldname": "agent_call_device",
                    "label": "Default Agent Call Device",
                    "fieldtype": "Select",
                    "options": "Mobile Bridge\nBrowser Softphone\nSystem Dialer",
                    "default": "Mobile Bridge",
                    "reqd": 1,
                    "insert_after": "browser_softphone_sdk_url",
                    "description": "Added by Vobiz System Call. Browser Softphone uses the existing Vobiz Agent Console.",
                },
                {
                    "fieldname": "browser_softphone_registrar",
                    "label": "Browser Softphone Registrar",
                    "fieldtype": "Data",
                    "default": "registrar.vobiz.ai",
                    "insert_after": "enable_browser_softphone",
                    "depends_on": "eval:doc.enable_browser_softphone",
                },
                {
                    "fieldname": "browser_softphone_sdk_url",
                    "label": "Browser Softphone SDK URL",
                    "fieldtype": "Data",
                    "default": "/assets/vobiz_system_call/vendor/vobiz-webrtc-sdk-1.0.3/vobiz-webrtc-sdk.min.js",
                    "insert_after": "browser_softphone_registrar",
                    "depends_on": "eval:doc.enable_browser_softphone",
                },
                {
                    "fieldname": "system_dialer_sip_domain",
                    "label": "System Dialer SIP Domain",
                    "fieldtype": "Data",
                    "insert_after": "agent_call_device",
                    "depends_on": "eval:doc.agent_call_device=='System Dialer'",
                },
                {
                    "fieldname": "system_dialer_url_template",
                    "label": "System Dialer URL Template",
                    "fieldtype": "Data",
                    "default": "sip:{number}@{sip_domain}",
                    "insert_after": "system_dialer_sip_domain",
                    "depends_on": "eval:doc.agent_call_device=='System Dialer'",
                    "description": "Supported placeholders: {number}, {sip_domain}, {raw_number}, {reference_doctype}, {reference_name}.",
                },
            ],
            "Vobiz User Mapping": [
                {"fieldname": "agent_call_device", "label": "Agent Call Device",
                 "fieldtype": "Select", "options": "Use Default\nBrowser Softphone\nMobile Bridge",
                 "default": "Use Default", "insert_after": "caller_id",
                 "description": "Use Default follows Vobiz Settings. Changes apply to new calls."},
                {
                    "fieldname": "browser_softphone_section",
                    "label": "Browser Softphone",
                    "fieldtype": "Section Break",
                    "insert_after": "caller_id",
                    "collapsible": 1,
                    "depends_on": "eval:doc.enabled",
                },
                {
                    "fieldname": "browser_softphone_enabled",
                    "label": "Browser Softphone Enabled",
                    "fieldtype": "Check",
                    "default": "1",
                    "insert_after": "browser_softphone_section",
                },
                {
                    "fieldname": "browser_softphone_username",
                    "label": "Browser Softphone Username",
                    "fieldtype": "Data",
                    "insert_after": "browser_softphone_enabled",
                },
                {
                    "fieldname": "browser_softphone_password",
                    "label": "Browser Softphone Password",
                    "fieldtype": "Password",
                    "insert_after": "browser_softphone_username",
                    "no_copy": 1,
                },
                {
                    "fieldname": "browser_softphone_endpoint_uri",
                    "label": "Browser Softphone Endpoint URI",
                    "fieldtype": "Data",
                    "insert_after": "browser_softphone_password",
                    "description": "Optional full SIP URI. Leave blank to use sip:username@registrar.vobiz.ai.",
                },
            ],
        },
        update=True,
    )
    frappe.clear_cache(doctype="Vobiz Settings")
    frappe.clear_cache(doctype="Vobiz User Mapping")


def ensure_defaults():
    if not frappe.db.exists("DocType", "Vobiz Settings"):
        return
    settings = frappe.get_single("Vobiz Settings")
    changed = False
    defaults = {
        "agent_call_device": "Mobile Bridge",
        "browser_softphone_registrar": "registrar.vobiz.ai",
        "browser_softphone_sdk_url": "/assets/vobiz_system_call/vendor/vobiz-webrtc-sdk-1.0.3/vobiz-webrtc-sdk.min.js",
        "system_dialer_url_template": "sip:{number}@{sip_domain}",
    }
    for fieldname, value in defaults.items():
        if settings.meta.has_field(fieldname) and not settings.get(fieldname):
            settings.set(fieldname, value)
            changed = True
    if changed:
        settings.save(ignore_permissions=True)


def cleanup_standalone_ui():
    """Compatibility entry point: legacy data is intentionally retained."""
    return


def ensure_console():
    from frappe.modules.import_file import import_file_by_path
    path = frappe.get_app_path(
        "vobiz_system_call", "vobiz_system_call", "page",
        "vobiz_agent_console", "vobiz_agent_console.json",
    )
    import_file_by_path(path, force=True)


def before_uninstall():
    # Return ownership before Frappe deletes this app's modules/pages.
    from frappe.modules.import_file import import_file_by_path
    path = frappe.get_app_path(
        "vobiz_click_to_call", "vobiz_click_to_call", "page",
        "vobiz_agent_console", "vobiz_agent_console.json",
    )
    import_file_by_path(path, force=True)
    frappe.clear_cache()


def ensure_indexes():
    # Fixed identifiers only. No blocking COPY fallback on production tables.
    indexes = [
        ("Vobiz User Mapping", "vsc_endpoint", ("browser_softphone_username", "enabled")),
        ("Vobiz User Mapping", "vsc_did", ("caller_id", "enabled", "browser_softphone_enabled")),
    ]
    for doctype, index, fields in indexes:
        if not frappe.db.sql(
            "SELECT INDEX_NAME FROM information_schema.STATISTICS "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s LIMIT 1",
            ("tab" + doctype, index),
        ):
            columns = ", ".join("`" + field + "`" for field in fields)
            # Frappe commits pending setup writes before MariaDB schema changes.
            frappe.db.sql_ddl(
                f"ALTER TABLE `tab{doctype}` ADD INDEX `{index}` ({columns}), "
                "ALGORITHM=INPLACE, LOCK=NONE"
            )


def configure_profile_from_core_mapping(
    user: str,
    caller_id: str = "",
    sip_username: str = "",
    endpoint_uri: str = "",
    webhook_base_url: str = "",
):
    ensure_patch_fields()
    ensure_defaults()

    settings = frappe.get_single("Vobiz Settings")
    if webhook_base_url and settings.meta.has_field("webhook_base_url"):
        settings.webhook_base_url = webhook_base_url
    if settings.meta.has_field("browser_softphone_registrar"):
        settings.browser_softphone_registrar = settings.browser_softphone_registrar or "registrar.vobiz.ai"
    if settings.meta.has_field("browser_softphone_sdk_url"):
        settings.browser_softphone_sdk_url = (
            settings.browser_softphone_sdk_url
            or "/assets/vobiz_system_call/vendor/vobiz-webrtc-sdk-1.0.3/vobiz-webrtc-sdk.min.js"
        )
    settings.save(ignore_permissions=True)

    mapping_name = frappe.db.get_value("Vobiz User Mapping", {"user": user, "enabled": 1}, "name")
    if not mapping_name:
        frappe.throw(_("No active Vobiz User Mapping found for {0}.").format(user))

    mapping = frappe.get_doc("Vobiz User Mapping", mapping_name)
    mapping.agent_call_device = "Browser Softphone"
    mapping.browser_softphone_enabled = 1
    mapping.browser_softphone_username = sip_username
    mapping.browser_softphone_endpoint_uri = endpoint_uri
    if caller_id:
        mapping.caller_id = caller_id
    password = mapping.get_password("browser_softphone_password", raise_exception=False) or ""
    if not password and os.environ.get("VOBIZ_SYSTEM_CALL_SIP_PASSWORD"):
        mapping.browser_softphone_password = os.environ["VOBIZ_SYSTEM_CALL_SIP_PASSWORD"]
    mapping.save(ignore_permissions=True)
    frappe.db.commit()
    return {"mapping": mapping.name, "settings": settings.name}


def configure_profile_from_env():
    return configure_profile_from_core_mapping(
        user=os.environ.get("VOBIZ_SYSTEM_CALL_USER", ""),
        caller_id=os.environ.get("VOBIZ_SYSTEM_CALL_CALLER_ID", ""),
        sip_username=os.environ.get("VOBIZ_SYSTEM_CALL_SIP_USERNAME", ""),
        endpoint_uri=os.environ.get("VOBIZ_SYSTEM_CALL_ENDPOINT_URI", ""),
        webhook_base_url=os.environ.get("VOBIZ_SYSTEM_CALL_WEBHOOK_BASE_URL", ""),
    )
