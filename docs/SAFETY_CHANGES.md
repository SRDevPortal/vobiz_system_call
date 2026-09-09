# Browser call safety changes

Current local site name: `sriaas.local` (renamed from `sriaas.butest.tech` on 2026-09-08). Historical verification entries below retain the original name.

Updated locally on 2026-09-08. Base revision: 356b0a7.
The deployment includes changes in BOTH vobiz_system_call and vobiz_click_to_call.

## Implemented

- Public answer requests fail closed when the callback token is absent/incorrect or Browser Softphone mode is disabled.
- Outgoing routing requires a unique enabled SIP mapping, exact endpoint and destination, a current prepared browser call, a fresh startup window, and an authenticated provider UUID. Unknown endpoints, changed destinations, cancelled calls and conflicting UUIDs receive Hangup XML.
- Browser configuration no longer returns the provider answer URL/shared token. Disabled or incomplete configurations do not return the SIP password.
- Per-call Dial callbacks use an HMAC tied to call name and provider UUID, derived from the server-side callback secret, rather than the readable call-log token.
- Agent mapping and call state are locked in a consistent order. A competing start cannot reserve an already-reserved agent.
- Browser and provider events no longer overwrite final outcomes. SDK IDs cannot overwrite authenticated provider IDs. Browser audio events are not authoritative answer timestamps.
- Stop Call is available directly in the softphone, including incoming calls. It invokes SDK hangup and server cancellation. The core cancellation URL also dispatches browser logs through the safe handler.
- Unissued calls can be cancelled/expired atomically. Calls with a provider UUID remain reserved until authenticated end events or a matching terminal CDR confirm the outcome.
- Incoming calls require a unique DID mapping, Available/accepting status, working-hours permission, and a live single-tab browser lease. Missing/ambiguous DIDs and unavailable agents are rejected.
- Incoming call keys are deterministic per provider UUID, preventing duplicate inserts. The browser explicitly associates the incoming call with its own routed log instead of falling back to an outgoing log.
- Incoming logs intentionally do not guess a CRM/Patient reference from unindexed phone searches. Shared-DID team routing and automatic reference association require an explicit additional routing policy.
- SDK loading and registration have 15-second timeouts and retry cleanup. Registration claims a tab lease before SIP login to prevent competing tabs replacing each other. Presence expires after 65 seconds and refreshes every 25 seconds.
- Raw callback jobs receive correctly named top-level arguments; token/cmd fields are stripped and payload size is bounded.
- Legacy standalone DocTypes are retained. A compatibility cleanup function is now a no-op.
- Migration explicitly reapplies the extension console; before uninstall restores the core console before Frappe removes the extension's module.
- Recording starts through the existing recording worker on provider-confirmed answer. CDR reconciliation enriches durations, billsec and recording URL without downgrading final outcomes.
- The core stale-call timeout and availability helper recognize extension-managed calls and leave release to provider-aware recovery.

## Configuration before Browser Softphone testing

Keep Mobile Bridge selected until staging tests pass.

1. Configure a strong, random Inbound Callback Token in Vobiz Settings. Rotate any token previously exposed by the old softphone configuration response.
2. Enable Vobiz CDR Sync. Browser startup requires it for recovery.
3. Configure the SIP username/password/endpoint in each enabled mapping and the caller ID in its normalized international format.
4. Use the System Manager-only vobiz_system_call.api.webrtc.get_provider_answer_url method to obtain the provider's answer URL. Configure the Vobiz application to use it over public HTTPS.
5. Use one registered console tab per agent. Incoming browser routing currently requires an unambiguous DID-to-agent mapping.
6. Run the scheduler and short-queue worker when enabling calls. Failed provider requests intentionally keep an agent reserved rather than report a call as stopped without confirmation.

The recovery cron runs each minute and scans 100 mapping rows per pass using a keyset cursor. A complete sweep takes multiple passes on larger sites. Calls without a provider UUID expire after a 45-second startup deadline, when a recovery pass reaches them. No long-running DB locks are held during provider requests.

System Dialer remains an OS URL handoff. It cannot provide reliable browser audio control or external-dialer call outcomes.

## Applied to sriaas.butest.tech

- Two online indexes added to Vobiz User Mapping: vsc_endpoint and vsc_did.
- Safe app setup hook applied and extension console refreshed.
- Recovery Scheduled Job Type registered.
- New cancel_call override resolved successfully.
- Call device remained Mobile Bridge.

