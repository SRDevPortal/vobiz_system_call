# Local SDK patch

Upstream: https://unpkg.com/vobiz-webrtc-sdk@1.0.3/dist/vobiz-webrtc-sdk.min.js
Version: 1.0.3. Upstream license and bundled third-party notices are included.

The upstream LOG_COLLECTION and LOG_COLLECTION_JWT constants are empty. fetch("")
posts call diagnostics to the current Desk page and rejects with an unhandled failure.
The original JavaScript patch resolves the log-upload promise immediately when the
selected endpoint is absent or whitespace. SIP, media and call behavior are unchanged.

Original SHA256: b59866701281028c32b07c1a8345fa4d89e2218f04f7dc533a2dfe2b65be8170

Local reliability patch (2026-09-16): VobizLogStorage keeps only the newest 65,536 characters; malformed stored JSON is discarded. Blocked storage and quota failures are contained within the SDK logger. A quota failure removes only VobizLogStorage and retries one 4,096-character entry. Logging never aborts call setup. See tests/test_sdk_logging.cjs.

Local lifecycle patch (2026-10-15): added an opt-out `managePageLifecycle: false`
for the app-owned lifecycle. The constructor keeps the switch instance-local
(defaulting to true), so another SDK instance cannot change it. It skips only SDK close-listener installation and
its corresponding idle cleanup, including the unsupported `window.onunload`
assignments. SDK behavior is unchanged when this option is absent. The Agent
Console owns the active-call `beforeunload` warning and performs browser-leg
cleanup on `pagehide`, so canceling a close warning does not tear down the call.
SIP signaling, audio, and normal hangup code are unchanged. The bundled asset
cache version is `managed-lifecycle-20261015`.
