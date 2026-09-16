# Disposition after call completion

Deploy the matching `vobiz_click_to_call` and `vobiz_system_call` changes together.
Both completion publishers now include the call's CRM reference and direction.
The console retains matching call context after SDK cleanup, recovers missing
details by exact call ID, and retries transient lookup failures. Duplicate events
do not reopen disposition, and late results cannot interrupt a newer call.

After deployment, build both apps, clear the site cache, and restart web and queue
workers through the site's usual deployment workflow. The System Call asset
version is `20260916.1`. Reload the browser after any current call finishes.

Verify customer hangup and reconnection after confirmed termination: disposition
should open once for the correct lead. These commits do not change the provider
timeout/status handling or registration ownership rules.