No bench process was started by this task. During verification, externally started bench processes appeared and were left untouched.

## Verification

- 33 Python tests passed (27 behavior regressions plus six pre-existing tests).
- Six Node/VM browser lifecycle tests passed, covering SDK hangup order, failed startup cleanup, pending provider confirmation, stale UUID events, SDK retry/timeout, and registration timeout.
- Existing core bounded stale-ringing recovery test passed.
- JavaScript syntax and git diff whitespace checks passed.
- Local HTTP checks: ping 200; both original and extension public answer URLs reject missing authentication with 403.
- EXPLAIN endpoint lookup: ref / vsc_endpoint / estimated one row.
- EXPLAIN DID lookup: ref / vsc_did / estimated one row.
- EXPLAIN recovery keyset: range / PRIMARY (bounded LIMIT 100).
- EXPLAIN nonexistent call-key lookup: constant lookup optimized to an impossible condition, with no scan.

Tests use mocked provider/SDK/database behavior. No paid calls were placed. Real SIP registration, headset/audio, provider event field/leg semantics, recording retrieval, concurrent-user load, shared-console uninstall and disaster recovery still require staging validation.

## Files to deploy together

Extension: api/call.py, api/webrtc.py, api/lifecycle.py, api/settings.py, install.py, hooks.py, pyproject.toml, replacement agent console JS and tests.

Core compatibility changes: vobiz_click_to_call/api/call.py and vobiz_click_to_call/services/cdr.py. Do not deploy the extension changes while dropping these two guards.

For another site, run the normal app migration to register the recovery schedule, apply the online indexes and refresh the console. Migration refuses a blocking COPY fallback if online index creation is unavailable.

## Ngrok console fixes (2026-09-08)

The v15 ngrok proxy suppresses the HTML dev_server flag so Socket.IO uses the
public HTTPS origin. Missing Origin headers on same-origin polling fall back to
https://$host; supplied Origin values are preserved and mismatches are rejected.
Verified full Guest namespace connections with missing/matching origins and rejection
of an unrelated origin, beyond the Engine.IO opening handshake.

SDK 1.0.3 is now served from public/vendor/vobiz-webrtc-sdk-1.0.3 with upstream
licenses and PATCH.md provenance. A single guard skips log uploads with an empty
destination; upstream otherwise posts to the current Desk page. App defaults and
the current site's SDK setting use the local file. Two SDK logging tests and all
six existing browser lifecycle tests passed; public asset returned 200.

Hard refresh the console to load the corrected SDK. Existing SDK instances keep
the old code until reloaded. No real calls were placed for this verification.

## Repeated audio test playback

Test Audio now reuses a dedicated AudioContext, awaits resume, prevents overlapping
tests and schedules a fixed 650 ms tone using the audio clock with short gain ramps.
It releases oscillator/gain nodes after playback and reports tone completion rather
than claiming the user heard sound. Context reuse, readiness, duration, rapid clicks
and node cleanup tests passed together with call/audio regression tests.

## Live microphone test

Test Mic opens an eight-second local analyser meter. It distinguishes captured sound
from silence using RMS input level (not speech recognition), without recording or
connecting the microphone to speakers. Stop test, navigation and starting/answering
a call release test tracks, nodes and context. Late permission results are released
when a test was cancelled. Tests cover sound/silence and late-permission cleanup.

## Inbound caller identity correction

Inbound SIP Dial now presents the authenticated provider customer number as callerId,
including retries. Previously it presented the business DID while browser association
required the customer number, causing a legitimate incoming call to fail matching.
The business DID remains on the log and controls agent routing. Matching was not
relaxed. All 35 Python tests pass, including first/retry routing and SIP caller matching.

## Inbound SIP identity follow-up

Customer callerId routing subsequently failed before the SIP endpoint rang (provider
DialStatus failed, ORIGINATOR_CANCEL). The exact provider reason is not established.
Restored the business DID that previously reached the browser. Incoming association
now requires the registered tab, owned incoming nonterminal log, current mapping
reservation and matching DID in both mapping and log. The UI displays customer_number
from the authenticated provider log. Failed browser association clears incoming_pending.
This supersedes the customer-callerId change above. 35 Python tests and six browser
lifecycle checks pass; real inbound callback verification remains pending.

