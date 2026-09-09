function vsc_settings_devices(frm) {
    const selected = frm.doc.agent_call_device || '';
    const choices = [];
    if (frm.doc.enable_mobile_bridge) choices.push('Mobile Bridge');
    if (frm.doc.enable_browser_softphone) choices.push('Browser Softphone');
    // Preserve existing System Dialer sites without offering it as a new mode.
    if (frm.vsc_preserve_system_dialer) choices.push('System Dialer');
    frm.set_df_property('agent_call_device', 'options', [''].concat(choices).join('\n'));
    frm.set_value('agent_call_device', choices.includes(selected) ? selected : '');
    frm.toggle_display('browser_softphone_registrar', !!frm.doc.enable_browser_softphone);
    frm.toggle_display('browser_softphone_sdk_url', !!frm.doc.enable_browser_softphone);
}
frappe.ui.form.on('Vobiz Settings', {
    refresh(frm) {
        if (frm.vsc_preserve_system_dialer === undefined) {
            frm.vsc_preserve_system_dialer = frm.doc.agent_call_device === 'System Dialer';
        }
        vsc_settings_devices(frm);
    },
    enable_mobile_bridge: vsc_settings_devices,
    enable_browser_softphone: vsc_settings_devices
});
