# Vobiz System Call

Patch app for Vobiz Click To Call browser/system calling.

The app keeps softphone code outside the core `vobiz_click_to_call` source, but
it works inside the same Vobiz Click To Call UI:

- adds system-call fields to `Vobiz Settings`
- adds browser softphone fields to `Vobiz User Mapping`
- overrides the existing `vobiz-agent-console` page with the browser softphone UI
- exposes the WebRTC answer URL at `vobiz_system_call.api.webrtc.answer`

See [SAFETY_CHANGES.md](SAFETY_CHANGES.md) for browser-call prerequisites, recovery behavior, deployment requirements and validation results.

## Customer-number privacy

When Privacy Shield is installed, its site switch is enabled, and the current
user lacks View Full, outgoing Browser Softphone and System Dialer requests are
routed through Mobile Bridge. Mobile Bridge must be enabled. The browser
receives the masked call response and never receives the SDK destination or a
system-dialer URL.

Authenticated incoming-call lookup and conference recovery project the
customer number after call ownership and route checks succeed. Queue highlighting
for masked rows matches the trusted call-log and reference identity instead of
comparing visible last digits. Full-view users retain their selected call device.
Provider callbacks, routing, and stored call-log numbers keep their original
values.