## Stop Call already-ended race

The browser may hang up before the server DELETE arrives. Browser cancellation now
opts into VobizClient.hangup_call(..., allow_missing=True). Only exact "call not found"
responses with status 400/404/410 are handled as pending confirmation; credentials,
server and unrelated errors still raise. Reservations remain until authenticated
callbacks/CDR recovery confirms the outcome. No terminal status is inferred from 404.

Deploy the additional core compatibility file vobiz_click_to_call/services/client.py
together with vobiz_system_call/api/webrtc.py. Existing core callers retain their
previous error behavior unless explicitly opting in. 37 Python tests and six browser
lifecycle checks passed. No real calls were placed or cancelled for verification.

## Consistent call ending and incoming disposition

Header End Call and softphone Stop Call share confirmation, including rejecting
a confirmation if its call has been replaced. Browser-ended calls poll their own
log for provider-confirmed terminal state for up to two minutes before prompting;
existing console refresh remains available afterward. Incoming calls without CRM
references now use generic disposition options and no unrelated lead status fields
or auto-save timer. Existing AI/auto-dial disposition policies remain in place.
Tests cover confirmation rejection, stale calls, prompt deduplication, unlinked
incoming calls and delayed provider completion. All browser regressions passed.

## Incoming CRM disposition completion

Core get_call_status now includes direction, required to recognize unlinked incoming
calls. After terminal confirmation, the extension can attach one uniquely matched,
readable CRM Lead using indexed Indian-number fields only. Multiple/no matches use
an explicit lead picker; the server verifies the selected record's phone and access.
No routing-time CRM scan or guess is introduced. The agent can instead save a call-only
disposition. Linked calls use the existing Status/Lead Disposition/Notes/countdown
form for either agent or customer hangup. Other-country numbers retain call-only
disposition until an appropriate indexed matching strategy is available.
39 Python tests and all browser regressions pass. Real modal interaction remains to
be verified after refreshing the console. Include the core api/call.py change when deploying.

### Incoming shared disposition form
Removed the separate customer-selection popup. Unmatched incoming calls now open Complete Call Disposition with CRM Lead, Status, Lead Disposition and Notes. Selecting a validated matching lead loads CRM options inside the same dialog and preserves notes. Saving is blocked until the lead context is loaded; server matching and ownership checks remain. Already matched calls retain the existing countdown flow.

### Disposition status consistency and Frappe 15 cleanup
The dialog now uses its CRM context options even when empty, rather than retaining another status's dispositions. Status changes clear old selections and ignore out-of-order responses. Timeout saves no longer carry a disposition from a different status. Incoming preparation wraps the Frappe jQuery thenable in a native Promise before finally cleanup. Verified on site: Fresh has no configured dispositions; Want Discount belongs to Financial Issue.

### Strict status-related Lead Disposition
Workdesk status changes immediately clear prior choices and ignore stale responses. Blank status leaves the modal/workdesk choices empty. Core manual options no longer fall back to generic dispositions for CRM Leads with no configured choices, and CRM save validation rejects nonempty choices outside the selected status even when its option list is empty. Deploy the core settings.py and disposition.py changes together with the console.

### Frappe 15 dependency repository resolution
Qualified required_apps with SRDevPortal so the installer resolves private/custom app names without searching the frappe and erpnext GitHub organizations. Both dependencies remain required.

### Installation index transaction boundary
ensure_indexes uses frappe.db.sql_ddl for ALTER TABLE, committing preceding setup writes through the Frappe schema API before MariaDB implicit-commit DDL. Existing-index checks and ALGORITHM=INPLACE, LOCK=NONE are retained. Regression covers pending writes and repeat execution without duplicate DDL.

### Removed obsolete frappe_crm compatibility package
Verified sites/apps.txt and sriaas.local installed apps use crm. Removed the frappe_crm shim, packaging inclusions, obsolete name-repair command/script, and their tests. The real apps/crm package and site data are unchanged.

### Per-agent call devices
Added independent browser/mobile enable flags and per-agent Use Default / Browser Softphone / Mobile Bridge selection. Device resolution occurs under the agent lock. Incoming mobile legs share authenticated callbacks and provider reconciliation while retaining their stored mode. Browser presence is required only for browser routing/release. Active-call device changes are blocked and the console retains the shared disposition flow. See AGENT_CALL_DEVICES.md for deployment and live validation.
