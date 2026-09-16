// Real DOM gestures, no provider calls. Run with Playwright available in NODE_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const jquery = path.resolve(__dirname, '../../../../frappe/frappe/public/js/lib/jquery/jquery.min.js');

(async () => {
    const browser = await chromium.launch({headless: true});
    const results = [];
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        async function setup() {
            await page.goto('about:blank');
            await page.setContent('<div id="desk"><button data-workdesk-action="call">Start Call</button><button class="btn-modal-primary">Start Call</button></div>');
            await page.addScriptTag({path: jquery});
            await page.evaluate(() => {window.frappe = {pages: {'vobiz-agent-console': {}}, show_alert() {}}; window.__ = x => x;});
            await page.addScriptTag({content: source + '\nwindow.TestConsole = VobizAgentConsole;'});
            await page.evaluate(() => {
                const row = {doctype:'CRM Lead', name:'LEAD1', phone:'+123', phone_field:'phone'};
                const c = window.c = Object.create(TestConsole.prototype);
                c.state = {softphone: {config: {call_device:'Phone'}}, active_call:{}, active_workdesk_row:row,
                    active_workdesk_body: $('#desk'), active_workdesk_dialog: {$wrapper:$('#desk'), get_primary_btn:() => $('.btn-modal-primary')}};
                window.actions = []; window.requests = 0;
                c.cancel_call_log = id => {actions.push('stop:' + id); return Promise.resolve();};
                c.get_softphone_tab_id = () => 'TAB';
                c.render_workdesk_live_call = c.refresh_workdesk_live_call = c.load = () => {};
                frappe.call = () => {
                    requests++;
                    return new Promise((resolve, reject) => {window.finishStart = resolve; window.failStart = reject;});
                };
                c.bind_workdesk_call_intent($('#desk'));
                $('#desk').on('click', '[data-workdesk-action]', event =>
                    c.handle_workdesk_action('call', row, {}, $('#desk'), event)?.catch(error => actions.push('error:' + error.message)));
                $('.btn-modal-primary').on('click', () =>
                    c.handle_workdesk_primary_action(row, c.consume_workdesk_call_intent($('.btn-modal-primary')[0]))?.catch(error => actions.push('error:' + error.message)));
                window.showCall = (id, status='Connected') => {
                    c.state.active_call = id ? {name:id, status, reference_doctype:row.doctype, reference_name:row.name} : {};
                    c.update_workdesk_primary_action(row);
                };
                showCall('');
            });
        }
        async function mouseDown(selector) {
            const b = await page.locator(selector).boundingBox();
            await page.mouse.move(b.x+b.width/2, b.y+b.height/2);
            await page.mouse.down();
        }
        for (const selector of ['[data-workdesk-action]', '.btn-modal-primary']) {
            for (const replacement of ['', 'NEW']) {
                await setup(); await page.evaluate(() => showCall('OLD'));
                await mouseDown(selector); await page.evaluate(id => showCall(id), replacement);
                await page.mouse.up();
                assert.deepEqual(await page.evaluate(() => ({requests, actions})), {requests:0, actions:[]});
                results.push('PASS Stop gesture preserved: '+selector+' replacement='+replacement);
            }
            await setup(); await page.evaluate(() => showCall('OLD'));
            await page.locator(selector).focus(); await page.keyboard.down('Space');
            await page.evaluate(() => showCall(''));
            await page.keyboard.up('Space');
            assert.deepEqual(await page.evaluate(() => ({requests, actions})), {requests:0, actions:[]});
            results.push('PASS keyboard Stop preserved: '+selector);

            await setup(); await page.locator(selector).dblclick();
            assert.equal(await page.evaluate(() => requests), 1);
            assert.equal(await page.locator(selector).isDisabled(), true);
            await page.evaluate(() => showCall('')); // A poll cannot re-enable pending Start.
            assert.equal(await page.locator(selector).isDisabled(), true);
            await page.evaluate(() => finishStart({message:{call_log:'C1', status:'Queued'}}));
            await page.waitForFunction(() => !c.start_call_in_flight);
            assert.deepEqual(await page.evaluate(() => actions), []);
            results.push('PASS double Start sends one request, no error: '+selector);

            // Completion of an exceptionally fast Start must not let the second click Stop it.
            await setup();
            await page.evaluate(() => {
                frappe.call = () => {requests++; showCall('FAST'); return Promise.resolve({message:{call_log:'FAST',status:'Queued'}});};
            });
            await page.locator(selector).dblclick();
            assert.deepEqual(await page.evaluate(() => ({requests, actions})), {requests:1, actions:[]});
            results.push('PASS fast Start double click cannot become Stop: '+selector);

            await setup(); await page.locator(selector).click();
            await page.evaluate(() => failStart(Error('offline')));
            await page.waitForFunction(() => !c.start_call_in_flight);
            assert.equal(await page.locator(selector).isDisabled(), false);
            await page.locator(selector).click();
            assert.equal(await page.evaluate(() => requests), 2);
            await page.evaluate(() => finishStart({message:{}}));
            results.push('PASS failed Start can retry: '+selector);
        }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({provider_calls:0, checks:results.length, results}, null, 2));
    } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
