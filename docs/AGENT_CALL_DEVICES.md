# Agent call devices

Vobiz Settings enables Browser Softphone and Mobile Bridge independently. Default Agent Call Device retains the previous global value. Each Vobiz User Mapping selects Use Default, Browser Softphone, or Mobile Bridge. Use Default follows the current global default. Existing System Dialer defaults remain supported.

On sriaas.local both modes are enabled and the default remains Browser Softphone. Existing mappings use Use Default. Changing an agent to Mobile Bridge requires its Agent Mobile; changing to Browser Softphone requires enabled browser credentials. Refresh the Agent Console after saving a device change.

Outgoing Mobile Bridge calls use the core bridge flow. Browser calls require the Agent Console and a registered browser. The server resolves the mapping under its call lock; it does not silently fall back from browser to mobile.

Incoming calls use the existing authenticated answer URL. Exactly one enabled mapping must match the DID; shared-DID routing remains unsupported. Browser agents require live browser presence. Mobile agents dial their Agent Mobile without requiring a browser lease. Both check availability and working hours and reserve the agent. The call log records its device; retries, cancellation and provider reconciliation use that recorded device. Mobile incoming call completion notifies the console to load the shared disposition form.

Device/connection changes are blocked during active calls. Disabling a mode used by enabled mappings requires reassigning those mappings first. Changes to the default cannot reroute active inherited calls.

Deployment: deploy the complete app revision, then run bench --site SITE migrate, clear the site cache, and refresh Desk. In container deployments ensure the backend/workers have the same app code and restart them using the deployment manager. This change has been applied only to the local sriaas.local bench, not the separate Docker site.

Validation: Python safety tests and browser regression suites pass, including overrides, disabled-mode rejection, mobile incoming XML without browser presence, and active-call change protection. Configuration was checked for the mapped agent without exposing credentials. Real provider incoming/outgoing calls and audio/disposition behavior still require live validation.
