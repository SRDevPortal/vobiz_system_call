// Run with node. Exercises actual console methods; no provider calls or media.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const requests = [];
const sandbox = {
    frappe: {pages: {'vobiz-agent-console': {}}, call: request => {
        requests.push(request);
        return Promise.resolve({message: {status: 'Failed'}});
    }},
    document: {addEventListener() {}}, window: {}, __: value => value, console
};
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
vm.runInNewContext(source + '; globalThis.Console = VobizAgentConsole;', sandbox);
function agent() {
    const c = Object.create(sandbox.Console.prototype);
    c.state = {softphone: {current_call_log: 'CALL-2', sdk_call_uuid: ''}};
    for (const name of ['stop_browser_ringback', 'prepare_browser_ringback_audio', 'stop_browser_microphone_test',
        'start_timer', 'render_browser_softphone', 'disable_browser_outgoing_tones', 'load']) c[name] = () => {};
    c.connect_browser_softphone = () => Promise.resolve();
    c.reset_browser_softphone_call_state = () => {};
    c.cancel_call_log = async () => { c.cancelled = true; };
    return c;
}
const failure = (attempt = 'CALL-2') => ['Rejected', {
    extraHeaders: {'X-VH-Attempt-ID': attempt}, direction: 'outgoing',
    originator: 'remote', protocol: 'SIP', code: 403, state: 'rejected', reason: 'none'
}];
(async () => {
    let c = agent();
    assert.equal(c.matches_browser_call_event(failure('CALL-1')), false, 'Old attempt without UUID must be rejected');
    assert.equal(c.matches_browser_call_event(failure()), true);
    await c.sync_browser_softphone_event('onCallFailed', failure());
    let request = requests.pop();
    const evidence = JSON.parse(request.args.failure_evidence);
    assert.equal(evidence.attempt_id, 'CALL-2');
    assert.equal(evidence.code, 403);
    assert.equal(evidence.originator, 'remote');
    assert.equal(evidence.sdk_cause, 'Rejected');
    assert.equal(request.args.reason, 'Rejected', 'SDK cause survives a missing Reason header');

    await c.sync_browser_softphone_event('onCallFailed', {reason: 'NORMAL_CLEARING'});
    assert.equal(JSON.parse(requests.pop().args.failure_evidence).attempt_id, '', 'Never invent identity for an untagged SDK event');
    c.state.softphone.retired_call_uuids = ['old-uuid'];
    assert.equal(c.matches_browser_call_event({callUUID: 'old-uuid'}), false);

    c = agent();
    c.state.softphone.client = {client: {call: () => false}};
    await assert.rejects(c.start_browser_softphone_call({call_log: 'CALL-2'}, {}), /did not start/);
    request = requests.pop();
    assert.equal(request.args.event, 'onCallFailed');
    assert.equal(JSON.parse(request.args.failure_evidence).phase, 'sdk-declined');
    assert.equal(c.cancelled, undefined, 'Do not issue a hangup for an unissued call');

    c = agent();
    c.connect_browser_softphone = () => Promise.reject(new Error('Registration failed'));
    await assert.rejects(c.start_browser_softphone_call({call_log: 'CALL-2'}, {}), /Registration failed/);
    request = requests.pop();
    assert.equal(JSON.parse(request.args.failure_evidence).phase, 'pre-dial');
    assert.equal(JSON.parse(request.args.failure_evidence).attempt_id, 'CALL-2');

    c = agent();
    let sentHeaders;
    c.state.softphone.client = {client: {call: (_destination, headers) => { sentHeaders = headers; return true; }}};
    await c.start_browser_softphone_call({call_log: 'CALL-2', conference_headers: {'X-VH-Other': 'kept'}}, {});
    assert.equal(sentHeaders['X-VH-Attempt-ID'], 'CALL-2');
    assert.equal(sentHeaders['X-VH-Other'], 'kept');
    assert.equal(requests.pop().args.event, 'browserCallStarted');

    c = agent();
    let resolveRegistration;
    let dialled = false;
    c.connect_browser_softphone = () => new Promise(resolve => { resolveRegistration = resolve; });
    c.state.softphone.client = {client: {call: () => { dialled = true; return true; }}};
    const obsolete = c.start_browser_softphone_call({call_log: 'CALL-2'}, {});
    c.state.softphone.current_call_log = 'CALL-3';
    resolveRegistration();
    await assert.rejects(obsolete, /superseded/);
    assert.equal(dialled, false, 'A late registration callback must not dial an obsolete attempt');
    assert.equal(requests.pop().args.call_log, 'CALL-2', 'Recovery stays bound to its original attempt');

    c = agent();
    c.set_browser_network_issue = () => {};
    c.watch_browser_call_disposition = () => {};
    c.browser_request_with_timeout = promise => promise;
    c.sync_browser_softphone_event = () => Promise.resolve({message: {status: 'Ringing', pending_provider: true}});
    c.reset_browser_softphone_call_state = () => { throw new Error('Uncertain call must retain its controls'); };
    c.browser_softphone_call_done('onCallFailed', failure());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.state.softphone.status, 'Checking call status');
    assert.equal(c.state.softphone.current_call_log, 'CALL-2');

    // Check the bundled SDK's actual validation functions, not an assumed prefix.
    const sdk = fs.readFileSync(path.join(__dirname, '../public/vendor/vobiz-webrtc-sdk-1.0.3/vobiz-webrtc-sdk.min.js'), 'utf8');
    const validation = sdk.match(/e\.checkExtraHeaderKey=function\(n\).*?e\.checkExtraHeaderJWTVal=/s)[0];
    const validator = {e: {}};
    vm.runInNewContext(validation.slice(0, validation.lastIndexOf('e.checkExtraHeaderJWTVal=')), validator);
    assert.equal(validator.e.checkExtraHeaderKey('X-VH-Attempt-ID'), true);
    assert.equal(validator.e.checkExtraHeaderVal('CTC-test_attempt-123'), true);
    console.log('Browser startup recovery checks passed: attempt identity, SDK evidence, false return, registration failure, header compatibility.');
})().catch(error => { console.error(error); process.exitCode = 1; });
