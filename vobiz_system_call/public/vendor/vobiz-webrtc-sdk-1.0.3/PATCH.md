# Local SDK patch

Upstream: https://unpkg.com/vobiz-webrtc-sdk@1.0.3/dist/vobiz-webrtc-sdk.min.js
Version: 1.0.3. Upstream license and bundled third-party notices are included.

The upstream LOG_COLLECTION and LOG_COLLECTION_JWT constants are empty. fetch("")
posts call diagnostics to the current Desk page and rejects with an unhandled failure.
The only JavaScript change resolves the log-upload promise immediately when the
selected endpoint is absent or whitespace. SIP, media and call behavior are unchanged.

Original SHA256: b59866701281028c32b07c1a8345fa4d89e2218f04f7dc533a2dfe2b65be8170
