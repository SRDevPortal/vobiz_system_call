// Exercise the actual Frappe FilterGroup event lifecycle with a minimal DOM adapter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class Element {
    constructor() { this.events = {}; this.visible = false; this.length = 1; }
    on(event, fn) { (this.events[event] ||= []).push(fn); return this; }
    off(event) { delete this.events[event]; return this; }
    emit(event) { for (const fn of this.events[event] || []) fn(); }
    popover(action) {
        if (typeof action === 'object') return this;
        const show = action === 'toggle' ? !this.visible : action === 'show';
        if (show === this.visible) return this;
        this.visible = show;
        this.emit(show ? 'shown.bs.popover' : 'hidden.bs.popover');
        return this;
    }
    find() { return this; }
    toggle() { return this; }
    toggleClass() { return this; }
    html() { return this; }
    attr() { return this; }
    is() { return this.visible; }
}
const button = new Element(), wrapper = new Element(), body = new Element();
const $ = target => target === '.filter-popover' ? wrapper : target;
$.extend = Object.assign;
const sandbox = {
    $, document: {body}, window: {},
    frappe: {pages: {'vobiz-agent-console': {}}, ui: {}, router: {on() {}},
        model: {with_doctype: (dt, fn) => fn()}},
    __: value => value
};
const nativeSource = fs.readFileSync(path.join(__dirname, '../../../frappe/frappe/public/js/frappe/ui/filters/filter_list.js'), 'utf8');
vm.runInNewContext(nativeSource, sandbox);
const NativeFilterGroup = sandbox.frappe.ui.FilterGroup;
// Only substitute DOM layout and individual field controls; retain native
// constructor, event binding, show/hide, apply, clear and button updates.
NativeFilterGroup.prototype.init_filter_popover = function() {};
NativeFilterGroup.prototype.set_filter_events = function() {};
NativeFilterGroup.prototype.add_filter = function(dt, field) {
    this.filters.push({field: true, get_value: () => [dt, field, '=', 'example'],
        get_selected_value: () => 'example', remove() {}});
};
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
vm.runInNewContext(source + ';globalThis.Console = VobizAgentConsole;', sandbox);
const c = Object.create(sandbox.Console.prototype);
let doctype = 'CRM Lead', loads = 0;
c.state = {queue_filters: [], queue_page: 3, selected_queue_keys: new Set(['lead'])};
c.page = {main: {find: () => button}};
c.queue_meta_value = () => doctype;
c.load = () => loads++;
c.render_filter_button = () => {};
c.open_filter_popover();
const group = c.state.filter_group;
assert(group instanceof NativeFilterGroup);
assert.equal(button.visible, true);
assert.equal((button.events.click || []).length, 0, 'Only delegated metadata-aware toggle');
button.popover('hide');
assert.equal(loads, 1, 'Native hide/apply refreshes queue');
assert.equal(c.state.queue_page, 1);
assert.equal(c.state.selected_queue_keys.size, 0);
c.open_filter_popover();
assert.equal(button.visible, true, 'Reopens on next click');
assert.equal(c.state.filter_group, group, 'Reuse native group');
assert.equal(group.get_filters()[0][0], 'CRM Lead', 'Applied filters retained');
button.popover('hide');
assert.equal(loads, 1, 'No duplicate refresh for unchanged filters');
doctype = 'Patient';
c.reset_filter_group_if_doctype_changed();
c.open_filter_popover();
assert.equal(group.doctype, 'Patient');
assert.equal(group.get_filters()[0][0], 'Patient', 'New rows use selected DocType');
button.popover('hide');
assert.equal(loads, 2);
group.clear_filters();
group.apply();
assert.equal(c.state.queue_filters.length, 0, 'Clear applies empty filters');
assert.equal(loads, 3);
for (const dt of ['CRM Lead', 'Patient', 'CRM Lead']) {
    doctype = dt;
    c.reset_filter_group_if_doctype_changed();
    c.open_filter_popover();
    assert.equal(button.visible, true);
    button.popover('hide');
}
assert.equal(button.events['shown.bs.popover'].length, 1);
assert.equal(button.events['hidden.bs.popover'].length, 1);
assert.equal(body.events.click.length, 1, 'Source changes do not accumulate outside-click handlers');
console.log('Native Frappe queue popover passed: open/reopen, apply, clear, source isolation and no duplicate handlers.');
