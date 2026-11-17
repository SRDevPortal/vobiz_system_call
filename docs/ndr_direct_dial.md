# NDR direct dial

When **Vobiz Settings > NDR Queue > Enable NDR Dialpad** is checked, agents whose enabled Vobiz User Mapping includes NDR (alone or with other queue sources) get a Dialpad button in the Agent Console. Other agents do not get the button and cannot use the API.

## Agent flow

Open Dialpad, type/paste a phone number or use the keypad, and press Call. Ten-digit domestic numbers use the configured default country code; international numbers should include + and their country code. Use End Call, Complete Call and disposition through the existing console flow.

The agent's configured Browser Softphone, Mobile Bridge or System Dialer is used. Existing caller ID selection, browser ownership, busy-agent locking, call blocking, working hours and configured daily limits still apply. Rapid repeated clicks share the existing in-flight guard.

A single exact, readable CRM Lead or Patient match is linked. Duplicate, inaccessible or unmatched destinations remain standalone Vobiz Call Logs. No lead/patient is created. Background auto-linking is skipped for standalone direct calls. Exact matching recognizes common number formats but does not scan with suffix/LIKE searches.

Direct dial is not tied to a Patient Encounter/order, so it uses the normal call disposition flow. Use the existing NDR queue's call action for encounter-specific NDR outcomes.

Retry uses the original server-side number and reference, checks the current NDR mapping and access again, and retains the existing single-retry rule. A newly created matching record does not change a standalone retry's target.

## Apps and rollout

Deploy these changes together:

- vobiz_ai: direct-call marker at Call Log creation; prevent background auto-linking.
- vobiz_click_to_call: authorized direct-call API, matching, console eligibility, standalone destination daily limit and status context.
- vobiz_system_call: device-aware API override, console dialpad, retry and standalone disposition support.

The new Check field `enable_ndr_dialpad` defaults to disabled. Run the site migration to load the Vobiz Settings field, then check it to enable direct dialing. It is independent of Enable NDR Tab. Turning it off hides the dialpad on the next console refresh and rejects new direct calls/retries on the backend; active calls can still be ended/completed. No call-history backfill is required. After deploying all three apps, clear the site's cache, restart web/workers using the deployment's normal procedure, and hard-refresh the console. Run any migrations required by other changes included in that deployment.

On dev, verify an enabled NDR mapping shows Dialpad, a non-NDR/disabled mapping is rejected, an unknown number produces a standalone call, and a known unique readable record links correctly. Test a configured agent's outbound audio, End Call, Complete Call, retry and disposition before production rollout. Never use a real customer number for an unapproved test call.

## Validation on 2026-11-17

- New feature tests: 26 Python tests and 7 JavaScript tests passed.
- Added standalone retry regression test passed.
- Broader selected Python run: 233/235 passed. The two existing source-string assertions in test_server_safety_guards concern unchanged callback-decorator and navbar code; neither changed in this feature.
- Full top-level system-call JavaScript run: 202/211 passed. The same nine failures reproduce against the original HEAD console source. An existing recovered-disposition harness was updated to stub the new render method.
- Python compilation, JavaScript syntax and git diff whitespace checks passed.
- Real local MariaDB check: permission-aware matching and standalone Call Log insert/reload/retry target passed. Transaction rolled back; no test Call Log persisted.
- Local Chrome component preview: number entry, keypad digit, backspace and mocked submission checked; the current non-NDR user's real console hides Dialpad. Preview removed by reload. No provider call placed. Local Administrator has no configured softphone credentials, so live audio was not tested.

Deployment to production requires the normal release process for all three apps.

Additional setting validation: disabled/missing settings reject direct calls and retries, eligibility changes without a restart, and the final backend check rejects a setting disabled during call preparation.
