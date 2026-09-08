# Vobiz System Call

Patch app for Vobiz Click To Call browser/system calling.

The app keeps softphone code outside the core `vobiz_click_to_call` source, but
it works inside the same Vobiz Click To Call UI:

- adds system-call fields to `Vobiz Settings`
- adds browser softphone fields to `Vobiz User Mapping`
- overrides the existing `vobiz-agent-console` page with the browser softphone UI
- exposes the WebRTC answer URL at `vobiz_system_call.api.webrtc.answer`

See [SAFETY_CHANGES.md](SAFETY_CHANGES.md) for browser-call prerequisites, recovery behavior, deployment requirements and validation results.
