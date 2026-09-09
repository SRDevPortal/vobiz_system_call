app_name = "vobiz_system_call"
app_title = "Vobiz System Call"
app_publisher = "SRIAAS"
app_description = "Browser softphone extension for Vobiz Click To Call"
app_email = "webdevelopersriaas@gmail.com"
app_license = "MIT"

required_apps = ["SRDevPortal/vobiz_click_to_call", "SRDevPortal/vobiz_ai"]

after_install = "vobiz_system_call.install.after_install"
after_migrate = "vobiz_system_call.install.after_migrate"

override_whitelisted_methods = {
    "vobiz_click_to_call.api.call.cancel_call": "vobiz_system_call.api.call.cancel_call",
    "vobiz_click_to_call.api.call.start_call": "vobiz_system_call.api.call.start_call",
    "vobiz_click_to_call.api.webrtc.get_browser_softphone_config": "vobiz_system_call.api.webrtc.get_browser_softphone_config",
    "vobiz_click_to_call.api.webrtc.update_browser_softphone_call": "vobiz_system_call.api.webrtc.update_browser_softphone_call",
    "vobiz_click_to_call.api.webrtc.answer": "vobiz_system_call.api.webrtc.answer",
}

app_include_js = [
    "/assets/vobiz_system_call/js/vobiz_system_call.js",
]

before_uninstall = "vobiz_system_call.install.before_uninstall"

scheduler_events = {
    "cron": {"* * * * *": ["vobiz_system_call.api.lifecycle.recover_calls"]},
}


doc_events = {
    "Vobiz User Mapping": {"validate": "vobiz_system_call.api.device.validate_mapping"},
    "Vobiz Settings": {"validate": "vobiz_system_call.api.device.validate_settings"},
}
doctype_js = {
    "Vobiz User Mapping": "public/js/user_mapping.js",
    "Vobiz Settings": "public/js/settings.js",
}
