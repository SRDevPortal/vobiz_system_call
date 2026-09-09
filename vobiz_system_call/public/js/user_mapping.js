function vsc_mapping_device_fields(frm) {
    const selected = frm.doc.agent_call_device || 'Use Default';
    const device = selected === 'Use Default' ? frm.vsc_default_device : selected;
    frm.toggle_display('browser_softphone_section', !!frm.doc.enabled && device === 'Browser Softphone');
}
frappe.ui.form.on('Vobiz User Mapping', {
    refresh(frm) {
        frappe.call('vobiz_system_call.api.device.get_device_options').then(r => {
            const config = r.message || {};
            frm.vsc_default_device = config.default;
            frm.set_df_property('agent_call_device', 'options', (config.options || []).join('\n'));
            frm.set_df_property('agent_call_device', 'description', __('Use Default currently uses {0}. Refresh the Agent Console after changing this setting.', [config.default || '']));
            vsc_mapping_device_fields(frm);
        });
    },
    agent_call_device: vsc_mapping_device_fields,
    enabled: vsc_mapping_device_fields
});
