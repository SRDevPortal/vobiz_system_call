const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'),
  'utf8'
);

function setup() {
  const requests = [];
  const ctx = {
    frappe: {
      pages: {'vobiz-agent-console': {}},
      show_alert() {},
      call(args) {
        requests.push(args);
        return Promise.resolve({message: {}});
      },
    },
    __: value => value,
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\nthis.ConsoleClass = VobizAgentConsole;', ctx);
  const obj = Object.create(ctx.ConsoleClass.prototype);
  obj.state = {softphone: {config: {}}};
  obj.get_softphone_tab_id = () => 'privacy-tab';
  obj.load = obj.update_workdesk_primary_action = () => {};
  const start = (row, choice) => obj.perform_start_call_for_row(row, choice, true);
  return {obj, requests, start};
}

test('private queue choice sends no masked or raw phone as destination', async () => {
  const context = setup();
  await context.start({
    doctype: 'CRM Lead',
    name: 'LEAD-1',
    phone: '******0101',
    phone_field: 'privacy:v1:opaque',
    phone_masked: true,
  });
  const args = context.requests.at(-1).args;
  assert.equal(args.phone_field, 'privacy:v1:opaque');
  assert.equal(args.phone_number, null);
  assert.equal(args.reference_name, 'LEAD-1');
});

test('selected patient choice sends only its opaque identifier', async () => {
  const context = setup();
  await context.start({doctype: 'Patient', name: 'PATIENT-1'}, {
    fieldname: 'privacy:v1:second-choice',
    number: '******0199',
    number_masked: true,
  });
  const args = context.requests.at(-1).args;
  assert.equal(args.phone_field, 'privacy:v1:second-choice');
  assert.equal(args.phone_number, null);
  assert.equal(args.patient_phone_selected, 1);
});

test('unrestricted calling retains existing arguments', async () => {
  const context = setup();
  await context.start({
    doctype: 'CRM Lead',
    name: 'LEAD-1',
    phone: '2025550101',
    phone_field: 'mobile_no',
  });
  const args = context.requests.at(-1).args;
  assert.equal(args.phone_number, '2025550101');
  assert.equal(args.phone_field, 'mobile_no');
});

test('masked incoming row matches trusted call and reference identity', () => {
  const {obj} = setup();
  obj.state.softphone.current_call_log = 'CALL-1';
  const row = {
    doctype: 'Patient',
    name: 'PATIENT-1',
    phone: '******0101',
    phone_masked: true,
  };
  assert.equal(obj.softphone_incoming_matches_row(row), false);
  obj.state.workdesk_live_call = {
    name: 'CALL-1',
    reference_doctype: 'Patient',
    reference_name: 'PATIENT-1',
  };
  assert.equal(obj.softphone_incoming_matches_row(row), true);
  obj.state.workdesk_live_call.reference_name = 'OTHER';
  assert.equal(obj.softphone_incoming_matches_row(row), false);
});
