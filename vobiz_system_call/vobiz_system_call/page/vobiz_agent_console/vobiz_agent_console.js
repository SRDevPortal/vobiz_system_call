frappe.pages['vobiz-agent-console'].on_page_load = function(wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: '',
		single_column: true
	});
	$(wrapper).find('.page-head').hide();
	$(wrapper).find('.page-body').css('padding-top', '12px');
	wrapper.vobiz_agent_console = new VobizAgentConsole(page);
};

frappe.pages['vobiz-agent-console'].on_page_show = function(wrapper) {
	if (wrapper.vobiz_agent_console) {
		wrapper.vobiz_agent_console.on_page_show();
	}
};

frappe.pages['vobiz-agent-console'].on_page_hide = function(wrapper) {
	if (wrapper.vobiz_agent_console) {
		wrapper.vobiz_agent_console.on_page_hide();
	}
};

const VOBIZ_WHATSAPP_PAGE_SIZE = 30;
const VOBIZ_AGENT_IDLE_MS = 5 * 60 * 1000;
const VOBIZ_NETWORK_RECOVERY_MS = 30000;
const VOBIZ_MISSED_CALL_SEEN_KEY = 'vobiz_agent_console_missed_call_seen';

class VobizAgentConsole {
	constructor(page) {
		this.page = page;
		this.state = {
			queue: [],
			queue_meta: this.default_queue_meta(),
			selected: null,
			selected_queue_keys: new Set(),
			active_call: null,
			ending_active_call: false,
			call_started_at: null,
			dispositions: [],
			patient_followup_status_options: [],
			lead_disposition_context: {},
			ai_disposition_enabled: false,
			restore_checked: false,
			restore_in_flight: false,
			active_workdesk_key: null,
			active_workdesk_body: null,
			active_workdesk_row: null,
			active_workdesk_dialog: null,
			detail_loading_key: null,
			workdesk_live_call: null,
			workdesk_live_call_log: null,
			workdesk_live_polling: false,
			disposition_prompted_call_log: null,
			active_disposition_call_log: null,
			navigating_from_workdesk: false,
			last_callback_call_log: null,
			queue_filters: [],
			queue_sort_by: 'creation_desc',
			queue_page: 1,
			queue_page_size: 25,
			queue_has_more: false,
			missed_call_seen: this.load_missed_call_seen(),
			filter_group: null,
			auto_dial: {
				running: false,
				in_flight: false,
				queue: [],
				cursor: 0,
				results: [],
				events: [],
				current: null,
				awaiting_disposition: false,
				started_at: null,
				stopped_at: null
			},
			softphone: {
				config: null,
				client: null,
				sdk_loading: false,
				sdk_ready: false,
				registering: false,
				registered: false,
				in_call: false,
				muted: false,
				current_call_log: '',
				current_destination: '',
				current_customer: '',
				direction: '',
				incoming_call_uuid: '',
				incoming_caller: '',
				auto_connect_attempted: false,
				started_at: null,
				media_granted: false,
				diagnostics: {
					mic: 'checking',
					mic_message: __('Checking microphone'),
					audio: 'idle',
					audio_message: __('Audio test ready'),
					network: 'checking',
					network_message: __('Checking connection')
				},
				status: __('Not Connected'),
				error: ''
			}
		};
		this.timer = null;
		this.poller = null;
		this.load_in_flight = false;
		this.search_timer = null;
		this.heartbeat_timer = null;
		this.heartbeat_in_flight = false;
		this.last_heartbeat_at = 0;
		this.idle_timer = null;
		this.is_idle_offline = false;
		this.attendance_tab_id = this.get_attendance_tab_id();
		this.render();
		this.bind();
		this.bind_realtime();
		$(document).trigger('vobiz_refresh_availability');
		this.start_console_heartbeat();
		this.load_browser_softphone_config();
		this.load();
		this.start_polling();
	}

	default_queue_meta() {
		return {
			source: 'CRM Lead',
			doctype: 'CRM Lead',
			title: __('Lead Queue'),
			id_label: __('CRM Lead ID'),
			selected_label: __('leads'),
			summary_tab_label: __('CRM Lead'),
			data_label: __('CRM Lead Data'),
			empty_message: __('No callable records found')
		};
	}

	render() {
		this.page.main.html(`
			<div class="vobiz-console">
				<div class="vobiz-console-head">
					<div>
						<div class="vobiz-eyebrow">${__('APP / VOBIZ CALL CENTER / DIALER')}</div>
						<h2>${__('Vobiz Agent Call Center')}</h2>
					</div>
					<div class="vobiz-head-actions">
						<div class="vobiz-head-active-call hidden" data-role="head-active-call">
							<span class="vobiz-head-call-pulse"></span>
							<div class="vobiz-head-call-copy">
								<small data-role="head-call-status">${__('Active Call')}</small>
								<strong data-role="head-call-customer"></strong>
							</div>
							<button type="button" class="btn btn-danger btn-xs" data-action="end-active-call">
								<i class="fa fa-phone"></i> ${__('End Call')}
							</button>
							<button type="button" class="btn btn-success btn-xs" data-action="complete-active-call" title="${__('Mark this call log Completed')}">
								${__('Complete Call')}
							</button>
						</div>
						<button class="btn btn-default btn-sm" data-action="open-analytics">
							<i class="fa fa-line-chart"></i> ${__('Analytics')}
						</button>
						<div class="vobiz-agent-state">
							<span class="vobiz-state-dot"></span>
							<span data-role="availability">${__('Checking')}</span>
					</div>
					</div>
				</div>

				<section class="vobiz-band vobiz-dialer-control">
					<div>
						<strong>${__('Auto-Dial Controls')}</strong>
						<div class="text-muted" data-role="selected-count">${__('0 leads selected')}</div>
					</div>
					<div class="vobiz-actions">
						<button class="btn btn-default btn-sm" data-action="refresh">
							<i class="fa fa-refresh"></i> ${__('Refresh')}
						</button>
						<button class="btn btn-primary btn-sm" data-action="toggle-auto" data-role="auto-toggle">
							<i class="fa fa-play"></i> ${__('Start Auto Dial')}
						</button>
						<button class="btn btn-default btn-sm" data-action="auto-report">
							<i class="fa fa-list"></i> ${__('Auto Dial Report')}
						</button>
					</div>
				</section>

				<section class="vobiz-band vobiz-softphone hidden" data-role="softphone-panel">
					<div class="vobiz-softphone-main">
						<div class="vobiz-softphone-state">
							<span class="vobiz-softphone-dot" data-role="softphone-dot"></span>
							<div>
								<strong>${__('Browser Softphone')}</strong>
								<div class="text-muted" data-role="softphone-status">${__('Not Connected')}</div>
							</div>
						</div>
						<div class="vobiz-softphone-meta">
							<span data-role="softphone-endpoint"></span>
							<span data-role="softphone-answer-url"></span>
						</div>
						<div class="vobiz-softphone-diagnostics" data-role="softphone-diagnostics"></div>
						<div class="vobiz-softphone-live hidden" data-role="softphone-live"></div>
					</div>
					<div class="vobiz-softphone-actions">
						<button class="btn btn-primary btn-sm hidden" data-action="softphone-use-here">${__('Use here')}</button>
						<button class="btn btn-default btn-sm" data-action="softphone-test-mic">
							<i class="fa fa-microphone"></i> ${__('Test Mic')}
						</button>
						<button class="btn btn-default btn-sm" data-action="softphone-test-audio">
							<i class="fa fa-volume-up"></i> ${__('Test Audio')}
						</button>
						<button class="btn btn-success btn-sm hidden" data-action="softphone-answer">
							<i class="fa fa-phone"></i> ${__('Pick Call')}
						</button>
						<button class="btn btn-default btn-sm hidden" data-action="softphone-workdesk">
							<i class="fa fa-address-card-o"></i> ${__('Open Workdesk')}
						</button>
						<button class="btn btn-danger btn-sm hidden" data-action="softphone-stop">
							<i class="fa fa-phone"></i> ${__('Stop Call')}
						</button>
						<button class="btn btn-default btn-sm hidden" data-action="softphone-mute">
							<i class="fa fa-microphone-slash"></i> <span>${__('Mute')}</span>
						</button>
					</div>
					<button class="btn btn-xs btn-default" data-action="softphone-enable-audio">${__("Enable audio")}</button>
					<audio data-role="softphone-audio" controls autoplay playsinline></audio>
					<div data-role="mic-test-panel" class="hidden" style="margin-top:8px">
						<label>${__('Microphone input')} <meter data-role="mic-test-level" min="0" max="100" value="0" style="width:180px;vertical-align:middle"></meter></label>
						<span data-role="mic-test-message" role="status" aria-live="polite"></span>
						<button class="btn btn-xs btn-default" data-action="softphone-stop-mic-test">${__('Stop test')}</button>
					</div>
				</section>

				<div class="vobiz-layout">
					<section class="vobiz-band vobiz-queue">
						<div class="vobiz-section-title">
							<h3 data-role="queue-title">${__('Lead Queue')}</h3>
							<div class="vobiz-queue-tools">
								<select class="form-control input-sm hidden" data-role="queue-source-filter"></select>
								<select class="form-control input-sm" data-role="queue-sort">
									<option value="modified_desc">${__('Recently Updated')}</option>
									<option value="modified_asc">${__('Oldest Updated')}</option>
									<option value="creation_desc" selected>${__('Newest Created')}</option>
									<option value="creation_asc">${__('Oldest Created')}</option>
									<option value="name_asc">${__('Name A-Z')}</option>
									<option value="name_desc">${__('Name Z-A')}</option>
									<option value="whatsapp_unread_desc">${__('New WhatsApp Msgs')}</option>
									<option value="next_follow_up_asc">${__('Next Follow-up')}</option>
								</select>
								<button class="btn btn-default btn-sm vobiz-filter-btn" data-action="open-filters">
									<i class="fa fa-filter filter-icon"></i> <span class="button-label">${__('Filters')}</span>
								</button>
								<input class="form-control input-sm" data-role="search" placeholder="${__('Search')}">
							</div>
						</div>
						<div class="vobiz-table-wrap">
							<table class="table table-sm vobiz-table">
								<thead>
									<tr>
										<th style="width: 34px"><input type="checkbox" data-role="check-all"></th>
										<th style="width: 170px" data-role="queue-id-label">${__('CRM Lead ID')}</th>
										<th>${__('Name')}</th>
										<th>${__('Phone')}</th>
										<th style="width: 112px">${__('Missed Call')}</th>
										<th style="width: 92px">${__('WhatsApp')}</th>
										<th class="vobiz-patient-col hidden">${__('Department')}</th>
										<th class="vobiz-patient-col hidden">${__('Disease')}</th>
										<th class="vobiz-patient-col hidden">${__('Language')}</th>
										<th class="vobiz-patient-col hidden">${__('Follow-up ID')}</th>
										<th class="vobiz-patient-col hidden">${__('Day')}</th>
										<th class="vobiz-team-col">${__('Team')}</th>
										<th class="vobiz-lead-owner-col">${__('Lead Owner')}</th>
										<th style="width: 150px">${__('Status')}</th>
										<th style="width: 150px">${__('Next Action')}</th>
										<th style="width: 86px">${__('Updated On')}</th>
										<th style="width: 180px">${__('Created On')}</th>
										<th style="width: 88px">${__('Action')}</th>
									</tr>
								</thead>
								<tbody data-role="queue"></tbody>
							</table>
						</div>
						<div class="vobiz-pagination" data-role="queue-pagination">
							<div class="vobiz-page-summary" data-role="queue-page-summary"></div>
							<div class="vobiz-page-controls">
								<select class="form-control input-sm" data-role="queue-page-size">
									<option value="10">10</option>
									<option value="25" selected>25</option>
									<option value="50">50</option>
									<option value="100">100</option>
								</select>
								<button class="btn btn-default btn-sm" data-action="queue-page-prev"><i class="fa fa-chevron-left"></i></button>
								<span class="vobiz-page-number" data-role="queue-page-number"></span>
								<button class="btn btn-default btn-sm" data-action="queue-page-next"><i class="fa fa-chevron-right"></i></button>
							</div>
						</div>
					</section>

					</div>
				</div>
			`);
		this.inject_styles();
	}

	inject_styles() {
		if ($('#vobiz-agent-console-style').length) return;
		$('head').append(`
			<style id="vobiz-agent-console-style">
				.vobiz-console { background: #f7f7fb; margin: 0 -15px -15px; min-height: calc(100vh - 72px); overflow-x: hidden; padding: 24px; }
				.vobiz-console-head { align-items: center; display: flex; justify-content: space-between; margin-bottom: 20px; }
				.vobiz-console-head h2 { font-size: 22px; font-weight: 700; margin: 0; }
				.vobiz-eyebrow { color: #6b7280; font-size: 11px; font-weight: 700; letter-spacing: .04em; margin-bottom: 4px; }
				.vobiz-head-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
				.vobiz-head-active-call { align-items: center; background: #fff7ed; border: 1px solid #fdba74; border-radius: 7px; display: flex; gap: 9px; max-width: 420px; padding: 5px 7px 5px 10px; }
				.vobiz-head-active-call.hidden { display: none; }
				.vobiz-head-call-pulse { animation: vobiz-call-pulse 1.4s infinite; background: #16a34a; border-radius: 50%; flex: 0 0 auto; height: 9px; width: 9px; }
				.vobiz-head-call-copy { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
				.vobiz-head-call-copy small { color: #9a3412; font-size: 10px; font-weight: 800; text-transform: uppercase; }
				.vobiz-head-call-copy strong { color: #431407; max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				@keyframes vobiz-call-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(22, 163, 74, .35); } 50% { box-shadow: 0 0 0 5px rgba(22, 163, 74, 0); } }
				.vobiz-agent-state { align-items: center; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; display: flex; gap: 8px; padding: 8px 12px; }
				.vobiz-state-dot { background: #16a34a; border-radius: 50%; height: 9px; width: 9px; }
				.vobiz-stats { display: grid; gap: 16px; grid-template-columns: repeat(6, minmax(0, 1fr)); margin-bottom: 16px; }
				.vobiz-stat { background: #fff; border: 1px solid #ebeef2; border-radius: 8px; padding: 18px; }
				.vobiz-stat.clickable { cursor: pointer; transition: border-color .15s ease, transform .15s ease; }
				.vobiz-stat.clickable:hover { border-color: #b8d8ff; transform: translateY(-1px); }
				.vobiz-stat strong { display: block; font-size: 28px; line-height: 1.1; margin-top: 10px; }
				.vobiz-stat span { color: #4b5563; font-size: 12px; font-weight: 700; }
				.vobiz-stat small { color: #6b7280; display: block; font-size: 11px; margin-top: 7px; min-height: 15px; }
				.vobiz-stat.danger { border-top: 4px solid #dc2626; }
				.vobiz-stat.success { border-top: 4px solid #16a34a; }
				.vobiz-stat.warning { border-top: 4px solid #ca8a04; }
				.vobiz-stat.info { border-top: 4px solid #0284c7; }
				.vobiz-stat.neutral { border-top: 4px solid #64748b; }
				.vobiz-performance-head { align-items: center; display: flex; justify-content: space-between; margin-bottom: 14px; }
				.vobiz-performance-head h4 { font-size: 18px; font-weight: 800; margin: 2px 0 0; }
				.vobiz-perf-kpis { display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 18px; }
				.vobiz-perf-kpi { background: #f9fafb; border: 1px solid #eef0f3; border-radius: 8px; padding: 12px; }
				.vobiz-perf-kpi span { color: #6b7280; display: block; font-size: 11px; font-weight: 800; margin-bottom: 6px; text-transform: uppercase; }
				.vobiz-perf-kpi strong { font-size: 24px; line-height: 1; }
				.vobiz-performance-section { border-top: 1px solid #eef0f3; margin-top: 14px; padding-top: 14px; }
				.vobiz-performance-section h4 { font-size: 15px; font-weight: 800; margin: 0 0 10px; }
				.vobiz-performance-table { table-layout: auto; }
				.vobiz-performance-table th { color: #6b7280; font-size: 11px; font-weight: 800; }
				.vobiz-performance-table td { vertical-align: middle; white-space: normal; word-break: break-word; }
				.vobiz-performance-table code { white-space: nowrap; }
				.vobiz-icon { align-items: center; border: 1px solid currentColor; border-radius: 6px; display: inline-flex; height: 30px; justify-content: center; width: 30px; }
				.vobiz-band { background: #fff; border: 1px solid #ebeef2; border-radius: 8px; margin-bottom: 16px; padding: 16px; }
				.vobiz-dialer-control { align-items: center; display: flex; justify-content: space-between; }
				.vobiz-actions { display: flex; gap: 10px; }
				.vobiz-softphone { align-items: center; display: flex; gap: 14px; justify-content: space-between; margin-bottom: 14px; }
				.vobiz-softphone.hidden { display: none; }
				.vobiz-softphone-main { display: grid; flex: 1 1 auto; gap: 8px; min-width: 0; }
				.vobiz-softphone-state { align-items: center; display: flex; gap: 10px; min-width: 0; }
				.vobiz-softphone-dot { background: #9ca3af; border-radius: 50%; flex: 0 0 auto; height: 10px; width: 10px; }
				.vobiz-softphone-dot.online { background: #16a34a; box-shadow: 0 0 0 4px rgba(22, 163, 74, .12); }
				.vobiz-softphone-dot.connecting { background: #f59e0b; box-shadow: 0 0 0 4px rgba(245, 158, 11, .14); }
				.vobiz-softphone-dot.in-call { animation: vobiz-call-pulse 1.4s infinite; background: #2563eb; }
				.vobiz-softphone-dot.error { background: #dc2626; }
				.vobiz-softphone-meta { color: #6b7280; display: flex; flex-wrap: wrap; font-size: 11px; gap: 10px; line-height: 1.35; }
				.vobiz-softphone-meta span { overflow-wrap: anywhere; }
				.vobiz-softphone-diagnostics { display: flex; flex-wrap: wrap; gap: 6px; }
				.vobiz-health-chip { align-items: center; background: #fff; border: 1px solid #e5e7eb; border-radius: 999px; color: #4b5563; display: inline-flex; font-size: 11px; font-weight: 800; gap: 5px; line-height: 1; padding: 5px 8px; }
				.vobiz-health-chip.ok { background: #f0fdf4; border-color: #86efac; color: #15803d; }
				.vobiz-health-chip.warn { background: #fffbeb; border-color: #fde68a; color: #92400e; }
				.vobiz-health-chip.error { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
				.vobiz-softphone-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
				.vobiz-softphone audio { display: none; }
				.vobiz-softphone-live { align-items: center; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; display: grid; gap: 10px; grid-template-columns: 54px minmax(0, 1fr); padding: 10px; }
				.vobiz-softphone-live.hidden { display: none; }
				.vobiz-softphone-phone { align-items: center; background: #111827; border-radius: 8px; color: #fff; display: flex; height: 54px; justify-content: center; position: relative; width: 54px; }
				.vobiz-softphone-phone .fa { font-size: 21px; }
				.vobiz-softphone-phone:after { animation: vobiz-phone-ring 1.2s ease-in-out infinite; border: 2px solid rgba(37, 99, 235, .55); border-radius: 10px; content: ""; inset: -4px; position: absolute; }
				.vobiz-softphone-live-title { font-size: 14px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.vobiz-softphone-live-number { color: #4b5563; font-size: 12px; font-weight: 700; overflow-wrap: anywhere; }
				.vobiz-softphone-live-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
				.vobiz-softphone-chip { align-items: center; background: #fff; border: 1px solid #e5e7eb; border-radius: 999px; color: #374151; display: inline-flex; font-size: 11px; font-weight: 800; gap: 5px; line-height: 1; padding: 5px 8px; }
				.vobiz-softphone-chip.ok { border-color: #bbf7d0; color: #15803d; }
				.vobiz-softphone-chip.warn { border-color: #fde68a; color: #92400e; }
				.vobiz-softphone-wave { align-items: end; display: inline-flex; gap: 3px; height: 12px; margin-left: 2px; }
				.vobiz-softphone-wave span { animation: vobiz-wave 1s ease-in-out infinite; background: currentColor; border-radius: 999px; display: block; height: 6px; width: 3px; }
				.vobiz-softphone-wave span:nth-child(2) { animation-delay: .12s; height: 11px; }
				.vobiz-softphone-wave span:nth-child(3) { animation-delay: .24s; height: 8px; }
				@keyframes vobiz-phone-ring { 0%, 100% { opacity: .28; transform: scale(.96); } 50% { opacity: .85; transform: scale(1.04); } }
				@keyframes vobiz-wave { 0%, 100% { transform: scaleY(.55); } 50% { transform: scaleY(1); } }
				.vobiz-layout { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
				.vobiz-section-title { align-items: center; display: flex; gap: 12px; justify-content: space-between; margin-bottom: 12px; }
				.vobiz-section-title h3 { font-size: 15px; font-weight: 700; margin: 0; }
				.vobiz-queue-tools { display: flex; gap: 8px; justify-content: flex-end; min-width: 280px; }
				.vobiz-filter-btn { align-items: center !important; display: inline-flex !important; flex: 0 0 auto; gap: 6px; justify-content: center; min-width: 86px; white-space: nowrap !important; width: auto !important; }
				.vobiz-filter-btn .filter-icon, .vobiz-filter-btn .button-label { display: inline-block; line-height: 1; white-space: nowrap; }
				.vobiz-queue-tools select { max-width: 150px; }
				.vobiz-queue-tools input { max-width: 260px; }
				.vobiz-table-wrap { overflow-x: auto; }
				.vobiz-table { margin: 0; table-layout: fixed; }
				.vobiz-table th { color: #6b7280; font-size: 11px; font-weight: 700; }
				.vobiz-table td { overflow: hidden; text-overflow: ellipsis; vertical-align: middle; white-space: nowrap; }
				.vobiz-table .hidden { display: none; }
				.vobiz-table tr.vobiz-callback-highlight td { background: #eff6ff !important; border-bottom-color: #bfdbfe; border-top: 1px solid #93c5fd; }
				.vobiz-table tr.vobiz-callback-highlight td:first-child { box-shadow: inset 4px 0 0 #2563eb; }
				.vobiz-pagination { align-items: center; border-top: 1px solid #eef0f3; display: flex; gap: 12px; justify-content: space-between; margin-top: 12px; padding-top: 12px; }
				.vobiz-page-summary { color: #6b7280; font-size: 12px; }
				.vobiz-page-controls { align-items: center; display: flex; gap: 8px; }
				.vobiz-page-controls select { width: 78px; }
				.vobiz-page-number { color: #374151; font-size: 12px; font-weight: 700; min-width: 86px; text-align: center; }
				.vobiz-person { align-items: center; display: flex; gap: 9px; min-width: 0; }
				.vobiz-avatar { align-items: center; background: #eaf3ff; border-radius: 50%; color: #2563eb; display: inline-flex; flex: 0 0 auto; font-weight: 700; height: 28px; justify-content: center; width: 28px; }
				.vobiz-status { font-size: 12px; font-weight: 700; }
				.vobiz-status.New { color: #0284c7; } .vobiz-status.Qualified, .vobiz-status.Converted { color: #16a34a; }
				.vobiz-status.Not { color: #dc2626; } .vobiz-status.Contacted { color: #ca8a04; }
				.vobiz-missed-cell { align-items: center; display: inline-flex; height: 28px; justify-content: center; min-width: 32px; position: relative; }
				.vobiz-missed-cell.clickable { cursor: pointer; }
				.vobiz-missed-count { align-items: center; background: #f3f4f6; border: 1px solid #eef0f3; border-radius: 6px; color: #111827; display: inline-flex; font-size: 12px; font-weight: 900; height: 28px; justify-content: center; min-width: 32px; padding: 0 7px; }
				button.vobiz-missed-cell { background: transparent; border: 0; padding: 0; }
				button.vobiz-missed-cell:focus .vobiz-missed-count, button.vobiz-missed-cell:hover .vobiz-missed-count { background: #fee2e2; border-color: #fecaca; color: #991b1b; }
				.vobiz-missed-badge { align-items: center; background: #ef4444; border: 2px solid #fff; border-radius: 999px; color: #fff; display: inline-flex; font-size: 9px; height: 18px; justify-content: center; line-height: 1; min-width: 18px; position: absolute; right: -6px; top: -7px; }
				.vobiz-missed-badge .fa { transform: rotate(135deg); }
				.vobiz-missed-cell.has-new .vobiz-missed-badge { animation: vobiz-missed-pulse 1.2s ease-in-out infinite; box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45); }
				.vobiz-missed-empty { opacity: 0.75; }
				@keyframes vobiz-missed-pulse { 0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.45); } 70% { box-shadow: 0 0 0 7px rgba(220, 38, 38, 0); } 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); } }
				.vobiz-missed-list { display: grid; gap: 10px; max-height: 520px; overflow: auto; }
				.vobiz-missed-row { border: 1px solid #eef0f3; border-radius: 8px; display: grid; gap: 8px; padding: 10px; }
				.vobiz-missed-row-head { align-items: center; display: flex; gap: 10px; justify-content: space-between; }
				.vobiz-missed-row-head strong { font-size: 13px; }
				.vobiz-missed-row-grid { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
				.vobiz-missed-row-grid span { color: #6b7280; display: block; font-size: 11px; font-weight: 800; margin-bottom: 2px; }
				.vobiz-missed-row-grid div { min-width: 0; overflow-wrap: anywhere; }
				.vobiz-wa-queue { align-items: center; border-radius: 999px; display: inline-flex; font-size: 12px; font-weight: 800; gap: 5px; justify-content: center; min-height: 26px; min-width: 52px; padding: 3px 9px; }
				.vobiz-wa-queue.has-new { background: #dcfce7; border-color: #86efac; color: #15803d; }
				.vobiz-wa-queue.is-quiet { color: #dc2626; }
				.vobiz-wa-count { background: #16a34a; border-radius: 999px; color: #fff; font-size: 10px; line-height: 1; min-width: 17px; padding: 3px 5px; text-align: center; }
				.vobiz-wa-empty { color: #9ca3af; font-weight: 700; }
				.vobiz-side { min-width: 0; }
				.vobiz-pill { background: #eff6ff; border-radius: 999px; color: #2563eb; font-size: 12px; padding: 3px 8px; }
				.vobiz-call-focus { border-top: 1px solid #eef0f3; padding-top: 12px; }
				.vobiz-call-title { font-size: 16px; font-weight: 700; }
				.vobiz-call-timer { font-size: 36px; font-weight: 800; margin: 12px 0; }
				.vobiz-call-controls { display: flex; gap: 8px; }
				.vobiz-call-assets { border-top: 1px solid #eef0f3; font-size: 12px; margin-top: 12px; padding-top: 10px; }
				.vobiz-call-assets a { font-weight: 700; }
				.vobiz-auto-call-dialog .modal-dialog { max-width: min(520px, calc(100vw - 32px)); }
				.vobiz-auto-call-dialog .modal-body { padding: 16px; }
				.vobiz-auto-call-dialog .vobiz-band { margin-bottom: 0; }
				.vobiz-auto-live { border-top: 1px solid #eef0f3; display: grid; gap: 8px; max-height: 220px; overflow: auto; padding-top: 10px; }
				.vobiz-auto-event { border-left: 3px solid #d1d5db; padding-left: 8px; }
				.vobiz-auto-event.active { border-color: #0ea5e9; }
				.vobiz-auto-event.done { border-color: #16a34a; }
				.vobiz-auto-event.failed { border-color: #dc2626; }
				.vobiz-auto-event strong { display: block; font-size: 12px; }
				.vobiz-auto-event span { color: #6b7280; display: block; font-size: 11px; overflow-wrap: anywhere; }
				.vobiz-live-call { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 12px; padding: 12px; }
				.vobiz-live-call-head { align-items: center; display: flex; justify-content: space-between; margin-bottom: 10px; }
				.vobiz-live-call-head strong { font-size: 13px; }
				.vobiz-live-pill { background: #eef2ff; border-radius: 999px; color: #3730a3; font-size: 11px; font-weight: 800; padding: 3px 8px; }
				.vobiz-live-phone { align-items: center; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; display: grid; gap: 10px; grid-template-columns: 46px minmax(0, 1fr); margin-bottom: 12px; padding: 10px; }
				.vobiz-live-phone-icon { align-items: center; background: #111827; border-radius: 8px; color: #fff; display: flex; height: 46px; justify-content: center; width: 46px; }
				.vobiz-live-phone-title { font-size: 13px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.vobiz-live-phone-number { color: #4b5563; font-size: 12px; font-weight: 700; overflow-wrap: anywhere; }
				.vobiz-live-steps { display: grid; gap: 8px; }
				.vobiz-live-step { align-items: start; display: grid; gap: 9px; grid-template-columns: 22px minmax(0, 1fr); }
				.vobiz-live-dot { background: #d1d5db; border-radius: 50%; height: 10px; margin: 5px auto 0; width: 10px; }
				.vobiz-live-step.active .vobiz-live-dot { background: #0ea5e9; box-shadow: 0 0 0 4px rgba(14, 165, 233, .12); }
				.vobiz-live-step.done .vobiz-live-dot { background: #16a34a; }
				.vobiz-live-step.failed .vobiz-live-dot { background: #dc2626; }
				.vobiz-live-title { font-size: 12px; font-weight: 800; }
				.vobiz-live-meta { color: #6b7280; font-size: 12px; overflow-wrap: anywhere; }
				.vobiz-transcript { background: #f9fafb; border: 1px solid #eef0f3; border-radius: 6px; margin-top: 6px; max-height: 120px; overflow: auto; padding: 8px; white-space: pre-wrap; }
				.vobiz-side textarea, .vobiz-side select { margin-bottom: 10px; }
				.vobiz-tabs { border-bottom: 1px solid #e5e7eb; display: flex; flex-wrap: wrap; gap: 20px; margin: -4px 0 16px; max-width: 100%; }
				.vobiz-tabs button { background: none; border: 0; border-bottom: 2px solid transparent; font-weight: 700; padding: 8px 0; }
				.vobiz-tabs button.active { border-color: #111827; }
				.vobiz-context-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) 360px; min-height: 210px; }
				.vobiz-guidance-list { margin: 0; padding-left: 18px; }
				.vobiz-history-row { border-bottom: 1px solid #eef0f3; display: grid; gap: 8px; grid-template-columns: 130px 100px 1fr; padding: 8px 0; }
				.vobiz-info-list { display: grid; gap: 14px; margin-top: 12px; }
				.vobiz-info-row { align-items: center; display: grid; gap: 12px; grid-template-columns: 38px minmax(0, 1fr); }
				.vobiz-info-icon { align-items: center; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 50%; display: flex; height: 38px; justify-content: center; width: 38px; }
				.vobiz-detail-head { align-items: center; display: flex; gap: 12px; justify-content: space-between; margin-bottom: 14px; }
				.vobiz-detail-head h3 { font-size: 16px; font-weight: 700; margin: 0; }
				.vobiz-audio-list { display: grid; gap: 12px; }
				.vobiz-audio-card { border: 1px solid #eef0f3; border-radius: 8px; padding: 12px; }
				.modal-dialog.modal-xl, .modal-dialog.modal-extra-large { max-width: min(1200px, calc(100vw - 32px)); }
				.vobiz-workdesk-modal { overflow-x: hidden; }
				.vobiz-workdesk-modal .modal-dialog { margin-left: auto; margin-right: auto; max-width: min(1180px, calc(100vw - 64px)) !important; width: auto !important; }
				.vobiz-workdesk-modal .modal-content, .vobiz-workdesk-modal .modal-body, .vobiz-workdesk-modal .form-layout, .vobiz-workdesk-modal .form-page, .vobiz-workdesk-modal .form-section, .vobiz-workdesk-modal .section-body { max-width: 100%; min-width: 0; overflow-x: hidden; }
				.modal-body { overflow-x: hidden; }
				.modal-body .form-column, .modal-body .frappe-control, .modal-body [data-fieldname="details"] { max-width: 100%; min-width: 0; overflow-x: hidden; }
				.vobiz-detail-dialog, .vobiz-detail-dialog * { box-sizing: border-box; max-width: 100%; }
				.vobiz-detail-dialog { overflow-x: hidden; width: 100%; }
				.vobiz-workdesk { max-width: 100%; min-height: 520px; min-width: 0; overflow-x: hidden; }
				.vobiz-workdesk-top { margin-bottom: 14px; }
				.vobiz-workdesk-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-start; margin-top: 10px; }
				.vobiz-workdesk-actions .btn { white-space: nowrap; }
				.vobiz-workdesk-title { min-width: 0; }
				.vobiz-workdesk-title h3 { font-size: 18px; font-weight: 800; margin: 0 0 4px; overflow-wrap: anywhere; }
				.vobiz-call-route { align-items: center; color: #4b5563; display: flex; flex-wrap: wrap; font-size: 12px; gap: 8px; margin-top: 8px; }
				.vobiz-call-route-chip { background: #f9fafb; border: 1px solid #eef0f3; border-radius: 6px; font-weight: 700; max-width: 100%; overflow-wrap: anywhere; padding: 4px 8px; }
				.vobiz-call-route-icon { color: #059669; }
				.vobiz-workdesk-grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
				.vobiz-workdesk-card { border: 1px solid #eef0f3; border-radius: 8px; min-width: 0; overflow-x: hidden; padding: 12px; }
				.vobiz-workdesk-wide { grid-column: 1 / -1; }
				.vobiz-workdesk-card h4 { font-size: 13px; font-weight: 800; margin: 0 0 10px; }
				.vobiz-field-grid { display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
				.vobiz-field { background: #f9fafb; border-radius: 6px; min-height: 54px; padding: 8px; }
				.vobiz-field-label { color: #6b7280; font-size: 11px; font-weight: 700; margin-bottom: 4px; }
				.vobiz-field-value { font-weight: 700; overflow-wrap: anywhere; }
				.vobiz-related-row { align-items: center; border-bottom: 1px solid #eef0f3; display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) auto; padding: 8px 0; }
				.vobiz-related-row:last-child { border-bottom: 0; }
				.vobiz-related-title { font-weight: 700; overflow-wrap: anywhere; }
				.vobiz-related-meta { color: #6b7280; font-size: 12px; overflow-wrap: anywhere; }
				.vobiz-clinical-history { display: grid; gap: 12px; }
				.vobiz-clinical-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
				.vobiz-clinical-head { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; margin-bottom: 10px; }
				.vobiz-clinical-head span { color: #6b7280; font-size: 12px; }
				.vobiz-clinical-section { border-top: 1px solid #f0f2f5; padding: 9px 0; }
				.vobiz-clinical-label { color: #374151; font-size: 12px; font-weight: 800; margin-bottom: 4px; }
				.vobiz-clinical-text { color: #4b5563; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
				.vobiz-clinical-med-table { margin-bottom: 0; table-layout: fixed; }
				.vobiz-clinical-med-table th { color: #6b7280; font-size: 11px; font-weight: 800; }
				.vobiz-clinical-med-table td { font-size: 12px; white-space: normal; word-break: break-word; }
				.vobiz-empty { color: #6b7280; padding: 12px 0; }
				.vobiz-wa-chat-list { background: #f9fafb; border: 1px solid #eef0f3; border-radius: 8px; display: grid; gap: 8px; margin-top: 12px; max-height: 420px; min-width: 0; overflow-x: hidden; overflow-y: auto; padding: 10px; width: 100%; }
				.vobiz-wa-loader { color: #64748b; cursor: pointer; font-size: 12px; font-weight: 700; padding: 6px; text-align: center; }
				.vobiz-wa-message { border: 1px solid #eef0f3; border-radius: 8px; max-width: min(82%, 860px); min-width: 0; overflow: hidden; padding: 8px 10px; }
				.vobiz-wa-message.inbound { background: #fff; justify-self: start; }
				.vobiz-wa-message.outbound { background: #ecfdf5; justify-self: end; }
				.vobiz-wa-message-meta { color: #6b7280; font-size: 11px; font-weight: 700; margin-bottom: 4px; }
				.vobiz-wa-message-body { font-size: 13px; white-space: pre-wrap; word-break: break-word; }
				.vobiz-wa-delivery-status { align-items: center; color: #64748b; display: flex; font-size: 11px; gap: 4px; justify-content: flex-end; margin-top: 4px; }
				.vobiz-wa-delivery-status svg { height: 12px; width: 18px; }
				.vobiz-wa-delivery-status.is-read { color: #0369a1; }
				.vobiz-wa-delivery-status.is-failed { color: #b91c1c; }
				.vobiz-wa-media { display: block; margin-top: 6px; }
				.vobiz-wa-image { border-radius: 8px; display: block; height: auto; max-height: 360px; max-width: 260px; object-fit: contain; width: auto; }
				.vobiz-wa-media-link { align-items: center; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; display: inline-flex; gap: 8px; padding: 8px 10px; text-decoration: none; }
				.vobiz-wa-window { align-items: center; background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; color: #78350f; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; padding: 10px 12px; font-size: 12px; }
				.vobiz-wa-window span { flex: 1 1 220px; }
				.vobiz-wa-window.is-open { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
				.vobiz-wa-window.is-pending { background: #f8fafc; border-color: #e2e8f0; color: #475569; }
				.vobiz-wa-icon-btn:disabled { opacity: .45; cursor: not-allowed; }
				.vobiz-wa-composer { align-items: center; background: #fff; border: 1px solid #e5e7eb; border-radius: 18px; box-shadow: 0 1px 6px rgba(15, 23, 42, .06); display: grid; gap: 6px; grid-template-columns: 32px 32px 32px minmax(0, 1fr) 42px; margin-top: 12px; max-width: 100%; min-width: 0; overflow: visible; padding: 8px 10px; width: 100%; }
				.vobiz-wa-icon-btn { align-items: center; background: transparent; border: 0; color: #111827; display: inline-flex; font-size: 17px; height: 32px; justify-content: center; min-width: 32px; padding: 0; width: 32px; }
				.vobiz-wa-attach-wrap, .vobiz-wa-emoji-wrap { position: relative; }
				.vobiz-wa-menu { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; bottom: 42px; box-shadow: 0 12px 30px rgba(15, 23, 42, .16); display: none; left: 0; min-width: 190px; padding: 8px; position: absolute; z-index: 10; }
				.vobiz-wa-menu.show { display: grid; gap: 4px; }
				.vobiz-wa-menu button { align-items: center; background: transparent; border: 0; border-radius: 8px; display: flex; gap: 10px; padding: 8px 10px; text-align: left; width: 100%; }
				.vobiz-wa-menu button:hover { background: #f3f4f6; }
				.vobiz-wa-emoji-menu { grid-template-columns: repeat(8, 30px); min-width: 276px; }
				.vobiz-wa-emoji-menu button { font-size: 18px; justify-content: center; padding: 4px; }
				.vobiz-wa-composer textarea { background: transparent; border: 0; box-shadow: none; height: 36px; line-height: 20px; margin: 0; max-height: 96px; min-height: 36px; min-width: 0; padding: 8px 4px; resize: none; width: 100%; }
				.vobiz-wa-composer textarea:focus { border: 0; box-shadow: none; outline: 0; }
				.vobiz-wa-send { align-items: center; background: #16a34a; border: 0; border-radius: 50%; color: #fff; display: inline-flex; font-size: 18px; height: 42px; justify-content: center; padding: 0; width: 42px; }
				.vobiz-wa-send:disabled { opacity: .65; }
				.vobiz-dialpad { align-items: center; display: grid; gap: 14px; grid-template-columns: 110px minmax(0, 1fr); }
				.vobiz-pad-grid { display: grid; gap: 8px; grid-template-columns: repeat(3, 1fr); }
				.vobiz-pad-grid button { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 6px; font-weight: 700; height: 38px; }
				.vobiz-wave { align-items: center; display: flex; gap: 4px; height: 120px; }
				.vobiz-wave span { background: #6b7280; border-radius: 999px; display: block; width: 5px; }
				.vobiz-callback-popup { align-items: flex-start; display: grid; gap: 14px; grid-template-columns: 44px minmax(0, 1fr); }
				.vobiz-callback-icon { align-items: center; background: #ecfdf5; border: 1px solid #bbf7d0; border-radius: 50%; color: #16a34a; display: flex; font-size: 18px; height: 44px; justify-content: center; width: 44px; }
				.vobiz-callback-popup h4 { font-size: 16px; font-weight: 800; margin: 0 0 10px; }
				.vobiz-callback-row { align-items: center; border-top: 1px solid #eef0f3; display: grid; gap: 10px; grid-template-columns: 110px minmax(0, 1fr); padding: 8px 0; }
				.vobiz-callback-row span { color: #6b7280; font-size: 12px; font-weight: 700; }
				.vobiz-callback-row strong { overflow-wrap: anywhere; }
				.vobiz-template-card { background: #f9fafb; border: 1px solid #eef0f3; border-radius: 8px; display: grid; gap: 8px; margin-top: 10px; padding: 10px; white-space: pre-wrap; word-break: break-word; }
				@media (max-width: 1100px) {
					.vobiz-stats, .vobiz-layout, .vobiz-context-grid, .vobiz-workdesk-grid, .vobiz-field-grid { grid-template-columns: 1fr; }
					.vobiz-console { padding: 14px; }
					.vobiz-workdesk-top { display: block; }
					.vobiz-workdesk-actions { justify-content: flex-start; margin-top: 10px; }
					.vobiz-wa-composer { grid-template-columns: 30px 30px 30px minmax(0, 1fr) 40px; padding: 8px; }
				}
				@media (max-width: 700px) {
					.vobiz-workdesk-modal .modal-dialog { max-width: calc(100vw - 20px) !important; }
					.vobiz-wa-composer { border-radius: 14px; gap: 4px; grid-template-columns: 28px 28px 28px minmax(0, 1fr) 38px; padding: 7px; }
					.vobiz-wa-icon-btn { font-size: 15px; height: 28px; min-width: 28px; width: 28px; }
					.vobiz-wa-send { height: 38px; width: 38px; }
					.vobiz-wa-menu { left: auto; right: 0; }
				}
			</style>
		`);
	}

	bind() {
		const $main = this.page.main;
		$main.on('click', '[data-action="refresh"]', () => this.load());
		$main.on('click', '[data-action="open-analytics"]', () => frappe.set_route('vobiz-agent-analytics'));
		$main.on('click', '[data-action="end-active-call"]', () => this.end_header_active_call());
		$main.on('click', '[data-action="complete-active-call"]', () => this.complete_header_active_call());
		$main.on('click', '[data-action="softphone-connect"]', () => this.connect_browser_softphone());
		$main.on('click', '[data-action="softphone-use-here"]', () => this.use_softphone_here());
		$main.on('click', '[data-action="softphone-mute"]', () => this.toggle_browser_softphone_mute());
		$main.on('click', '[data-action="softphone-stop"]', () => this.hangup_browser_softphone());
		$main.on('click', '[data-action="softphone-answer"]', (e) => this.answer_browser_softphone($(e.currentTarget).attr('data-call-log')));
		$main.on('click', '[data-action="softphone-workdesk"]', (e) => this.open_softphone_workdesk($(e.currentTarget).attr('data-call-log')));
		$main.on('click', '[data-action="softphone-test-mic"]', () => this.test_browser_microphone());
		$main.on('click', '[data-action="softphone-stop-mic-test"]', () => this.stop_browser_microphone_test());
		$main.on('click', '[data-action="softphone-test-audio"]', () => this.test_browser_audio());
		$main.on('click', '[data-action="softphone-enable-audio"]', () => this.enable_browser_softphone_audio());
		$main.on('click', '[data-action="toggle-auto"]', () => this.toggle_auto_dial());
		$main.on('click', '[data-action="auto-report"]', () => this.open_auto_dial_report());
		$main.on('click', '[data-action="open-filters"]', () => this.open_filter_popover());
		$main.on('click', '[data-action="queue-page-prev"]', () => this.change_queue_page(-1));
		$main.on('click', '[data-action="queue-page-next"]', () => this.change_queue_page(1));
		$main.on('click', '[data-action="call-row"]', (e) => {
			e.stopPropagation();
			this.call_row($(e.currentTarget).closest('tr').data('index'));
		});
		$main.on('click', '[data-action="open-missed-calls"]', (e) => {
			e.stopPropagation();
			this.open_missed_calls($(e.currentTarget).closest('tr').data('index'));
		});
		$main.on('click', '[data-action="open-whatsapp-row"]', (e) => {
			e.stopPropagation();
			this.open_queue_whatsapp($(e.currentTarget).closest('tr').data('index'));
		});
		$main.on('click', '[data-action="select-row"]', (e) => this.select_row($(e.currentTarget).data('index')));
		$main.on('click', '[data-action="call-selected"]', () => this.call_selected());
		$main.on('click', '[data-action="open-reference"]', () => this.open_reference());
		$main.on('click', '[data-action="cancel-call"]', () => this.cancel_call());
		$main.on('click', '[data-action="save-disposition"]', () => this.save_disposition());
		$main.on('change', '[data-role="lead-status"]', () => this.refresh_lead_disposition_options());
		$main.on('click', '[data-tab]', (e) => this.show_tab($(e.currentTarget).data('tab')));
		$main.on('change', '[data-role="check-all"]', (e) => {
			const checked = e.currentTarget.checked;
			$main.find('[data-role="row-check"]').each((_, el) => {
				const row = this.state.queue[$(el).closest('tr').data('index')];
				const key = this.queue_row_key(row);
				if (key) {
					if (checked) {
						this.state.selected_queue_keys.add(key);
					} else {
						this.state.selected_queue_keys.delete(key);
					}
				}
				$(el).prop('checked', checked);
			});
			this.update_selected_count();
		});
		$main.on('change', '[data-role="row-check"]', (e) => {
			const row = this.state.queue[$(e.currentTarget).closest('tr').data('index')];
			const key = this.queue_row_key(row);
			if (key) {
				if (e.currentTarget.checked) {
					this.state.selected_queue_keys.add(key);
				} else {
					this.state.selected_queue_keys.delete(key);
				}
			}
			this.update_selected_count();
		});
		$main.on('click', '[data-role="row-check"]', (e) => e.stopPropagation());
		$main.on('input', '[data-role="search"]', () => this.queue_search_changed());
		$main.on('change', '[data-role="queue-source-filter"]', () => {
			this.state.queue_filters = [];
			this.state.filter_group = null;
			this.state.queue_page = 1;
			this.state.selected_queue_keys.clear();
			this.load();
		});
		$main.on('change', '[data-role="queue-sort"]', () => {
			this.state.queue_sort_by = (this.page.main.find('[data-role="queue-sort"]').val() || 'creation_desc').trim();
			this.state.queue_page = 1;
			this.state.selected_queue_keys.clear();
			this.load();
		});
		$main.on('change', '[data-role="queue-page-size"]', () => {
			this.state.queue_page_size = parseInt(this.page.main.find('[data-role="queue-page-size"]').val(), 10) || 25;
			this.state.queue_page = 1;
			this.load();
		});
		$(document).on('visibilitychange.vobiz-agent-console', () => {
			if (!document.hidden && this.is_console_visible()) {
				this.start_console_heartbeat();
				this.schedule_whatsapp_sync(0);
			} else {
				this.stop_whatsapp_sync();
			}
		});
		$(document).on('vobiz_availability_changed.vobiz-agent-console', (event, data) => {
			this.render_availability(data || {}, this.state.active_call || {});
		});
		$(document).on('page-change.vobiz-agent-console route-change.vobiz-agent-console', () => {
			setTimeout(() => {
				if (!this.is_console_visible()) {
					this.stop_console_heartbeat();
				}
			}, 0);
		});
		window.addEventListener('pagehide', () => {
			this.stop_browser_microphone_test();
			this.stop_console_heartbeat();
		});
		this.bind_activity_tracking();
	}

	load_browser_softphone_config() {
		this.bind_softphone_window_channel();
		const softphone = this.state.softphone;
		softphone.config_promise = frappe.call('vobiz_click_to_call.api.webrtc.get_browser_softphone_config').then((r) => {
			this.state.softphone.config = r.message || {};
			this.render_browser_softphone();
			if ((this.state.softphone.config || {}).enabled) {
				this.run_softphone_diagnostics();
				this.load_browser_softphone_sdk()
					.then(() => this.auto_connect_browser_softphone())
					.catch(() => {});
			}
		}).catch(() => {
			this.state.softphone.error = __('Could not load browser softphone settings.');
			this.render_browser_softphone();
		});
		return softphone.config_promise;
	}

	render_browser_softphone() {
		this.sync_post_call_disposition();
		const softphone = this.state.softphone || {};
		const config = softphone.config || {};
		const enabledMode = config.call_device === 'Browser Softphone';
		const $panel = this.page.main.find('[data-role="softphone-panel"]');
		$panel.toggleClass('hidden', !enabledMode);
		if (!enabledMode) return;

		let dotClass = 'vobiz-softphone-dot';
		if (this.browser_softphone_reconnecting()) {
			dotClass += ' connecting';
		} else if (softphone.in_call) {
			dotClass += ' in-call';
		} else if (softphone.registered) {
			dotClass += ' online';
		} else if (softphone.registering || softphone.sdk_loading) {
			dotClass += ' connecting';
		} else if (softphone.error || (config.missing || []).length) {
			dotClass += ' error';
		}
		this.page.main.find('[data-role="softphone-dot"]').attr('class', dotClass);

		const missing = (config.missing || []).join(', ');
		const status = this.browser_softphone_network_message() || softphone.error || (missing ? __('Missing: {0}', [missing]) : softphone.status || __('Not Connected'));
		this.page.main.find('[data-role="softphone-status"]').text(status);
		this.page.main.find('[data-action="softphone-use-here"]')
			.toggleClass('hidden', !this.show_softphone_use_here())
			.prop('disabled', Boolean(softphone.switching_window))
			.text(softphone.switching_window ? __('Switching…') : __('Use here'));
		this.page.main.find('[data-role="softphone-endpoint"]').text(config.endpoint_uri || config.username || '');
		this.page.main.find('[data-role="softphone-answer-url"]').text(config.answer_url ? __('Answer URL ready') : '');
		this.page.main.find('[data-role="softphone-diagnostics"]').html(this.browser_softphone_diagnostics_html());
		const showLive = Boolean(softphone.current_call_log || softphone.current_destination || softphone.in_call);
		this.page.main.find('[data-role="softphone-live"]')
			.toggleClass('hidden', !showLive)
			.html(showLive ? this.browser_softphone_live_html() : '');
		this.page.main.find('[data-action="softphone-mute"]').toggleClass('hidden', !softphone.in_call);
		this.page.main.find('[data-action="softphone-stop"]').toggleClass('hidden', !softphone.current_call_log);
		this.page.main.find('[data-action="softphone-mute"] span').text(softphone.muted ? __('Unmute') : __('Mute'));
		const incomingWaiting = this.browser_incoming_waiting();
		this.page.main.find('[data-action="softphone-answer"]')
			.toggleClass('hidden', !incomingWaiting)
			.attr('data-call-log', softphone.current_call_log || '')
			.prop('disabled', Boolean(softphone.incoming_answering))
			.text(softphone.incoming_answering ? __('Connecting…') : __('Pick Call'));
		this.page.main.find('[data-action="softphone-workdesk"]')
			.toggleClass('hidden', !softphone.current_call_log)
			.attr('data-call-log', softphone.current_call_log || '')
			.prop('disabled', Boolean(this.softphone_workdesk_request));
		this.render_workdesk_incoming_controls();
	}

	workdesk_incoming_controls_html() {
		if (!this.browser_incoming_waiting()) return '';
		const softphone = this.state.softphone;
		const escape = frappe.utils.escape_html;
		const caller = softphone.current_customer || __('Customer');
		const number = softphone.current_destination || softphone.incoming_caller || '';
		return `<div class="vobiz-live-call" role="group" aria-label="${escape(__('Incoming Call'))}">
			<div class="vobiz-live-call-head" style="gap:12px;flex-wrap:wrap;margin-bottom:0">
				<div><strong>${__('Incoming Call')}: ${escape(caller)}</strong><div>${escape(number)}</div></div>
				<div class="vobiz-call-controls">
					<button type="button" class="btn btn-success btn-sm" data-incoming-answer data-call-log="${escape(softphone.current_call_log)}" ${softphone.incoming_answering ? 'disabled' : ''}>
						<i class="fa fa-phone"></i> ${softphone.incoming_answering ? __('Connecting…') : __('Pick Call')}
					</button>
				</div>
			</div>
		</div>`;
	}

	render_workdesk_incoming_controls() {
		const $body = this.state.active_workdesk_body;
		if ($body && $body.length) $body.find('[data-workdesk-incoming]').html(this.workdesk_incoming_controls_html());
	}

	async open_softphone_workdesk(expectedCallLog) {
		const callLog = this.state.softphone.current_call_log;
		if (!callLog || (expectedCallLog && expectedCallLog !== callLog) || this.softphone_workdesk_request) return;
		const request = {};
		const originalDialog = this.state.active_workdesk_dialog;
		const stillCurrent = () => this.state.softphone.current_call_log === callLog;
		this.softphone_workdesk_request = request;
		this.render_browser_softphone();
		try {
			const response = await this.browser_request_with_timeout(frappe.call({
				method: 'vobiz_click_to_call.api.call.get_call_status',
				args: { call_log: callLog, sync_provider: 0 }
			}));
			const call = response.message || {};
			if (!stillCurrent() || call.name !== callLog) return;
			this.track_browser_workdesk_call(call);
			if (!call.reference_doctype || !call.reference_name) {
				frappe.msgprint(__('This caller is not linked to a customer record yet. You can still pick up the call.'));
				return;
			}
			const row = (this.state.queue || []).find(item => item.doctype === call.reference_doctype && item.name === call.reference_name)
				|| { doctype: call.reference_doctype, name: call.reference_name, title: call.reference_title || call.reference_name,
					phone: this.state.softphone.current_destination || call.customer_number_display || '' };
			if (this.state.active_workdesk_dialog && this.state.active_workdesk_key === this.detail_key(row)) {
				this.state.active_workdesk_dialog.show();
				this.render_workdesk_incoming_controls();
				return;
			}
			const details = await this.browser_request_with_timeout(frappe.call({
				method: 'vobiz_click_to_call.api.console.get_reference_context',
				args: { reference_doctype: row.doctype, reference_name: row.name, lite: 1 }
			}));
			if (!stillCurrent() || this.state.active_workdesk_dialog !== originalDialog) return;
			const context = details.message || {};
			const workdeskRow = { ...row, ...(context.reference || {}), doctype: row.doctype, name: row.name };
			const open = () => {
				if (!stillCurrent() || (this.state.active_workdesk_dialog && this.state.active_workdesk_dialog !== originalDialog)) return;
				this.state.context = context;
				this.state.selected = workdeskRow;
				this.apply_context_dispositions(context);
				this.open_detail_dialog(workdeskRow, context);
			};
			if (originalDialog && originalDialog.$wrapper.is(':visible')) {
				originalDialog.$wrapper.one('hidden.bs.modal', open);
				originalDialog.hide();
			} else {
				open();
			}
		} catch (_) {
			if (stillCurrent()) frappe.msgprint(__('Could not open this customer’s workdesk. Please try again.'));
		} finally {
			if (this.softphone_workdesk_request === request) this.softphone_workdesk_request = null;
			this.render_browser_softphone();
		}
	}

	browser_softphone_live_html() {
		const softphone = this.state.softphone || {};
		const config = softphone.config || {};
		const title = softphone.current_customer || __('Customer');
		const destination = softphone.current_destination || '';
		const status = this.browser_softphone_network_message() || softphone.error || softphone.status || __('Calling');
		const headsetState = softphone.media_granted ? __('Headset active') : __('Headset ready');
		const audioState = this.browser_softphone_reconnecting() ? __('Checking audio connection') : (softphone.in_call ? __('Browser audio active') : __('Browser audio ready'));
		const micState = softphone.muted ? __('Mic muted') : __('Mic live');
		const duration = this.browser_softphone_duration_label();
		const direction = softphone.direction || (softphone.incoming_call_uuid || softphone.incoming_caller ? __('Incoming') : __('Outgoing'));
		return `
			<div class="vobiz-softphone-phone">
				<i class="fa fa-phone"></i>
			</div>
			<div>
				<div class="vobiz-softphone-live-title">${frappe.utils.escape_html(title)}</div>
				<div class="vobiz-softphone-live-number">${frappe.utils.escape_html(destination || config.endpoint_uri || '')}</div>
				<div class="vobiz-softphone-live-chips">
					<span class="vobiz-softphone-chip ok"><i class="fa fa-exchange"></i> ${frappe.utils.escape_html(direction)}</span>
					<span class="vobiz-softphone-chip ok"><i class="fa fa-plug"></i> ${frappe.utils.escape_html(status)}</span>
					<span class="vobiz-softphone-chip ok"><i class="fa fa-clock-o"></i> <span data-role="softphone-duration">${frappe.utils.escape_html(duration)}</span></span>
					<span class="vobiz-softphone-chip ok"><i class="fa fa-headphones"></i> ${headsetState}</span>
					<span class="vobiz-softphone-chip ok"><i class="fa fa-volume-up"></i> ${audioState}<span class="vobiz-softphone-wave"><span></span><span></span><span></span></span></span>
					<span class="vobiz-softphone-chip ${softphone.muted ? 'warn' : 'ok'}"><i class="fa fa-microphone"></i> ${micState}</span>
				</div>
			</div>
		`;
	}

	browser_softphone_diagnostics_html() {
		const diagnostics = (this.state.softphone || {}).diagnostics || {};
		const chip = (icon, state, label) => {
			const className = state === 'ok' ? 'ok' : (state === 'error' ? 'error' : 'warn');
			return `
				<span class="vobiz-health-chip ${className}">
					<i class="fa ${icon}"></i> ${frappe.utils.escape_html(label || '')}
				</span>
			`;
		};
		return `
			${chip('fa-microphone', diagnostics.mic, diagnostics.mic_message || __('Mic status unknown'))}
			${chip('fa-volume-up', diagnostics.audio, diagnostics.audio_message || __('Audio test ready'))}
			${chip('fa-wifi', diagnostics.network, diagnostics.network_message || __('Connection status unknown'))}
			${diagnostics.upload_message ? chip('fa-upload', diagnostics.upload_state, diagnostics.upload_message) : ''}
		`;
	}

	run_softphone_diagnostics() {
		this.check_browser_microphone(false);
		this.measure_browser_network(false);
	}

	stop_browser_microphone_test(message = __('Microphone test stopped')) {
		if (this.page && this.page.main) this.page.main.find('[data-role="mic-test-panel"]').addClass('hidden');
		const test = this.browser_mic_test;
		if (!test) return;
		this.browser_mic_test = null;
		clearInterval(test.timer);
		clearTimeout(test.deadline);
		if (test.source) test.source.disconnect();
		if (test.analyser) test.analyser.disconnect();
		if (test.stream) test.stream.getTracks().forEach(track => track.stop());
		if (test.context) test.context.close().catch(() => {});
		this.page.main.find('[data-role="mic-test-level"]').val(0);
		this.page.main.find('[data-role="mic-test-message"]').text(message);
		this.page.main.find('[data-action="softphone-stop-mic-test"]').addClass('hidden');
	}

	async test_browser_microphone() {
		if (this.browser_mic_test) return;
		if (this.state.softphone.in_call) {
			frappe.msgprint(__('Finish the current call before testing the microphone.'));
			return;
		}
		const test = { detected: false };
		this.browser_mic_test = test;
		const main = this.page.main;
		main.find('[data-role="mic-test-panel"]').removeClass('hidden');
		main.find('[data-action="softphone-stop-mic-test"]').removeClass('hidden');
		main.find('[data-role="mic-test-level"]').val(0);
		main.find('[data-role="mic-test-message"]').text(__('Allow microphone access, then speak'));
		try {
			const Context = window.AudioContext || window.webkitAudioContext;
			if (!Context || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
				throw new Error(__('This browser cannot test microphone input.'));
			}
			test.context = new Context();
			await test.context.resume();
			if (this.browser_mic_test !== test) return;
			const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
			if (this.browser_mic_test !== test) {
				stream.getTracks().forEach(track => track.stop());
				return;
			}
			test.stream = stream;
			test.source = test.context.createMediaStreamSource(stream);
			test.analyser = test.context.createAnalyser();
			test.analyser.fftSize = 1024;
			test.source.connect(test.analyser); // No speaker connection: avoid microphone feedback.
			const samples = new Float32Array(test.analyser.fftSize);
			main.find('[data-role="mic-test-message"]').text(__('Speak now ? listening for 8 seconds'));
			test.timer = setInterval(() => {
				if (this.browser_mic_test !== test) return;
				test.analyser.getFloatTimeDomainData(samples);
				const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
				main.find('[data-role="mic-test-level"]').val(Math.min(100, rms * 500));
				if (rms >= 0.01 && !test.detected) {
					test.detected = true;
					main.find('[data-role="mic-test-message"]').text(__('Sound detected ? keep speaking'));
				}
			}, 100);
			test.deadline = setTimeout(() => {
				if (this.browser_mic_test !== test) return;
				const message = test.detected ? __('Microphone sound detected') : __('No sound detected. Check mute, input device and microphone volume.');
				const diagnostics = this.state.softphone.diagnostics || (this.state.softphone.diagnostics = {});
				diagnostics.mic = test.detected ? 'ok' : 'error';
				diagnostics.mic_message = message;
				this.stop_browser_microphone_test(message);
				this.render_browser_softphone();
			}, 8000);
		} catch (err) {
			if (this.browser_mic_test !== test) return;
			this.stop_browser_microphone_test((err && err.message) || __('Microphone test failed'));
		}
	}

	check_browser_microphone(showMessage) {
		const softphone = this.state.softphone;
		const diagnostics = softphone.diagnostics || {};
		softphone.diagnostics = diagnostics;
		diagnostics.mic = 'checking';
		diagnostics.mic_message = __('Checking microphone');
		this.render_browser_softphone();
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			diagnostics.mic = 'error';
			diagnostics.mic_message = __('Connect your mic');
			softphone.error = __('Browser cannot access microphone.');
			this.render_browser_softphone();
			if (showMessage) frappe.msgprint(__('Browser cannot access microphone. Please connect a mic and allow microphone permission.'));
			return Promise.resolve(false);
		}
		return navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((stream) => {
			(stream.getTracks() || []).forEach(track => track.stop());
			softphone.media_granted = true;
			if (softphone.error === __('Microphone permission denied.') || softphone.error === __('Browser cannot access microphone.')) {
				softphone.error = '';
			}
			diagnostics.mic = 'ok';
			diagnostics.mic_message = __('Mic connected');
			this.render_browser_softphone();
			if (showMessage) frappe.show_alert({ message: __('Microphone is connected.'), indicator: 'green' });
			return true;
		}).catch((err) => {
			softphone.media_granted = false;
			softphone.error = __('Connect your mic');
			diagnostics.mic = 'error';
			diagnostics.mic_message = __('Connect your mic');
			this.render_browser_softphone();
			if (showMessage) {
				frappe.msgprint((err && err.message) ? __('Microphone error: {0}', [err.message]) : __('Please connect a mic and allow microphone permission.'));
			}
			return false;
		});
	}

	async test_browser_audio() {
		if (this.browser_audio_test_running) return;
		this.browser_audio_test_running = true;
		const softphone = this.state.softphone;
		const diagnostics = softphone.diagnostics || {};
		softphone.diagnostics = diagnostics;
		diagnostics.audio = 'checking';
		diagnostics.audio_message = __('Testing audio');
		this.render_browser_softphone();
		let oscillator, gain;
		try {
			const AudioContextClass = window.AudioContext || window.webkitAudioContext;
			if (!AudioContextClass) throw new Error(__('Browser audio test is not supported.'));
			if (!this.browser_audio_test_context || this.browser_audio_test_context.state === 'closed') {
				this.browser_audio_test_context = new AudioContextClass();
			}
			const audioContext = this.browser_audio_test_context;
			await audioContext.resume();
			if (audioContext.state !== 'running') throw new Error(__('Audio is paused. Click Test Audio again to enable playback.'));
			oscillator = audioContext.createOscillator();
			gain = audioContext.createGain();
			oscillator.frequency.value = 720;
			const start = audioContext.currentTime + 0.03;
			gain.gain.setValueAtTime(0, start);
			gain.gain.linearRampToValueAtTime(0.06, start + 0.03);
			gain.gain.setValueAtTime(0.06, start + 0.62);
			gain.gain.linearRampToValueAtTime(0, start + 0.65);
			oscillator.connect(gain);
			gain.connect(audioContext.destination);
			await new Promise(resolve => {
				oscillator.onended = resolve;
				oscillator.start(start);
				oscillator.stop(start + 0.65);
			});
			diagnostics.audio = 'ok';
			diagnostics.audio_message = __('Test tone finished');
			frappe.show_alert({ message: __('Test tone finished. Confirm you heard it through your speaker or headset.'), indicator: 'blue' });
		} catch (err) {
			diagnostics.audio = 'error';
			diagnostics.audio_message = __('Audio test failed');
			frappe.msgprint((err && err.message) || __('Browser audio test failed.'));
		} finally {
			if (oscillator) oscillator.disconnect();
			if (gain) gain.disconnect();
			this.browser_audio_test_running = false;
			this.render_browser_softphone();
		}
	}

	measure_browser_network(showMessage) {
		const softphone = this.state.softphone;
		const diagnostics = softphone.diagnostics || {};
		softphone.diagnostics = diagnostics;
		diagnostics.network = 'checking';
		diagnostics.network_message = __('Checking connection');
		this.render_browser_softphone();
		if (navigator.onLine === false) {
			diagnostics.network = 'error';
			diagnostics.network_message = __('Offline');
			this.render_browser_softphone();
			if (showMessage) frappe.msgprint(__('Internet is offline.'));
			return Promise.resolve(false);
		}
		const started = Date.now();
		const url = `/api/method/ping?_=${Date.now()}`;
		return fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(() => {
			const latency = Date.now() - started;
			const label = latency <= 250
				? __('Strong {0}ms', [latency])
				: (latency <= 800 ? __('Average {0}ms', [latency]) : __('Weak {0}ms', [latency]));
			diagnostics.network = latency <= 800 ? 'ok' : 'warn';
			diagnostics.network_message = label;
			this.render_browser_softphone();
			if (showMessage) frappe.show_alert({ message: __('Connection: {0}', [label]), indicator: latency <= 800 ? 'green' : 'orange' });
			return true;
		}).catch(() => {
			diagnostics.network = 'error';
			diagnostics.network_message = __('Connection error');
			this.render_browser_softphone();
			if (showMessage) frappe.msgprint(__('Could not test internet connection.'));
			return false;
		});
	}

	browser_softphone_duration_label() {
		const startedAt = (this.state.softphone || {}).started_at;
		if (!startedAt) return '00:00';
		const startTime = startedAt instanceof Date ? startedAt.getTime() : new Date(startedAt).getTime();
		if (!startTime) return '00:00';
		const seconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
		const minutes = Math.floor(seconds / 60);
		return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
	}


	load_browser_softphone_sdk() {
		const softphone = this.state.softphone;
		if (window.Vobiz) return Promise.resolve();
		if (softphone.sdk_promise) return softphone.sdk_promise;
		const sdkUrl = (softphone.config || {}).sdk_url;
		if (!sdkUrl) return Promise.reject(new Error(__('Browser SDK URL is missing.')));
		softphone.sdk_loading = true;
		softphone.sdk_promise = new Promise((resolve, reject) => {
			const script = document.createElement('script');
			const fail = () => {
				clearTimeout(timer);
				script.remove();
				softphone.sdk_loading = false;
				reject(new Error(__('Browser SDK failed to load.')));
			};
			const timer = setTimeout(fail, 15000);
			script.src = sdkUrl;
			script.async = true;
			script.onload = () => {
				if (!window.Vobiz) return fail();
				clearTimeout(timer);
				softphone.sdk_loading = false;
				softphone.sdk_ready = true;
				resolve();
			};
			script.onerror = fail;
			document.head.appendChild(script);
		}).catch((err) => {
			softphone.sdk_promise = null;
			softphone.error = err.message;
			this.render_browser_softphone();
			throw err;
		});
		return softphone.sdk_promise;
	}

	auto_connect_browser_softphone() {
		const softphone = this.state.softphone;
		const config = softphone.config || {};
		if (!config.enabled || config.call_device !== 'Browser Softphone') return Promise.resolve();
		if (softphone.ownership_blocked || softphone.registered || softphone.registering || softphone.auto_connect_attempted) return Promise.resolve();
		softphone.auto_connect_attempted = true;
		return this.connect_browser_softphone({ silent: true }).catch((err) => {
			softphone.auto_connect_attempted = false;
			softphone.error = (err && err.message) || softphone.error || __('Could not connect softphone automatically.');
			this.render_browser_softphone();
		});
	}


	connect_browser_softphone(options = {}) {
		const softphone = this.state.softphone;
		const config = softphone.config || {};
		if (softphone.ownership_blocked) return Promise.reject(this.softphone_ownership_error());
		if (softphone.client && (this.browser_softphone_reconnecting() || softphone.pending_end_call)) {
			return Promise.reject(new Error(__('Softphone is reconnecting. Please wait.')));
		}
		if (softphone.registered) return Promise.resolve();
		if (softphone.register_promise) return softphone.register_promise;
		if (!config.call_device && softphone.config_promise) {
			return softphone.config_promise.then(() => this.connect_browser_softphone(options));
		}
		if (!config.enabled) return Promise.reject(new Error(__('Browser Softphone is not configured.')));
		softphone.connection_attempted = true;
		softphone.registering = true;
		softphone.error = '';
		softphone.status = __('Connecting');
		const attempt = this.load_browser_softphone_sdk().then(() => this.send_browser_presence(true, true)).then(() => new Promise((resolve, reject) => {
			if (softphone.ownership_blocked) return reject(this.softphone_ownership_error());
			const timeout = setTimeout(() => reject(new Error(__('Softphone login timed out.'))), 15000);
			softphone.resolve_register = () => { clearTimeout(timeout); resolve(); };
			softphone.reject_register = (err) => { clearTimeout(timeout); reject(err); };
			try {
				softphone.client = new window.Vobiz({
					debug: 'ERROR', permOnClick: false, enableTracking: false,
					closeProtection: true, maxAverageBitrate: 48000
				});
				this.disable_browser_outgoing_tones();
				this.bind_browser_softphone_events(softphone.client);
				softphone.client.client.login(config.username, config.password);
			} catch (err) {
				softphone.reject_register(err);
			}
		}));
		softphone.register_promise = attempt.catch((err) => {
			const client = softphone.client;
			softphone.client = null; // Ignore late events from an expired registration.
			this.send_browser_presence(false).catch(() => {});
			try { if (client) client.client.logout(); } catch (_) {}
			softphone.registered = false;
			softphone.error = err.message || __('Could not connect softphone.');
			throw err;
		}).finally(() => {
			softphone.registering = false;
			softphone.register_promise = null;
			softphone.resolve_register = null;
			softphone.reject_register = null;
			this.render_browser_softphone();
		});
		return softphone.register_promise;
	}

	bind_browser_softphone_events(vobiz) {
		if (!vobiz || !vobiz.client || vobiz._vobizConsoleBound) return;
		vobiz._vobizConsoleBound = true;
		const client = vobiz.client;
		const on = (event, handler) => client.on(event, (...args) => {
			if (this.state.softphone.client === vobiz) handler(args.length > 1 ? args : args[0]);
		});
			on('onWebrtcNotSupported', () => this.browser_softphone_failed(__('WebRTC is not supported in this browser.')));
			on('onLogin', () => {
			const softphone = this.state.softphone;
			softphone.ownership_blocked = false;
			softphone.registering = false;
			softphone.registered = true;
			softphone.conference_login_required = false;
			const resume = (softphone.config || {}).recovery_call;
			if (resume && resume.name && !softphone.current_call_log) {
				softphone.current_call_log = resume.name;
				softphone.current_destination = resume.customer_number || '';
				softphone.conference_recovery = true;
				softphone.conference_generation = resume.conference_generation;
				softphone.recovery_verification = {call_log: resume.name};
				softphone.in_call = true;
				softphone.status = __('Reconnecting');
			}
			if (!softphone.in_call && !softphone.current_call_log && !softphone.incoming_pending) softphone.status = __('Registered');
			softphone.error = '';
			this.render_browser_softphone();
			this.start_browser_network_monitor(vobiz);
			// Presence was claimed before SDK login. A later transport failure must
			// not log out the SDK: logout also terminates its active call.
			if (softphone.resolve_register) softphone.resolve_register();
		});
		on('onConnectionChange', (info) => {
			if (!info || !['connected', 'disconnected'].includes(info.state)) return;
			this.set_browser_network_issue('signaling', info.state === 'disconnected');
			if (info.state === 'connected') this.check_browser_network(vobiz, true);
		});
		on('onMediaConnected', (callInfo) => {
			if (!this.matches_browser_call_event(callInfo)) return;
			this.set_browser_network_issue('media', false);
			this.attach_browser_softphone_audio();
			this.enable_browser_softphone_audio();
		});
		on('onLoginFailed', (reason) => this.browser_softphone_failed(reason || __('Softphone login failed.')));
		on('onLogout', () => {
			const recovering = this.state.softphone;
			if (recovering.conference_recovery && recovering.current_call_log && !recovering.ownership_blocked) {
				recovering.registered = false;
				recovering.conference_login_required = true;
				recovering.conference_session_ended = true;
				recovering.recovery_verification = {call_log: recovering.current_call_log};
				this.set_browser_network_issue('signaling', true);
				this.render_browser_softphone();
				return;
			}
			this.stop_browser_network_monitor();
			this.stop_browser_softphone_audio();
			const softphone = this.state.softphone;
			softphone.registering = false;
			softphone.registered = false;
			softphone.in_call = false;
			softphone.muted = false;
			softphone.direction = '';
			softphone.incoming_call_uuid = '';
			softphone.incoming_caller = '';
			softphone.incoming_answering = false;
			softphone.incoming_answered = false;
			softphone.status = __('Disconnected');
			clearInterval(this.browser_presence_timer);
			this.render_browser_softphone();
			this.render_queue();
		});
		on('onCallRemoteRinging', (callInfo) => {
			if (!this.matches_browser_call_event(callInfo)) return;
			this.browser_softphone_status(__('Ringing'), true);
			this.attach_browser_softphone_audio();
			this.enable_browser_softphone_audio();
			this.sync_browser_softphone_event('onCallRemoteRinging', callInfo).catch(() => this.load());
		});
		on('onCallAnswered', (callInfo) => {
			if (!this.matches_browser_call_event(callInfo)) return;
			const softphone = this.state.softphone;
			softphone.incoming_answering = false;
			const customerConfirmed = softphone.incoming_answered || [this.state.active_call, this.state.workdesk_live_call]
				.some(call => call?.name === softphone.current_call_log && ['Connected', 'In Progress'].includes(call.status));
			softphone.incoming_answered = !softphone.conference_recovery && (!softphone.provider_session_recording || customerConfirmed);
			if (softphone.conference_recovery && softphone.muted) {
				try { client.mute(); } catch (_) {}
			}
			softphone.incoming_call_uuid = '';
			this.browser_softphone_status(softphone.incoming_answered ? __('In Call') : __('Connecting customer'), true);
			this.attach_browser_softphone_audio();
			this.sync_browser_softphone_event('onCallAnswered', callInfo).catch(() => this.load());
		});
		on('onCallTerminated', (callInfo) => this.browser_softphone_call_done('onCallTerminated', callInfo));
		on('onCallFailed', (callInfo) => this.browser_softphone_call_done('onCallFailed', callInfo));
		on('onIncomingCall', (args) => {
			const values = Array.isArray(args) ? args : [args];
			this.browser_softphone_incoming(values[0], values[1], values[2], values[3]);
		});
		on('onIncomingCallCanceled', (callInfo) => {
			const eventUUID = this.extract_call_uuid(callInfo);
			const currentUUID = this.state.softphone.sdk_call_uuid;
			if (eventUUID && currentUUID && eventUUID !== currentUUID) return;
			if (!this.state.softphone.incoming_pending && !this.state.softphone.incoming_caller) return;
			this.state.softphone.incoming_pending = false;
			this.browser_softphone_call_done('onCallTerminated', {});
			const softphone = this.state.softphone;
			softphone.incoming_call_uuid = '';
			softphone.incoming_caller = '';
			softphone.incoming_answering = false;
			softphone.incoming_answered = false;
			softphone.direction = '';
			this.browser_softphone_status(softphone.registered ? __('Registered') : __('Disconnected'), false);
			this.render_queue();
		});
		on('onMediaPermission', (granted) => {
			this.state.softphone.media_granted = Boolean(granted);
			if (!granted) {
				this.state.softphone.error = __('Microphone permission denied.');
				this.state.softphone.diagnostics.mic = 'error';
				this.state.softphone.diagnostics.mic_message = __('Connect your mic');
			} else {
				this.state.softphone.diagnostics.mic = 'ok';
				this.state.softphone.diagnostics.mic_message = __('Mic connected');
			}
			this.render_browser_softphone();
		});
	}


	browser_softphone_incoming(callerId, extraHeaders, callInfo, callerName) {
		const softphone = this.state.softphone;
		if (softphone.current_call_log || softphone.in_call) return;
		const info = this.normalize_browser_softphone_event(callInfo);
		const caller = callerId || info.caller_id || info.from || '';
		const incomingRequest = {};
		softphone.incoming_request = incomingRequest;
		softphone.incoming_call_uuid = this.extract_call_uuid(info);
		softphone.sdk_call_uuid = softphone.incoming_call_uuid;
		softphone.incoming_pending = true;
		softphone.incoming_answering = false;
		softphone.incoming_answered = false;
		this.sync_post_call_disposition();
		frappe.call({
			method: 'vobiz_system_call.api.webrtc.get_incoming_call',
			args: { caller, tab_id: this.get_softphone_tab_id() }
		}).then((r) => {
			if (!softphone.incoming_pending || softphone.incoming_request !== incomingRequest) return;
			const call = r.message || {};
			if (!call.call_log) throw new Error(__('Incoming call could not be linked.'));
			softphone.current_call_log = call.call_log;
			softphone.incoming_call_uuid = this.extract_call_uuid(info);
			softphone.sdk_call_uuid = softphone.incoming_call_uuid;
			softphone.incoming_caller = call.customer_number || caller;
			softphone.current_destination = call.customer_number || caller;
			softphone.current_customer = callerName || __('Customer');
			softphone.direction = __('Incoming Call');
			softphone.status = __('Incoming Call');
			softphone.in_call = true;
			softphone.started_at = new Date();
			this.state.call_started_at = softphone.started_at;
			this.track_browser_workdesk_call({ ...call, name: call.call_log });
			this.start_timer();
			this.render_browser_softphone();
			this.render_queue();
		}).catch((err) => {
			if (!softphone.incoming_pending || softphone.incoming_request !== incomingRequest) return;
			softphone.incoming_pending = false;
			softphone.incoming_call_uuid = '';
			softphone.error = err.message || __('Incoming call could not be linked.');
			try { softphone.client.client.hangup(); } catch (_) {}
			this.render_browser_softphone();
		});
	}

	normalize_browser_softphone_event(callInfo = {}) {
		if (Array.isArray(callInfo)) {
			const merged = { args: callInfo };
			callInfo.forEach((part, index) => {
				if (part && typeof part === 'object' && !Array.isArray(part)) {
					Object.assign(merged, part);
				} else if (part !== undefined && part !== null && part !== '') {
					merged[`arg${index}`] = String(part);
				}
			});
			return merged;
		}
		if (!callInfo || typeof callInfo !== 'object') {
			return { reason: callInfo ? String(callInfo) : '' };
		}
		return callInfo;
	}

	extract_call_uuid(callInfo = {}) {
		const keys = ['callUUID', 'CallUUID', 'callUuid', 'call_uuid', 'xcallUUID', 'uuid'];
		const seen = new Set();
		const scan = (value, depth = 0) => {
			if (!value || depth > 4) return '';
			if (typeof value !== 'object') return '';
			if (seen.has(value)) return '';
			seen.add(value);
			for (const key of keys) {
				const found = value[key];
				if (found) return String(found);
			}
			if (value.id && String(value.id).length >= 8) return String(value.id);
			for (const child of Object.values(value)) {
				const found = Array.isArray(child)
					? child.map(item => scan(item, depth + 1)).find(Boolean)
					: scan(child, depth + 1);
				if (found) return found;
			}
			return '';
		};
		return scan(this.normalize_browser_softphone_event(callInfo));
	}

	browser_softphone_failed(reason) {
		const softphone = this.state.softphone;
		softphone.registering = false;
		softphone.registered = false;
		softphone.error = reason || __('Softphone failed.');
		this.render_browser_softphone();
		if (softphone.reject_register) softphone.reject_register(new Error(softphone.error));
	}

	browser_softphone_status(status, inCall) {
		const softphone = this.state.softphone;
		softphone.status = status;
		softphone.in_call = Boolean(inCall);
		if (softphone.current_call_log && (this.state.workdesk_live_call || {}).name === softphone.current_call_log) {
			// Joining a conference confirms only the browser leg. Keep the
			// customer's server status until its own answer/completion arrives.
			if (!softphone.conference_recovery && !softphone.provider_session_recording) this.state.workdesk_live_call.status = inCall && softphone.incoming_answered ? 'Connected' : status;
			this.render_workdesk_live_call();
		}
		this.render_browser_softphone();
	}


	browser_softphone_call_done(event, callInfo) {
		const softphone = this.state.softphone;
		if (!this.matches_browser_call_event(callInfo)) return;
		const callLog = softphone.current_call_log;
		if (!callLog) return;
		if (softphone.conference_recovery) {
			softphone.conference_join_started_at = 0;
			softphone.conference_session_ended = true;
			softphone.recovery_verification = {call_log: callLog};
			this.set_browser_network_issue('media', true);
			this.sync_browser_softphone_event(event, callInfo, callLog).catch(() => {});
			// Only customer termination may open disposition. Keep the logical
			// call and its End Call control while replacing the browser leg.
			this.render_browser_softphone();
			return;
		}
		this.set_browser_network_issue('media', false);
		this.sync_browser_softphone_event(event, callInfo, callLog).then(() => {
			this.watch_browser_call_disposition(callLog);
			if (softphone.current_call_log !== callLog) return;
			this.reset_browser_softphone_call_state(
				softphone.registered ? __('Registered') : __('Disconnected'), callLog, ''
			);
			this.load();
		}).catch((err) => {
			softphone.error = err.message || __('Call status could not be saved. Please retry Stop Call.');
			softphone.in_call = false;
			this.render_browser_softphone();
		});
	}

	matches_browser_call_event(callInfo) {
		const softphone = this.state.softphone;
		if (!softphone.current_call_log) return false;
		const uuid = this.extract_call_uuid(this.normalize_browser_softphone_event(callInfo));
		if (uuid && softphone.sdk_call_uuid && uuid !== softphone.sdk_call_uuid) return false;
		if (uuid && (softphone.conference_retired_uuids || []).includes(uuid)) return false;
		if (uuid) softphone.sdk_call_uuid = uuid;
		return true;
	}

	disconnect_browser_softphone() {
		const softphone = this.state.softphone;
		this.stop_browser_network_monitor();
		this.send_browser_presence(false).catch(() => {});
		const client = softphone.client;
		softphone.client = null;
		softphone.registered = false;
		try { if (client) client.client.logout(); } catch (_) {}
		this.render_browser_softphone();
	}

	send_browser_presence(registered = true, claimIdle = false) {
		return this.prepare_softphone_window().then(() => this.send_browser_window_presence(registered, claimIdle));
	}

	send_browser_window_presence(registered, claimIdle = false) {
		const s = this.state.softphone;
		const healthyCall = registered && s.registered && s.in_call && s.recovery_media_connected
			&& !s.pending_end_call && !s.recovery_verification && !Object.keys(s.network_issues || {}).length;
		const request = frappe.call({
			method: 'vobiz_system_call.api.webrtc.browser_presence',
			args: { tab_id: this.get_softphone_tab_id(), registered: registered ? 1 : 0,
				claim_idle: registered && claimIdle ? 1 : 0, call_log: healthyCall ? s.current_call_log : '' },
			silent: true
		});
		return this.browser_request_with_timeout(request).then(r => {
			const data = (r || {}).message || {};
			if (registered && data.registered === false) {
				if (data.ownership === 'release_requested') this.release_softphone_for_switch(data).catch(() => {});
				else this.mark_softphone_other_window();
				throw this.softphone_ownership_error(data.ownership);
			}
			return r;
		});
	}

	get_softphone_tab_id() {
		if (typeof vobiz_system_call !== 'undefined' && vobiz_system_call.get_softphone_window) {
			this.softphone_window = this.softphone_window || vobiz_system_call.get_softphone_window();
			return this.softphone_window.id;
		}
		// Safe fallback while an older shared asset is still cached.
		if (!this.softphone_tab_id) this.softphone_tab_id = window.crypto && window.crypto.randomUUID
			? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		return this.softphone_tab_id;
	}

	prepare_softphone_window() {
		this.get_softphone_tab_id();
		return this.softphone_window ? this.softphone_window.ready : Promise.resolve(this.softphone_tab_id);
	}

	show_softphone_use_here() {
		const s = this.state.softphone;
		return !s.registered && !s.registering && !s.sdk_loading && Boolean(s.ownership_blocked || s.connection_attempted);
	}

	softphone_ownership_error(state) {
		const messages = {
			active_call: __('Finish the current call or stop auto-dial before switching windows.'),
			superseded: __('Use here was selected in another window. Your softphone is switching there.'),
			expired: __('The previous switch request expired. Please select Use softphone here again.')
		};
		const err = new Error(messages[state] || __('A previous window still holds the softphone registration. Select Use here to switch.'));
		err.softphone_ownership = true;
		return err;
	}

	bind_softphone_window_channel() {
		if (this.softphone_window_channel_bound) return;
		this.softphone_window_channel_bound = true;
		const key = 'vobiz-softphone-window:' + ((frappe.session || {}).user || 'session');
		this.softphone_window_signal_key = key;
		try {
			if (typeof window.BroadcastChannel === 'function') {
				this.softphone_window_channel = new window.BroadcastChannel(key);
				this.softphone_window_channel.onmessage = event => this.handle_softphone_ownership(event.data || {});
				return;
			}
		} catch (_) {}
		if (typeof window.addEventListener === 'function') window.addEventListener('storage', event => {
			if (event.key !== key || !event.newValue) return;
			try { this.handle_softphone_ownership(JSON.parse(event.newValue)); } catch (_) {}
		});
	}

	signal_softphone_window(data) {
		this.bind_softphone_window_channel();
		try {
			if (this.softphone_window_channel) this.softphone_window_channel.postMessage(data);
			else if (window.localStorage) {
				window.localStorage.setItem(this.softphone_window_signal_key, JSON.stringify(data));
				window.localStorage.removeItem(this.softphone_window_signal_key);
			}
		} catch (_) {} // Server realtime and heartbeat remain independent fallbacks.
	}

	softphone_has_live_session() {
		const s = this.state.softphone;
		const active = this.state.active_call || {};
		if ((this.state.auto_dial || {}).running || s.current_call_log || s.in_call || s.incoming_pending || s.pending_end_call ||
			(active.name && !this.is_terminal_status(active.status))) return true;
		try { return Boolean(s.client && s.client.client.getCallUUID && s.client.client.getCallUUID()); }
		catch (_) { return true; }
	}

	mark_softphone_other_window() {
		const s = this.state.softphone;
		s.ownership_blocked = true;
		s.auto_connect_attempted = true;
		s.error = '';
		s.status = __('Softphone registration is reserved');
		if (!this.softphone_has_live_session()) {
			s.network_issues = {};
			s.recovery_verification = null;
			this.disconnect_browser_softphone();
		}
		this.render_browser_softphone();
	}

	async use_softphone_here() {
		const s = this.state.softphone;
		if (s.switching_window) return;
		if (this.softphone_has_live_session()) {
			s.error = __('Finish the current call or stop auto-dial before switching windows.');
			this.render_browser_softphone();
			return;
		}
		s.switching_window = true;
		s.ownership_action = (s.ownership_action || 0) + 1;
		s.error = '';
		s.status = __('Waiting for the other window to disconnect…');
		this.render_browser_softphone();
		try {
			await this.prepare_softphone_window();
			let token;
			let signalledToken;
			for (let waitedMs = 0; waitedMs < 75000;) {
				const r = await this.browser_request_with_timeout(frappe.call({
					method: 'vobiz_system_call.api.ownership.use_here', type: 'POST', silent: true,
					args: {tab_id: this.get_softphone_tab_id(), transfer_token: token}
				}));
				const data = r.message || {};
				if (data.ownership === 'granted') {
					s.ownership_blocked = false;
					s.auto_connect_attempted = false;
					// Reclaiming this window must not race its previous SDK unregister.
					if (this.softphone_switch_release) await this.softphone_switch_release;
					await this.connect_browser_softphone();
					return;
				}
				if (data.ownership !== 'waiting') throw this.softphone_ownership_error(data.ownership);
				token = data.transfer_token;
				if (token !== signalledToken && data.old_tab) {
					signalledToken = token;
					this.signal_softphone_window({state: 'release_requested', tab_id: data.old_tab, transfer_token: token});
				}
				// Catch a prompt SDK logout sooner, then return to normal polling.
				// Keep the full fallback wait for a suspended or unreachable owner.
				const waitMs = waitedMs < 1000 ? 250 : 1000;
				await new Promise(resolve => setTimeout(resolve, waitMs));
				waitedMs += waitMs;
			}
			throw new Error(__('Window switch timed out. Please try Use softphone here again.'));
		} catch (err) {
			s.ownership_blocked = true;
			s.error = err.message || __('Could not switch windows. Please try again.');
		} finally {
			s.switching_window = false;
			this.render_browser_softphone();
		}
	}

	release_softphone_for_switch(data) {
		if (data.tab_id !== this.get_softphone_tab_id()) return Promise.resolve();
		if (this.softphone_switch_release) {
			if (this.softphone_switch_release_token === data.transfer_token) return this.softphone_switch_release;
			return this.softphone_switch_release.then(
				() => this.release_softphone_for_switch(data), () => this.release_softphone_for_switch(data));
		}
		const s = this.state.softphone;
		const action = s.ownership_action || 0;
		this.softphone_switch_release_token = data.transfer_token;
		let busy = true;
		const release = async () => {
			const check = await this.browser_request_with_timeout(frappe.call({
				method: 'vobiz_system_call.api.ownership.switch_status', type: 'POST', silent: true,
				args: {tab_id: this.get_softphone_tab_id(), transfer_token: data.transfer_token}
			}));
			const state = (check.message || {}).ownership;
			if (!['release_requested', 'active_call'].includes(state)) return;
			if ((s.ownership_action || 0) !== action) return;
			busy = state === 'active_call' || this.softphone_has_live_session();
			if (!busy) {
				s.ownership_blocked = true;
				s.auto_connect_attempted = true;
				this.stop_browser_network_monitor();
				if (s.reject_register) s.reject_register(this.softphone_ownership_error());
				const wrapper = s.client;
				s.client = null; // Ignore delayed login/logout events from the old SDK.
				s.registered = false;
				if (wrapper && wrapper.client) await new Promise((resolve, reject) => {
					const sdk = wrapper.client;
					const timer = setTimeout(() => reject(new Error(__('Waiting for the old softphone to disconnect.'))), 6000);
					sdk.on('onLogout', () => { clearTimeout(timer); resolve(); });
					try { sdk.logout(); } catch (err) { clearTimeout(timer); reject(err); }
				});
			}
			await this.browser_request_with_timeout(frappe.call({
				method: 'vobiz_system_call.api.ownership.release_for_switch', type: 'POST', silent: true,
				args: {tab_id: this.get_softphone_tab_id(), transfer_token: data.transfer_token, busy: busy ? 1 : 0}
			}));
		};
		this.softphone_switch_release = release().finally(() => {
			this.softphone_switch_release = null;
			this.softphone_switch_release_token = null;
			if (!busy && (s.ownership_action || 0) === action) this.mark_softphone_other_window();
		});
		return this.softphone_switch_release;
	}

	handle_softphone_ownership(data = {}) {
		if (data.state === 'release_requested') this.release_softphone_for_switch(data).catch(() => {});
		if (data.state === 'granted' && data.tab_id !== this.get_softphone_tab_id()) {
			// Realtime messages may arrive late; confirm ownership before disconnecting.
			this.send_browser_presence().catch(() => {});
		}
		if (data.state === 'blocked' && data.tab_id === this.get_softphone_tab_id()) {
			this.state.softphone.error = __('Finish the current call or stop auto-dial before switching windows.');
			this.render_browser_softphone();
		}
	}

	browser_request_with_timeout(request, timeoutMs = 8000) {
		// Frappe's call wrapper does not forward a timeout option to jQuery.
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(__('Server request timed out.')));
				if (request && typeof request.abort === 'function') request.abort();
			}, timeoutMs);
			Promise.resolve(request).then(resolve, reject).finally(() => clearTimeout(timeout));
		});
	}

	browser_softphone_reconnecting() {
		const softphone = this.state.softphone;
		return Object.keys(softphone.network_issues || {}).length > 0
			|| Boolean(softphone.recovery_verification && softphone.recovery_verification.call_log === softphone.current_call_log);
	}

	browser_softphone_network_message() {
		const softphone = this.state.softphone;
		if (softphone.pending_end_call) return __('Ending call—waiting for connection and provider confirmation');
		if (!this.browser_softphone_reconnecting()) return '';
		const issues = softphone.network_issues || {};
		if (issues.offline !== undefined || issues.media !== undefined || issues.signaling !== undefined) return __('Network issue—reconnecting…');
		if (issues.server !== undefined) return __('Server connection interrupted—retrying…');
		return __('Connection restored—checking call status…');
	}

	set_browser_network_issue(source, failed) {
		const softphone = this.state.softphone;
		const issues = softphone.network_issues || (softphone.network_issues = {});
		const hadIssue = issues[source] !== undefined;
		if (failed && !hadIssue) {
			issues[source] = Date.now();
			if (softphone.current_call_log) {
				// Reconnection is not evidence that the customer call survived.
				softphone.recovery_verification = {call_log: softphone.current_call_log};
			}
		}
		if (!failed) delete issues[source];
		if (!failed && hadIssue && softphone.recovery_verification) softphone.recovery_verification.next_check_at = 0;
		if (hadIssue !== failed) {
			this.render_browser_softphone();
			this.render_workdesk_live_call();
		}
	}

	start_browser_network_monitor(vobiz) {
		this.stop_browser_network_monitor();
		this.browser_network_listener = () => this.check_browser_network(vobiz, true);
		window.addEventListener('offline', this.browser_network_listener);
		window.addEventListener('online', this.browser_network_listener);
		this.browser_presence_timer = setInterval(() => this.check_browser_network(vobiz), 3000);
		this.check_browser_network(vobiz, true);
	}

	stop_browser_network_monitor() {
		clearInterval(this.browser_presence_timer);
		if (this.browser_network_listener) {
			window.removeEventListener('offline', this.browser_network_listener);
			window.removeEventListener('online', this.browser_network_listener);
			this.browser_network_listener = null;
		}
		this.browser_presence_check = null;
		this.browser_presence_checked_at = 0;
		this.state.softphone.network_issues = {};
	}

	check_browser_network(vobiz, force = false) {
		const softphone = this.state.softphone;
		if (softphone.client !== vobiz) return;
		const sdk = vobiz.client;
		const offline = window.navigator && window.navigator.onLine === false;
		this.set_browser_network_issue('offline', Boolean(offline));
		try {
			if (typeof sdk.isConnected === 'function') this.set_browser_network_issue('signaling', !sdk.isConnected());
			// Use the SDK's public accessor only. Its own reconnect/re-INVITE logic
			// owns ICE recovery; competing negotiations can destroy the SIP call.
			const sameCall = softphone.current_call_log && softphone.sdk_call_uuid
				&& typeof sdk.getCallUUID === 'function' && sdk.getCallUUID() === softphone.sdk_call_uuid;
			const pc = sameCall && typeof sdk.getPeerConnection === 'function' && (sdk.getPeerConnection() || {}).pc;
			softphone.recovery_media_connected = Boolean(pc && ['connected', 'completed'].includes(pc.iceConnectionState));
			if (pc) {
				if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) this.set_browser_network_issue('media', true);
				if (['connected', 'completed'].includes(pc.iceConnectionState)) this.set_browser_network_issue('media', false);
			}
		} catch (_) {} // A session may end between the SDK accessors.
		const issues = softphone.network_issues || {};
		const mediaLostAt = Math.min(...['offline', 'media'].filter(key => issues[key] !== undefined).map(key => issues[key]));
		if (!softphone.conference_recovery && softphone.current_call_log && Date.now() - mediaLostAt >= VOBIZ_NETWORK_RECOVERY_MS
			&& !softphone.pending_end_call) {
			// A server-only failure must never end healthy audio. Only sustained
			// browser/media loss exhausts this grace period.
			this.cancel_call_log(softphone.current_call_log).catch(() => {});
		}
		if (offline) return;
		if (softphone.pending_end_call && !this.browser_end_retry) {
			const callLog = softphone.pending_end_call;
			if (callLog === softphone.current_call_log) {
				const retry = {};
				this.browser_end_retry = retry;
				this.cancel_call_log(callLog).catch(() => {}).finally(() => {
					if (this.browser_end_retry === retry) this.browser_end_retry = null;
				});
			}
		}
		if (this.browser_presence_check || (!force && !softphone.conference_recovery && !this.browser_softphone_reconnecting()
			&& Date.now() - this.browser_presence_checked_at < 25000)) return;
		const check = {};
		this.browser_presence_check = check;
		return this.send_browser_presence().then(() => {
			if (softphone.client !== vobiz || this.browser_presence_check !== check) return;
			this.set_browser_network_issue('server', false);
			if (softphone.conference_recovery) return this.recover_conference_call(vobiz);
			if (softphone.recovery_verification) return this.verify_recovered_browser_call(vobiz);
			return this.refresh_browser_softphone_call(this.state.active_call || {});
		}).catch(err => {
			if (softphone.client !== vobiz || this.browser_presence_check !== check) return;
			if (err && err.softphone_ownership) return;
			const status = Number(err && err.status);
			if ([401, 403, 417].includes(status)) {
				// Authentication, permissions and tab-ownership rejection are not
				// temporary network failures. Keep the existing enforcement.
				softphone.error = __('Browser registration was rejected. Please sign in again or close the other calling tab.');
				this.disconnect_browser_softphone();
				return;
			}
			this.set_browser_network_issue('server', true);
		}).finally(() => {
			if (this.browser_presence_check === check) {
				this.browser_presence_check = null;
				this.browser_presence_checked_at = Date.now();
			}
		});
	}

	recover_conference_call(vobiz) {
		const s = this.state.softphone;
		const callLog = s.current_call_log;
		if (!callLog || !s.conference_recovery || s.client !== vobiz || s.pending_end_call || s.conference_end_requested === callLog
			|| this.conference_recovery_check || Date.now() < (s.conference_next_check || 0)) return Promise.resolve();
		// Allow the initial SIP/ICE negotiation to complete before asking the
		// server whether an old browser leg needs replacing.
		if (s.conference_join_started_at && Date.now() - s.conference_join_started_at < 12000) return Promise.resolve();
		const sdk = vobiz.client;
		let uuid = '', alive = false, media = false;
		try {
			uuid = typeof sdk.getCallUUID === 'function' ? (sdk.getCallUUID() || '') : '';
			const peer = uuid && typeof sdk.getPeerConnection === 'function' && sdk.getPeerConnection();
			const pc = peer && (peer.pc || peer);
			alive = Boolean(uuid && !s.conference_session_ended);
			media = Boolean(alive && pc && ['connected', 'completed'].includes(pc.iceConnectionState));
		} catch (_) {}
		const check = {};
		this.conference_recovery_check = check;
		return this.browser_request_with_timeout(frappe.call({
			method: 'vobiz_system_call.api.conference.recover', type: 'POST', silent: true,
			args: {call_log: callLog, tab_id: this.get_softphone_tab_id(), sdk_uuid: uuid,
				media_connected: media ? 1 : 0, session_alive: alive ? 1 : 0, generation: s.conference_generation}
		}), 12000).then(r => {
			if (s.current_call_log !== callLog || s.client !== vobiz) return;
			const call = r.message || {};
			if (call.name !== callLog) return;
			if (this.is_terminal_status(call.status)) {
				this.reconcile_browser_softphone_call(call);
				this.load();
				return;
			}
			if (s.pending_end_call || s.conference_end_requested === callLog) return;
			if (s.conference_login_required && !s.registered && !s.ownership_blocked &&
				!call.ending && Date.now() >= (s.conference_login_after || 0)) {
				s.conference_login_after = Date.now() + 15000;
				try { sdk.login(s.config.username, s.config.password); } catch (_) {}
			}
			if (call.ending) {
				s.pending_end_call = callLog;
				s.recovery_verification = {call_log: callLog};
			} else if (call.agent_connected && media) {
				s.recovery_verification = null;
				this.set_browser_network_issue('media', false);
				s.status = call.status === 'Connected' ? __('In Call') : __(call.status);
				for (const current of [this.state.active_call, this.state.workdesk_live_call]) {
					if (current?.name === callLog) current.status = call.status;
				}
				this.render_workdesk_live_call();
				this.attach_browser_softphone_audio();
			} else if (call.retire_session && alive) {
				s.recovery_verification = {call_log: callLog};
				try { Promise.resolve(sdk.hangup()).catch(() => {}); } catch (_) {}
			} else if (call.destination && !alive && s.registered && !s.ownership_blocked) {
				if (s.sdk_call_uuid) {
					s.conference_retired_uuids = [...(s.conference_retired_uuids || []), s.sdk_call_uuid].slice(-64);
				}
				s.sdk_call_uuid = '';
				s.conference_generation = call.conference_generation;
				s.conference_session_ended = false;
				s.conference_join_started_at = Date.now();
				s.recovery_verification = {call_log: callLog};
				s.in_call = true;
				s.status = __('Reconnecting');
				this.disable_browser_outgoing_tones();
				try {
					const started = sdk.call(call.destination, call.conference_headers || {});
					if (started === false) s.conference_session_ended = true;
					Promise.resolve(started).catch(() => { if (s.current_call_log === callLog) s.conference_session_ended = true; });
				} catch (_) { s.conference_session_ended = true; }
			}
			this.render_browser_softphone();
		}).catch(() => {
			// A failed request cannot end or redial the customer's call.
			if (s.current_call_log === callLog) s.recovery_verification = {call_log: callLog};
		}).finally(() => {
			s.conference_next_check = Date.now() + 5000;
			if (this.conference_recovery_check === check) this.conference_recovery_check = null;
		});
	}

	verify_recovered_browser_call(vobiz) {
		const softphone = this.state.softphone;
		const verification = softphone.recovery_verification;
		const callLog = softphone.current_call_log;
		if (!verification || verification.call_log !== callLog || softphone.client !== vobiz) return Promise.resolve();
		if (this.browser_recovery_check || Date.now() < (verification.next_check_at || 0)) return Promise.resolve();
		const check = {};
		this.browser_recovery_check = check;
		return this.browser_request_with_timeout(frappe.call({
			method: 'vobiz_system_call.api.webrtc.verify_browser_call',
			args: {call_log: callLog}, silent: true
		}), 30000).then(r => {
			if (softphone.client !== vobiz || softphone.current_call_log !== callLog) return;
			const call = r.message || {};
			if (call.name !== callLog) return;
			if (this.is_terminal_status(call.status)) {
				this.reconcile_browser_softphone_call(call);
				this.load();
			} else if (call.provider_state === 'active' && softphone.recovery_verification === verification
				&& Object.keys(softphone.network_issues || {}).length === 0 && !softphone.pending_end_call
				&& (!softphone.in_call || softphone.recovery_media_connected)) {
				softphone.recovery_verification = null;
				this.attach_browser_softphone_audio();
				this.enable_browser_softphone_audio();
				this.render_browser_softphone();
				this.render_workdesk_live_call();
			}
		}).catch(() => {
			// A failed verification stays visibly pending, never "In Call".
		}).finally(() => {
			verification.next_check_at = Date.now() + 10000;
			if (this.browser_recovery_check === check) this.browser_recovery_check = null;
		});
	}

	browser_incoming_waiting() {
		const s = this.state.softphone || {};
		return Boolean(s.current_call_log && (s.incoming_call_uuid || s.incoming_caller)) && !s.incoming_answered;
	}

	answer_browser_softphone(expectedCallLog) {
		this.stop_browser_microphone_test();
		const softphone = this.state.softphone;
		if (expectedCallLog && softphone.current_call_log !== expectedCallLog) return;
		if (!this.browser_incoming_waiting() || softphone.incoming_answering) return;
		if (!softphone.client || !softphone.client.client) {
			frappe.msgprint(__('Softphone is not connected yet.'));
			return;
		}
		const sdk = softphone.client.client;
		const callUUID = softphone.incoming_call_uuid || '';
		const callLog = softphone.current_call_log;
		const failed = (error) => {
			if (softphone.client?.client !== sdk || softphone.current_call_log !== callLog
				|| softphone.incoming_call_uuid !== callUUID || softphone.incoming_answered) return;
			softphone.incoming_answering = false;
			softphone.status = __('Incoming Call');
			softphone.error = error?.message || __('Could not answer the call. Try Pick Call again.');
			this.render_browser_softphone();
		};
		softphone.incoming_answering = true;
		softphone.error = '';
		softphone.status = __('Connecting…');
		this.render_browser_softphone();
		try {
			const answer = ['answer', 'accept', 'pickup'].find(name => typeof sdk[name] === 'function');
			if (!answer) throw new Error(__('Pick Call is not supported by this softphone SDK.'));
			const result = callUUID ? sdk[answer](callUUID) : sdk[answer]();
			if (result === false) failed();
			else if (result && typeof result.then === 'function') {
				Promise.resolve(result).then(value => { if (value === false) failed(); }).catch(failed);
			}
			// SDK acceptance is not a connected call. onCallAnswered confirms it.
		} catch (error) {
			failed(error);
		}
	}


	hangup_browser_softphone() {
		const callLog = this.state.softphone.current_call_log;
		return this.confirm_end_call(callLog, this.state.softphone.current_customer);
	}

	completed_call_context(call) {
		const active = this.state.active_call || {};
		const pending = this.completed_call_contexts || (this.completed_call_contexts = new Map());
		const merged = {};
		for (const source of [pending.get(call.name), this.state.workdesk_live_call, active.last_call, active, call]) {
			if (source?.name !== call.name) continue;
			for (const [key, value] of Object.entries(source)) {
				if (value !== undefined && value !== null) merged[key] = value;
			}
		}
		pending.set(call.name, merged);
		if (this.is_terminal_status(merged.status)) {
			// Keep completion evidence after the disposition context is consumed.
			// A slower console snapshot must not resurrect this same call.
			const confirmed = this.confirmed_terminal_calls || (this.confirmed_terminal_calls = new Set());
			confirmed.add(call.name);
			if (confirmed.size > 200) confirmed.delete(confirmed.values().next().value);
		}
		return merged;
	}

	reconcile_browser_softphone_call(call = {}) {
		const softphone = this.state.softphone;
		if (softphone.provider_session_recording && !softphone.conference_recovery
			&& call.name === softphone.current_call_log && ['Connected', 'In Progress'].includes(call.status)) {
			softphone.incoming_answered = true;
			if (!softphone.pending_end_call && !softphone.recovery_verification) softphone.status = __('In Call');
			this.render_browser_softphone();
		}
		if (!call.name || !this.is_terminal_status(call.status)) return false;
		if (softphone.current_call_log !== call.name) {
			// The SDK can clear first. Reconcile only the matching server snapshot;
			// an older completion must never reset or hang up a newer SDK session.
			if ((this.state.active_call || {}).name !== call.name) return false;
			call = this.completed_call_context(call);
			this.state.active_call = { last_call: call };
			this.clear_tracked_live_call(call.name);
			this.render_active_call();
			this.maybe_prompt_workdesk_disposition(call);
			return true;
		}
		call = this.completed_call_context(call);
		const sdk = softphone.client && softphone.client.client;
		let matchingSession = false;
		try {
			matchingSession = Boolean(sdk && softphone.sdk_call_uuid && typeof sdk.getCallUUID === 'function'
				&& sdk.getCallUUID() === softphone.sdk_call_uuid);
		} catch (_) {}
		// Clear the matching UI before SDK cleanup, which may emit another end event.
		softphone.error = '';
		if ((this.state.active_call || {}).name === call.name) {
			this.state.active_call = { last_call: Object.assign({}, this.state.active_call, call) };
		}
		this.reset_browser_softphone_call_state(
			softphone.registered ? __('Registered') : __('Disconnected'), call.name, call.status
		);
		if (matchingSession) {
			try { Promise.resolve(sdk.hangup()).catch(() => {}); } catch (_) {}
		}
		// Keep the verified call context: the next console reload may omit it
		// because the server has already released the agent's call mapping.
		this.maybe_prompt_workdesk_disposition(call);
		return true;
	}

	refresh_browser_softphone_call(active = {}) {
		const callLog = this.state.softphone.current_call_log;
		if (!callLog) return Promise.resolve();
		const call = active.name === callLog ? active : active.last_call;
		if (call && call.name === callLog) {
			this.reconcile_browser_softphone_call(call);
			return Promise.resolve();
		}
		// The console may omit a finished call; absence alone is not termination evidence.
		if (this.browser_status_in_flight) return this.browser_status_in_flight;
		this.browser_status_in_flight = Promise.resolve(frappe.call({
			method: 'vobiz_click_to_call.api.call.get_call_status',
			args: { call_log: callLog, sync_provider: 0 }
		})).then(r => {
			const current = r.message || {};
			if (current.name === callLog) this.reconcile_browser_softphone_call(current);
		}).catch(() => {}).finally(() => { this.browser_status_in_flight = null; });
		return this.browser_status_in_flight;
	}

	reset_browser_softphone_call_state(status, callLog, terminalStatus) {
		if (callLog && this.state.softphone.current_call_log !== callLog) return;
		this.stop_browser_softphone_audio();
		const softphone = this.state.softphone;
		softphone.pending_end_call = '';
		softphone.conference_recovery = false;
		softphone.provider_session_recording = false;
		softphone.conference_generation = 0;
		softphone.conference_end_requested = '';
		softphone.conference_login_required = false;
		softphone.conference_login_after = 0;
		softphone.conference_retired_uuids = [];
		softphone.conference_session_ended = false;
		softphone.conference_join_started_at = 0;
		softphone.conference_next_check = 0;
		if (softphone.config) softphone.config.recovery_call = null;
		softphone.recovery_verification = null;
		this.set_browser_network_issue('media', false);
		softphone.in_call = false;
		softphone.muted = false;
		softphone.current_destination = '';
		softphone.current_customer = '';
		softphone.direction = '';
		softphone.incoming_call_uuid = '';
		softphone.incoming_caller = '';
		softphone.incoming_answering = false;
		softphone.incoming_answered = false;
		softphone.started_at = null;
		softphone.current_call_log = '';
		softphone.sdk_call_uuid = '';
		softphone.incoming_pending = false;
		softphone.status = status || (softphone.registered ? __('Registered') : __('Disconnected'));
		this.state.call_started_at = null;
		if (callLog) {
			this.clear_tracked_live_call(callLog);
			if ((this.state.active_call || {}).name === callLog) {
				this.state.active_call = terminalStatus ? { last_call: { name: callLog, status: terminalStatus } } : null;
			}
		}
		this.stop_timer();
		this.render_browser_softphone();
		this.render_queue();
		this.render_workdesk_live_call();
		this.update_workdesk_primary_action(this.state.active_workdesk_row);
		this.render_active_call(true);
	}

	toggle_browser_softphone_mute() {
		const softphone = this.state.softphone;
		if (!softphone.client || !softphone.client.client) return;
		if (softphone.muted) {
			softphone.client.client.unmute();
		} else {
			softphone.client.client.mute();
		}
		softphone.muted = !softphone.muted;
		this.render_browser_softphone();
	}

	enable_browser_softphone_audio() {
		const softphone = this.state.softphone;
		const audio = this.page.main.find('[data-role="softphone-audio"]').get(0);
		const sdk = softphone.client && softphone.client.client;
		const targets = [audio];
		if (sdk && softphone.status === __('Incoming Call')) targets.push(sdk.ringToneView);
		for (const target of targets.filter(Boolean)) {
			if (!target.srcObject && !target.src) continue;
			target.muted = false;
			target.volume = 1;
			Promise.resolve(target.play()).then(() => {
				softphone.diagnostics = softphone.diagnostics || {};
				softphone.diagnostics.audio = 'ok';
				softphone.audio_playback_blocked = false;
				softphone.diagnostics.audio_message = __('Playback enabled');
				this.render_browser_softphone();
			}).catch(() => this.browser_softphone_audio_blocked());
		}
	}

	browser_softphone_audio_blocked() {
		const softphone = this.state.softphone;
		softphone.diagnostics = softphone.diagnostics || {};
		softphone.diagnostics.audio = 'error';
		softphone.audio_playback_blocked = true;
		softphone.diagnostics.audio_message = __('Audio blocked: click Enable audio');
		this.render_browser_softphone();
	}

	update_browser_upload_diagnostics(reports, pc) {
		const softphone = this.state.softphone;
		const diagnostics = softphone.diagnostics || (softphone.diagnostics = {});
		let outbound;
		reports.forEach(report => {
			if (report.type === 'outbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio') && !report.isRemote) outbound = report;
		});
		if (!outbound) return;
		const codec = reports.get(outbound.codecId);
		let feedback = outbound.remoteId && reports.get(outbound.remoteId);
		if (!feedback) reports.forEach(report => {
			if (report.type === 'remote-inbound-rtp' && report.localId === outbound.id) feedback = report;
		});
		const name = codec && codec.mimeType ? codec.mimeType.replace(/^audio\//i, '') : __('unknown codec');
		const rate = codec && codec.clockRate ? ` ${codec.clockRate / 1000} kHz` : '';
		const loss = feedback && Number.isFinite(feedback.fractionLost) ? Math.max(0, feedback.fractionLost * 100) : null;
		const jitter = feedback && Number.isFinite(feedback.jitter) ? Math.round(feedback.jitter * 1000) : null;
		diagnostics.upload_state = 'checking'; // Packet statistics cannot establish perceived voice clarity.
		diagnostics.upload_message = __('Upload: ') + name + rate
			+ (loss === null ? __('; loss not reported') : `; ${loss.toFixed(1)}% ` + __('loss'))
			+ (jitter === null ? '' : `; ${jitter} ms ` + __('jitter'));
	}

	disable_browser_outgoing_tones() {
		const sdk = this.state.softphone.client && this.state.softphone.client.client;
		if (!sdk) return;
		// Provider early media supplies ringback. Do not mix local tones into it.
		if (typeof sdk.setRingToneBack === 'function') sdk.setRingToneBack(false);
		if (typeof sdk.setConnectTone === 'function') sdk.setConnectTone(false);
		for (const tone of [sdk.ringBackToneView, sdk.connectToneView].filter(Boolean)) {
			tone.pause();
			tone.muted = true;
		}
	}

	stop_browser_softphone_tones() {
		const sdk = this.state.softphone.client && this.state.softphone.client.client;
		if (!sdk) return;
		for (const tone of [sdk.ringBackToneView, sdk.ringToneView, sdk.connectToneView].filter(Boolean)) {
			tone.pause();
			tone.muted = true;
		}
	}

	stop_browser_softphone_audio() {
		clearInterval(this.browser_audio_timer);
		this.browser_audio_timer = null;
		const audio = this.page.main.find('[data-role="softphone-audio"]').get(0);
		if (audio) { audio.pause(); audio.srcObject = null; }
		this.state.softphone.received_audio_packets = 0;
		if (this.state.softphone.diagnostics) this.state.softphone.diagnostics.upload_message = '';
		this.stop_browser_softphone_tones();
	}

	attach_browser_softphone_audio() {
		clearInterval(this.browser_audio_timer);
		const owner = this.state.softphone.client;
		const callLog = this.state.softphone.current_call_log;
		const update = () => {
			const softphone = this.state.softphone;
			if (!owner || softphone.client !== owner || softphone.current_call_log !== callLog || !softphone.in_call) {
				this.stop_browser_softphone_audio();
				return;
			}
			const audio = this.page.main.find('[data-role="softphone-audio"]').get(0);
			if (!audio) return;
			const sdk = owner.client;
			let stream = null;
			let pc = null;
			try {
				const result = sdk.getPeerConnection();
				pc = result && (result.pc || result);
				const tracks = pc.getReceivers().map(r => r.track).filter(t => t && t.kind === 'audio' && t.readyState !== 'ended');
				if (tracks.length) {
					const existing = audio.srcObject && audio.srcObject.getAudioTracks();
					stream = existing && existing.length === tracks.length && tracks.every(t => existing.includes(t)) ? audio.srcObject : new MediaStream(tracks);
				}
			} catch (_) { /* The SDK may not have created the peer connection yet. Retry. */ }
			if (!stream) stream = sdk.remoteView && sdk.remoteView.srcObject;
			if (softphone.status === __('In Call') || softphone.received_audio_packets) this.stop_browser_softphone_tones();
			if (pc && pc.getStats && !softphone.audio_stats_pending) {
				softphone.audio_stats_pending = true;
				pc.getStats().then(reports => {
					if (softphone.client !== owner || softphone.current_call_log !== callLog) return;
					this.update_browser_upload_diagnostics(reports, pc);
					let packets = 0;
					reports.forEach(report => {
						if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) packets += report.packetsReceived || 0;
					});
					softphone.received_audio_packets = packets;
					if (packets) this.stop_browser_softphone_tones();
					softphone.diagnostics = softphone.diagnostics || {};
					if (!softphone.audio_playback_blocked) {
						softphone.diagnostics.audio = packets ? 'ok' : 'checking';
						softphone.diagnostics.audio_message = packets ? __('Receiving audio: {0} packets', [packets]) : __('Waiting for incoming audio');
						this.render_browser_softphone();
					}
				}).catch(() => {}).finally(() => { softphone.audio_stats_pending = false; });
			}
			if (!stream || !stream.getAudioTracks().some(t => t.readyState !== 'ended')) return;
			if (audio.srcObject !== stream) {
				audio.srcObject = stream;
				audio.muted = false;
				audio.volume = 1;
			}

			// Use one output element to avoid playing the customer twice.
			if (sdk.remoteView && sdk.remoteView !== audio) sdk.remoteView.muted = true;
			if (audio.paused && !softphone.audio_play_pending) {
				softphone.audio_play_pending = true;
				Promise.resolve(audio.play()).catch(() => this.browser_softphone_audio_blocked())
					.finally(() => { softphone.audio_play_pending = false; });
			}
		};
		this.browser_audio_timer = setInterval(update, 500);
		update();
	}

	sync_browser_softphone_event(event, callInfo = {}, callLogOverride = '') {
		const callLog = callLogOverride || this.state.softphone.current_call_log;
		if (!callLog) return Promise.resolve();
		if (!callLogOverride && !this.matches_browser_call_event(callInfo)) return Promise.resolve();
		const info = this.normalize_browser_softphone_event(callInfo);
		return frappe.call({
			method: 'vobiz_click_to_call.api.webrtc.update_browser_softphone_call',
			args: {
				call_log: callLog,
				event,
				status: info.status || '',
				reason: info.reason || '',
				call_uuid: this.extract_call_uuid(info),
				conference_generation: this.state.softphone.conference_generation || 0
			}
		});
	}


	start_browser_softphone_call(message, row) {
		this.stop_browser_microphone_test();
		const softphone = this.state.softphone;
		softphone.current_call_log = message.call_log;
		softphone.sdk_call_uuid = '';
		softphone.conference_recovery = Boolean(message.conference_recovery);
		softphone.provider_session_recording = Boolean(message.provider_session_recording);
		softphone.conference_generation = message.conference_generation || 0;
		softphone.conference_session_ended = false;
		softphone.conference_join_started_at = Date.now();
		let dialAttempted = false;
		return this.connect_browser_softphone().then(() => {
			softphone.current_destination = message.conference_recovery ? message.customer_number : (message.destination || message.customer_number);
			softphone.current_customer = row.title || row.name || __('Customer');
			softphone.direction = __('Outgoing');
			softphone.in_call = true;
			softphone.status = __('Calling');
			softphone.started_at = new Date();
			this.state.call_started_at = softphone.started_at;
			this.start_timer();
			this.render_browser_softphone();
			this.disable_browser_outgoing_tones();
			dialAttempted = true;
			softphone.client.client.call(message.destination || softphone.current_destination, message.conference_headers || {});
			return this.sync_browser_softphone_event('browserCallStarted', {}, message.call_log);
		}).then(() => message).catch((err) => {
			if (!dialAttempted && message.conference_recovery) {
				return this.cancel_call_log(message.call_log, row).then(() => { throw err; });
			}
			if (!dialAttempted) {
				// Registration failed before invoking the SDK: no voice call was issued.
				return Promise.resolve(this.sync_browser_softphone_event(
					'onCallFailed', {reason: err.message || __('Softphone registration failed.')}, message.call_log
				)).then(() => {
					if (softphone.current_call_log === message.call_log) {
						this.reset_browser_softphone_call_state(__('Disconnected'), message.call_log, 'Failed');
					}
					this.load();
					throw err;
				});
			}
			return this.cancel_call_log(message.call_log, row).then(() => { throw err; });
		});
	}

	load() {
		if (!this.is_console_visible()) {
			this.stop_console_heartbeat();
			return;
		}
		if (this.load_in_flight) return;
		this.load_in_flight = true;
		const search = (this.page.main.find('[data-role="search"]').val() || '').trim();
		const queue_source_filter = (this.page.main.find('[data-role="queue-source-filter"]').val() || '').trim();
		const sort_by = (this.state.queue_sort_by || this.page.main.find('[data-role="queue-sort"]').val() || 'creation_desc').trim();
		this.state.queue_sort_by = sort_by;
		const request = frappe.call('vobiz_click_to_call.api.console.get_agent_console_data', {
			limit: this.state.queue_page_size || 25,
			limit_start: Math.max(0, ((this.state.queue_page || 1) - 1) * (this.state.queue_page_size || 25)),
			search,
			queue_source_filter,
			sort_by,
			filters: JSON.stringify(this.state.queue_filters || [])
		}).then((r) => {
			const data = r.message || {};
			const returnedCall = data.active_call || {};
			if (this.confirmed_terminal_calls?.has(returnedCall.name) && !this.is_terminal_status(returnedCall.status)) {
				// This response was captured before confirmed termination. Applying it
				// would restore Connected/Busy and silently block Save Disposition.
				return;
			}
			this.state.queue = data.queue || [];
			this.state.queue_has_more = Boolean((data.queue_pagination || {}).has_more);
			this.state.queue_meta = Object.assign(this.default_queue_meta(), data.queue_meta || {});
			this.prune_selected_queue_keys();
			this.reset_filter_group_if_doctype_changed();
			this.state.active_call = data.active_call || null;
			this.refresh_browser_softphone_call(data.active_call || {});
			this.state.dispositions = data.dispositions || [];
			this.state.patient_followup_status_options = data.patient_followup_status_options || [];
			this.state.ai_disposition_enabled = Boolean(data.ai_disposition_enabled);
			if (!this.state.lead_disposition_context || !this.state.lead_disposition_context.name) {
				this.state.lead_disposition_context = { options: (data.dispositions || []).map(value => ({ name: value })) };
			}
			this.render_availability(data.availability || {}, data.active_call || {});
			this.render_queue();
			this.render_filter_button();
			this.render_dispositions();
			this.render_manual_disposition_visibility();
			this.render_active_call();
			this.refresh_workdesk_live_call();
			this.render_auto_toggle();
			this.refresh_auto_dial_current();
			this.render_auto_live();
			this.maybe_continue_auto_dial();
			if (!this.state.selected && this.state.queue.length) {
				this.select_row(0);
			}
			this.restore_workdesk_dialog();
		});
		request.always(() => {
			this.load_in_flight = false;
		});
	}

	queue_search_changed() {
		clearTimeout(this.search_timer);
		this.state.queue_page = 1;
		this.search_timer = setTimeout(() => this.load(), 300);
	}

	on_page_show() {
		this.schedule_whatsapp_sync(0);
		$(document).trigger('vobiz_refresh_availability');
		this.state.restore_checked = false;
		this.note_agent_activity();
		this.start_console_heartbeat();
		this.auto_connect_browser_softphone();
		this.load();
		this.restore_workdesk_dialog();
	}

	on_page_hide() {
		this.stop_whatsapp_sync();
		this.stop_browser_microphone_test();
		this.stop_console_heartbeat();
	}

	start_polling() {
		clearInterval(this.poller);
		this.poller = setInterval(() => this.load(), 30000);
		$(window).one('beforeunload', () => {
			clearInterval(this.poller);
			this.stop_browser_network_monitor();
			clearInterval(this.timer);
			clearTimeout(this.search_timer);
			clearTimeout(this.idle_timer);
			this.stop_console_heartbeat();
			this.unbind_realtime();
			$(document).off('visibilitychange.vobiz-agent-console vobiz_availability_changed.vobiz-agent-console page-change.vobiz-agent-console route-change.vobiz-agent-console mousemove.vobiz-agent-console keydown.vobiz-agent-console click.vobiz-agent-console scroll.vobiz-agent-console touchstart.vobiz-agent-console');
		});
	}

	start_console_heartbeat() {
		if (!this.is_console_visible() || this.is_idle_offline) return;
		this.send_console_heartbeat();
		clearInterval(this.heartbeat_timer);
		this.heartbeat_timer = setInterval(() => {
			if (this.is_console_visible() && !this.is_idle_offline) {
				this.send_console_heartbeat();
			}
		}, 25000);
	}

	stop_console_heartbeat() {
		clearInterval(this.heartbeat_timer);
		this.heartbeat_timer = null;
	}

	send_console_heartbeat() {
		if (this.heartbeat_in_flight) return;
		const now = Date.now();
		if (now - this.last_heartbeat_at < 20000) return;
		this.heartbeat_in_flight = true;
		this.last_heartbeat_at = now;
		const done = () => {
			this.heartbeat_in_flight = false;
		};
		const request = frappe.call({
			method: 'vobiz_click_to_call.api.console.heartbeat_agent_console',
			type: 'POST',
			freeze: false,
			args: { tab_id: this.attendance_tab_id },
			callback: done,
			error: done
		});
		if (request && typeof request.finally === 'function') {
			request.finally(done);
		} else if (request && typeof request.always === 'function') {
			request.always(done);
		}
	}

	mark_console_offline(useKeepalive) {
		const url = '/api/method/vobiz_click_to_call.api.console.mark_agent_console_offline';
		if (useKeepalive && window.fetch) {
			const body = new URLSearchParams();
			body.set('tab_id', this.attendance_tab_id);
			fetch(url, {
				method: 'POST',
				keepalive: true,
				headers: { 'X-Frappe-CSRF-Token': frappe.csrf_token || '' },
				body,
				credentials: 'same-origin'
			}).catch(() => {});
			return;
		}
		frappe.call({
			method: 'vobiz_click_to_call.api.console.mark_agent_console_offline',
			type: 'POST',
			freeze: false,
			args: { tab_id: this.attendance_tab_id }
		});
	}

	get_attendance_tab_id() {
		const key = 'vobiz_agent_console_tab_id';
		try {
			let value = window.sessionStorage && window.sessionStorage.getItem(key);
			if (!value) {
				value = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
				window.sessionStorage.setItem(key, value);
			}
			return value;
		} catch (e) {
			return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		}
	}

	bind_activity_tracking() {
		const events = 'mousemove.vobiz-agent-console keydown.vobiz-agent-console click.vobiz-agent-console scroll.vobiz-agent-console touchstart.vobiz-agent-console';
		$(document).on(events, () => this.note_agent_activity());
		this.reset_idle_timer();
	}

	note_agent_activity() {
		if (!this.is_console_visible()) return;
		if (this.is_idle_offline) {
			this.is_idle_offline = false;
			this.start_console_heartbeat();
		}
		this.reset_idle_timer();
	}

	reset_idle_timer() {
		clearTimeout(this.idle_timer);
		if (!this.is_console_visible()) return;
		const availability = window.vobiz_click_to_call && window.vobiz_click_to_call.get_availability
			? window.vobiz_click_to_call.get_availability() : null;
		if (!availability || !availability.idle_auto_offline_enabled) return;
		if (['Busy', 'Away'].includes(availability.availability_status)) return;
		const seconds = Number(availability.idle_auto_offline_seconds) || 300;
		this.idle_timer = setTimeout(() => this.mark_idle_offline(), Math.max(60, seconds) * 1000);
	}

	mark_idle_offline() {
		if (!this.is_console_visible()) return;
		const availability = window.vobiz_click_to_call && window.vobiz_click_to_call.get_availability
			? window.vobiz_click_to_call.get_availability() : null;
		if (!availability || !availability.idle_auto_offline_enabled
			|| ['Busy', 'Away'].includes(availability.availability_status)
			|| (this.state.softphone || {}).in_call) return;
		this.is_idle_offline = true;
		this.stop_console_heartbeat();
		this.mark_console_offline();
	}

	bind_realtime() {
		if (!frappe.realtime || this.callback_handler) return;
		this.callback_handler = (payload) => this.handle_customer_callback(payload || {});
		this.patient_routed_handler = (payload) => this.handle_patient_routed_call(payload || {});
		this.call_disconnected_handler = (payload) => this.handle_call_disconnected(payload || {});
		this.softphone_ownership_handler = (payload) => this.handle_softphone_ownership(payload || {});
		this.whatsapp_message_handler = (payload) => this.handle_whatsapp_message(payload || {});
		this.whatsapp_status_handler = (payload) => this.handle_whatsapp_status(payload || {});
		frappe.realtime.on('vobiz_customer_callback', this.callback_handler);
		frappe.realtime.on('vobiz_patient_routed_call', this.patient_routed_handler);
		frappe.realtime.on('vobiz_call_disconnected', this.call_disconnected_handler);
		frappe.realtime.on('vobiz_softphone_ownership', this.softphone_ownership_handler);
		frappe.realtime.on('wa_chat_new_message', this.whatsapp_message_handler);
		frappe.realtime.on('wa_chat_message_status_updated', this.whatsapp_status_handler);
	}

	unbind_realtime() {
		this.stop_whatsapp_sync();
		if (frappe.realtime && this.whatsapp_message_handler && frappe.realtime.off) {
			frappe.realtime.off('wa_chat_new_message', this.whatsapp_message_handler);
		}
		this.whatsapp_message_handler = null;
		if (frappe.realtime && this.whatsapp_status_handler && frappe.realtime.off) {
			frappe.realtime.off('wa_chat_message_status_updated', this.whatsapp_status_handler);
		}
		this.whatsapp_status_handler = null;
		if (frappe.realtime && this.callback_handler && frappe.realtime.off) {
			frappe.realtime.off('vobiz_customer_callback', this.callback_handler);
		}
		if (frappe.realtime && this.patient_routed_handler && frappe.realtime.off) {
			frappe.realtime.off('vobiz_patient_routed_call', this.patient_routed_handler);
		}
		if (frappe.realtime && this.call_disconnected_handler && frappe.realtime.off) {
			frappe.realtime.off('vobiz_call_disconnected', this.call_disconnected_handler);
			frappe.realtime.off('vobiz_softphone_ownership', this.softphone_ownership_handler);
		}
		this.callback_handler = null;
		this.patient_routed_handler = null;
		this.call_disconnected_handler = null;
	}

	is_console_visible() {
		const route = frappe.get_route ? frappe.get_route() : [];
		const routeText = route.join('/');
		return routeText === 'vobiz-agent-console' || window.location.pathname.includes('/app/vobiz-agent-console');
	}

	handle_customer_callback(payload) {
		if (!this.is_console_visible()) return;
		if (!payload.call_log || this.state.last_callback_call_log === payload.call_log) return;
		this.state.last_callback_call_log = payload.call_log;
		this.load();
		this.show_customer_callback_popup(payload);
	}

	show_customer_callback_popup(payload) {
		if (this.callback_dialog) {
			this.callback_dialog.hide();
		}
		const reference = [payload.reference_doctype, payload.reference_name].filter(Boolean).join(' ');
		const dialog = new frappe.ui.Dialog({
			title: __('Customer Callback'),
			fields: [{
				fieldname: 'details',
				fieldtype: 'HTML',
				options: `
					<div class="vobiz-callback-popup">
						<div class="vobiz-callback-icon"><i class="fa fa-phone"></i></div>
						<div>
							<h4>${__('Incoming customer callback')}</h4>
							<div class="vobiz-callback-row"><span>${__('Customer')}</span><strong>${frappe.utils.escape_html(payload.customer_number || '-')}</strong></div>
							<div class="vobiz-callback-row"><span>${__('Called DID')}</span><strong>${frappe.utils.escape_html(payload.did_number || '-')}</strong></div>
							<div class="vobiz-callback-row"><span>${__('Lead')}</span><strong>${frappe.utils.escape_html(reference || payload.crm_lead || '-')}</strong></div>
						</div>
					</div>
				`
			}],
			primary_action_label: __('Open Workdesk'),
			primary_action: () => {
				dialog.hide();
				this.open_callback_workdesk(payload);
			}
		});
		this.callback_dialog = dialog;
		dialog.get_close_btn().show();
		dialog.show();
	}

	open_callback_workdesk(payload) {
		if (!payload.reference_doctype || !payload.reference_name) return;
		const existing = (this.state.queue || []).find(row => row.doctype === payload.reference_doctype && row.name === payload.reference_name);
		const row = existing || {
			doctype: payload.reference_doctype,
			name: payload.reference_name,
			title: payload.reference_name,
			phone: payload.customer_number || ''
		};
		frappe.call('vobiz_click_to_call.api.console.get_reference_context', {
			reference_doctype: row.doctype,
			reference_name: row.name,
			lite: 1
		}).then((r) => {
			this.state.context = r.message || {};
			this.apply_context_dispositions(this.state.context);
			this.open_detail_dialog(row, r.message || {});
		});
	}

	handle_patient_routed_call(payload) {
		if (!this.is_console_visible()) return;
		const key = payload.call_log || `${payload.patient || ''}:${payload.customer_number || ''}`;
		if (!payload.patient || this.state.last_patient_routed_call === key) return;
		this.state.last_patient_routed_call = key;
		this.load();
		this.show_patient_routed_popup(payload);
	}

	show_patient_routed_popup(payload) {
		if (this.patient_routed_dialog) {
			this.patient_routed_dialog.hide();
		}
		const dialog = new frappe.ui.Dialog({
			title: __('Incoming Patient Call'),
			fields: [{
				fieldname: 'details',
				fieldtype: 'HTML',
				options: `
					<div class="vobiz-callback-popup">
						<div class="vobiz-callback-icon"><i class="fa fa-phone"></i></div>
						<div>
							<h4>${__('Patient call routed to you')}</h4>
							<div class="vobiz-callback-row"><span>${__('Patient')}</span><strong>${frappe.utils.escape_html(payload.patient_name || payload.patient || '-')}</strong></div>
							<div class="vobiz-callback-row"><span>${__('Caller')}</span><strong>${frappe.utils.escape_html(payload.customer_number || '-')}</strong></div>
							<div class="vobiz-callback-row"><span>${__('Department')}</span><strong>${frappe.utils.escape_html(payload.medical_department || '-')}</strong></div>
							<div class="vobiz-callback-row"><span>${__('Follow-up ID')}</span><strong>${frappe.utils.escape_html(payload.sr_followup_id || '-')}</strong></div>
						</div>
					</div>
				`
			}],
			primary_action_label: __('Open Workdesk'),
			primary_action: () => {
				dialog.hide();
				this.open_patient_routed_workdesk(payload);
			},
			secondary_action_label: __('Open Patient'),
			secondary_action: () => {
				dialog.hide();
				frappe.set_route('Form', 'Patient', payload.patient);
			}
		});
		this.patient_routed_dialog = dialog;
		dialog.get_close_btn().show();
		dialog.show();
	}

	open_patient_routed_workdesk(payload) {
		if (!payload.patient) return;
		const existing = (this.state.queue || []).find(row => row.doctype === 'Patient' && row.name === payload.patient);
		const row = existing || {
			doctype: 'Patient',
			name: payload.patient,
			title: payload.patient_name || payload.patient,
			phone: payload.customer_number || ''
		};
		frappe.call('vobiz_click_to_call.api.console.get_reference_context', {
			reference_doctype: 'Patient',
			reference_name: payload.patient,
			lite: 1
		}).then((r) => {
			this.state.context = r.message || {};
			this.apply_context_dispositions(this.state.context);
			this.open_detail_dialog(row, r.message || {});
		});
	}

	render_availability(capability, active_call) {
		const status = active_call && active_call.name
			? 'Busy'
			: (capability.availability_status || (capability.can_call ? 'Available' : 'Offline'));
		const colors = {
			Available: '#16a34a',
			Busy: '#f97316',
			Away: '#d6a000',
			Offline: '#8d99a6'
		};
		const labels = { Away: __('Break') };
		this.page.main.find('[data-role="availability"]').text(labels[status] || __(status));
		this.page.main.find('.vobiz-state-dot').css('background', colors[status] || '#8d99a6');
	}

	render_queue() {
		this.render_queue_meta();
		const filteredRows = this.filtered_queue_rows();
		this.clamp_queue_page(filteredRows.length);
		this.page.main.find('[data-role="queue-page-size"]').val(String(this.state.queue_page_size || 25));
		const rows = this.paginated_queue_rows(filteredRows);
		this.page.main.find('[data-role="queue"]').html(rows.map(row => this.row_html(row)).join('') || `
			<tr><td colspan="${this.queue_colspan()}" class="text-muted text-center">${frappe.utils.escape_html(this.queue_meta_value('empty_message'))}</td></tr>
		`);
		this.render_queue_pagination(filteredRows.length);
		this.update_selected_count();
	}

	visible_queue_rows() {
		return this.paginated_queue_rows(this.filtered_queue_rows());
	}

	filtered_queue_rows() {
		const query = (this.page.main.find('[data-role="search"]').val() || '').toLowerCase();
		const rows = this.state.queue
			.map((row, index) => ({ ...row, index }))
			.filter(row => !query || [row.name, row.title, row.company, row.phone, row.owner, row.status, row.next_action, row.team, row.sr_medical_department, row.sr_dpt_disease, row.sr_dpt_language, row.sr_followup_id, row.sr_followup_day, row.missed_call_status, row.missed_call_time, row.whatsapp_last_message_preview].join(' ').toLowerCase().includes(query));
		return this.new_missed_calls_first(rows);
	}

	new_missed_calls_first(rows) {
		return (rows || []).slice().sort((a, b) => {
			const aNew = this.is_new_missed_call(a);
			const bNew = this.is_new_missed_call(b);
			if (aNew !== bNew) {
				return aNew ? -1 : 1;
			}
			if (aNew && bNew) {
				return String(b.missed_call_time || '').localeCompare(String(a.missed_call_time || ''));
			}
			return (a.index || 0) - (b.index || 0);
		});
	}

	paginated_queue_rows(rows) {
		return rows || [];
	}

	clamp_queue_page(totalRows) {
		this.state.queue_page = Math.max(1, this.state.queue_page || 1);
	}

	change_queue_page(delta) {
		if (delta > 0 && !this.state.queue_has_more) return;
		this.state.queue_page = Math.max(1, (this.state.queue_page || 1) + delta);
		this.load();
	}

	render_queue_pagination(totalRows) {
		const pageSize = this.state.queue_page_size || 25;
		const page = this.state.queue_page || 1;
		const start = totalRows ? ((page - 1) * pageSize) + 1 : 0;
		const end = totalRows ? start + totalRows - 1 : 0;
		this.page.main.find('[data-role="queue-page-summary"]').text(
			totalRows
				? __('Showing {0}-{1}', [start, end])
				: __('No records')
		);
		this.page.main.find('[data-role="queue-page-number"]').text(__('Page {0}', [page]));
		this.page.main.find('[data-action="queue-page-prev"]').prop('disabled', page <= 1);
		this.page.main.find('[data-action="queue-page-next"]').prop('disabled', !this.state.queue_has_more);
	}

	render_queue_meta() {
		const meta = this.state.queue_meta || this.default_queue_meta();
		this.page.main.find('[data-role="queue-title"]').text(meta.title || __('Lead Queue'));
		this.page.main.find('[data-role="queue-id-label"]').text(meta.id_label || __('CRM Lead ID'));
		this.page.main.find('.vobiz-patient-col').toggleClass('hidden', (meta.doctype || '') !== 'Patient');
		this.page.main.find('.vobiz-team-col').toggleClass('hidden', (meta.doctype || '') === 'Patient');
		this.page.main.find('.vobiz-lead-owner-col').toggleClass('hidden', (meta.doctype || '') === 'Patient');
		this.render_queue_sort(meta);
		this.render_queue_source_filter(meta);
	}

	queue_colspan() {
		const meta = this.state.queue_meta || this.default_queue_meta();
		return (meta.doctype || '') === 'Patient' ? 16 : 13;
	}

	reset_filter_group_if_doctype_changed() {
		const doctype = this.queue_meta_value('doctype');
		if (this.state.filter_doctype && this.state.filter_doctype !== doctype) {
			this.state.queue_filters = [];
			this.state.filter_group = null;
		}
		this.state.filter_doctype = doctype;
	}

	open_filter_popover() {
		const doctype = this.queue_meta_value('doctype');
		const $button = this.page.main.find('[data-action="open-filters"]');
		if (!doctype || !frappe.ui.FilterGroup) {
			frappe.msgprint(__('Filters are not available on this page.'));
			return;
		}
		if (this.state.filter_group && this.state.filter_doctype === doctype) {
			return;
		}
		frappe.model.with_doctype(doctype, () => {
			this.state.filter_doctype = doctype;
			this.state.filter_group = new frappe.ui.FilterGroup({
				doctype,
				parent_doctype: doctype,
				filter_button: $button,
				filters: this.state.queue_filters || [],
				on_change: () => {
					this.state.queue_filters = this.state.filter_group.get_filters();
					this.state.queue_page = 1;
					this.render_filter_button();
					this.load();
				}
			});
			$button.popover('toggle');
		});
	}

	render_filter_button() {
		const count = (this.state.queue_filters || []).length;
		const $button = this.page.main.find('[data-action="open-filters"]');
		$button
			.toggleClass('btn-primary-light', count > 0)
			.toggleClass('btn-default', count === 0)
			.find('.button-label')
			.html(count ? __('Filters {0}', [`<span class="filter-label">${count}</span>`]) : __('Filters'));
	}

	render_queue_source_filter(meta) {
		const $filter = this.page.main.find('[data-role="queue-source-filter"]');
		const options = Array.isArray(meta.source_options) ? meta.source_options : [];
		if (options.length <= 1) {
			$filter.addClass('hidden').val('');
			return;
		}
		const current = $filter.val() || '';
		$filter.html(options.map(value => `<option value="${frappe.utils.escape_html(value)}">${frappe.utils.escape_html(value)}</option>`).join(''));
		if (current && options.includes(current)) {
			$filter.val(current);
		} else {
			$filter.val(meta.source || options[0]);
		}
		$filter.removeClass('hidden');
	}

	render_queue_sort(meta) {
		const $sort = this.page.main.find('[data-role="queue-sort"]');
		const current = this.state.queue_sort_by || $sort.val() || 'creation_desc';
		$sort.val(current);
		const isPatient = (meta.doctype || '') === 'Patient';
		$sort.find('option[value="next_follow_up_asc"]').toggleClass('hidden', isPatient);
		if (isPatient && $sort.val() === 'next_follow_up_asc') {
			this.state.queue_sort_by = 'creation_desc';
			$sort.val('creation_desc');
		}
	}

	queue_meta_value(key) {
		const meta = this.state.queue_meta || this.default_queue_meta();
		return meta[key] || this.default_queue_meta()[key] || '';
	}

	phone_digits(value) {
		return String(value || '').replace(/\D/g, '');
	}

	softphone_incoming_matches_row(row) {
		const incoming = this.phone_digits((this.state.softphone || {}).incoming_caller);
		const rowPhone = this.phone_digits(row && row.phone);
		if (!incoming || !rowPhone) return false;
		return incoming.endsWith(rowPhone) || rowPhone.endsWith(incoming);
	}

	row_html(row) {
		const initials = (row.title || row.name || '?').trim().slice(0, 1).toUpperCase();
		const statusClass = String(row.status || '').split(' ')[0];
		const loading = this.state.detail_loading_key === this.detail_key(row);
		const checked = this.state.selected_queue_keys.has(this.queue_row_key(row)) ? 'checked' : '';
		const callbackHighlight = this.softphone_incoming_matches_row(row) ? 'vobiz-callback-highlight' : '';
		return `
			<tr class="${callbackHighlight}" data-index="${row.index}" data-action="select-row">
				<td><input type="checkbox" data-role="row-check" ${checked}></td>
				<td><code>${frappe.utils.escape_html(row.name || '')}</code></td>
				<td><div class="vobiz-person"><span class="vobiz-avatar">${frappe.utils.escape_html(initials)}</span><span>${frappe.utils.escape_html(row.title || row.name || '')}</span></div></td>
				<td>${frappe.utils.escape_html(row.phone || '')}</td>
				<td>${this.missed_call_cell_html(row)}</td>
				<td>${this.whatsapp_queue_cell_html(row)}</td>
				<td class="vobiz-patient-col ${this.is_patient_queue() ? '' : 'hidden'}">${frappe.utils.escape_html(row.sr_medical_department || '')}</td>
				<td class="vobiz-patient-col ${this.is_patient_queue() ? '' : 'hidden'}">${frappe.utils.escape_html(row.sr_dpt_disease || '')}</td>
				<td class="vobiz-patient-col ${this.is_patient_queue() ? '' : 'hidden'}">${frappe.utils.escape_html(row.sr_dpt_language || '')}</td>
				<td class="vobiz-patient-col ${this.is_patient_queue() ? '' : 'hidden'}">${frappe.utils.escape_html(row.sr_followup_id || '')}</td>
				<td class="vobiz-patient-col ${this.is_patient_queue() ? '' : 'hidden'}">${frappe.utils.escape_html(row.sr_followup_day || '')}</td>
				<td class="vobiz-team-col ${this.is_patient_queue() ? 'hidden' : ''}">${frappe.utils.escape_html(row.team || '')}</td>
				<td class="vobiz-lead-owner-col ${this.is_patient_queue() ? 'hidden' : ''}">${frappe.utils.escape_html(row.owner || '')}</td>
				<td><span class="vobiz-status ${frappe.utils.escape_html(statusClass)}">${frappe.utils.escape_html(row.status || '')}</span></td>
				<td>${frappe.utils.escape_html(row.next_action || '')}</td>
				<td title="${frappe.utils.escape_html(row.modified || '')}">${frappe.utils.escape_html(this.compact_relative_time(row.modified))}</td>
				<td title="${frappe.utils.escape_html(row.creation || '')}">${frappe.utils.escape_html(this.format_datetime(row.creation))}</td>
				<td>
					<button class="btn btn-xs btn-primary" data-action="call-row" ${loading ? 'disabled' : ''}>
						<i class="fa ${loading ? 'fa-spinner fa-spin' : 'fa-phone'}"></i> ${loading ? __('Loading') : __('Details')}
					</button>
				</td>
			</tr>
		`;
	}

	missed_call_cell_html(row) {
		const count = parseInt(row.missed_call_count || 0, 10) || 0;
		const isNew = this.is_new_missed_call(row);
		const title = count
			? (isNew ? __('New missed calls: {0}', [count]) : __('Missed calls: {0}', [count]))
			: __('No missed calls');
		const content = `
			<span class="vobiz-missed-count">${frappe.utils.escape_html(String(count))}</span>
			${count ? `<span class="vobiz-missed-badge"><i class="fa fa-phone"></i></span>` : ''}
		`;
		if (!count) {
			return `
				<div class="vobiz-missed-cell vobiz-missed-empty" title="${frappe.utils.escape_html(title)}">
					${content}
				</div>
			`;
		}
		return `
			<button type="button" class="vobiz-missed-cell clickable ${isNew ? 'has-new' : ''}" data-action="open-missed-calls" title="${frappe.utils.escape_html(title)}">
				${content}
			</button>
		`;
	}

	is_recent_missed_call(value) {
		if (!value) {
			return false;
		}
		const normalized = String(value).replace(' ', 'T');
		const missedAt = new Date(normalized);
		if (Number.isNaN(missedAt.getTime())) {
			return false;
		}
		const minutes = (Date.now() - missedAt.getTime()) / 60000;
		return minutes >= 0 && minutes <= 120;
	}

	is_new_missed_call(row) {
		if (!this.is_recent_missed_call(row.missed_call_time)) {
			return false;
		}
		const key = this.detail_key(row);
		return !key || this.state.missed_call_seen[key] !== String(row.missed_call_time || '');
	}

	mark_missed_call_seen(row) {
		const key = this.detail_key(row);
		if (!key || !row.missed_call_time) return;
		this.state.missed_call_seen[key] = String(row.missed_call_time || '');
		this.save_missed_call_seen();
	}

	load_missed_call_seen() {
		try {
			return JSON.parse(window.localStorage.getItem(VOBIZ_MISSED_CALL_SEEN_KEY) || '{}') || {};
		} catch (e) {
			return {};
		}
	}

	save_missed_call_seen() {
		try {
			window.localStorage.setItem(VOBIZ_MISSED_CALL_SEEN_KEY, JSON.stringify(this.state.missed_call_seen || {}));
		} catch (e) {
			// Local storage can be blocked; in that case the cue may return after refresh.
		}
	}

	whatsapp_queue_cell_html(row) {
		if (!row.whatsapp_conversation) {
			return `<span class="vobiz-wa-empty">-</span>`;
		}
		const unread = parseInt(row.whatsapp_unread_count || 0, 10) || 0;
		const preview = row.whatsapp_last_message_preview || '';
		const title = preview
			? __('WhatsApp: {0}', [preview])
			: (unread ? __('Unread WhatsApp messages') : __('Open WhatsApp chat'));
		const className = unread ? 'has-new' : 'is-quiet';
		return `
			<button class="btn btn-xs btn-default vobiz-wa-queue ${className}" data-action="open-whatsapp-row" title="${frappe.utils.escape_html(title)}">
				<i class="fa fa-whatsapp"></i>
				${unread ? `<span class="vobiz-wa-count">${frappe.utils.escape_html(String(unread))}</span>` : `<span>${__('Chat')}</span>`}
			</button>
		`;
	}

	compact_relative_time(value) {
		if (!value) return '-';
		const raw = String(value).replace(' ', 'T');
		const date = new Date(raw);
		if (Number.isNaN(date.getTime())) return '-';

		const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
		if (seconds < 60) return `${Math.max(seconds, 1)}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d`;
		const months = Math.floor(days / 30);
		if (months < 12) return `${months}mo`;
		return `${Math.floor(months / 12)}y`;
	}

	format_datetime(value) {
		if (!value) return '-';
		const raw = String(value).replace(' ', 'T');
		const date = new Date(raw);
		if (Number.isNaN(date.getTime())) return '-';

		return date.toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	is_patient_queue() {
		return ((this.state.queue_meta || {}).doctype || '') === 'Patient';
	}

	update_selected_count() {
		const count = this.selected_queue_rows().length;
		const selectedLabel = this.queue_meta_value('selected_label');
		this.sync_check_all_state();
		const session = this.state.auto_dial || {};
		if (session.running || (session.results || []).length) {
			const total = (session.queue || []).length;
			const done = (session.results || []).length;
			const status = session.running ? __('running') : __('stopped');
			this.page.main.find('[data-role="selected-count"]').text(
				__('{0} {1} selected - Auto dial {2}: {3}/{4}', [count, selectedLabel, status, done, total])
			);
			return;
		}
		this.page.main.find('[data-role="selected-count"]').text(__('{0} {1} selected', [count, selectedLabel]));
	}

	queue_row_key(row) {
		if (!row || !row.name) return '';
		return `${row.doctype || this.queue_meta_value('doctype') || ''}::${row.name}`;
	}

	prune_selected_queue_keys() {
		const available = new Set((this.state.queue || []).map(row => this.queue_row_key(row)).filter(Boolean));
		Array.from(this.state.selected_queue_keys || []).forEach(key => {
			if (!available.has(key)) {
				this.state.selected_queue_keys.delete(key);
			}
		});
	}

	selected_queue_rows() {
		const selected = this.state.selected_queue_keys || new Set();
		return (this.state.queue || []).filter(row => selected.has(this.queue_row_key(row)));
	}

	sync_check_all_state() {
		const rows = this.visible_queue_rows();
		const selected = this.state.selected_queue_keys || new Set();
		const selectedVisible = rows.filter(row => selected.has(this.queue_row_key(row))).length;
		const $checkAll = this.page.main.find('[data-role="check-all"]');
		$checkAll.prop('checked', Boolean(rows.length && selectedVisible === rows.length));
		$checkAll.prop('indeterminate', Boolean(selectedVisible && selectedVisible < rows.length));
	}

	render_auto_toggle() {
		const session = this.state.auto_dial || {};
		const $button = this.page.main.find('[data-role="auto-toggle"]');
		if (session.running) {
			$button.removeClass('btn-primary').addClass('btn-danger')
				.html(`<i class="fa fa-stop"></i> ${__('Stop Auto Dial')}`);
			return;
		}
		$button.removeClass('btn-danger').addClass('btn-primary')
			.html(`<i class="fa fa-play"></i> ${__('Start Auto Dial')}`);
	}

	render_auto_live() {
		const session = this.state.auto_dial || {};
		const events = (session.events || []).slice(-12).reverse();
		const current = session.current || {};
		const currentDetail = `${current.status || __('Starting')}${current.call_log ? ` • ${current.call_log}` : ''}`;
		const currentHtml = current.lead ? `
			<div class="vobiz-auto-event active">
				<strong>${__('Current')}: ${frappe.utils.escape_html(current.lead)}</strong>
				<span>${frappe.utils.escape_html(currentDetail)}</span>
				<span>${frappe.utils.escape_html(current.phone || '')}</span>
			</div>
		` : '';
		this.page.main.find('[data-role="auto-live-state"]').text(session.running ? __('Running') : __('Stopped'));
		this.page.main.find('[data-role="auto-live"]').html(currentHtml + (events.map(event => `
			<div class="vobiz-auto-event ${frappe.utils.escape_html(event.state || '')}">
				<strong>${frappe.utils.escape_html(event.title || '')}</strong>
				<span>${frappe.utils.escape_html(event.detail || '')}</span>
				<span>${frappe.utils.escape_html(event.time || '')}</span>
			</div>
		`).join('') || (!currentHtml ? `<div class="text-muted">${__('Start auto dial to see live call actions here.')}</div>` : '')));
	}

	add_auto_event(title, detail, state) {
		const session = this.state.auto_dial || {};
		session.events = session.events || [];
		session.events.push({
			title,
			detail,
			state: state || '',
			time: frappe.datetime.now_datetime()
		});
		this.state.auto_dial = session;
		this.render_auto_live();
	}

	agent_console_targets(selector) {
		let $targets = this.page.main.find(selector);
		if (this.auto_call_dialog && this.auto_call_dialog.$wrapper) {
			$targets = $targets.add(this.auto_call_dialog.$wrapper.find(selector));
		}
		return $targets;
	}

	show_auto_call_dialog() {
		if (this.auto_call_dialog && this.auto_call_dialog.$wrapper && this.auto_call_dialog.$wrapper.is(':visible')) {
			this.render_auto_call_dialog();
			return;
		}
		const dialog = new frappe.ui.Dialog({
			title: __('Real-Time Agent Console'),
			fields: [{
				fieldname: 'details',
				fieldtype: 'HTML',
				options: this.auto_call_dialog_html()
			}]
		});
		this.auto_call_dialog = dialog;
		dialog.$wrapper.addClass('vobiz-auto-call-dialog');
		dialog.get_close_btn().show();
		dialog.$wrapper.on('click', '[data-action="open-reference"]', () => this.open_reference());
		dialog.$wrapper.on('click', '[data-action="cancel-call"]', () => {
			const callLog = ((this.state.auto_dial || {}).current || {}).call_log || ((this.state.active_call || {}).name);
			if (callLog) {
				this.cancel_call_log(callLog);
			}
		});
		dialog.$wrapper.on('hidden.bs.modal', () => {
			if (this.state.active_workdesk_dialog !== dialog) return;
			this.stop_whatsapp_sync();
			if (this.auto_call_dialog === dialog) {
				this.auto_call_dialog = null;
			}
		});
		dialog.show();
		this.render_auto_call_dialog();
	}

	hide_auto_call_dialog() {
		if (!this.auto_call_dialog) return;
		const dialog = this.auto_call_dialog;
		this.auto_call_dialog = null;
		dialog.hide();
	}

	auto_call_dialog_html() {
		return `
			<section class="vobiz-band vobiz-active">
				<div class="vobiz-section-title">
					<h3>${__('Current Call')}</h3>
					<span class="vobiz-pill" data-role="call-status">${__('Idle')}</span>
				</div>
				<div class="vobiz-call-focus">
					<div class="vobiz-call-title" data-role="focus-name">${__('No active call')}</div>
					<div class="text-muted" data-role="focus-meta">${__('Waiting for auto dial call')}</div>
					<div class="vobiz-call-timer" data-role="timer">00:00</div>
					<div class="vobiz-call-controls">
						<button class="btn btn-default btn-sm" data-action="open-reference"><i class="fa fa-external-link"></i></button>
						<button class="btn btn-danger btn-sm" data-action="cancel-call"><i class="fa fa-phone"></i> ${__('End')}</button>
					</div>
					<div class="vobiz-call-assets" data-role="call-assets"></div>
				</div>
			</section>
		`;
	}

	render_auto_call_dialog() {
		if (!this.auto_call_dialog) return;
		this.render_active_call(true);
		const session = this.state.auto_dial || {};
		const current = session.current || {};
		if (current.title || current.lead) {
			this.agent_console_targets('[data-role="focus-name"]').text(current.title || current.lead);
			this.agent_console_targets('[data-role="focus-meta"]').text(`${current.lead || ''} • ${current.phone || __('No phone')}`);
			this.agent_console_targets('[data-role="call-status"]').text(current.status || __('Starting'));
		}
	}

	select_row(index) {
		const row = this.state.queue[index];
		if (!row) return;
		this.state.selected = row;
		frappe.call('vobiz_click_to_call.api.console.get_reference_context', {
			reference_doctype: row.doctype,
			reference_name: row.name,
			lite: 1
		}).then((r) => {
			this.state.context = r.message || {};
			this.apply_context_dispositions(this.state.context);
			this.show_tab('call_summary');
			this.render_focus(row);
		});
	}

	render_focus(row) {
		this.agent_console_targets('[data-role="focus-name"]').text(row.title || row.name || __('Selected record'));
		this.agent_console_targets('[data-role="focus-meta"]').text(`${row.doctype} • ${row.phone || __('No phone')}`);
	}

	render_active_call(skipDispositionPrompt) {
		const active = this.state.active_call || {};
		const last = active.last_call || {};
		this.render_header_active_call(active);
		this.agent_console_targets('[data-role="call-status"]').text(active.status || last.status || __('Idle'));
		if (active.reference_name) {
			this.agent_console_targets('[data-role="focus-name"]').text(active.reference_title || active.reference_name);
			this.agent_console_targets('[data-role="focus-meta"]').text(`${active.reference_doctype || ''} • ${active.customer_number_display || ''}`);
		} else if (last.status) {
			this.agent_console_targets('[data-role="focus-meta"]').text(__('Last call {0}', [last.status]));
		}
		if (active.name && !this.is_terminal_status(active.status)) {
			this.state.call_started_at = active.started_at ? new Date(active.started_at) : null;
			this.start_timer();
		} else {
			this.state.call_started_at = null;
			this.stop_timer();
			if (!skipDispositionPrompt && last.name && this.is_terminal_status(last.status)) {
				this.clear_tracked_live_call(last.name);
				this.maybe_prompt_workdesk_disposition(last);
			}
		}
		this.render_call_assets(active.name ? active : last);
		this.render_workdesk_live_call();
		if (!skipDispositionPrompt && !this.disposition_call_in_progress() && this.completed_call_contexts?.size) {
			for (const call of Array.from(this.completed_call_contexts.values())) this.maybe_prompt_workdesk_disposition(call);
		}
		this.sync_post_call_disposition();
	}

	render_call_assets(call) {
		const rows = [];
		if (call.recording_status) {
			rows.push(`<div><strong>${__('Recording')}</strong>: ${frappe.utils.escape_html(call.recording_status)}</div>`);
		}
		if (call.recording_url) {
			const recordingUrl = call.recording_download_url || `/api/method/vobiz_click_to_call.api.recording.stream?call_log=${encodeURIComponent(call.name || '')}`;
			rows.push(`<div><a href="${frappe.utils.escape_html(recordingUrl)}" target="_blank" rel="noopener">${__('Open Recording')}</a></div>`);
		}
		if (call.transcript_status) {
			rows.push(`<div><strong>${__('Transcript')}</strong>: ${frappe.utils.escape_html(call.transcript_status)}</div>`);
		}
		if (call.transcript_text) {
			rows.push(`<div class="vobiz-transcript">${frappe.utils.escape_html(call.transcript_text)}</div>`);
		}
		if (call.recording_error || call.transcript_error) {
			rows.push(`<div class="text-muted">${frappe.utils.escape_html(call.recording_error || call.transcript_error)}</div>`);
		}
		this.agent_console_targets('[data-role="call-assets"]').html(rows.join(''));
	}

	start_timer() {
		clearInterval(this.timer);
		const tick = () => {
			if (!this.state.call_started_at) {
				this.agent_console_targets('[data-role="timer"]').text('00:00');
				this.page.main.find('[data-role="softphone-duration"]').text('00:00');
				return;
			}
			const seconds = Math.max(0, Math.floor((Date.now() - this.state.call_started_at.getTime()) / 1000));
			const minutes = Math.floor(seconds / 60);
			const label = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
			this.agent_console_targets('[data-role="timer"]').text(label);
			this.page.main.find('[data-role="softphone-duration"]').text(label);
		};
		tick();
		this.timer = setInterval(tick, 1000);
	}

	stop_timer() {
		clearInterval(this.timer);
		this.timer = null;
		this.agent_console_targets('[data-role="timer"]').text('00:00');
		this.page.main.find('[data-role="softphone-duration"]').text('00:00');
	}

	render_dispositions() {
		const context = this.state.lead_disposition_context || {};
		const active = this.state.active_call || {};
		const row = this.state.active_workdesk_row || this.state.selected || {};
		const isPatient = this.is_patient_disposition_reference(active, row);
		this.page.main.find('[data-role="lead-status"]').closest('.form-group, .vobiz-field, .control-input-wrapper').toggle(!isPatient);
		this.page.main.find('[data-role="disposition"]').closest('.form-group, .vobiz-field, .control-input-wrapper').toggle(!isPatient);
		this.page.main.find('[data-role="sr-followup-status"]').closest('.form-group, .vobiz-field, .control-input-wrapper').toggle(isPatient);
		if (isPatient) {
			const currentFollowupStatus = row.sr_followup_status || '';
			this.page.main.find('[data-role="sr-followup-status"]').html([''].concat(this.patient_followup_status_options()).map(value =>
				`<option value="${frappe.utils.escape_html(value)}">${frappe.utils.escape_html(value || __('Select Follow-up Status'))}</option>`
			).join('')).val(currentFollowupStatus);
			return;
		}
		const statusOptions = context.status_options || [];
		const currentStatus = context.status || '';
		const currentDisposition = context.disposition || '';
		const options = [''].concat(this.state.dispositions || []);
		this.page.main.find('[data-role="lead-status"]').html([''].concat(statusOptions).map(value =>
			`<option value="${frappe.utils.escape_html(value)}">${frappe.utils.escape_html(value || __('Select Status'))}</option>`
		).join('')).val(currentStatus);
		this.page.main.find('[data-role="disposition"]').html(options.map(value =>
			`<option value="${frappe.utils.escape_html(value)}">${frappe.utils.escape_html(value || __('Select Lead Disposition'))}</option>`
		).join('')).val(currentDisposition);
	}

	is_patient_disposition_reference(call = {}, row = {}) {
		return (
			(call.reference_doctype || '') === 'Patient'
			|| (row.doctype || '') === 'Patient'
			|| this.is_patient_queue()
		);
	}

	patient_followup_status_options() {
		return this.state.patient_followup_status_options || [];
	}

	render_manual_disposition_visibility() {
		this.page.main.find('[data-role="manual-disposition-section"]').toggle(!this.state.ai_disposition_enabled);
	}

	apply_context_dispositions(context) {
		const leadDisposition = ((context || {}).workdesk || {}).lead_disposition || {};
		const patientFollowupOptions = ((context || {}).workdesk || {}).patient_followup_status_options || [];
		const options = (leadDisposition.options || []).map(row => row.name).filter(Boolean);
		this.state.lead_disposition_context = leadDisposition;
		if (patientFollowupOptions.length) {
			this.state.patient_followup_status_options = patientFollowupOptions;
		}
		this.state.dispositions = options;
		this.render_dispositions();
	}

	async refresh_lead_disposition_options() {
		const reference = this.active_disposition_reference();
		const leadStatus = this.page.main.find('[data-role="lead-status"]').val();
		const request = this.disposition_refresh_request = (this.disposition_refresh_request || 0) + 1;
		this.state.dispositions = [];
		this.state.lead_disposition_context = Object.assign({}, this.state.lead_disposition_context, {
			status: leadStatus || '', disposition: '', options: []
		});
		this.render_dispositions();
		if (!reference.reference_doctype || !reference.reference_name || !leadStatus) return;
		try {
			const r = await frappe.call({
				method: 'vobiz_click_to_call.api.disposition.get_lead_disposition_context_api',
				args: Object.assign({}, reference, {lead_status: leadStatus})
			});
			const current = this.active_disposition_reference();
			if (request !== this.disposition_refresh_request
				|| current.reference_doctype !== reference.reference_doctype
				|| current.reference_name !== reference.reference_name
				|| this.page.main.find('[data-role="lead-status"]').val() !== leadStatus) return;
			const context = r.message || {};
			this.state.lead_disposition_context = Object.assign({}, context, {disposition: ''});
			this.state.dispositions = (context.options || []).map(row => row.name).filter(Boolean);
			this.render_dispositions();
		} catch (error) {
			// Leave choices empty on failure instead of restoring another status's options.
		}
	}

	active_disposition_reference() {
		const active = this.state.active_call || {};
		const selected = this.state.selected || {};
		const contextReference = (this.state.context || {}).reference || {};
		return {
			reference_doctype: active.reference_doctype || selected.doctype || contextReference.doctype,
			reference_name: active.reference_name || selected.name || contextReference.name
		};
	}

	show_tab(tab) {
		this.page.main.find('[data-tab]').removeClass('active');
		this.page.main.find(`[data-tab="${tab}"]`).addClass('active');
		const context = this.state.context || {};
		if (tab === 'transcript') return this.render_transcript(context.history || []);
		if (tab === 'audio') return this.render_audio(context.history || []);
		if (tab === 'history') return this.render_history(context.history || []);
		this.render_call_summary(context);
	}

	render_call_summary(context) {
		const reference = context.reference || this.state.selected || {};
		const latest = (context.history || [])[0] || {};
		const guidance = context.guidance || {};
		const script = guidance.script || [__('Select a lead to load call guidance.')];
		this.page.main.find('[data-role="tab-panel"]').html(`
			<div class="vobiz-detail-head">
				<div>
					<h3>${frappe.utils.escape_html(reference.title || reference.name || __('Lead Details'))}</h3>
					<div class="text-muted">${frappe.utils.escape_html(reference.doctype || '')} • ${frappe.utils.escape_html(reference.phone || '')}</div>
				</div>
				<button class="btn btn-primary btn-sm" data-action="call-selected"><i class="fa fa-phone"></i> ${__('Start Call')}</button>
			</div>
			<strong>${__('Call Info')}</strong>
			<div class="vobiz-info-list">
				${this.info_row('fa-phone', __('Caller'), reference.phone || __('No phone'))}
				${this.info_row('fa-user', __('Agent'), latest.user || frappe.session.user)}
				${this.info_row('fa-calendar', __('Date'), latest.creation ? frappe.datetime.str_to_user(latest.creation) : __('No previous call'))}
				${this.info_row('fa-clock-o', __('Duration'), latest.duration_label || '00:00')}
			</div>
			<hr>
			<strong>${__('Guidance')}</strong>
			<ul class="vobiz-guidance-list">${script.map(line => `<li>${frappe.utils.escape_html(line)}</li>`).join('')}</ul>
		`);
	}

	info_row(icon, label, value) {
		return `
			<div class="vobiz-info-row">
				<div class="vobiz-info-icon"><i class="fa ${icon}"></i></div>
				<div><div class="text-muted">${frappe.utils.escape_html(label)}</div><strong>${frappe.utils.escape_html(String(value || ''))}</strong></div>
			</div>
		`;
	}

	render_transcript(history) {
		const rows = history.filter(row => row.transcript_text || row.transcript_status || row.ai_summary);
		this.page.main.find('[data-role="tab-panel"]').html(rows.map(row => `
			<div class="vobiz-audio-card">
				<div class="vobiz-detail-head">
					<div><strong>${frappe.utils.escape_html(row.name)}</strong><div class="text-muted">${frappe.datetime.str_to_user(row.creation)} • ${frappe.utils.escape_html(row.status || '')}</div></div>
					<a class="btn btn-xs btn-default" href="/app/vobiz-call-log/${frappe.utils.escape_html(row.name)}">${__('Open')}</a>
				</div>
				${row.ai_summary ? `<div><strong>${__('Summary')}</strong><div>${frappe.utils.escape_html(row.ai_summary)}</div></div>` : ''}
				${row.transcript_text ? `<div class="vobiz-transcript">${frappe.utils.escape_html(row.transcript_text)}</div>` : `<div class="text-muted">${frappe.utils.escape_html(row.transcript_status || __('No transcript yet'))}</div>`}
			</div>
		`).join('') || `<div class="text-muted">${__('No transcript available for this lead.')}</div>`);
	}

	render_audio(history) {
		const rows = history.filter(row => row.recording_url || row.recording_status);
		this.page.main.find('[data-role="tab-panel"]').html(`
			<div class="vobiz-audio-list">
				${rows.map(row => `
					<div class="vobiz-audio-card">
						<div><strong>${frappe.utils.escape_html(row.name)}</strong></div>
						<div class="text-muted">${frappe.datetime.str_to_user(row.creation)} • ${frappe.utils.escape_html(row.recording_status || row.status || '')} • ${frappe.utils.escape_html(row.duration_label || '')}</div>
						${this.audio_player_html(row) || `<div class="text-muted">${__('No audio file yet')}</div>`}
						${row.recording_download_url ? `<a href="${frappe.utils.escape_html(row.recording_download_url)}" target="_blank" rel="noopener">${__('Open Recording')}</a>` : ''}
					</div>
				`).join('') || `<div class="text-muted">${__('No recording available for this lead.')}</div>`}
			</div>
		`);
	}

	render_history(history) {
		this.page.main.find('[data-role="tab-panel"]').html(history.map(row => `
			<div class="vobiz-history-row">
				<div>${frappe.datetime.str_to_user(row.creation)}</div>
				<div>${frappe.utils.escape_html(row.status || '')}</div>
				<div>${frappe.utils.escape_html(row.disposition || row.ai_next_action || row.ai_summary || '')}</div>
			</div>
		`).join('') || `<div class="text-muted">${__('No previous interactions')}</div>`);
	}

	render_insights(history) {
		const total = history.length;
		const connected = history.filter(row => ['Connected', 'Completed'].includes(row.status)).length;
		const missed = history.filter(row => ['Failed', 'Busy', 'No Answer', 'Cancelled'].includes(row.status)).length;
		this.page.main.find('[data-role="tab-panel"]').html(`
			<div class="vobiz-stats" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
				<div class="vobiz-stat"><span>${__('Previous Calls')}</span><strong>${total}</strong></div>
				<div class="vobiz-stat"><span>${__('Connected')}</span><strong>${connected}</strong></div>
				<div class="vobiz-stat"><span>${__('Missed')}</span><strong>${missed}</strong></div>
			</div>
		`);
	}

	call_row(index) {
		const row = this.state.queue[index];
		if (!row) return;
		if (this.state.detail_loading_key) return;
		this.mark_missed_call_seen(row);
		this.set_detail_loading(row, true);
		const request = frappe.call({
			method: 'vobiz_click_to_call.api.console.get_reference_context',
			args: {
				reference_doctype: row.doctype,
				reference_name: row.name,
				lite: 1
			}
		});
		request.then((r) => {
			this.state.context = r.message || {};
			this.apply_context_dispositions(this.state.context);
			this.open_detail_dialog(row, r.message || {});
		});
		request.always(() => this.set_detail_loading(row, false));
	}

	handle_call_disconnected(payload = {}) {
		if (!payload.name || !this.is_terminal_status(payload.status)) return;
		const active = this.state.active_call || {};
		const known = this.state.softphone.current_call_log === payload.name || active.name === payload.name
			|| active.last_call?.name === payload.name || this.state.workdesk_live_call_log === payload.name
			|| this.completed_call_contexts?.has(payload.name);
		if (!known) {
			if (payload.direction === 'Incoming') this.watch_browser_call_disposition(payload.name);
			return;
		}
		const call = this.completed_call_context(payload);
		if (this.reconcile_browser_softphone_call(call)) return;
		if (active.name === call.name || (!active.name && active.last_call?.name === call.name)) {
			this.state.active_call = { last_call: call };
			this.render_active_call(true);
		}
		this.maybe_prompt_workdesk_disposition(call);
	}

	render_header_active_call(active = {}) {
		const isActive = Boolean(active.name && !this.is_terminal_status(active.status));
		const $control = this.page.main.find('[data-role="head-active-call"]');
		$control.toggleClass('hidden', !isActive);
		if (!isActive) return;

		const customer = active.reference_title || active.reference_name || active.customer_number_display || __('Customer');
		const status = active.status || __('Active Call');
		$control.find('[data-role="head-call-status"]').text(status);
		$control.find('[data-role="head-call-customer"]').text(customer).attr('title', customer);
		$control.find('[data-action="end-active-call"]').prop('disabled', Boolean(this.state.ending_active_call));
		$control.find('[data-action="complete-active-call"]')
			.prop('disabled', Boolean(this.state.completing_call_log))
			.text(this.state.completing_call_log === active.name ? __('Completing…') : __('Complete Call'));
	}

	complete_header_active_call() {
		const active = this.state.active_call || {};
		if (!active.name || this.is_terminal_status(active.status) || this.state.completing_call_log) return;
		const callLog = active.name;
		this.state.completing_call_log = callLog;
		this.render_header_active_call(active);
		return this.browser_request_with_timeout(Promise.resolve().then(() => frappe.call({
			method: 'vobiz_system_call.api.call.complete_call_log',
			args: {call_log: callLog}
		}))).then(r => {
			const call = r.message || {};
			if (call.name !== callLog || !this.is_terminal_status(call.status)) {
				throw new Error(__('Call log was not marked completed. Please retry.'));
			}
			this.handle_call_disconnected(Object.assign({}, active, call));
			this.load();
		}).catch(error => {
			frappe.msgprint(error.message || __('Could not complete the call log. Please retry.'));
		}).finally(() => {
			if (this.state.completing_call_log === callLog) this.state.completing_call_log = '';
			this.render_header_active_call(this.state.active_call || {});
		});
	}

	end_header_active_call() {
		const active = this.state.active_call || {};
		return this.confirm_end_call(active.name, active.reference_title || active.reference_name);
	}

	confirm_end_call(callLog, title) {
		if (!callLog || this.state.ending_active_call) return;
		this.state.ending_active_call = true;
		const release = () => {
			this.state.ending_active_call = false;
			this.render_header_active_call(this.state.active_call || {});
		};
		const dialog = frappe.confirm(__('End the active call with {0}?', [title || __('this customer')]), () => {
			// A delayed confirmation must never stop a different/new call.
			if (this.state.softphone.current_call_log !== callLog && (this.state.active_call || {}).name !== callLog) {
				release();
				return;
			}
			this.state.confirmed_end_call = true;
			Promise.resolve(this.cancel_call_log(callLog)).finally(() => { this.state.confirmed_end_call = false; release(); });
		}, release);
		if (dialog && dialog.$wrapper) dialog.$wrapper.one('hidden.bs.modal', () => {
			if (!this.state.confirmed_end_call) release();
		});
	}

	open_missed_calls(index) {
		const row = this.state.queue[index];
		if (!row || !parseInt(row.missed_call_count || 0, 10)) return;
		this.mark_missed_call_seen(row);
		this.render_queue();
		const dialog = new frappe.ui.Dialog({
			title: __('Missed Calls'),
			size: 'large',
			fields: [{ fieldname: 'missed_calls', fieldtype: 'HTML' }]
		});
		dialog.show();
		dialog.get_field('missed_calls').$wrapper.html(`<div class="text-muted">${__('Loading missed calls...')}</div>`);
		frappe.call('vobiz_click_to_call.api.console.get_reference_missed_calls', {
			reference_doctype: row.doctype,
			reference_name: row.name,
			limit: 50
		}).then((r) => {
			const data = r.message || {};
			dialog.get_field('missed_calls').$wrapper.html(this.missed_call_list_html(data.calls || []));
		}).catch(() => {
			dialog.get_field('missed_calls').$wrapper.html(`<div class="text-danger">${__('Unable to load missed calls.')}</div>`);
		});
	}

	missed_call_list_html(calls) {
		if (!calls.length) {
			return `<div class="text-muted">${__('No missed calls found.')}</div>`;
		}
		return `
			<div class="vobiz-missed-list">
				${calls.map(call => this.missed_call_row_html(call)).join('')}
			</div>
		`;
	}

	missed_call_row_html(call) {
		const when = call.start_time || call.creation || call.modified || '';
		const reason = call.hangup_cause || call.call_status || call.dial_status || call.error_message || '';
		return `
			<div class="vobiz-missed-row">
				<div class="vobiz-missed-row-head">
					<strong>${frappe.utils.escape_html(call.status || __('Missed'))}</strong>
					<a class="btn btn-xs btn-default" href="/app/vobiz-call-log/${frappe.utils.escape_html(call.name || '')}">${__('Open')}</a>
				</div>
				<div class="vobiz-missed-row-grid">
					<div><span>${__('Time')}</span>${frappe.utils.escape_html(when ? this.format_datetime(when) : '-')}</div>
					<div><span>${__('Customer')}</span>${frappe.utils.escape_html(call.customer_number || '-')}</div>
					<div><span>${__('Agent')}</span>${frappe.utils.escape_html(call.user || call.user_mobile || call.agent_number || '-')}</div>
					<div><span>${__('DID')}</span>${frappe.utils.escape_html(call.did_number || '-')}</div>
					<div><span>${__('Duration')}</span>${frappe.utils.escape_html(call.duration_label || '0s')}</div>
					<div><span>${__('Reason')}</span>${frappe.utils.escape_html(reason || '-')}</div>
				</div>
			</div>
		`;
	}

	open_queue_whatsapp(index) {
		const row = this.state.queue[index];
		if (!row || !row.whatsapp_conversation) return;
		if (this.state.detail_loading_key) return;
		this.set_detail_loading(row, true);
		const request = frappe.call({
			method: 'vobiz_click_to_call.api.console.get_reference_context',
			args: {
				reference_doctype: row.doctype,
				reference_name: row.name,
				lite: 1
			}
		});
		request.then((r) => {
			this.state.context = r.message || {};
			this.apply_context_dispositions(this.state.context);
			this.open_detail_dialog(row, r.message || {}, 'whatsapp');
		});
		request.always(() => this.set_detail_loading(row, false));
	}

	detail_key(row) {
		return row && row.doctype && row.name ? `${row.doctype}::${row.name}` : '';
	}

	set_detail_loading(row, loading) {
		const key = this.detail_key(row);
		if (!key) return;
		if (loading) {
			this.state.detail_loading_key = key;
		} else if (this.state.detail_loading_key === key) {
			this.state.detail_loading_key = null;
		}
		this.render_queue();
	}

	open_detail_dialog(row, context, initial_tab) {
		context.workdesk = context.workdesk || {};
		context.loaded_workdesk_tabs = context.loaded_workdesk_tabs || { summary: true };
		this.state.navigating_from_workdesk = false;
		this.state.active_workdesk_key = row && row.doctype && row.name ? `${row.doctype}::${row.name}` : null;
		this.state.active_workdesk_row = row;
		const dialog = new frappe.ui.Dialog({
			title: __('Agent Workdesk'),
			size: 'extra-large',
			static: true,
			fields: [{ fieldname: 'details', fieldtype: 'HTML' }],
			primary_action_label: __('Start Call'),
			primary_action: () => this.handle_workdesk_primary_action(row, this.consume_workdesk_call_intent(dialog.get_primary_btn()[0]))
		});
		this.state.active_workdesk_dialog = dialog;
		dialog.$wrapper.addClass('vobiz-workdesk-modal');
		this.bind_workdesk_call_intent(dialog.$wrapper);
		dialog.get_close_btn().show();
		dialog.$wrapper.on('hidden.bs.modal', () => {
			if (this.state.active_workdesk_dialog !== dialog) return;
			this.close_whatsapp_media_viewer();
			dialog.$wrapper.find('[data-wa-playback]').each((_, media) => { media.pause(); media.removeAttribute('src'); media.load(); });
			this.state.active_workdesk_key = null;
			this.state.active_workdesk_body = null;
			this.state.active_workdesk_row = null;
			this.state.active_workdesk_dialog = null;
			if (!this.state.navigating_from_workdesk) {
				this.clear_workdesk_return_state();
			}
		});
		dialog.show();
		const $body = dialog.get_field('details').$wrapper;
		$body.attr('data-wa-reference', '1').data('whatsapp-reference', {
			reference_doctype: row.doctype,
			reference_name: row.name
		});
		this.state.active_workdesk_body = $body;
		const render = (tab) => {
			this.stop_whatsapp_sync();
			$body.find('[data-detail-tab]').removeClass('active');
			$body.find(`[data-detail-tab="${tab}"]`).addClass('active');
			const workdesk = context.workdesk || {};
			if (tab === 'encounters') {
				$body.find('[data-detail-panel]').html(this.workdesk_encounters_html(workdesk));
			} else if (tab === 'clinical-history') {
				$body.find('[data-detail-panel]').html(this.workdesk_clinical_history_html(workdesk));
			} else if (tab === 'reports') {
				$body.find('[data-detail-panel]').html(this.workdesk_reports_html(workdesk));
			} else if (tab === 'vobiz') {
				$body.find('[data-detail-panel]').html(this.workdesk_vobiz_html(workdesk, context.history || []));
			} else if (tab === 'whatsapp') {
				$body.find('[data-detail-panel]').html(this.workdesk_whatsapp_html(workdesk));
				this.initialize_whatsapp_window($body, workdesk.whatsapp || {});
				setTimeout(() => this.scroll_whatsapp_to_bottom($body), 50);
				this.schedule_whatsapp_sync(0);
			} else {
				$body.find('[data-detail-panel]').html(this.workdesk_lead_html(row, context));
				this.render_workdesk_live_call();
			}
		};
		$body.html(`
			<div class="vobiz-detail-dialog">
				<div data-workdesk-incoming></div>
				<div class="vobiz-tabs">
					<button class="active" data-detail-tab="summary">${frappe.utils.escape_html(this.queue_meta_value('summary_tab_label'))}</button>
					<button data-detail-tab="encounters">${__('Encounters')}</button>
					<button data-detail-tab="clinical-history">${__('Patient Clinical History')}</button>
					<button data-detail-tab="reports">${__('Reports')}</button>
					<button data-detail-tab="vobiz">${__('Vobiz Summary')}</button>
					<button data-detail-tab="whatsapp">${__('WhatsApp')}</button>
				</div>
				<div data-detail-panel></div>
			</div>
		`);
		$body.on('click', '[data-incoming-answer]', (e) => this.answer_browser_softphone($(e.currentTarget).attr('data-call-log')));
		this.render_workdesk_incoming_controls();
		$body.on('click', '[data-detail-tab]', (e) => {
			const tab = $(e.currentTarget).data('detail-tab');
			this.load_workdesk_tab(row, context, tab, $body, render);
		});
		$body.on('click', '[data-workdesk-action]', (e) => this.handle_workdesk_action($(e.currentTarget).data('workdesk-action'), row, context, $body, e));
		$body.on('change', '[data-workdesk-status]', (e) => this.save_workdesk_status(row, context, $(e.currentTarget)));
		// Scroll does not bubble; capture it for dynamically rendered chat lists.
		$body.get(0).addEventListener('scroll', (e) => {
			const el = e.target;
			if (!el.matches('[data-wa-chat-list]')) return;
			if (el.scrollTop <= 80) {
				this.load_more_whatsapp_messages($(el));
			}
			const view = this.active_whatsapp_view();
			if (view && view.element === el) this.mark_visible_whatsapp_read(view);
		}, true);
		$body.on('click', '[data-wa-loader]', (e) => this.load_more_whatsapp_messages($(e.currentTarget).closest('[data-wa-chat-list]')));
		$body.on('click', '[data-wa-send]', () => this.send_workdesk_whatsapp($body));
		$body.on('click', '[data-wa-image-view]', (event) => { event.preventDefault(); this.open_whatsapp_media_viewer($body, event.currentTarget); });
		$body.on('click', '[data-wa-media-download]', (event) => this.prepare_whatsapp_media_download($body, event));
		$body.on('click', '[data-wa-window-retry]', () => this.schedule_whatsapp_sync(0));
		$body.on('click', '[data-wa-template]', () => this.open_workdesk_template_dialog($body));
		$body.on('click', '[data-wa-attach]', (e) => {
			e.stopPropagation();
			$body.find('[data-wa-emoji-menu]').removeClass('show');
			$(e.currentTarget).siblings('[data-wa-attach-menu]').toggleClass('show');
		});
		$body.on('click', '[data-wa-attach-action]', (e) => {
			e.stopPropagation();
			$body.find('[data-wa-attach-menu]').removeClass('show');
			this.open_workdesk_attachment_dialog($body, $(e.currentTarget).data('wa-attach-action'));
		});
		$body.on('click', '[data-wa-emoji]', (e) => {
			e.stopPropagation();
			$body.find('[data-wa-attach-menu]').removeClass('show');
			$(e.currentTarget).siblings('[data-wa-emoji-menu]').toggleClass('show');
		});
		$body.on('click', '[data-wa-emoji-value]', (e) => {
			e.stopPropagation();
			this.insert_workdesk_emoji($body, $(e.currentTarget).data('wa-emoji-value'));
			$body.find('[data-wa-emoji-menu]').removeClass('show');
		});
		$body.on('keydown', '[data-wa-reply]', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.send_workdesk_whatsapp($body);
			}
		});
		$body.on('click', () => {
			$body.find('[data-wa-attach-menu], [data-wa-emoji-menu]').removeClass('show');
		});
		$body.on('click', '[data-open-doc]', (e) => {
			const $btn = $(e.currentTarget);
			this.remember_workdesk_return(row);
			frappe.set_route('Form', $btn.data('doctype'), $btn.data('name'));
		});
		this.load_workdesk_tab(row, context, initial_tab || 'summary', $body, render);
		this.update_workdesk_primary_action(row);
	}

	bind_workdesk_call_intent($wrapper) {
		const selector = '[data-workdesk-action="call"], .btn-modal-primary';
		$wrapper[0].addEventListener('click', event => {
			if (event.detail <= 1 || !event.target.closest(selector)) return;
			// The second half of a double click must not act on the new label.
			event.preventDefault();
			event.stopImmediatePropagation();
			this.workdesk_call_intents?.delete(event.target.closest(selector));
		}, true);
		$wrapper.on('pointerdown keydown', selector, (event) => {
			if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
			if (event.repeat) return;
			const button = event.currentTarget;
			this.workdesk_call_intents = this.workdesk_call_intents || new WeakMap();
			this.workdesk_call_intents.set(button, { call_log: button.getAttribute('data-call-log') || '' });
		});
		$wrapper.on('pointercancel blur', selector, event => this.workdesk_call_intents?.delete(event.currentTarget));
	}

	consume_workdesk_call_intent(button) {
		const intent = this.workdesk_call_intents?.get(button);
		this.workdesk_call_intents?.delete(button);
		return intent || { call_log: button?.getAttribute('data-call-log') || '' };
	}

	handle_workdesk_primary_action(row, intent) {
		const call = this.matching_active_call(row);
		const active = call && call.name && !this.is_terminal_status(call.status);
		if (intent) {
			if (intent.call_log) {
				// A Stop gesture cannot become Start or target a replacement call.
				if (active && call.name === intent.call_log) return this.cancel_call_log(intent.call_log, row);
				return Promise.resolve();
			}
			// Likewise, a Start gesture must not hang up a call arriving meanwhile.
			if (active) return Promise.resolve();
		} else if (active) {
			return this.cancel_call_log(call.name, row);
		}
		this.state.selected = row;
		return this.start_call_for_row(row);
	}

	update_workdesk_primary_action(row) {
		const dialog = this.state.active_workdesk_dialog;
		if (!dialog || !row) return;

		const call = this.matching_active_call(row);
		const isActive = Boolean(call && call.name && !this.is_terminal_status(call.status));
		const $buttons = dialog.get_primary_btn().add(dialog.$wrapper.find('.btn-modal-primary'));
		$buttons
			.toggleClass('btn-primary', !isActive)
			.toggleClass('btn-danger', isActive)
			.prop('disabled', !isActive && Boolean(this.start_call_in_flight))
			.attr('data-call-log', isActive ? call.name : '')
			.html(isActive
				? `<i class="fa fa-phone"></i> ${__('Stop Call')}`
				: `<i class="fa fa-phone"></i> ${__('Start Call')}`);
		this.update_workdesk_header_call_action(row, call);
	}

	update_workdesk_header_call_action(row, call) {
		const $body = this.state.active_workdesk_body;
		if (!$body || !$body.length || !row) return;
		const isActive = Boolean(call && call.name && !this.is_terminal_status(call.status));
		$body.find('[data-workdesk-action="call"]')
			.toggleClass('btn-primary', !isActive)
			.toggleClass('btn-success', !isActive)
			.toggleClass('btn-danger', isActive)
			.attr('data-call-log', isActive ? call.name : '')
			.prop('disabled', !isActive && Boolean(this.start_call_in_flight))
			.html(isActive
				? `<i class="fa fa-phone"></i> ${__('Stop Call')}`
				: `<i class="fa fa-phone"></i> ${__('Start Call')}`);
	}

	load_workdesk_tab(row, context, tab, $body, render) {
		const deferredTabs = ['encounters', 'clinical-history', 'reports', 'vobiz', 'whatsapp'];
		context.loaded_workdesk_tabs = context.loaded_workdesk_tabs || { summary: true };
		if (!deferredTabs.includes(tab) || context.loaded_workdesk_tabs[tab]) {
			render(tab);
			return;
		}

		$body.find('[data-detail-tab]').removeClass('active');
		$body.find(`[data-detail-tab="${tab}"]`).addClass('active');
		$body.find('[data-detail-panel]').html(`
			<div class="vobiz-workdesk-card">
				<div class="vobiz-empty">${__('Loading details...')}</div>
			</div>
		`);
		frappe.call({
			method: 'vobiz_click_to_call.api.console.get_workdesk_tab',
			args: {
				reference_doctype: row.doctype,
				reference_name: row.name,
				tab
			}
		}).then((r) => {
			const data = r.message || {};
			if (data.whatsapp) data.whatsapp.window_received_at = Date.now();
			context.workdesk = Object.assign(context.workdesk || {}, data);
			if (data.history) {
				context.history = data.history;
			}
			context.loaded_workdesk_tabs[tab] = true;
			render(tab);
		});
	}

	workdesk_lead_html(row, context) {
		const workdesk = context.workdesk || {};
		const fields = ((workdesk.lead || {}).fields || []);
		return `
			<div class="vobiz-workdesk">
				${this.workdesk_header_html(row, context)}
				<div class="vobiz-workdesk-grid">
					<div class="vobiz-workdesk-card">
						<h4>${frappe.utils.escape_html(this.queue_meta_value('data_label'))}</h4>
						<div class="vobiz-field-grid">
								${fields.map(field => this.workdesk_field_html(field.label, field.value, field.fieldtype, field, row)).join('') || `<div class="vobiz-empty">${__('No fields found for this record.')}</div>`}
						</div>
					</div>
					${this.workdesk_lead_disposition_html(row, workdesk)}
					<div class="vobiz-workdesk-card">
						<h4>${__('Guidance')}</h4>
						<div data-workdesk-live-call>${this.workdesk_live_call_html(row)}</div>
						<ul class="vobiz-guidance-list">${((context.guidance || {}).script || []).map(line => `<li>${frappe.utils.escape_html(line)}</li>`).join('')}</ul>
					</div>
					<div class="vobiz-workdesk-card vobiz-workdesk-wide">
						<h4>${__('Notes')}</h4>
						<textarea class="form-control" rows="4" data-workdesk-note placeholder="${__('Write call notes')}" data-reference-doctype="${frappe.utils.escape_html(row.doctype || '')}" data-reference-name="${frappe.utils.escape_html(row.name || '')}"></textarea>
						<div class="vobiz-workdesk-actions">
							<button class="btn btn-primary btn-sm" data-workdesk-action="save-note"><i class="fa fa-sticky-note-o"></i> ${__('Save Note')}</button>
						</div>
					</div>
				</div>
			</div>
		`;
	}

	workdesk_lead_disposition_html(row, workdesk) {
		if (!row || row.doctype !== 'CRM Lead') {
			return '';
		}
		const leadDisposition = workdesk.lead_disposition || {};
		const options = leadDisposition.options || [];
		if (!leadDisposition.name && !leadDisposition.status && !options.length) {
			return '';
		}
		return `
			<div class="vobiz-workdesk-card">
				<h4>${__('Lead Disposition')}</h4>
				<div class="vobiz-field-grid">
					${this.workdesk_field_html(__('CRM Status'), leadDisposition.status || '-')}
					${this.workdesk_field_html(__('Lead Disposition'), leadDisposition.disposition || '-')}
				</div>
				<hr>
				<div class="vobiz-related-meta">${__('Available for this lead')}</div>
				<div class="vobiz-info-list">
					${options.slice(0, 8).map(row => `
						<div class="vobiz-related-row">
							<div>
								<div class="vobiz-related-title">${frappe.utils.escape_html(row.name || '')}</div>
								<div class="vobiz-related-meta">${frappe.utils.escape_html(row.status || __('Any CRM Status'))}</div>
							</div>
						</div>
					`).join('') || `<div class="vobiz-empty">${__('No active SR Lead Disposition found for this status.')}</div>`}
				</div>
			</div>
		`;
	}

	render_workdesk_live_call() {
		const $body = this.state.active_workdesk_body;
		const row = this.state.active_workdesk_row;
		if (!$body || !$body.length || !row) return;
		$body.find('[data-workdesk-live-call]').html(this.workdesk_live_call_html(row));
		this.update_workdesk_primary_action(row);
	}

	workdesk_live_call_html(row) {
		const call = this.matching_active_call(row);
		if (!call || !call.name) {
			return `
				<div class="vobiz-live-call">
					<div class="vobiz-live-call-head">
						<strong>${__('Live Call')}</strong>
						<span class="vobiz-live-pill">${__('Idle')}</span>
					</div>
					<div class="vobiz-live-meta">${__('Start a call to see agent and customer live events here.')}</div>
				</div>
			`;
		}

		const steps = this.live_call_steps(call);
		const networkMessage = this.state.softphone.current_call_log === call.name
			? this.browser_softphone_network_message() : '';
		const details = [
			call.dial_status ? __('Dial: {0}', [call.dial_status]) : '',
			call.hangup_cause ? __('Hangup: {0}', [call.hangup_cause]) : '',
			call.error_message ? call.error_message : ''
		].filter(Boolean).join(' · ');

		return `
			<div class="vobiz-live-call">
				<div class="vobiz-live-call-head">
					<strong>${__('Live Call')}</strong>
					<span class="vobiz-live-pill">${frappe.utils.escape_html(networkMessage || call.status || __('Active'))}</span>
				</div>
				${this.workdesk_phone_surface_html(call)}
				<div class="vobiz-live-steps">
					${steps.map(step => `
						<div class="vobiz-live-step ${frappe.utils.escape_html(step.state)}">
							<span class="vobiz-live-dot"></span>
							<div>
								<div class="vobiz-live-title">${frappe.utils.escape_html(step.title)}</div>
								<div class="vobiz-live-meta">${frappe.utils.escape_html(step.meta)}</div>
							</div>
						</div>
					`).join('')}
				</div>
				${details ? `<div class="vobiz-live-meta" style="margin-top:10px;">${frappe.utils.escape_html(details)}</div>` : ''}
			</div>
		`;
	}

	workdesk_phone_surface_html(call) {
		const title = call.reference_title || call.reference_name || __('Customer');
		const number = call.customer_number_display || call.customer_number || call.to_number || '';
		const agent = call.agent_mobile_display || call.user_mobile || call.from_number || '';
		const networkMessage = this.state.softphone.current_call_log === call.name
			? this.browser_softphone_network_message() : '';
		const status = networkMessage || call.status || __('Calling');
		const isBrowser = ((this.state.softphone || {}).current_call_log === call.name) || call.call_device === 'Browser Softphone';
		return `
			<div class="vobiz-live-phone">
				<div class="vobiz-live-phone-icon"><i class="fa fa-phone"></i></div>
				<div>
					<div class="vobiz-live-phone-title">${frappe.utils.escape_html(title)}</div>
					<div class="vobiz-live-phone-number">${frappe.utils.escape_html(number || __('No phone'))}</div>
					<div class="vobiz-softphone-live-chips">
						<span class="vobiz-softphone-chip ok"><i class="fa fa-plug"></i> ${frappe.utils.escape_html(status)}</span>
						<span class="vobiz-softphone-chip ok"><i class="fa fa-headphones"></i> ${networkMessage ? __('Checking connection') : (isBrowser ? __('Browser connected') : __('System calling'))}</span>
						<span class="vobiz-softphone-chip ok"><i class="fa fa-volume-up"></i> ${networkMessage ? __('Checking audio connection') : __('Audio active')}<span class="vobiz-softphone-wave"><span></span><span></span><span></span></span></span>
						${agent ? `<span class="vobiz-softphone-chip"><i class="fa fa-user"></i> ${frappe.utils.escape_html(agent)}</span>` : ''}
					</div>
				</div>
			</div>
		`;
	}

	track_browser_workdesk_call(call) {
		const softphone = this.state.softphone;
		if (!call.name || call.name !== softphone.current_call_log
			|| !call.reference_doctype || !call.reference_name
			|| this.is_terminal_status(call.status) || this.confirmed_terminal_calls?.has(call.name)) return;
		this.state.workdesk_live_call_log = call.name;
		this.state.workdesk_live_call = { ...call, status: softphone.incoming_answered ? 'Connected' : (call.status || 'Ringing') };
		this.render_workdesk_live_call();
	}

	matching_active_call(row) {
		const active = this.state.active_call || {};
		const tracked = this.state.workdesk_live_call || {};
		// The authenticated incoming invite already identifies the customer. Do
		// not let a previous call's completed snapshot override this live call.
		if (tracked.name && tracked.name === this.state.softphone.current_call_log
			&& !this.is_terminal_status(tracked.status) && !this.confirmed_terminal_calls?.has(tracked.name)
			&& tracked.reference_doctype === row.doctype && tracked.reference_name === row.name) {
			return tracked;
		}
		if (
			active.name &&
			active.reference_doctype === row.doctype &&
			active.reference_name === row.name
		) {
			return active;
		}
		const last = active.last_call || {};
		if (
			last.name &&
			(last.reference_doctype || active.reference_doctype) === row.doctype &&
			(last.reference_name || active.reference_name) === row.name
		) {
			return last;
		}
		if (
			tracked.name &&
			tracked.reference_doctype === row.doctype &&
			tracked.reference_name === row.name
		) {
			return tracked;
		}
		return null;
	}

	refresh_workdesk_live_call() {
		const callLog = this.state.workdesk_live_call_log;
		if (!callLog || this.state.workdesk_live_polling) return;
		const active = this.state.active_call || {};
		if (active.name === callLog) {
			this.state.workdesk_live_call = active;
			this.render_workdesk_live_call();
			return;
		}

		this.state.workdesk_live_polling = true;
		frappe.call({
			method: 'vobiz_click_to_call.api.call.get_call_status',
			args: { call_log: callLog, sync_provider: 0 }
		}).then((r) => {
			const call = r.message || {};
			if (this.state.workdesk_live_call_log !== callLog) return;
			if (call.name) {
				this.reconcile_browser_softphone_call(call);
				this.state.workdesk_live_call = call;
				if ((this.state.active_call || {}).name === call.name) {
					this.state.active_call = this.is_terminal_status(call.status) ? { last_call: call } : call;
				}
				this.render_workdesk_live_call();
				if (this.is_terminal_status(call.status)) {
					this.state.active_call = { last_call: call };
					this.clear_tracked_live_call(call.name);
					this.render_workdesk_live_call();
					this.maybe_prompt_workdesk_disposition(call);
				}
			}
		}).always(() => {
			this.state.workdesk_live_polling = false;
		});
	}

	live_call_steps(call) {
		const flow = call.call_flow || 'Customer First';
		const first = flow === 'Agent First' ? __('Agent') : __('Customer');
		const second = flow === 'Agent First' ? __('Customer') : __('Agent');
		const firstNumber = flow === 'Agent First' ? call.agent_mobile_display : call.customer_number_display;
		const secondNumber = flow === 'Agent First' ? call.customer_number_display : call.agent_mobile_display;
		const status = call.status || '';
		const terminal = ['Completed', 'Failed', 'Busy', 'No Answer', 'Cancelled', 'Canceled'].includes(status);
		const answeredFirst = Boolean(call.answer_time) || ['Agent Answered', 'Customer Answered', 'Agent Ringing', 'Connected', 'Completed'].includes(status);
		const connected = ['Connected', 'Completed'].includes(status);

		let firstState = 'active';
		let firstMeta = __('Calling {0}...', [first.toLowerCase()]);
		let secondState = 'waiting';
		let secondMeta = __('Waiting for {0} to answer.', [first.toLowerCase()]);

		if (answeredFirst || connected) {
			firstState = 'done';
			firstMeta = __('{0} answered.', [first]);
			secondState = connected ? 'done' : 'active';
			secondMeta = connected ? __('Call connected with {0}.', [second.toLowerCase()]) : __('Calling {0}...', [second.toLowerCase()]);
		}

		if (terminal) {
			if (connected || status === 'Completed') {
				firstState = 'done';
				secondState = 'done';
				firstMeta = __('{0} answered.', [first]);
				secondMeta = __('Call completed.');
			} else if (answeredFirst) {
				firstState = 'done';
				secondState = 'failed';
				firstMeta = __('{0} answered.', [first]);
				secondMeta = this.live_failure_text(call, second);
			} else {
				firstState = 'failed';
				secondState = 'waiting';
				firstMeta = this.live_failure_text(call, first);
				secondMeta = __('Not called because {0} did not connect.', [first.toLowerCase()]);
			}
		}

		return [
			{
				state: firstState,
				title: __('{0} leg', [first]),
				meta: `${firstMeta}${firstNumber ? ` ${firstNumber}` : ''}`
			},
			{
				state: secondState,
				title: __('{0} leg', [second]),
				meta: `${secondMeta}${secondNumber ? ` ${secondNumber}` : ''}`
			}
		];
	}

	live_failure_text(call, party) {
		const status = call.status || '';
		const signal = this.normalized_call_signal(call);
		if (status === 'Busy' || signal.includes('busy')) {
			return __('{0} line was busy.', [party]);
		}
		if (status === 'No Answer' || signal.includes('no-answer') || signal.includes('no answer') || signal.includes('timeout') || signal.includes('unanswered')) {
			return __('{0} did not respond or pick the call.', [party]);
		}
		if (
			status === 'Cancelled' ||
			status === 'Canceled' ||
			signal.includes('cancel') ||
			signal.includes('reject') ||
			signal.includes('decline') ||
			signal.includes('hangup-before-connect') ||
			signal.includes('originator-cancel')
		) {
			return __('{0} cut or rejected the call.', [party]);
		}
		if (signal.includes('hangup') && !['Connected', 'Completed'].includes(status)) {
			return __('{0} cut the call.', [party]);
		}
		return __('{0} call failed.', [party]);
	}

	normalized_call_signal(call) {
		return [
			call.status,
			call.call_status,
			call.dial_status,
			call.hangup_cause,
			call.error_message
		].filter(Boolean).join(' ').toLowerCase().replace(/_/g, '-');
	}

	workdesk_header_html(row, context) {
		const workdesk = context.workdesk || {};
		const agent = workdesk.agent || {};
		const agent_number = agent.agent_mobile || __('Not mapped');
		const customer_number = row.phone || __('No phone');
		return `
			<div class="vobiz-workdesk-top">
				<div class="vobiz-workdesk-title">
					<h3>${frappe.utils.escape_html(row.title || row.name || '')}</h3>
					<div class="vobiz-call-route">
						<span class="vobiz-call-route-chip">${__('Agent')}: ${frappe.utils.escape_html(agent_number)}</span>
						<i class="fa fa-link vobiz-call-route-icon" aria-hidden="true"></i>
						<span class="vobiz-call-route-chip">${__('Customer')}: ${frappe.utils.escape_html(customer_number)}</span>
					</div>
					<div class="text-muted">${frappe.utils.escape_html(row.doctype || '')} • ${frappe.utils.escape_html(row.phone || __('No phone'))}</div>
				</div>
				<div class="vobiz-workdesk-actions">
					<button class="btn btn-primary btn-sm" data-workdesk-action="call"><i class="fa fa-phone"></i> ${__('Start Call')}</button>
					<button class="btn btn-default btn-sm" data-workdesk-action="open-lead"><i class="fa fa-external-link"></i> ${__('Open')} ${frappe.utils.escape_html(this.queue_meta_value('summary_tab_label'))}</button>
					<button class="btn btn-default btn-sm" data-workdesk-action="whatsapp"><i class="fa fa-whatsapp"></i> ${workdesk.whatsapp && workdesk.whatsapp.conversation ? __('Open WhatsApp') : __('WhatsApp')}</button>
					<button class="btn btn-default btn-sm" data-workdesk-action="new-encounter"><i class="fa fa-file-text-o"></i> ${__('Create Encounter')}</button>
				</div>
			</div>
		`;
	}

	workdesk_field_html(label, value, fieldtype, field, row) {
		if (this.is_editable_workdesk_status(field, row)) {
			return this.workdesk_status_field_html(field, row);
		}
		return `
			<div class="vobiz-field">
				<div class="vobiz-field-label">${frappe.utils.escape_html(label || '')}</div>
				<div class="vobiz-field-value">${this.workdesk_field_value_html(value, fieldtype)}</div>
			</div>
		`;
	}

	is_editable_workdesk_status(field, row) {
		return row
			&& ['Patient Encounter', 'Issue'].includes(row.doctype)
			&& field
			&& field.fieldname === 'status'
			&& Array.isArray(field.options)
			&& field.options.length;
	}

	workdesk_status_field_html(field, row) {
		const current = field.value || '';
		return `
			<div class="vobiz-field">
				<div class="vobiz-field-label">${frappe.utils.escape_html(field.label || __('Status'))}</div>
				<select class="form-control input-sm" data-workdesk-status data-reference-doctype="${frappe.utils.escape_html(row.doctype || '')}" data-reference-name="${frappe.utils.escape_html(row.name || '')}">
					${field.options.map(option => `
						<option value="${frappe.utils.escape_html(option)}" ${option === current ? 'selected' : ''}>${frappe.utils.escape_html(option)}</option>
					`).join('')}
				</select>
			</div>
		`;
	}

	workdesk_field_value_html(value, fieldtype) {
		if (value === undefined || value === null || value === '') {
			return '-';
		}
		const text = String(value);
		if (['HTML', 'Text Editor'].includes(fieldtype || '')) {
			if (frappe.utils.sanitize_html) {
				return frappe.utils.sanitize_html(text);
			}
			return frappe.utils.escape_html(this.strip_html(text));
		}
		return frappe.utils.escape_html(text);
	}

	strip_html(value) {
		return String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
	}

	workdesk_encounters_html(workdesk) {
		const rows = workdesk.encounters || [];
		return this.workdesk_related_html(__('Patient Encounters'), workdesk.encounters || [], 'Patient Encounter', (row) => [
			row.patient_name || row.patient || '',
			row.sr_encounter_type || '',
			row.sr_encounter_status || '',
			row.encounter_date || '',
			row.invoiced ? __('Invoiced') : ''
		].filter(Boolean).join(' • '), rows.length ? __('Encounter already present.') : __('No previous encounter found.'), {
			label: __('Create Encounter'),
			action: 'new-encounter',
			icon: 'fa-file-text-o'
		});
	}

	workdesk_clinical_history_html(workdesk) {
		const history = workdesk.clinical_history || {};
		const patient = history.patient || {};
		const rows = history.rows || [];
		if (!patient.name && !rows.length) {
			return `<div class="vobiz-workdesk-card"><div class="vobiz-empty">${__('No linked patient found for clinical history.')}</div></div>`;
		}
		const patient_name = patient.patient_name || patient.first_name || patient.name || '-';
		const patient_id = patient.sr_patient_id || patient.patient_id || patient.name || '-';
		const mobile = patient.mobile || patient.mobile_no || patient.sr_mobile_no || '-';
		const phone = patient.phone || patient.phone_no || patient.sr_phone_no || '-';
		return `
			<div class="vobiz-workdesk-card">
				<h4>${__('Patient Clinical History')}</h4>
				<div class="vobiz-field-grid">
					${this.workdesk_field_html(__('Patient'), patient_name)}
					${this.workdesk_field_html(__('Patient ID'), patient_id)}
					${this.workdesk_field_html(__('Gender'), patient.sex || patient.gender || '-')}
					${this.workdesk_field_html(__('Mobile / Phone'), [mobile, phone].filter((value) => value && value !== '-').join(' / ') || '-')}
				</div>
				<hr>
				<div class="vobiz-clinical-history">
					${rows.map((row) => this.workdesk_clinical_history_row_html(row)).join('') || `<div class="vobiz-empty">${__('No encounters with clinical notes found.')}</div>`}
				</div>
			</div>
		`;
	}

	workdesk_clinical_history_row_html(row) {
		const date = row.encounter_date ? frappe.datetime.str_to_user(row.encounter_date) : '-';
		const practitioner = row.practitioner_name || row.practitioner || '';
		const section = (title, value) => {
			const clean = this.strip_html(value);
			return clean ? `
				<div class="vobiz-clinical-section">
					<div class="vobiz-clinical-label">${frappe.utils.escape_html(title)}</div>
					<div class="vobiz-clinical-text">${frappe.utils.escape_html(clean)}</div>
				</div>
			` : '';
		};
		const medications = row.medications || {};
		return `
			<div class="vobiz-clinical-card">
				<div class="vobiz-clinical-head">
					<strong>${frappe.utils.escape_html(row.name || '')}</strong>
					<span>${frappe.utils.escape_html([date, practitioner].filter(Boolean).join(' / '))}</span>
				</div>
				${section(__('Complaints'), row.sr_complaints)}
				${section(__('Observations'), row.sr_observations)}
				${section(__('Investigations'), row.sr_investigations)}
				${section(__('Diagnosis'), row.sr_diagnosis)}
				${section(__('Notes'), row.sr_notes)}
				${this.workdesk_medication_table_html(__('Ayurvedic Medications'), medications.drug_prescription || [])}
				${this.workdesk_medication_table_html(__('Homeopathy Medications'), medications.sr_homeopathy_drug_prescription || [])}
				${this.workdesk_medication_table_html(__('Allopathy Medications Considered'), medications.sr_allopathy_drug_prescription || [])}
			</div>
		`;
	}

	workdesk_medication_table_html(title, rows) {
		if (!rows.length) return '';
		return `
			<div class="vobiz-clinical-section">
				<div class="vobiz-clinical-label">${frappe.utils.escape_html(title)}</div>
				<div class="vobiz-table-wrap">
					<table class="table table-sm vobiz-clinical-med-table">
						<thead>
							<tr>
								<th>${__('Medication')}</th>
								<th>${__('Dosage')}</th>
								<th>${__('Period')}</th>
								<th>${__('Form')}</th>
								<th>${__('Instruction')}</th>
							</tr>
						</thead>
						<tbody>
							${rows.map((row) => `
								<tr>
									<td>${frappe.utils.escape_html(row.medication || '-')}</td>
									<td>${frappe.utils.escape_html(row.dosage || '-')}</td>
									<td>${frappe.utils.escape_html(row.period || '-')}</td>
									<td>${frappe.utils.escape_html(row.dosage_form || '-')}</td>
									<td>${frappe.utils.escape_html(row.sr_drug_instruction || '-')}</td>
								</tr>
							`).join('')}
						</tbody>
					</table>
				</div>
			</div>
		`;
	}

	workdesk_appointments_html(workdesk) {
		return this.workdesk_related_html(__('Patient Appointments'), workdesk.appointments || [], 'Patient Appointment', (row) => [
			row.patient_name || row.patient || '',
			row.appointment_date || row.appointment_datetime || '',
			row.appointment_time || '',
			row.status || row.department || row.practitioner || ''
		].filter(Boolean).join(' • '), __('No previous appointment found.'), {
			label: __('Create Appointment'),
			action: 'new-appointment',
			icon: 'fa-calendar'
		});
	}

	workdesk_invoices_html(workdesk) {
		return this.workdesk_related_html(__('Sales Invoices'), workdesk.sales_invoices || [], 'Sales Invoice', (row) => [
			row.customer || row.sr_si_patient_id || '',
			row.posting_date || '',
			row.status || '',
			row.grand_total ? frappe.format(row.grand_total, { fieldtype: 'Currency' }) : ''
		].filter(Boolean).join(' • '), __('No sales invoice found.'), {
			label: __('Create Sales Invoice'),
			action: 'new-invoice',
			icon: 'fa-file'
		});
	}

	workdesk_related_html(title, rows, doctype, metaBuilder, emptyText, emptyAction) {
		return `
			<div class="vobiz-workdesk-card">
				<h4>${frappe.utils.escape_html(title)}</h4>
				${rows.map(row => `
					<div class="vobiz-related-row">
						<div>
							<div class="vobiz-related-title">${frappe.utils.escape_html(row.name || '')}</div>
							<div class="vobiz-related-meta">${frappe.utils.escape_html(metaBuilder(row))}</div>
						</div>
						<button class="btn btn-xs btn-default" data-open-doc data-doctype="${frappe.utils.escape_html(doctype)}" data-name="${frappe.utils.escape_html(row.name || '')}">${__('Open')}</button>
					</div>
				`).join('') || this.workdesk_empty_action_html(emptyText, emptyAction)}
				${rows.length && emptyAction ? this.workdesk_inline_action_html(emptyAction) : ''}
			</div>
		`;
	}

	workdesk_empty_action_html(emptyText, emptyAction) {
		if (!emptyAction) {
			return `<div class="vobiz-empty">${frappe.utils.escape_html(emptyText)}</div>`;
		}
		return `
			<div class="vobiz-empty">${frappe.utils.escape_html(emptyText)}</div>
			<div style="margin-top:12px;">
				<button class="btn btn-primary btn-sm" data-workdesk-action="${frappe.utils.escape_html(emptyAction.action)}">
					<i class="fa ${frappe.utils.escape_html(emptyAction.icon || 'fa-plus')}"></i> ${frappe.utils.escape_html(emptyAction.label)}
				</button>
			</div>
		`;
	}

	workdesk_inline_action_html(emptyAction) {
		return `
			<div style="margin-top:12px;">
				<button class="btn btn-primary btn-sm" data-workdesk-action="${frappe.utils.escape_html(emptyAction.action)}">
					<i class="fa ${frappe.utils.escape_html(emptyAction.icon || 'fa-plus')}"></i> ${frappe.utils.escape_html(emptyAction.label)}
				</button>
			</div>
		`;
	}

	workdesk_reports_html(workdesk) {
		const reports = workdesk.reports || {};
		const files = reports.files || [];
		const ocr = reports.ocr || [];
		const insights = reports.insights || [];
		return `
			<div class="vobiz-workdesk-grid">
				<div class="vobiz-workdesk-card">
					<h4>${__('Files / Reports')}</h4>
					${files.map(row => `
						<div class="vobiz-related-row">
							<div>
								<div class="vobiz-related-title">${frappe.utils.escape_html(row.file_name || row.name || '')}</div>
								<div class="vobiz-related-meta">${frappe.utils.escape_html([row.file_type, row.attached_to_doctype, row.attached_to_name].filter(Boolean).join(' • '))}</div>
							</div>
							${row.file_url ? `<a class="btn btn-xs btn-default" target="_blank" rel="noopener" href="${frappe.utils.escape_html(row.file_url)}">${__('Open')}</a>` : ''}
						</div>
					`).join('') || `<div class="vobiz-empty">${__('No reports/files found.')}</div>`}
				</div>
				<div class="vobiz-workdesk-card">
					<h4>${__('AI / OCR Summary')}</h4>
					${ocr.map(row => this.workdesk_text_row(row.name, [row.status, row.confidence ? `${row.confidence}%` : '', row.pipeline].filter(Boolean).join(' • '), row.raw_text)).join('')}
					${insights.map(row => this.workdesk_text_row(row.name, [row.insight_type, row.confidence ? `${row.confidence}%` : '', row.pipeline].filter(Boolean).join(' • '), row.output_json || row.applied_fields)).join('')}
					${(!ocr.length && !insights.length) ? `<div class="vobiz-empty">${__('No AI report summary found.')}</div>` : ''}
				</div>
			</div>
		`;
	}

	workdesk_text_row(title, meta, text) {
		return `
			<div class="vobiz-audio-card">
				<div class="vobiz-related-title">${frappe.utils.escape_html(title || '')}</div>
				<div class="vobiz-related-meta">${frappe.utils.escape_html(meta || '')}</div>
				${text ? `<div class="vobiz-transcript">${frappe.utils.escape_html(String(text)).slice(0, 1200)}</div>` : ''}
			</div>
		`;
	}

	workdesk_vobiz_html(workdesk, history) {
		const vobiz = workdesk.vobiz || {};
		const rows = this.call_history_latest_first(history || vobiz.history || []);
		return `
			<div class="vobiz-workdesk-grid">
				<div class="vobiz-workdesk-card">
					<h4>${__('Vobiz Summary')}</h4>
					<div class="vobiz-field-grid">
						${this.workdesk_field_html(__('Total Calls'), vobiz.total || 0)}
						${this.workdesk_field_html(__('Connected'), vobiz.connected || 0)}
						${this.workdesk_field_html(__('Missed'), vobiz.missed || 0)}
						${this.workdesk_field_html(__('Latest Status'), (vobiz.latest || {}).status || '')}
					</div>
				</div>
				<div class="vobiz-workdesk-card">
					<h4>${__('Audio Recordings')}</h4>
					${this.detail_audio_html(rows)}
				</div>
			</div>
		`;
	}

	workdesk_whatsapp_html(workdesk) {
		const wa = workdesk.whatsapp || {};
		const data = wa.data || {};
		const messages = wa.messages || [];
		if (!wa.available) {
			return `<div class="vobiz-workdesk-card"><div class="vobiz-empty">${frappe.utils.escape_html(wa.message || __('WhatsApp is not available.'))}</div></div>`;
		}
		return `
			<div class="vobiz-workdesk-card">
				<h4>${__('WhatsApp')}</h4>
				<div class="vobiz-related-meta">${frappe.utils.escape_html(data.last_message_preview || data.ai_summary || __('WhatsApp chat preview.'))}</div>
				${wa.conversation ? this.workdesk_whatsapp_messages_html(messages, wa) : `<div class="vobiz-empty">${__('No WhatsApp conversation found for this lead.')}</div>`}
				${wa.conversation ? '' : `
					<div style="margin-top:12px;">
						<button class="btn btn-primary btn-sm" data-workdesk-action="whatsapp"><i class="fa fa-whatsapp"></i> ${__('Find Chat')}</button>
					</div>
				`}
			</div>
		`;
	}

	workdesk_whatsapp_messages_html(messages, wa = {}) {
		const first = messages[0] || {};
		const has_more = wa.has_more ? '1' : '0';
		const before = wa.next_before || first.creation || '';
		if (!messages.length) {
			return `
				<div class="vobiz-wa-chat-list" data-wa-chat-list data-conversation="${frappe.utils.escape_html(wa.conversation || '')}" data-before="" data-has-more="0">
					<div class="vobiz-empty">${__('No WhatsApp messages found.')}</div>
				</div>
				${this.workdesk_whatsapp_composer_html()}
			`;
		}
		return `
			<div class="vobiz-wa-chat-list" data-wa-chat-list data-conversation="${frappe.utils.escape_html(wa.conversation || '')}" data-before="${frappe.utils.escape_html(before || '')}" data-has-more="${has_more}">
				${wa.has_more ? `<div class="vobiz-wa-loader" data-wa-loader>${__('Scroll up to load older messages')}</div>` : ''}
				${messages.map((message) => this.workdesk_whatsapp_message_html(message)).join('')}
			</div>
			${this.workdesk_whatsapp_composer_html()}
		`;
	}

	workdesk_whatsapp_message_html(message) {
		const direction = String(message.direction || '').toLowerCase();
		const side = direction === 'outbound' ? 'outbound' : 'inbound';
		const body = this.workdesk_whatsapp_message_body_text(message);
		const media = this.workdesk_whatsapp_media_html(message);
		const meta = [
			message.direction || '',
			message.sender_type || '',
			message.creation ? frappe.datetime.str_to_user(message.creation) : ''
		].filter(Boolean).join(' • ');
		return `
			<div class="vobiz-wa-message ${side}" data-wa-message="${frappe.utils.escape_html(message.name || '')}">
				<div class="vobiz-wa-message-meta">${frappe.utils.escape_html(meta)}</div>
				${body ? `<div class="vobiz-wa-message-body">${frappe.utils.escape_html(body)}</div>` : ''}
				${media}
				${side === 'outbound' ? this.whatsapp_delivery_status_html(message.name, message.delivery_status) : ''}
			</div>
		`;
	}

	whatsapp_delivery_status_html(message_name, delivery_status) {
		const status = String(delivery_status || 'Pending').toLowerCase();
		const labels = { pending: __('Pending'), sent: __('Sent'), delivered: __('Delivered'), read: __('Read'), failed: __('Failed') };
		const label = labels[status] || __('Unknown');
		const state = labels[status] ? status : 'unknown';
		let icon;
		if (['sent', 'delivered', 'read'].includes(state)) {
			icon = `<svg viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.2 6.4 4.6 9.8 11.7 2.2"/>${state !== 'sent' ? '<path d="M6.1 6.4 9.5 9.8 16.6 2.2"/>' : ''}</svg>`;
		} else {
			icon = `<i class="fa ${state === 'failed' ? 'fa-exclamation-circle' : 'fa-clock-o'}" aria-hidden="true"></i>`;
		}
		return `<span class="vobiz-wa-delivery-status is-${state}" data-wa-status-message="${frappe.utils.escape_html(message_name || '')}" data-wa-status="${state}" title="${frappe.utils.escape_html(label)}" aria-label="${frappe.utils.escape_html(label)}">${icon}<span>${frappe.utils.escape_html(label)}</span></span>`;
	}

	workdesk_whatsapp_message_body_text(message) {
		const body = String(message.body || '').trim();
		const contentType = String(message.content_type || '').toLowerCase();
		if (body && !this.is_generic_whatsapp_media_body(body, contentType)) {
			return body;
		}
		if (!this.workdesk_whatsapp_media_url(message)) {
			return body || `[${message.content_type || __('Message')}]`;
		}
		return '';
	}

	is_generic_whatsapp_media_body(body, contentType) {
		const text = String(body || '').trim().toLowerCase();
		if (!text) return true;
		return [
			'image message received',
			'[image message received]',
			'document message received',
			'[document message received]',
			'video message received',
			'audio message received'
		].includes(text) || (contentType && text === contentType);
	}

	workdesk_whatsapp_media_url(message) {
		const url = String(message.display_media_url || message.media_url || message.attachment_url || '').trim();
		return /^https?:\/\/\S+$/i.test(url) || /^\/(?:private\/)?files\/\S+$/.test(url) ? url : '';
	}

	workdesk_whatsapp_media_html(message) {
		const url = this.workdesk_whatsapp_media_url(message);
		if (!url) return '';
		const kind = String(message.media_content_type || message.content_type || '').toLowerCase();
		const safe = frappe.utils.escape_html(url);
		const is_image = ['image', 'sticker'].includes(kind) || /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|#|$)/i.test(url);
		const is_video = kind === 'video' || /\.(mp4|webm|mov)(\?|#|$)/i.test(url);
		const is_audio = kind === 'audio' || /\.(mp3|ogg|oga|wav|m4a|aac)(\?|#|$)/i.test(url);
		const download = `<a class="btn btn-link btn-xs" href="${safe}" data-wa-media-download download>${__('Download')}</a>`;
		if (is_image) return `<a class="vobiz-wa-media" href="${safe}" data-wa-image-view data-wa-media-url="${safe}" aria-label="${__('View image')}" target="_blank" rel="noopener noreferrer"><img class="vobiz-wa-image" src="${safe}" alt="${__('WhatsApp image')}" loading="lazy"></a><div>${download}</div>`;
		if (is_video || is_audio) {
			const tag = is_video ? 'video' : 'audio';
			return `<${tag} controls preload="none" data-wa-playback style="display:block;max-width:100%;width:${is_video ? '320' : '280'}px;${is_video ? 'max-height:260px;' : ''}" src="${safe}"></${tag}><div><a class="btn btn-link btn-xs" href="${safe}" target="_blank" rel="noopener noreferrer">${__('Open original')}</a>${download}</div>`;
		}
		return `<a class="vobiz-wa-media vobiz-wa-media-link" href="${safe}" target="_blank" rel="noopener noreferrer"><i class="fa fa-file-o"></i><span>${frappe.utils.escape_html(message.file_name || message.media_content_type || message.content_type || __('Attachment'))}</span></a><div>${download}</div>`;
	}

	whatsapp_media_proxy_url($body, message, download = false) {
		const args = { message: String(message), ...$body.data('whatsapp-reference') };
		if (download) args.download = 1;
		return '/api/method/vobiz_click_to_call.api.console.get_whatsapp_message_media?'
			+ Object.entries(args).filter(([, value]) => value != null && value !== '').map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
	}

	prepare_whatsapp_media_download($body, event) {
		const $link = $(event.currentTarget);
		const message = $link.closest('[data-wa-message]').attr('data-wa-message');
		if (message && /^https?:\/\//i.test($link.attr('href') || '')) {
			$link.attr('href', this.whatsapp_media_proxy_url($body, message, true));
		}
	}

	close_whatsapp_media_viewer() {
		const viewer = this.whatsapp_media_viewer;
		this.whatsapp_media_viewer = null;
		if (viewer) viewer.dialog.hide();
	}

	open_whatsapp_media_viewer($body, clicked) {
		const view = this.active_whatsapp_view();
		if (!view || view.$body.get(0) !== $body.get(0)) return;
		const items = [];
		let selected = 0;
		$body.find('[data-wa-image-view]').each((_, element) => {
			const $link = $(element);
			const url = this.workdesk_whatsapp_media_url({ media_url: $link.attr('data-wa-media-url') });
			if (!url) return;
			if (element === clicked) selected = items.length;
			const $message = $link.closest('[data-wa-message]');
			items.push({ url, name: $message.attr('data-wa-message'), caption: $message.find('.vobiz-wa-message-body').text() || __('Image') });
		});
		if (!items.length) return;
		this.close_whatsapp_media_viewer();
		const dialog = new frappe.ui.Dialog({
			title: __('WhatsApp images'), size: 'large',
			fields: [{ fieldname: 'viewer', fieldtype: 'HTML', options: `
				<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
					<button class="btn btn-default btn-sm" type="button" data-wa-viewer-prev aria-label="${__('Previous image')}">${__('Previous')}</button>
					<span data-wa-viewer-count></span>
					<button class="btn btn-default btn-sm" type="button" data-wa-viewer-next aria-label="${__('Next image')}">${__('Next')}</button>
					<button class="btn btn-default btn-sm" type="button" data-wa-viewer-zoom-out aria-label="${__('Zoom out')}">&minus;</button>
					<button class="btn btn-default btn-sm" type="button" data-wa-viewer-reset title="${__('Fit image')}" aria-label="${__('Fit image')}">${__('Fit')}</button>
					<button class="btn btn-default btn-sm" type="button" data-wa-viewer-zoom-in aria-label="${__('Zoom in')}">+</button>
					<a class="btn btn-default btn-sm" data-wa-viewer-open target="_blank" rel="noopener noreferrer">${__('Open original')}</a>
					<a class="btn btn-default btn-sm" data-wa-viewer-download download>${__('Download')}</a>
				</div>
				<div data-wa-viewer-status role="status" aria-live="polite"></div>
				<div data-wa-viewer-stage style="height:60vh;overflow:auto;background:#f8fafc;border-radius:8px;"></div>
				<div data-wa-viewer-caption style="white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px;"></div>` }]
		});
		const viewer = { dialog, items, index: selected, scale: 1 };
		this.whatsapp_media_viewer = viewer;
		const $root = dialog.$wrapper;
		const $stage = $root.find('[data-wa-viewer-stage]');
		const zoom = () => {
			const $image = $stage.find('img');
			const image = $image.get(0);
			if (!image) return;
			const width = image.naturalWidth || $stage.width() || 600;
			const height = image.naturalHeight || width;
			const fit = Math.min(width, $stage.width() || width, ($stage.height() || 500) * width / height);
			$image.css({ width: fit * viewer.scale + 'px', maxWidth: 'none', height: 'auto' });
			$root.find('[data-wa-viewer-zoom-out]').prop('disabled', viewer.scale <= 0.5);
			$root.find('[data-wa-viewer-zoom-in]').prop('disabled', viewer.scale >= 4);
			$root.find('[data-wa-viewer-reset]').text(Math.round(viewer.scale * 100) + '%');
		};
		const render = () => {
			const item = items[viewer.index];
			viewer.scale = 1;
			$stage.empty();
			$root.find('[data-wa-viewer-count]').text((viewer.index + 1) + ' / ' + items.length);
			$root.find('[data-wa-viewer-prev], [data-wa-viewer-next]').prop('disabled', items.length < 2);
			$root.find('[data-wa-viewer-caption]').text(item.caption);
			$root.find('[data-wa-viewer-open]').attr('href', item.url);
			$root.find('[data-wa-viewer-download]').attr('href', /^https?:\/\//i.test(item.url) && item.name ? this.whatsapp_media_proxy_url($body, item.name, true) : item.url);
			$root.find('[data-wa-viewer-status]').text(__('Loading image...'));
			const $image = $('<img>', { alt: item.caption, style: 'display:block;margin:0 auto;', referrerpolicy: 'no-referrer' });
			let retried = false;
			const current = () => this.whatsapp_media_viewer === viewer && $stage.find('img').get(0) === $image.get(0);
			$image.on('load', () => { if (current()) { $root.find('[data-wa-viewer-status]').text(''); zoom(); } });
			$image.on('error', () => {
				if (!current()) return;
				if (!retried && item.name && /^https?:\/\//i.test(item.url)) {
					retried = true;
					$image.attr('src', this.whatsapp_media_proxy_url($body, item.name));
					return;
				}
				$image.hide();
				$root.find('[data-wa-viewer-status]').text(__('Image could not be loaded. Try Open original or Download.'));
			});
			$stage.append($image);
			$image.attr('src', item.url);
			zoom();
		};
		const move = delta => { viewer.index = (viewer.index + delta + items.length) % items.length; render(); };
		$root.on('click', '[data-wa-viewer-prev]', () => move(-1));
		$root.on('click', '[data-wa-viewer-next]', () => move(1));
		$root.on('click', '[data-wa-viewer-zoom-in]', () => { viewer.scale = Math.min(4, viewer.scale + 0.25); zoom(); });
		$root.on('click', '[data-wa-viewer-zoom-out]', () => { viewer.scale = Math.max(0.5, viewer.scale - 0.25); zoom(); });
		$root.on('click', '[data-wa-viewer-reset]', () => { viewer.scale = 1; zoom(); });
		$root.on('keydown', event => {
			if (!['Escape', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
			event.preventDefault(); event.stopPropagation();
			if (event.key === 'Escape') this.close_whatsapp_media_viewer();
			else move(event.key === 'ArrowLeft' ? -1 : 1);
		});
		$root.on('hidden.bs.modal', () => { if (this.whatsapp_media_viewer === viewer) this.whatsapp_media_viewer = null; $stage.empty(); });
		dialog.show();
		render();
	}

	workdesk_whatsapp_composer_html() {
		const emojis = ['😀', '😊', '🙏', '👍', '❤️', '😂', '🎉', '✅', '📞', '💊', '🩺', '💬', '🙌', '😇', '🤝', '⭐'];
		return `
			<div class="vobiz-wa-window is-pending" data-wa-window-banner role="status" aria-live="polite">
				<span data-wa-window-text>${__('Checking the messaging window...')}</span>
				<button class="btn btn-default btn-xs" type="button" data-wa-window-retry style="display:none">${__('Retry')}</button>
				<button class="btn btn-default btn-xs" type="button" data-wa-template>${__('Use template')}</button>
			</div>
			<div class="vobiz-wa-composer">
				<div class="vobiz-wa-attach-wrap">
					<button class="vobiz-wa-icon-btn" type="button" data-wa-attach disabled title="${__('Attach')}"><i class="fa fa-plus"></i></button>
					<div class="vobiz-wa-menu" data-wa-attach-menu>
						<button type="button" data-wa-attach-action="image"><i class="fa fa-image"></i> ${__('Photo')}</button>
						<button type="button" data-wa-attach-action="document"><i class="fa fa-file-text-o"></i> ${__('Document')}</button>
						<button type="button" data-wa-attach-action="audio"><i class="fa fa-volume-up"></i> ${__('Audio')}</button>
						<button type="button" data-wa-attach-action="sticker"><i class="fa fa-sticky-note-o"></i> ${__('Sticker')}</button>
					</div>
				</div>
				<button class="vobiz-wa-icon-btn" type="button" data-wa-template title="${__('Template')}"><i class="fa fa-file-text-o"></i></button>
				<div class="vobiz-wa-emoji-wrap">
					<button class="vobiz-wa-icon-btn" type="button" data-wa-emoji disabled title="${__('Emoji')}"><i class="fa fa-smile-o"></i></button>
					<div class="vobiz-wa-menu vobiz-wa-emoji-menu" data-wa-emoji-menu>
						${emojis.map((emoji) => `<button type="button" data-wa-emoji-value="${emoji}">${emoji}</button>`).join('')}
					</div>
				</div>
				<textarea class="form-control" data-wa-reply disabled placeholder="${__('Type a message')}"></textarea>
				<button class="vobiz-wa-send" type="button" data-wa-send disabled title="${__('Send')}"><i class="fa fa-paper-plane"></i></button>
			</div>
		`;
	}

	handle_workdesk_action(action, row, context, $body, event) {
		const workdesk = context.workdesk || {};
		if (action === 'call') {
			const intent = event ? this.consume_workdesk_call_intent(event.currentTarget) : undefined;
			if (event?.detail > 1) return Promise.resolve();
			return this.handle_workdesk_primary_action(row, intent);
		} else if (action === 'open-lead') {
			this.remember_workdesk_return(row);
			frappe.set_route('Form', row.doctype, row.name);
		} else if (action === 'new-encounter') {
			this.new_doc_with_defaults('Patient Encounter', (workdesk.create_defaults || {})['Patient Encounter'] || {}, row);
		} else if (action === 'save-note') {
			this.save_workdesk_note(row, $body);
		} else if (action === 'new-appointment') {
			this.new_doc_with_defaults('Patient Appointment', (workdesk.create_defaults || {})['Patient Appointment'] || {}, row);
		} else if (action === 'new-invoice') {
			this.new_doc_with_defaults('Sales Invoice', (workdesk.create_defaults || {})['Sales Invoice'] || {}, row);
		} else if (action === 'whatsapp') {
			if ($body && $body.length) {
				$body.find('[data-detail-tab="whatsapp"]').trigger('click');
			}
			setTimeout(() => this.open_whatsapp(row, $body), 60);
		}
	}

	save_workdesk_status(row, context, $select) {
		const status = ($select.val() || '').trim();
		if (!row || !row.doctype || !row.name || !status) {
			return;
		}

		$select.prop('disabled', true);
		frappe.call({
			method: 'vobiz_click_to_call.api.console.update_reference_status',
			type: 'POST',
			args: {
				reference_doctype: row.doctype,
				reference_name: row.name,
				status
			}
		}).then(() => {
			row.status = status;
			const fields = (((context || {}).workdesk || {}).lead || {}).fields || [];
			const field = fields.find(item => item.fieldname === 'status');
			if (field) {
				field.value = status;
			}
			frappe.show_alert({ message: __('Status updated'), indicator: 'green' });
			this.load();
		}).always(() => {
			$select.prop('disabled', false);
		});
	}

	save_workdesk_note(row, $body) {
		const $input = ($body || this.state.active_workdesk_body).find('[data-workdesk-note]').first();
		const note = ($input.val() || '').trim();
		if (!note) {
			frappe.show_alert({ message: __('Add a note first.'), indicator: 'orange' });
			return;
		}
		frappe.call({
			method: 'vobiz_click_to_call.api.console.save_reference_note',
			args: {
				reference_doctype: row.doctype,
				reference_name: row.name,
				note
			},
			type: 'POST'
		}).then(() => {
			$input.val('');
			frappe.show_alert({ message: __('Note saved'), indicator: 'green' });
		});
	}

	new_doc_with_defaults(doctype, defaults, row) {
		if (row) {
			this.remember_workdesk_return(row);
		}
		const clean = {};
		Object.keys(defaults || {}).forEach(key => {
			if (defaults[key]) clean[key] = defaults[key];
		});
		frappe.new_doc(doctype, clean);
	}

	open_whatsapp(row, $body) {
		frappe.call('vobiz_click_to_call.api.console.get_whatsapp_conversation', {
			reference_doctype: row.doctype,
			reference_name: row.name
		}).then((r) => {
			const message = r.message || {};
			if (message.success && message.conversation) {
				if ($body && $body.length) {
					this.refresh_inline_whatsapp($body, message.conversation);
				}
			} else {
				frappe.msgprint(message.message || __('No WhatsApp conversation found for this lead.'));
			}
		});
	}

	active_whatsapp_view() {
		if (!this.is_console_visible() || document.hidden) return null;
		const $body = this.state.active_workdesk_body;
		if (!$body || !$body.length) return null;
		const $list = $body.find('[data-wa-chat-list]').first();
		const element = $list.get(0);
		const conversation = $list.attr('data-conversation');
		if (!element || !conversation || !document.documentElement.contains(element)) return null;
		return { $body, $list, element, conversation };
	}

	is_current_whatsapp_view(view) {
		const current = this.active_whatsapp_view();
		return !!current && current.element === view.element && current.conversation === view.conversation;
	}

	stop_whatsapp_sync() {
		if (this.whatsapp_attachment_dialog) this.whatsapp_attachment_dialog.hide();
		this.close_whatsapp_media_viewer();
		const $body = this.state && this.state.active_workdesk_body;
		if ($body) $body.find('[data-wa-playback]').each((_, media) => { if (typeof media.pause === 'function') media.pause(); });
		clearTimeout(this.whatsapp_window_timer);
		this.whatsapp_window_timer = null;
		clearTimeout(this.whatsapp_sync_timer);
		this.whatsapp_sync_timer = null;
		this.whatsapp_sync_request = null;
		this.whatsapp_read_request = null;
		this.whatsapp_status_priority = new Set();
		this.whatsapp_status_offset = 0;
	}

	schedule_whatsapp_sync(delay = 10000) {
		clearTimeout(this.whatsapp_sync_timer);
		this.whatsapp_sync_timer = null;
		if (!this.active_whatsapp_view()) return;
		this.whatsapp_sync_timer = setTimeout(() => this.sync_inline_whatsapp(), delay);
	}

	handle_whatsapp_message(payload) {
		const view = this.active_whatsapp_view();
		if (!view || String(payload.conversation || '') !== view.conversation) return;
		view.$list.data('wa-read-state', null);
		// Fetch through the console's permission checks instead of trusting broadcast content.
		this.schedule_whatsapp_sync(150);
	}

	handle_whatsapp_status(payload) {
		const view = this.active_whatsapp_view();
		if (!view || String(payload.conversation || '') !== view.conversation) return;
		this.whatsapp_status_priority = this.whatsapp_status_priority || new Set();
		if (payload.message) this.whatsapp_status_priority.add(String(payload.message));
		this.schedule_whatsapp_sync(150);
	}

	whatsapp_status_message_names(view) {
		const names = [];
		view.$list.find('[data-wa-status-message]').each((_, el) => names.push(el.getAttribute('data-wa-status-message')));
		if (!names.length) return [];
		const visible = new Set(names);
		const selected = new Set([...(this.whatsapp_status_priority || [])].filter(name => visible.has(name)).slice(0, 100));
		this.whatsapp_status_priority = new Set();
		let offset = (this.whatsapp_status_offset || 0) % names.length;
		for (let count = 0; count < names.length && selected.size < 100; count++) {
			selected.add(names[offset]);
			offset = (offset + 1) % names.length;
		}
		this.whatsapp_status_offset = offset;
		return [...selected];
	}

	update_whatsapp_message_statuses(view, statuses) {
		const updates = new Map(statuses.map(row => [String(row.name), row.delivery_status]));
		view.$list.find('[data-wa-status-message]').each((_, el) => {
			const name = el.getAttribute('data-wa-status-message');
			if (!updates.has(name)) return;
			const status = String(updates.get(name) || 'Pending').toLowerCase();
			if (el.getAttribute('data-wa-status') === status) return;
			$(el).replaceWith(this.whatsapp_delivery_status_html(name, updates.get(name)));
		});
	}

	initialize_whatsapp_window($body, wa) {
		const view = this.active_whatsapp_view();
		if (!view || view.$body.get(0) !== $body.get(0)) return;
		// Use the initial chat response; guidance must not depend on incremental history polling.
		wa.window_received_at = wa.window_received_at || Date.now();
		if (wa.messaging_window) this.apply_whatsapp_window(view, wa.messaging_window, wa.window_received_at);
		else this.whatsapp_window_check_failed(view);
	}

	whatsapp_window_check_failed(view) {
		if (!this.is_current_whatsapp_view(view)) return;
		const snapshot = view.$list.data('wa-window-state');
		if (!snapshot || !snapshot.state) view.$list.data('wa-window-state', { state: null, failed: true });
		this.render_whatsapp_window(view);
	}

	apply_whatsapp_window(view, state, requested_at = Date.now()) {
		if (!this.is_current_whatsapp_view(view)) return;
		// Compare server timestamps in the same timezone, then use elapsed client time.
		// This avoids depending on the agent computer's timezone or clock setting.
		const timestamp = value => Date.parse(String(value || '').replace(' ', 'T') + 'Z');
		const remaining = state && state.can_send_free_form
			? timestamp(state.free_form_expires_at) - timestamp(state.server_time) : 0;
		view.$list.data('wa-window-state', {
			state,
			deadline: Number.isFinite(remaining) ? requested_at + remaining : 0
		});
		this.render_whatsapp_window(view);
	}

	whatsapp_window_guidance(snapshot) {
		const state = snapshot && snapshot.state;
		if (!state) return {
			kind: snapshot && snapshot.failed ? 'error' : 'pending', can_send: false,
			text: snapshot && snapshot.failed
				? __('Could not check the messaging window. Retrying automatically. You can retry now or use an approved template.')
				: __('Checking the messaging window. You can use an approved template while we check.')
		};
		if (state.can_send_free_form === true && snapshot.deadline > Date.now()) {
			const label = state.reason === 'ctwa_72h'
				? __('Click-to-WhatsApp messaging window open') : __('Messaging window open');
			const expires = frappe.datetime.str_to_user(state.free_form_expires_at);
			return { kind: 'open', can_send: true,
				text: label + ' - ' + __('You can send normal messages, photos and documents until') + ' ' + expires + '.' };
		}
		return { kind: 'closed', can_send: false,
			text: !state.last_customer_message_at
				? __('No incoming message from this patient yet. Send an approved template to start the conversation. Normal messages become available after the patient replies.')
				: __('Messaging window closed. Send an approved template to re-engage this patient. Normal messages become available after the patient replies.') };
	}

	render_whatsapp_window(view) {
		if (!this.is_current_whatsapp_view(view)) return;
		clearTimeout(this.whatsapp_window_timer);
		this.whatsapp_window_timer = null;
		const snapshot = view.$list.data('wa-window-state');
		const guidance = this.whatsapp_window_guidance(snapshot);
		const $banner = view.$body.find('[data-wa-window-banner]');
		$banner.attr('class', 'vobiz-wa-window is-' + guidance.kind);
		$banner.find('[data-wa-window-text]').text(guidance.text);
		$banner.find('[data-wa-template]').toggle(!guidance.can_send);
		$banner.find('[data-wa-window-retry]').toggle(guidance.kind === 'error');
		view.$body.find('[data-wa-reply], [data-wa-attach], [data-wa-emoji]').prop('disabled', !guidance.can_send);
		view.$body.find('[data-wa-send]').prop('disabled', !guidance.can_send || !!view.$list.data('wa-sending'));
		view.$body.find('[data-wa-reply]').attr('placeholder', guidance.can_send
			? __('Type a message') : __('Use an approved template to message this patient'));
		if (!guidance.can_send) view.$body.find('[data-wa-attach-menu], [data-wa-emoji-menu]').removeClass('show');
		if (guidance.can_send) {
			this.whatsapp_window_timer = setTimeout(() => {
				if (!this.is_current_whatsapp_view(view)) return;
				this.render_whatsapp_window(view);
				this.schedule_whatsapp_sync(0);
			}, Math.min(Math.max(1, snapshot.deadline - Date.now()), 2147483647));
		}
	}

	can_send_workdesk_whatsapp($body) {
		const view = this.active_whatsapp_view();
		if (!view || view.$body.get(0) !== $body.get(0)) return false;
		const guidance = this.whatsapp_window_guidance(view.$list.data('wa-window-state'));
		if (guidance.can_send) return true;
		this.render_whatsapp_window(view);
		this.schedule_whatsapp_sync(0);
		frappe.show_alert({ message: guidance.text, indicator: 'orange' });
		return false;
	}

	update_whatsapp_unread_count(conversation, count) {
		let changed = false;
		for (const row of this.state.queue || []) {
			if (String(row.whatsapp_conversation || '') !== String(conversation)) continue;
			if (Number(row.whatsapp_unread_count || 0) === count) continue;
			row.whatsapp_unread_count = count;
			changed = true;
		}
		if (changed) this.render_queue();
	}

	async mark_visible_whatsapp_read(view) {
		if (!this.is_current_whatsapp_view(view)) return;
		const snapshot = view.$list.data('wa-read-state');
		if (!snapshot || !snapshot.read_version || !snapshot.unread_count) return;
		if (view.element.scrollHeight - view.element.scrollTop - view.element.clientHeight > 96) return;
		if (this.whatsapp_read_request && this.whatsapp_read_request.element === view.element) return;
		const request = { element: view.element, snapshot };
		this.whatsapp_read_request = request;
		try {
			const response = await frappe.call({
				method: 'vobiz_click_to_call.api.console.mark_whatsapp_read',
				type: 'POST',
				args: {
					...view.$body.data('whatsapp-reference'),
					conversation: view.conversation,
					read_version: snapshot.read_version
				},
				freeze: false,
				silent: true
			});
			if (this.whatsapp_read_request !== request || !this.is_current_whatsapp_view(view)) return;
			const result = response.message || {};
			if (!result.success) return;
			if (result.marked_read && view.$list.data('wa-read-state') === snapshot) {
				view.$list.data('wa-read-state', { ...snapshot, unread_count: 0 });
				this.update_whatsapp_unread_count(view.conversation, 0);
				const notifications = window.wa_chat_hub && window.wa_chat_hub.notifications;
				if (notifications && notifications.refresh_count) notifications.refresh_count();
			} else {
				this.schedule_whatsapp_sync(150);
			}
		} catch (err) {
			// Keep the unread state and retry after the next successful message refresh.
		} finally {
			if (this.whatsapp_read_request === request) this.whatsapp_read_request = null;
		}
	}

	async sync_inline_whatsapp() {
		const view = this.active_whatsapp_view();
		if (!view) return;
		if (view.$list.attr('data-loading') === '1') {
			this.schedule_whatsapp_sync(150);
			return;
		}
		if (this.whatsapp_sync_request && this.whatsapp_sync_request.element === view.element) {
			this.whatsapp_sync_request.pending = true;
			return;
		}
		const request = { element: view.element, pending: false, started_at: Date.now() };
		this.whatsapp_sync_request = request;
		let has_more = false;
		try {
			const after_message = view.$list.find('[data-wa-message]').last().attr('data-wa-message') || '';
			const response = await frappe.call({
				method: 'vobiz_click_to_call.api.console.get_whatsapp_messages',
				args: {
					...view.$body.data('whatsapp-reference'),
					conversation: view.conversation,
					limit: 100,
					after_message,
					status_message_names: JSON.stringify(this.whatsapp_status_message_names(view))
				},
				freeze: false,
				silent: true
			});
			if (this.whatsapp_sync_request !== request || !this.is_current_whatsapp_view(view)) return;
			if (view.$list.attr('data-loading') === '1') {
				request.pending = true;
				return;
			}
			const page = response.message || {};
			if (!page.success) throw new Error('WhatsApp refresh failed');
			if (page.messaging_window) this.apply_whatsapp_window(view, page.messaging_window, request.started_at);
			else this.whatsapp_window_check_failed(view);
			this.append_live_whatsapp_messages(view, page.messages || []);
			this.update_whatsapp_message_statuses(view, page.message_statuses || []);
			if (!after_message) {
				view.$list.attr('data-before', page.next_before || '');
				view.$list.attr('data-has-more', page.has_more ? '1' : '0');
			}
			has_more = !!page.has_more_after;
			view.$list.data('wa-read-state', has_more ? null : {
				read_version: page.read_version,
				unread_count: Number(page.unread_count || 0)
			});
			this.update_whatsapp_unread_count(view.conversation, Number(page.unread_count || 0));
			if (!has_more) this.mark_visible_whatsapp_read(view);
		} catch (err) {
			if (this.whatsapp_sync_request === request) this.whatsapp_window_check_failed(view);
		} finally {
			if (this.whatsapp_sync_request === request) {
				this.whatsapp_sync_request = null;
				this.schedule_whatsapp_sync(has_more || request.pending ? 150 : 10000);
			}
		}
	}

	append_live_whatsapp_messages(view, messages) {
		const { $list, element } = view;
		const at_bottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
		const known = new Set();
		$list.find('[data-wa-message]').each((_, el) => known.add(el.getAttribute('data-wa-message')));
		let pinned_top = null;
		const pin_to_bottom = () => {
			element.scrollTop = element.scrollHeight;
			pinned_top = element.scrollTop;
		};
		let appended = false;
		for (const message of messages) {
			const name = String(message.name || '');
			if (!name || known.has(name)) continue;
			known.add(name);
			const $message = $(this.workdesk_whatsapp_message_html(message));
			$list.find('.vobiz-empty').remove();
			$list.append($message);
			appended = true;
			$message.find('img').one('load', () => {
				if (at_bottom && element.scrollTop === pinned_top && this.is_current_whatsapp_view(view)) pin_to_bottom();
			});
		}
		if (appended && at_bottom) pin_to_bottom();
	}

	refresh_inline_whatsapp($body, conversation) {
		frappe.call('vobiz_click_to_call.api.console.get_whatsapp_messages', {
			...$body.data('whatsapp-reference'),
			conversation,
			limit: VOBIZ_WHATSAPP_PAGE_SIZE
		}).then((r) => {
			const page = r.message || {};
			const wa = {
				conversation,
				has_more: page.has_more,
				next_before: page.next_before
			};
			const html = this.workdesk_whatsapp_messages_html(page.messages || [], wa);
			const $chat = $(html).filter('[data-wa-chat-list]');
			const $existing = $body.find('[data-wa-chat-list]').first();
			if ($existing.length) {
				$existing.replaceWith($chat);
			} else {
				$body.find('.vobiz-empty').last().replaceWith($chat);
			}
			$body.find('[data-workdesk-action="whatsapp"]').closest('div').remove();
			if (!$body.find('[data-wa-reply]').length) {
				$body.find('.vobiz-workdesk-card').append(this.workdesk_whatsapp_composer_html());
			}
			this.scroll_whatsapp_to_bottom($body);
			this.initialize_whatsapp_window($body, page);
			this.schedule_whatsapp_sync(0);
		});
	}

	load_more_whatsapp_messages($list) {
		if (!$list || !$list.length || $list.attr('data-loading') === '1' || $list.attr('data-has-more') !== '1') return;

		const conversation = $list.attr('data-conversation');
		const before = $list.attr('data-before');
		if (!conversation || !before) return;

		const el = $list.get(0);
		const old_height = el.scrollHeight;
		const old_top = el.scrollTop;
		$list.attr('data-loading', '1');
		$list.find('[data-wa-loader]').text(__('Loading older messages...'));
		frappe.call('vobiz_click_to_call.api.console.get_whatsapp_messages', {
			...$list.closest('[data-wa-reference]').data('whatsapp-reference'),
			conversation,
			limit: VOBIZ_WHATSAPP_PAGE_SIZE,
			before
		}).then((r) => {
			const page = r.message || {};
			const messages = page.messages || [];
			$list.find('[data-wa-loader]').remove();
			if (messages.length) {
				$list.prepend(messages.map((message) => this.workdesk_whatsapp_message_html(message)).join(''));
			}
			if (page.has_more) {
				$list.prepend(`<div class="vobiz-wa-loader" data-wa-loader>${__('Scroll up to load older messages')}</div>`);
			}
			$list.attr('data-before', page.next_before || before);
			$list.attr('data-has-more', page.has_more ? '1' : '0');
			el.scrollTop = el.scrollHeight - old_height + old_top;
		}).always(() => {
			$list.attr('data-loading', '0');
		});
	}

	send_workdesk_whatsapp($body) {
		if (!this.can_send_workdesk_whatsapp($body)) return;
		const $list = $body.find('[data-wa-chat-list]').first();
		const conversation = $list.attr('data-conversation');
		const $input = $body.find('[data-wa-reply]').first();
		const body = ($input.val() || '').trim();
		if (!conversation || !body) return;

		const $button = $body.find('[data-wa-send]').first();
		$list.data('wa-sending', true);
		$button.prop('disabled', true);
		frappe.call({
			method: 'vobiz_click_to_call.api.console.send_whatsapp_reply',
			args: { conversation, body, ...$body.data('whatsapp-reference') },
			type: 'POST'
		}).then((r) => {
			if (!r.message || !r.message.success) {
				frappe.msgprint({ title: __('Send failed'), indicator: 'red',
					message: frappe.utils.escape_html(((r.message || {}).result || {}).error || __('Message could not be sent. Your draft has been kept.')) });
				this.schedule_whatsapp_sync(0);
				return;
			}
			$input.val('');
			this.refresh_inline_whatsapp($body, conversation);
		}).always(() => {
			$list.data('wa-sending', false);
			const view = this.active_whatsapp_view();
			if (view && view.element === $list.get(0)) this.render_whatsapp_window(view);
			this.schedule_whatsapp_sync(0);
		});
	}

	insert_workdesk_emoji($body, emoji) {
		const input = $body.find('[data-wa-reply]').get(0);
		if (!input || !emoji) return;
		const start = input.selectionStart || 0;
		const end = input.selectionEnd || 0;
		const value = input.value || '';
		input.value = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
		input.focus();
		const next = start + String(emoji).length;
		input.setSelectionRange(next, next);
	}

	whatsapp_attachment_error(file, kind) {
		if (!file) return __('Choose a file first.');
		if (file.size === 0) return __('File is empty.');
		const mime = String(file.type || '').toLowerCase().split(';')[0];
		if (kind === 'image' && !mime.startsWith('image/')) return __('Only image files are supported here.');
		if (kind === 'audio') {
			const supported = ['audio/aac', 'audio/x-aac', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/amr', 'audio/ogg', 'audio/x-ogg'];
			const generic = ['', 'application/octet-stream', 'application/ogg'].includes(mime);
			if (!supported.includes(mime) && !(generic && /\.(aac|mp3|m4a|amr|ogg|opus)$/i.test(file.name))) return __('Choose MP3, AAC, M4A, AMR or OGG/Opus audio.');
			if (file.size > 16 * 1024 * 1024) return __('Audio must be 16 MB or smaller.');
		}
		if (kind === 'sticker') {
			if (mime !== 'image/webp' && !(['', 'application/octet-stream'].includes(mime) && /\.webp$/i.test(file.name))) return __('Choose a WebP sticker.');
			if (file.size > 500 * 1024) return __('Stickers must be 500 KB or smaller.');
		}
		return '';
	}

	setup_whatsapp_attachment_preview(dialog, kind) {
		let object_url = null;
		const $stage = dialog.$wrapper.find('[data-wa-attachment-preview]');
		const release = () => {
			$stage.find('audio').each((_, media) => { media.pause(); media.removeAttribute('src'); media.load(); });
			$stage.empty();
			if (object_url) URL.revokeObjectURL(object_url);
			object_url = null;
		};
		dialog.$wrapper.on('change', 'input[type="file"]', event => {
			release();
			const file = event.currentTarget.files[0];
			if (!file) return;
			const error = this.whatsapp_attachment_error(file, kind);
			if (error) { $stage.text(error); return; }
			try { object_url = URL.createObjectURL(file); }
			catch (err) { $stage.text(__('Preview is unavailable in this browser.')); return; }
			const $media = kind === 'audio'
				? $('<audio>', { controls: true, preload: 'metadata', style: 'width:100%;margin-top:12px' })
				: $('<img>', { alt: __('Sticker preview'), style: 'display:block;max-width:100%;max-height:240px;margin:12px auto;object-fit:contain' });
			$media.one('error', () => $('<div>', { class: 'text-muted', text: __('This file cannot be previewed in your browser.') }).appendTo($stage));
			$media.attr('src', object_url).appendTo($stage);
		});
		dialog.$wrapper.one('hidden.bs.modal', () => {
			dialog.wa_attachment_closed = true;
			release();
			if (this.whatsapp_attachment_dialog === dialog) this.whatsapp_attachment_dialog = null;
		});
	}

	open_workdesk_attachment_dialog($body, kind) {
		if (!this.can_send_workdesk_whatsapp($body)) return;
		const conversation = $body.find('[data-wa-chat-list]').first().attr('data-conversation');
		if (!conversation) {
			frappe.show_alert({ message: __('No WhatsApp conversation selected.'), indicator: 'orange' });
			return;
		}
		const config = {
			image: { title: __('Send Photo'), type: 'Image', accept: 'image/*' },
			document: { title: __('Send Document'), type: 'Document', accept: '.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation' },
			audio: { title: __('Send Audio'), type: 'Audio', accept: '.mp3,.aac,.m4a,.amr,.ogg,.opus,audio/mpeg,audio/aac,audio/mp4,audio/amr,audio/ogg', help: __('MP3, AAC, M4A, AMR or OGG/Opus. Maximum 16 MB.') },
			sticker: { title: __('Send Sticker'), type: 'Sticker', accept: '.webp,image/webp', help: __('WebP, 512 x 512 pixels. Maximum 100 KB for static or 500 KB for animated stickers.') },
		}[kind];
		if (!config) return;
		const preview = ['audio', 'sticker'].includes(kind);
		const input_id = `vobiz-wa-${kind}-upload`;
		const reference = { ...$body.data('whatsapp-reference') };
		let sending = false;
		const dialog = new frappe.ui.Dialog({
			title: config.title,
			fields: [
				{
					fieldname: 'file_upload', fieldtype: 'HTML',
					options: `<label for="${input_id}">${__('Choose a file')}</label><input type="file" class="form-control" id="${input_id}" accept="${config.accept}" />${preview ? `<p class="text-muted" style="margin-top:8px">${frappe.utils.escape_html(config.help)}</p><div data-wa-attachment-preview aria-live="polite"></div>` : ''}`
				},
				...(!preview ? [{ fieldname: 'caption', fieldtype: 'Small Text', label: kind === 'image' ? __('Caption') : __('File Name / Caption') }] : [])
			],
			primary_action_label: __('Upload & Send'),
			primary_action: (values = {}) => {
				if (sending || !this.can_send_workdesk_whatsapp($body)) return;
				const file_input = dialog.$wrapper.find(`#${input_id}`).get(0);
				const file = file_input && file_input.files && file_input.files[0];
				const error = this.whatsapp_attachment_error(file, kind);
				if (error) { frappe.show_alert({ message: error, indicator: 'orange' }); return; }
				sending = true;
				if (file_input) file_input.disabled = true;
				dialog.get_primary_btn().prop('disabled', true).text(__('Uploading...'));
				return this.upload_workdesk_whatsapp_file(conversation, file, kind, reference)
					.then((upload) => {
						if (dialog.wa_attachment_closed) return;
						if ($body.find('[data-wa-chat-list]').first().attr('data-conversation') !== conversation) throw new Error(__('The selected conversation changed. Reopen the attachment dialog.'));
						return this.send_workdesk_whatsapp_media($body, conversation, {
							body: preview ? '' : values.caption || '', content_type: config.type,
							media_url: upload.provider_file_url || upload.media_url,
							display_media_url: upload.file_url || upload.media_url,
							attachment_file: upload.file, file_name: upload.file_name || file.name,
							file_size: upload.file_size || ''
						});
					})
					.then(() => dialog.hide())
					.catch((err) => {
						frappe.msgprint({ title: __('Send failed'), message: frappe.utils.escape_html((err && err.message) || __('Could not upload and send file.')), indicator: 'red' });
					})
					.finally(() => {
						sending = false;
						if (file_input) file_input.disabled = false;
						dialog.get_primary_btn().prop('disabled', false).text(__('Upload & Send'));
					});
			}
		});
		if (preview) {
			if (this.whatsapp_attachment_dialog) this.whatsapp_attachment_dialog.hide();
			this.whatsapp_attachment_dialog = dialog;
			this.setup_whatsapp_attachment_preview(dialog, kind);
		}
		dialog.show();
	}

	open_workdesk_template_dialog($body) {
		const conversation = $body.find('[data-wa-chat-list]').first().attr('data-conversation');
		if (!conversation) {
			frappe.show_alert({ message: __('No WhatsApp conversation selected.'), indicator: 'orange' });
			return;
		}

		frappe.call('vobiz_click_to_call.api.console.get_whatsapp_templates', {
			...$body.data('whatsapp-reference'),
			conversation
		}).then((r) => {
			const response = r.message || {};
			const templates = response.templates || [];
			if (!response.success || !templates.length) {
				frappe.msgprint(response.message || __('No approved WhatsApp templates found for this conversation.'));
				return;
			}
			this.show_workdesk_template_dialog($body, conversation, templates);
		});
	}

	template_variable_slots(template, section) {
		if (section === 'header' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(template.header_format || '').toUpperCase())) return [];
		const supplied = Array.isArray(template[section + '_variables']) ? template[section + '_variables'] : [];
		const text = String(template[section + '_preview'] || '');
		const indices = new Set();
		for (const slot of supplied) if (Number.isInteger(Number(slot.index)) && Number(slot.index) > 0) indices.add(Number(slot.index));
		for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) if (Number(match[1]) > 0) indices.add(Number(match[1]));
		for (let index = 1; index <= Number(template[section + '_variable_count'] || 0); index++) indices.add(index);
		return [...indices].sort((a, b) => a - b).map(index => {
			const source = supplied.find(slot => Number(slot.index) === index) || {};
			const placeholder = '{{' + index + '}}';
			const position = text.indexOf(placeholder);
			return { index, placeholder, section,
				context: source.context || (position < 0 ? placeholder : text.slice(Math.max(0, position - 35), position + placeholder.length + 35)) };
		});
	}

	template_variable_fields_html(template) {
		const escape = frappe.utils.escape_html;
		const sections = ['header', 'body'].map(section => {
			const slots = this.template_variable_slots(template, section);
			if (!slots.length) return '';
			const title = section === 'header' ? __('Header variables') : __('Message variables');
			return `<fieldset style="margin:12px 0;border:0;padding:0"><legend style="font-size:14px;margin-bottom:8px">${escape(title)}</legend>${slots.map(slot => `
				<div class="form-group">
					<label style="display:block">${escape(section === 'header' ? __('Header') : __('Message'))} ${escape(slot.placeholder)} <span class="text-danger" aria-hidden="true">*</span>
						<input type="text" class="form-control" data-wa-template-variable="${section}_${slot.index}" aria-required="true" autocomplete="off" placeholder="${escape(__('Enter a value'))}" />
					</label>
					<div class="text-muted" style="font-size:12px;white-space:pre-wrap">${escape(slot.context)}</div>
				</div>`).join('')}</fieldset>`;
		}).join('');
		return sections || `<div class="text-muted">${escape(__('This template has no variables to fill.'))}</div>`;
	}

	read_template_variables(dialog, template, section) {
		return this.template_variable_slots(template, section).map(slot =>
			String(dialog.$wrapper.find(`[data-wa-template-variable="${section}_${slot.index}"]`).val() || '').trim());
	}

	validate_template_variables(dialog, template) {
		const missing = [];
		let $first;
		for (const section of ['header', 'body']) {
			for (const slot of this.template_variable_slots(template, section)) {
				const $input = dialog.$wrapper.find(`[data-wa-template-variable="${section}_${slot.index}"]`);
				const empty = !String($input.val() || '').trim();
				$input.attr('aria-invalid', empty ? 'true' : 'false');
				if (empty) {
					missing.push((section === 'header' ? __('Header') : __('Message')) + ' ' + slot.placeholder);
					$first = $first || $input;
				}
			}
		}
		if (!missing.length) return true;
		dialog.$wrapper.find('[data-wa-template-variable-errors]').text(__('Fill all required variables:') + ' ' + missing.join(', ')).show();
		$first.trigger('focus');
		return false;
	}

	setup_template_image_preview(dialog, get_template) {
		const $preview = dialog.$wrapper.find('[data-wa-template-image-preview]');
		const $stage = $preview.find('[data-wa-template-image-stage]');
		const $status = $preview.find('[data-wa-template-image-status]');
		let object_url = null, selected_file = null, revision = 0, closed = false;
		const release = () => {
			if (object_url) URL.revokeObjectURL(object_url);
			object_url = null;
			selected_file = null;
		};
		const update = () => {
			if (closed) return;
			const current = ++revision;
			const template = get_template();
			const is_image = String(template.header_format || '').toUpperCase() === 'IMAGE';
			$preview.toggle(is_image);
			$stage.empty();
			$status.text('');
			if (!is_image) { release(); return; }
			const input = dialog.$wrapper.find('[data-wa-template-image]').get(0);
			const file = input && input.files && input.files[0];
			const custom_url = String((dialog.get_value && dialog.get_value('header_values')) || '').trim();
			$preview.find('[data-wa-template-image-reset]').toggle(!!file || !!custom_url);
			$preview.find('[data-wa-template-image-source]').text(file
				? __('Selected replacement:') + ' ' + file.name
				: custom_url ? __('Replacement image URL') : __('Approved template image'));
			let url;
			if (file) {
				if (!String(file.type || '').startsWith('image/')) {
					release();
					$status.text(__('Choose an image file for this template.'));
					return;
				}
				if (file !== selected_file) {
					release();
					try { object_url = URL.createObjectURL(file); selected_file = file; }
					catch (err) { $status.text(__('Could not preview this file. Choose another image.')); return; }
				}
				url = object_url;
			} else {
				release();
				url = custom_url || String(template.header_media_url || '').trim();
				if (!url) {
					$status.text(__('No approved image is available. Choose a replacement image or enter an image URL.'));
					return;
				}
				if (!/^https?:\/\/\S+$/i.test(url) && !/^\/(?:private\/)?files\/\S+$/.test(url)) {
					$status.text(__('Enter a valid public image URL beginning with https:// or http://.'));
					return;
				}
			}
			$status.text(__('Loading image preview...'));
			const $image = $('<img>', {
				alt: __('Template header image preview'), referrerpolicy: 'no-referrer',
				style: 'display:block;max-width:100%;max-height:300px;width:auto;height:auto;object-fit:contain;border-radius:8px;margin:8px 0;'
			});
			$image.one('load', () => {
				if (!closed && current === revision) $status.text('');
			}).one('error', () => {
				if (closed || current !== revision) return;
				$image.hide();
				$status.text(__('Image preview could not be loaded. Check the image URL or choose a replacement image.'));
			});
			$stage.append($image);
			$image.attr('src', url);
		};
		const reset = () => {
			revision++;
			release();
			dialog.$wrapper.find('[data-wa-template-image]').val('');
			const clearing = dialog.set_value('header_values', '');
			update();
			if (clearing && clearing.then) clearing.then(update);
		};
		dialog.$wrapper.on('change', '[data-wa-template-image]', update);
		dialog.$wrapper.on('input change', '[data-fieldname="header_values"] textarea, [data-fieldname="header_values"] input', update);
		dialog.$wrapper.on('click', '[data-wa-template-image-reset]', reset);
		dialog.$wrapper.on('hidden.bs.modal', () => { closed = true; revision++; release(); $stage.empty(); });
		return { update, reset };
	}

	show_workdesk_template_dialog($body, conversation, templates) {
		const options = templates.map((template, index) => {
			const label = template.display_name || template.name || __('Template');
			const language = template.language_code || 'en';
			return `<option value="${index}">${frappe.utils.escape_html(label)} (${frappe.utils.escape_html(language)})</option>`;
		}).join('');
		const dialog = new frappe.ui.Dialog({
			title: __('Send WhatsApp Template'),
			fields: [
				{
					fieldname: 'template_html',
					fieldtype: 'HTML',
					options: `
						<div class="vobiz-template-send">
							<label>${__('Template')}</label>
							<select class="form-control" data-wa-template-select>${options}</select>
							<div data-wa-template-variables></div>
							<div class="text-muted" data-wa-template-progress></div>
							<div class="text-danger" role="alert" data-wa-template-variable-errors style="display:none"></div>
							<label style="margin-top:12px">${__('Preview')}</label>
							<div data-wa-template-image-preview style="display:none;border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:8px;">
								<div class="text-muted" data-wa-template-image-source></div>
								<div data-wa-template-image-stage></div>
								<div class="text-muted" role="status" data-wa-template-image-status></div>
								<button class="btn btn-default btn-xs" type="button" data-wa-template-image-reset style="display:none">${__('Use approved image')}</button>
							</div>
							<div class="vobiz-template-preview" data-wa-template-preview></div>
						</div>
					`
				},
				{
					fieldname: 'header_image',
					fieldtype: 'HTML',
					hidden: 1,
					options: `<label>${__('Header Image (optional replacement)')}</label><input type="file" class="form-control" data-wa-template-image accept="image/*" />`
				},
				{
					fieldname: 'header_values',
					fieldtype: 'Small Text',
					hidden: 1,
					label: __('Header Media URL'),
					description: __('Leave blank to use the approved template media, or enter a public media URL.')
				},
				{
					fieldname: 'followup_body',
					fieldtype: 'Small Text',
					label: __('Message After Template'),
					read_only: !this.whatsapp_window_guidance($body.find('[data-wa-chat-list]').first().data('wa-window-state')).can_send,
					description: __('Only available while the messaging window is open. Sending a template does not open the window; the patient must reply first.')
				}
			],
			primary_action_label: __('Send Template'),
			primary_action: async (values) => {
				const index = parseInt(dialog.$wrapper.find('[data-wa-template-select]').val(), 10) || 0;
				const template = templates[index] || {};
				if (!this.validate_template_variables(dialog, template)) return;
				const body_values = this.read_template_variables(dialog, template, 'body');
				const text_header_values = this.read_template_variables(dialog, template, 'header');
				dialog.get_primary_btn().prop('disabled', true).text(__('Sending...'));
				try {
					const media_header = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(template.header_format || '').toUpperCase());
					let header_values = media_header ? (values.header_values || '') : text_header_values;
					if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(template.header_format || '').toUpperCase()) && header_values) {
						header_values = [header_values.trim()];
					}
					if (String(template.header_format || '').toUpperCase() === 'IMAGE') {
						const input = dialog.$wrapper.find('[data-wa-template-image]').get(0);
						const file = input && input.files && input.files[0];
						if (file) {
							if (!String(file.type || '').startsWith('image/')) throw new Error(__('Choose an image file for this template.'));
							const upload = await this.upload_workdesk_whatsapp_file(
								conversation, file, true, $body.data('whatsapp-reference')
							);
							header_values = [upload.provider_file_url || upload.media_url];
						}
					}
					const response = await frappe.call({
						method: 'vobiz_click_to_call.api.console.send_whatsapp_template',
						args: {
							...$body.data('whatsapp-reference'),
							conversation,
							template_name: template.name,
							language_code: template.language_code,
							header_values,
							body_values,
							followup_body: values.followup_body || '',
							body_preview: this.render_template_text(template.body_preview || '', body_values),
							template_category: template.category || ''
						},
						type: 'POST'
					});
					const result = response.message || {};
					this.refresh_inline_whatsapp($body, conversation);
					if (!result.success || (result.result || {}).sent === false) {
						throw new Error((result.result || {}).error || __('Template could not be sent.'));
					}
					if (result.followup_error) frappe.msgprint({
						title: __('Template sent; follow-up not sent'), indicator: 'orange',
						message: frappe.utils.escape_html(result.followup_error)
					});
					dialog.hide();
				} catch (err) {
					frappe.msgprint({
						title: __('Send failed'),
						message: frappe.utils.escape_html((err && err.message) || __('Template could not be sent.')),
						indicator: 'red'
					});
				} finally {
					dialog.get_primary_btn().prop('disabled', false).text(__('Send Template'));
				}
			}
		});
		const image_preview = this.setup_template_image_preview(dialog, () => {
			const index = parseInt(dialog.$wrapper.find('[data-wa-template-select]').val(), 10) || 0;
			return templates[index] || {};
		});
		const update_preview = () => {
			const index = parseInt(dialog.$wrapper.find('[data-wa-template-select]').val(), 10) || 0;
			const template = templates[index] || {};
			const body_values = this.read_template_variables(dialog, template, 'body');
			const header_values = this.read_template_variables(dialog, template, 'header');
			const all_values = [...header_values, ...body_values];
			dialog.$wrapper.find('[data-wa-template-progress]').text(all_values.length
				? `${all_values.filter(Boolean).length} / ${all_values.length} ${__('required values filled')}` : '');
			dialog.$wrapper.find('[data-wa-template-variable-errors]').hide().text('');
			dialog.$wrapper.find('[data-wa-template-variable]').attr('aria-invalid', 'false');
			dialog.$wrapper.find('[data-wa-template-preview]').html(this.workdesk_template_preview_html({
				...template,
				header_preview: this.render_template_text(template.header_preview || '', header_values),
				body_preview: this.render_template_text(template.body_preview || '', body_values)
			}));
		};
		const select_template = () => {
			const index = parseInt(dialog.$wrapper.find('[data-wa-template-select]').val(), 10) || 0;
			const template = templates[index] || {};
			dialog.$wrapper.find('[data-wa-template-variables]').html(this.template_variable_fields_html(template));
			const header_format = String(template.header_format || '').toUpperCase();
			const media_header = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header_format);
			dialog.set_df_property('header_image', 'hidden', header_format !== 'IMAGE');
			dialog.set_df_property('header_values', 'hidden', !media_header);
			dialog.set_df_property('header_values', 'label', __('Header Media URL'));
			dialog.set_df_property('header_values', 'description', media_header
				? __('Leave blank to use the approved template media, or enter a public media URL.')
				: __('One value per line, only if the template has header variables.'));
			image_preview.reset();
			update_preview();
		};
		dialog.show();
		dialog.$wrapper.on('change', '[data-wa-template-select]', select_template);
		dialog.$wrapper.on('input', '[data-wa-template-variable]', update_preview);
		select_template();
	}

	workdesk_template_preview_html(template) {
		const header = template.header_preview || '';
		const body = template.body_preview || '';
		const meta = [
			template.category,
			template.status,
			(template.body_variable_count ? `${template.body_variable_count} ${__('body values')}` : ''),
			(template.header_variable_count ? `${template.header_variable_count} ${__('header values')}` : '')
		].filter(Boolean).join(' • ');
		return `
			<div class="vobiz-template-card">
				${meta ? `<div class="vobiz-related-meta">${frappe.utils.escape_html(meta)}</div>` : ''}
				${header ? `<strong>${frappe.utils.escape_html(header)}</strong>` : ''}
				${body ? `<div>${frappe.utils.escape_html(body)}</div>` : `<div class="text-muted">${__('No preview available.')}</div>`}
			</div>
		`;
	}

	render_template_text(text, values_input) {
		const values = Array.isArray(values_input) ? values_input : String(values_input || '').split('\n');
		return String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (placeholder, number) => {
			const value = values[Number(number) - 1];
			return value == null || !String(value).trim() ? placeholder : String(value).trim();
		});
	}

	upload_workdesk_whatsapp_file(conversation, file, kind, reference = {}) {
		const formData = new FormData();
		formData.append('conversation', conversation);
		formData.append('file', file);
		formData.append('kind', typeof kind === 'boolean' ? (kind ? 'image' : 'document') : kind);
		Object.entries(reference || {}).forEach(([key, value]) => {
			if (value) formData.append(key, value);
		});
		const method = 'vobiz_click_to_call.api.console.upload_whatsapp_media';

		return fetch(`/api/method/${method}`, {
			method: 'POST',
			headers: { 'X-Frappe-CSRF-Token': frappe.csrf_token },
			body: formData
		}).then(async (response) => {
			const data = await response.json();
			if (!response.ok) {
				throw new Error(this.whatsapp_upload_error(data));
			}
			return data;
		}).then((data) => {
			if (data.exc || (data.message && data.message.success === false)) {
				throw new Error(this.whatsapp_upload_error(data));
			}
			const upload = (data.message || {}).result || {};
			if (!(upload.provider_file_url || upload.media_url)) {
				throw new Error(__('Upload did not return a hosted media URL.'));
			}
			return upload;
		});
	}

	whatsapp_upload_error(data) {
		try {
			const messages = JSON.parse(data._server_messages || '[]');
			if (messages.length) {
				const first = typeof messages[0] === 'string' ? JSON.parse(messages[0]) : messages[0];
				if (first.message) return first.message;
			}
		} catch (e) {
			// Fall back to the API message when the server response is not structured.
		}
		return (data.message && data.message.message) || __('Upload failed.');
	}

	send_workdesk_whatsapp_media($body, conversation, payload) {
		if (!this.can_send_workdesk_whatsapp($body)) return Promise.reject(new Error(__('Use an approved template to message this patient.')));
		return frappe.call({
			method: 'vobiz_click_to_call.api.console.send_whatsapp_media',
			args: { ...$body.data('whatsapp-reference'), conversation, ...payload },
			type: 'POST'
		}).then((response) => {
			if (!response.message || !response.message.success) {
				throw new Error(((response.message || {}).result || {}).error || __('Media could not be sent.'));
			}
			this.refresh_inline_whatsapp($body, conversation);
		});
	}

	scroll_whatsapp_to_bottom($body) {
		const el = $body.find('[data-wa-chat-list]').get(0);
		if (el) el.scrollTop = el.scrollHeight;
	}

	workdesk_return_key() {
		return 'vobiz_agent_console:last_workdesk';
	}

	remember_workdesk_return(row) {
		if (!row || !row.doctype || !row.name) return;
		this.state.navigating_from_workdesk = true;
		try {
			localStorage.setItem(this.workdesk_return_key(), JSON.stringify({
				doctype: row.doctype,
				name: row.name
			}));
		} catch (e) {
			// localStorage may be unavailable in private contexts.
		}
	}

	clear_workdesk_return_state() {
		try {
			localStorage.removeItem(this.workdesk_return_key());
		} catch (e) {
			// ignore storage failures
		}
	}

	restore_workdesk_dialog() {
		if (this.state.restore_checked || this.state.restore_in_flight) return;
		this.state.restore_checked = true;

		let saved = null;
		try {
			saved = JSON.parse(localStorage.getItem(this.workdesk_return_key()) || 'null');
		} catch (e) {
			saved = null;
		}
		if (!saved || !saved.doctype || !saved.name) return;
		const saved_key = `${saved.doctype}::${saved.name}`;
		if (this.state.active_workdesk_key === saved_key) return;

		this.state.restore_in_flight = true;
		frappe.call('vobiz_click_to_call.api.console.get_reference_context', {
			reference_doctype: saved.doctype,
			reference_name: saved.name
		}).then((r) => {
			const context = r.message || {};
			const row = this.state.queue.find((item) => item.doctype === saved.doctype && item.name === saved.name)
				|| context.reference
				|| { doctype: saved.doctype, name: saved.name, title: saved.name };
			this.state.selected = row;
			this.open_detail_dialog(row, context);
		}).catch(() => {
			this.clear_workdesk_return_state();
		}).always(() => {
			this.state.restore_in_flight = false;
		});
	}

	detail_summary_html(row, context) {
		const latest = (context.history || [])[0] || {};
		const guidance = (context.guidance || {}).script || [];
		return `
			<div class="vobiz-detail-head">
				<div>
					<h3>${frappe.utils.escape_html(row.title || row.name || '')}</h3>
					<div class="text-muted">${frappe.utils.escape_html(row.doctype || '')} • ${frappe.utils.escape_html(row.phone || '')}</div>
				</div>
			</div>
			<div class="vobiz-info-list">
				${this.info_row('fa-phone', __('Caller'), row.phone || __('No phone'))}
				${this.info_row('fa-user', __('Agent'), latest.user || frappe.session.user)}
				${this.info_row('fa-calendar', __('Date'), latest.creation ? frappe.datetime.str_to_user(latest.creation) : __('No previous call'))}
				${this.info_row('fa-clock-o', __('Duration'), latest.duration_label || '00:00')}
			</div>
			<hr>
			<ul class="vobiz-guidance-list">${guidance.map(line => `<li>${frappe.utils.escape_html(line)}</li>`).join('')}</ul>
		`;
	}

	call_history_latest_first(history) {
		return (history || []).slice().sort((a, b) => {
			const left = new Date(a.creation || 0).getTime() || 0;
			const right = new Date(b.creation || 0).getTime() || 0;
			return right - left;
		});
	}

	detail_transcript_html(history) {
		const rows = this.call_history_latest_first(history).filter(row => row.transcript_text || row.transcript_status || row.ai_summary);
		return rows.map(row => `
			<div class="vobiz-audio-card">
				<div><strong>${frappe.utils.escape_html(row.name)}</strong></div>
				<div class="text-muted">${frappe.datetime.str_to_user(row.creation)} • ${frappe.utils.escape_html(row.transcript_status || row.status || '')}</div>
				${row.ai_summary ? `<div><strong>${__('Summary')}</strong><div>${frappe.utils.escape_html(row.ai_summary)}</div></div>` : ''}
				${row.transcript_text ? `<div class="vobiz-transcript">${frappe.utils.escape_html(row.transcript_text)}</div>` : `<div class="text-muted">${frappe.utils.escape_html(row.transcript_error || row.transcript_status || __('No transcript yet'))}</div>`}
			</div>
		`).join('') || `<div class="text-muted">${__('No transcript available for this lead.')}</div>`;
	}

	detail_audio_html(history) {
		const rows = this.call_history_latest_first(history).filter(row => row.recording_url || row.recording_status);
		return `
			<div class="vobiz-audio-list">
				${rows.map(row => `
					<div class="vobiz-audio-card">
						<div><strong>${frappe.utils.escape_html(row.name)}</strong></div>
						<div class="text-muted">${frappe.datetime.str_to_user(row.creation)} • ${frappe.utils.escape_html(row.recording_status || row.status || '')} • ${frappe.utils.escape_html(row.duration_label || '')}</div>
						${this.audio_player_html(row) || `<div class="text-muted">${__('No audio file yet')}</div>`}
					</div>
				`).join('') || `<div class="text-muted">${__('No recording available for this lead.')}</div>`}
			</div>
		`;
	}

	audio_player_html(row) {
		const url = row.recording_download_url || (row.name && row.recording_url ? `/api/method/vobiz_click_to_call.api.recording.stream?call_log=${encodeURIComponent(row.name)}` : '');
		if (!url) return '';
		return `<audio controls preload="none" src="${frappe.utils.escape_html(url)}" style="width:100%; margin-top:8px;"></audio>`;
	}

	call_selected() {
		const row = this.state.selected;
		if (!row) {
			frappe.msgprint(__('Select a lead first.'));
			return;
		}
		this.start_call_for_row(row);
	}

	start_call_for_row(row, patientPhone = null, browserReady = false) {
		if (!row) return Promise.resolve();
		// Only the first caller owns the result (especially manual versus auto-dial).
		if (this.start_call_in_flight) return Promise.resolve(null);
		// Own the entire operation, including microphone checks and number selection.
		const request = Promise.resolve().then(() => this.perform_start_call_for_row(row, patientPhone, browserReady));
		this.start_call_in_flight = request.finally(() => {
			this.start_call_in_flight = null;
			this.update_workdesk_primary_action(this.state.active_workdesk_row);
		});
		this.update_workdesk_primary_action(this.state.active_workdesk_row);
		return this.start_call_in_flight;
	}

	perform_start_call_for_row(row, patientPhone = null, browserReady = false) {
		if (!row) return Promise.resolve();
		const softphone = this.state.softphone;
		if (!browserReady) {
			return Promise.resolve(softphone.config_promise).then(() => {
				if ((softphone.config || {}).call_device === 'Browser Softphone') {
					if (softphone.current_call_log) throw new Error(__('Finish the current call first.'));
					return this.connect_browser_softphone().then(() => this.check_browser_microphone(false)).then(ready => {
						if (!ready) throw new Error(__('Connect a microphone and allow microphone access before calling.'));
						if (!softphone.registered || this.browser_softphone_reconnecting()) {
							throw new Error(__('Wait for the softphone to reconnect before calling.'));
						}
						return this.perform_start_call_for_row(row, patientPhone, true);
					});
				}
				return this.perform_start_call_for_row(row, patientPhone, true);
			});
		}
		if (row.doctype === 'Patient' && !patientPhone) {
			return frappe.call({
				method: 'vobiz_click_to_call.api.call.get_patient_phone_choices',
				args: { patient: row.name },
				freeze: true,
				freeze_message: __('Checking Patient numbers...')
			}).then((r) => {
				const choices = r.message || [];
				if (choices.length > 1) {
					return this.select_patient_phone(row, choices);
				}
				return this.perform_start_call_for_row(row, choices[0] || {
					fieldname: row.phone_field,
					number: row.phone
				});
			});
		}
		return frappe.call({
			method: 'vobiz_click_to_call.api.call.start_call',
			args: {
				reference_doctype: row.doctype,
				reference_name: row.name,
				phone_field: patientPhone ? patientPhone.fieldname : row.phone_field,
				phone_number: patientPhone ? patientPhone.number : row.phone,
				patient_phone_selected: patientPhone ? 1 : 0,
				client_context: 'agent_console',
				tab_id: this.get_softphone_tab_id()
			},
			freeze: true,
			freeze_message: __('Starting call...')
		}).then((r) => {
			const message = r.message || {};
			if (message.browser_softphone) {
				if (message.call_log) {
					this.state.disposition_prompted_call_log = null;
					this.state.workdesk_live_call_log = message.call_log;
					this.state.workdesk_live_call = {
						name: message.call_log,
						status: message.status || __('Initiated'),
						call_flow: message.call_flow || '',
						reference_doctype: row.doctype,
						reference_name: row.name,
						customer_number_display: row.phone || message.customer_number || '',
						agent_mobile_display: message.agent_mobile_display || ''
					};
					this.render_workdesk_live_call();
					this.update_workdesk_primary_action(row);
				}
				return this.start_browser_softphone_call(message, row).then(() => {
					this.load();
					return message;
				});
			}
			if (message.system_dialer && message.dial_url) {
				this.open_system_dialer(message.dial_url);
				this.state.workdesk_live_call_log = '';
				this.state.workdesk_live_call = null;
				this.render_workdesk_live_call();
				this.update_workdesk_primary_action(row);
				frappe.show_alert({ message: __('System dialer opened: {0}', [message.call_log || 'Vobiz']), indicator: 'green' });
				this.load();
				return message;
			}
			if (message.call_log) {
				this.state.disposition_prompted_call_log = null;
				this.state.workdesk_live_call_log = message.call_log;
				this.state.workdesk_live_call = {
					name: message.call_log,
					status: message.status || __('Queued'),
					call_flow: message.call_flow || '',
					reference_doctype: row.doctype,
					reference_name: row.name,
					customer_number_display: row.phone || message.customer_number || '',
					agent_mobile_display: message.agent_mobile_display || ''
				};
				this.render_workdesk_live_call();
				this.update_workdesk_primary_action(row);
				this.refresh_workdesk_live_call();
			}
			frappe.show_alert({ message: __('Call started: {0}', [message.call_log || 'Vobiz']), indicator: 'green' });
			this.load();
			return message;
		});
	}

	open_system_dialer(dialUrl) {
		if (!dialUrl) return;
		window.location.href = dialUrl;
	}

	select_patient_phone(row, choices) {
		return new Promise((resolve) => {
			let callStarted = false;
			const optionMap = {};
			const options = choices.map((choice) => {
				const option = `${choice.label}: ${choice.number}`;
				optionMap[option] = choice;
				return option;
			});
			const dialog = new frappe.ui.Dialog({
				title: __('Select Patient Number'),
				fields: [{
					fieldname: 'patient_number',
					fieldtype: 'Select',
					label: __('Number to call'),
					options,
					default: options[0] || '',
					reqd: 1
				}],
				primary_action_label: __('Start Call'),
				primary_action: (values) => {
					if (callStarted) return;
					const selected = optionMap[values.patient_number];
					if (!selected) return;
					callStarted = true;
					dialog.hide();
					resolve(this.perform_start_call_for_row(row, selected));
				}
			});
			dialog.$wrapper.on('hidden.bs.modal', () => {
				if (!callStarted) resolve(null);
			});
			dialog.show();
		});
	}

	toggle_auto_dial() {
		if ((this.state.auto_dial || {}).running) {
			this.stop_auto_dial();
			return;
		}
		this.start_auto_dial();
	}

	start_auto_dial() {
		const rows = this.selected_queue_rows();
		if (!rows.length) {
			frappe.msgprint(__('Select at least one lead to start auto dial.'));
			return;
		}
		if ((this.state.active_call || {}).name) {
			frappe.msgprint(__('Finish the active call before starting auto dial.'));
			return;
		}

		this.state.auto_dial = {
			running: true,
			in_flight: false,
			queue: rows,
			cursor: 0,
			results: [],
			events: [],
			current: null,
			awaiting_disposition: false,
			started_at: frappe.datetime.now_datetime(),
			stopped_at: null
		};
		this.add_auto_event(__('Auto dial started'), __('{0} leads queued.', [rows.length]), 'active');
		this.update_selected_count();
		this.render_auto_toggle();
		this.show_auto_call_dialog();
		this.run_next_auto_dial();
	}

	stop_auto_dial() {
		const session = this.state.auto_dial || {};
		const callLog = ((session.current || {}).call_log) || ((this.state.active_call || {}).name);
		session.running = false;
		session.in_flight = false;
		session.awaiting_disposition = false;
		session.stopped_at = frappe.datetime.now_datetime();
		this.state.auto_dial = session;
		this.add_auto_event(
			__('Auto dial stopped'),
			callLog ? __('Active auto dial call is being stopped.') : __('No active call was running.'),
			callLog ? 'active' : 'done'
		);
		this.update_selected_count();
		this.render_auto_toggle();
		this.hide_auto_call_dialog();
		if (callLog) {
			this.cancel_call_log(callLog).then(() => {
				frappe.show_alert({ message: __('Auto dial stopped and active call cleared.'), indicator: 'orange' });
			}).catch(() => {
				this.load();
				frappe.show_alert({ message: __('Auto dial stopped. Active call could not be cleared.'), indicator: 'red' });
			});
			return;
		}
		this.load();
		frappe.show_alert({ message: __('Auto dial stopped.'), indicator: 'orange' });
	}

	maybe_continue_auto_dial() {
		const session = this.state.auto_dial || {};
		if (!session.running || session.in_flight) return;
		if (session.awaiting_disposition) return;
		if (session.current && session.current.call_log) return;
		if ((this.state.active_call || {}).name) return;
		if (session.cursor >= session.queue.length) {
			session.running = false;
			session.stopped_at = session.stopped_at || frappe.datetime.now_datetime();
			this.state.auto_dial = session;
			this.add_auto_event(__('Auto dial completed'), __('All selected leads have been processed.'), 'done');
			this.update_selected_count();
			this.render_auto_toggle();
			this.hide_auto_call_dialog();
			return;
		}
		this.run_next_auto_dial();
	}

	run_next_auto_dial() {
		const session = this.state.auto_dial || {};
		if (!session.running || session.in_flight) return;
		const row = session.queue[session.cursor];
		if (!row) {
			this.maybe_continue_auto_dial();
			return;
		}

		session.cursor += 1;
		session.in_flight = true;
		session.current = {
			lead: row.name,
			title: row.title || row.name,
			phone: row.phone || '',
			status: __('Starting'),
			started_at: frappe.datetime.now_datetime()
		};
		this.state.auto_dial = session;
		this.state.selected = row;
		this.add_auto_event(__('Starting call'), `${row.name} • ${row.phone || __('No phone')}`, 'active');
		this.update_selected_count();
		this.show_auto_call_dialog();

		this.start_call_for_row(row).then((message) => {
			if (!message) {
				session.in_flight = false;
				session.current = null;
				this.state.auto_dial = session;
				this.stop_auto_dial();
				return;
			}
			if (message.system_dialer) {
				session.results.push({
					lead: row.name,
					title: row.title || row.name,
					phone: row.phone || '',
					call_log: message.call_log || '',
					status: __('System Dialer'),
					time: frappe.datetime.now_datetime()
				});
				session.running = false;
				session.in_flight = false;
				session.current = null;
				session.stopped_at = frappe.datetime.now_datetime();
				this.state.auto_dial = session;
				this.add_auto_event(__('System dialer opened'), `${row.name} • ${message.call_log || __('No call log')}`, 'done');
				this.update_selected_count();
				this.render_auto_toggle();
				this.render_auto_call_dialog();
				this.load();
				return;
			}
			session.current = {
				lead: row.name,
				title: row.title || row.name,
				phone: row.phone || '',
				call_log: message.call_log || '',
				status: message.status || __('Started'),
				started_at: frappe.datetime.now_datetime()
			};
			this.add_auto_event(__('Call request sent'), `${row.name} • ${message.call_log || __('No call log')}`, 'active');
			this.state.auto_dial = session;
			this.show_auto_call_dialog();
			this.refresh_auto_dial_current(true);
		}).catch((error) => {
			session.results.push({
				lead: row.name,
				title: row.title || row.name,
				phone: row.phone || '',
				call_log: '',
				status: __('Failed'),
				error: (error && error.message) || '',
				time: frappe.datetime.now_datetime()
			});
			session.in_flight = false;
			session.current = null;
			this.state.auto_dial = session;
			this.render_auto_call_dialog();
			this.add_auto_event(__('Call failed to start'), `${row.name} • ${(error && error.message) || ''}`, 'failed');
			this.maybe_continue_auto_dial();
		});
	}

	refresh_auto_dial_current(force) {
		const session = this.state.auto_dial || {};
		const current = session.current || {};
		if (!current.call_log || session.polling_current) return;
		const active = this.state.active_call || {};
		const terminal = ['Completed', 'Failed', 'Busy', 'No Answer', 'Cancelled', 'Canceled'];

		if (!force && active.name === current.call_log && !terminal.includes(active.status)) {
			current.status = active.status || current.status;
			session.current = current;
			this.state.auto_dial = session;
			this.render_auto_live();
			this.render_auto_call_dialog();
			return;
		}

		session.polling_current = true;
		this.state.auto_dial = session;
		frappe.call({
			method: 'vobiz_click_to_call.api.call.get_call_status',
			args: { call_log: current.call_log, sync_provider: 0 }
		}).then((r) => {
			const call = r.message || {};
			const latest = this.state.auto_dial || {};
			const latestCurrent = latest.current || {};
			if (!call.name || latestCurrent.call_log !== call.name) return;

			latestCurrent.status = call.status || latestCurrent.status;
			latestCurrent.call = call;
			latest.current = latestCurrent;
			latest.polling_current = false;
			this.state.auto_dial = latest;
			this.render_auto_call_dialog();

			if (terminal.includes(call.status)) {
				this.finish_auto_dial_call(call);
			} else {
				this.add_auto_event(__('Call update'), `${latestCurrent.lead} • ${call.status || __('Active')}`, 'active');
			}
		}).catch(() => {
			const latest = this.state.auto_dial || {};
			latest.polling_current = false;
			this.state.auto_dial = latest;
		}).always(() => {
			const latest = this.state.auto_dial || {};
			latest.polling_current = false;
			this.state.auto_dial = latest;
		});
	}

	finish_auto_dial_call(call) {
		const session = this.state.auto_dial || {};
		const current = session.current || {};
		if (!current.call_log || current.call_log !== call.name) return;

		const outcome = this.auto_call_outcome(call);
		session.results.push({
			lead: current.lead,
			title: current.title,
			phone: current.phone,
			call_log: call.name,
			status: outcome.label,
			duration: this.call_duration_label(call),
			time: frappe.datetime.now_datetime()
		});
		session.current = null;
		session.in_flight = false;
		session.awaiting_disposition = true;
		this.state.auto_dial = session;
		this.state.active_call = { last_call: call };
		this.state.call_started_at = null;
		this.state.disposition_prompted_call_log = call.name;
		this.clear_tracked_live_call(call.name);
		this.stop_timer();
		this.add_auto_event(__('Waiting for disposition'), `${current.lead} • ${outcome.label}. ${__('Update status to continue.')}`, outcome.state);
		this.update_selected_count();
		this.render_auto_live();
		this.render_auto_call_dialog();
		this.prompt_auto_dial_disposition(call, current);
	}

	prompt_auto_dial_disposition(call, current) {
		this.state.disposition_prompted_call_log = call.name;
		const row = (this.state.queue || []).find(item =>
			item.name === (call.reference_name || current.lead) &&
			(!call.reference_doctype || item.doctype === call.reference_doctype)
		) || this.state.selected || {
			doctype: call.reference_doctype,
			name: call.reference_name || current.lead,
			title: current.title || call.reference_name || current.lead,
			phone: current.phone || call.customer_number_display || ''
		};
		this.state.selected = row;

		const continue_after_disposition = () => this.complete_auto_dial_disposition(call.name);
		const dispositionOptions = {
			auto_dial: true,
			timeout_seconds: 60,
			timeout_status: 'Agent Not Available'
		};
		if (!row.doctype || !row.name) {
			this.open_post_call_disposition_dialog(call, row, continue_after_disposition, dispositionOptions);
			return;
		}

			frappe.call('vobiz_click_to_call.api.console.get_reference_context', {
				reference_doctype: row.doctype || call.reference_doctype,
				reference_name: row.name || call.reference_name,
				lite: 1
		}).then((r) => {
			this.state.context = r.message || {};
			this.apply_context_dispositions(this.state.context);
			this.open_post_call_disposition_dialog(call, row, continue_after_disposition, Object.assign({}, dispositionOptions, {
				disposition_context_refreshed: true
			}));
		}).catch(() => {
			this.open_post_call_disposition_dialog(call, row, continue_after_disposition, dispositionOptions);
		});
	}

	complete_auto_dial_disposition(call_log) {
		const session = this.state.auto_dial || {};
		if (!session.awaiting_disposition) return;
		session.awaiting_disposition = false;
		this.state.auto_dial = session;
		this.add_auto_event(__('Disposition completed'), `${call_log || __('Call')} • ${__('Moving to next lead.')}`, 'done');
		this.update_selected_count();
		this.render_auto_live();
		setTimeout(() => this.maybe_continue_auto_dial(), 500);
	}

	auto_call_outcome(call) {
		if (['Completed', 'Connected'].includes(call.status)) {
			return { label: __('Completed'), state: 'done' };
		}

		const flow = call.call_flow || 'Customer First';
		const first = flow === 'Agent First' ? __('Agent') : __('Customer');
		const second = flow === 'Agent First' ? __('Customer') : __('Agent');
		const answeredFirst = Boolean(call.answer_time) || ['Agent Answered', 'Customer Answered', 'Agent Ringing'].includes(call.status);
		const party = answeredFirst ? second : first;
		const signal = this.normalized_call_signal(call);
		let text = __('{0} Call Failed', [party]);
		if (call.status === 'Busy' || signal.includes('busy')) {
			text = __('{0} Busy', [party]);
		} else if (
			call.status === 'Cancelled' ||
			call.status === 'Canceled' ||
			signal.includes('cancel') ||
			signal.includes('reject') ||
			signal.includes('decline') ||
			signal.includes('hangup')
		) {
			text = __('{0} Busy / Cut Call', [party]);
		} else if (call.status === 'No Answer' || signal.includes('no-answer') || signal.includes('timeout') || signal.includes('unanswered')) {
			text = __('{0} Not Responding', [party]);
		}
		return { label: text, state: 'failed' };
	}

	call_duration_label(call) {
		const seconds = parseInt(call.billsec || call.duration || 0, 10) || 0;
		if (!seconds) return '0s';
		const minutes = Math.floor(seconds / 60);
		const rest = seconds % 60;
		return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
	}

	is_terminal_status(status) {
		return ['Completed', 'Failed', 'Busy', 'No Answer', 'Cancelled', 'Canceled'].includes(status || '');
	}

	clear_tracked_live_call(callLog) {
		if (!callLog || this.state.workdesk_live_call_log !== callLog) return;
		this.state.workdesk_live_call_log = null;
		this.state.workdesk_live_call = null;
	}

	open_auto_dial_report() {
		const session = this.state.auto_dial || {};
		const total = (session.queue || []).length;
		const completed = (session.results || []).length;
		const remaining = Math.max(0, total - completed);
		const dialog = new frappe.ui.Dialog({
			title: __('Auto Dial Report'),
			size: 'large',
			fields: [{ fieldname: 'report', fieldtype: 'HTML' }]
		});
		dialog.show();
		dialog.get_field('report').$wrapper.html(`
			<div class="vobiz-auto-report">
				<div class="vobiz-stats" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
					<div class="vobiz-stat"><span>${__('Selected')}</span><strong>${total}</strong></div>
					<div class="vobiz-stat"><span>${__('Started')}</span><strong>${completed}</strong></div>
					<div class="vobiz-stat"><span>${__('Remaining')}</span><strong>${remaining}</strong></div>
					<div class="vobiz-stat"><span>${__('Status')}</span><strong>${session.running ? __('Running') : __('Stopped')}</strong></div>
				</div>
				<div class="vobiz-table-wrap">
					<table class="table table-sm vobiz-table">
						<thead>
							<tr>
								<th>${__('CRM Lead ID')}</th>
								<th>${__('Name')}</th>
								<th>${__('Phone')}</th>
								<th>${__('Call Log')}</th>
								<th>${__('Status')}</th>
								<th>${__('Talk Time')}</th>
								<th>${__('Time')}</th>
							</tr>
						</thead>
						<tbody>
							${(session.results || []).map(row => `
								<tr>
									<td><code>${frappe.utils.escape_html(row.lead || '')}</code></td>
									<td>${frappe.utils.escape_html(row.title || '')}</td>
									<td>${frappe.utils.escape_html(row.phone || '')}</td>
									<td>${row.call_log ? `<a href="/app/vobiz-call-log/${frappe.utils.escape_html(row.call_log)}">${frappe.utils.escape_html(row.call_log)}</a>` : ''}</td>
									<td>${frappe.utils.escape_html(row.status || '')}</td>
									<td>${frappe.utils.escape_html(row.duration || '0s')}</td>
									<td>${frappe.utils.escape_html(row.time || '')}</td>
								</tr>
							`).join('') || `<tr><td colspan="7" class="text-muted text-center">${__('No auto dial calls started yet.')}</td></tr>`}
						</tbody>
					</table>
				</div>
			</div>
		`);
	}

	cancel_call() {
		const active = this.state.active_call || {};
		if (!active.name) return;
		this.cancel_call_log(active.name);
	}

	watch_browser_call_disposition(callLog) {
		this.browser_disposition_watchers = this.browser_disposition_watchers || new Set();
		if (this.browser_disposition_watchers.has(callLog)) return;
		this.browser_disposition_watchers.add(callLog);
		let attempts = 0;
		const check = () => frappe.call({
			method: 'vobiz_click_to_call.api.call.get_call_status', args: { call_log: callLog, sync_provider: 0 }
		}).then(r => {
			const call = r.message || {};
			if (this.is_terminal_status(call.status)) {
				this.browser_disposition_watchers.delete(callLog);
				const currentCall = this.state.softphone.current_call_log || (this.state.active_call || {}).name;
				if (call.name !== callLog) return;
				call.disposition_reference_checked = true;
				if (currentCall && currentCall !== callLog) {
					this.completed_call_context(call);
					return;
				}
				if (call.name === callLog) this.reconcile_browser_softphone_call(call);
				this.maybe_prompt_workdesk_disposition(Object.assign({}, call, {disposition_reference_checked: true}));
				this.load();
				return;
			}
			if (++attempts < 60) setTimeout(check, 2000);
			else this.browser_disposition_watchers.delete(callLog);
		}).catch(() => {
			// A transient network error must not discard the completed call's disposition.
			if (++attempts < 60) setTimeout(check, 2000);
			else this.browser_disposition_watchers.delete(callLog);
		});
		setTimeout(check, 500);
	}

	cancel_call_log(call_log, row) {
		if (!call_log) return Promise.resolve();
		// Online events and the retry timer can arrive during a slow Stop request.
		const requests = this.browser_cancel_requests || (this.browser_cancel_requests = new Map());
		if (requests.has(call_log)) return requests.get(call_log);
		const request = this.cancel_call_log_request(call_log, row).finally(() => requests.delete(call_log));
		requests.set(call_log, request);
		return request;
	}

	cancel_call_log_request(call_log, row) {
		const softphone = this.state.softphone;
		const isBrowser = softphone.current_call_log === call_log;
		if (isBrowser) {
			if (softphone.conference_recovery) softphone.conference_end_requested = call_log;
			if (softphone.conference_recovery || this.browser_softphone_reconnecting()) softphone.pending_end_call = call_log;
			try {
				if (!softphone.client || !softphone.client.client) throw new Error(__('Softphone session is unavailable.'));
				const sdk = softphone.client.client;
				const sameSession = typeof sdk.getCallUUID !== 'function' ||
					(softphone.sdk_call_uuid && sdk.getCallUUID() === softphone.sdk_call_uuid);
				Promise.resolve(sameSession ? sdk.hangup() : undefined).catch(err => {
					if (softphone.current_call_log !== call_log) return;
					softphone.error = err.message || __('Browser hang-up failed; awaiting provider termination.');
					this.render_browser_softphone();
				});
			} catch (err) {
				softphone.error = err.message || __('Browser hang-up failed; awaiting provider termination.');
			}
			softphone.status = __('Waiting for provider confirmation');
			this.render_browser_softphone();
		}
		const endpoint = isBrowser ? 'vobiz_system_call.api.webrtc.cancel_browser_call' : 'vobiz_click_to_call.api.call.cancel_call';
		const request = frappe.call(endpoint, { call_log });
		return (isBrowser ? this.browser_request_with_timeout(request, 30000) : Promise.resolve(request)).then(() => {
			const statusRequest = frappe.call({
				method: 'vobiz_click_to_call.api.call.get_call_status',
				args: { call_log, sync_provider: 0 }
			});
			return isBrowser ? this.browser_request_with_timeout(statusRequest) : statusRequest;
		}).then((r) => {
			const call = r.message || { name: call_log };
			if (isBrowser && softphone.current_call_log !== call_log) return call;
			const currentCall = softphone.current_call_log || (this.state.active_call || {}).name;
			if (currentCall && currentCall !== call_log) return call;
			if (!this.is_terminal_status(call.status)) {
				this.watch_browser_call_disposition(call_log);
				if (isBrowser) {
					softphone.status = __('Waiting for provider confirmation');
					this.render_browser_softphone();
				}
				this.load();
				return call;
			}
			if (isBrowser) this.reconcile_browser_softphone_call(call);
			if (this.state.workdesk_live_call_log === call_log) {
				this.clear_tracked_live_call(call_log);
			}
			this.state.active_call = { last_call: call };
			this.state.workdesk_live_call = null;
			this.render_workdesk_live_call();
			this.update_workdesk_primary_action(row || this.state.active_workdesk_row);
			const autoCallLog = (((this.state.auto_dial || {}).current || {}).call_log) || '';
			if (autoCallLog !== call_log) {
				this.maybe_prompt_workdesk_disposition(call);
			}
			frappe.show_alert({ message: __('Call stopped.'), indicator: 'orange' });
			this.load();
		}).catch(err => {
			this.watch_browser_call_disposition(call_log);
			if (isBrowser && softphone.current_call_log === call_log) {
				const status = Number(err && err.status) || 0;
				if (status === 0 || status >= 500) softphone.pending_end_call = call_log;
				else softphone.pending_end_call = '';
				softphone.error = __('Call could not be confirmed ended. Please retry End Call.');
				this.render_browser_softphone();
			}
			throw err;
		});
	}

	disposition_call_in_progress() {
		const s = this.state.softphone || {};
		const active = this.state.active_call || {};
		return Boolean(s.current_call_log || s.in_call || s.incoming_pending ||
			(active.name && !this.is_terminal_status(active.status)));
	}

	queue_post_call_disposition(call, row, on_done, options) {
		const queue = this.pending_post_call_dispositions || (this.pending_post_call_dispositions = new Map());
		if (!queue.has(call.name)) queue.set(call.name, [call, row, on_done,
			Object.assign({}, options, {disposition_context_refreshed: false})]);
	}

	sync_post_call_disposition() {
		const current = this.post_call_disposition;
		const busy = this.disposition_call_in_progress();
		if (current) {
			const callLog = (this.state.softphone || {}).current_call_log || (this.state.active_call || {}).name;
			if (busy && callLog && callLog !== current.call_log) current.waiting_for_end.add(callLog);
			if (busy && !current.suspended) {
				current.suspended = true;
				current.hiding = true;
				current.dialog.hide();
			} else if (!busy && !current.waiting_for_end.size && current.suspended && !current.hiding) {
				current.suspended = false;
				current.dialog.show();
			}
			return;
		}
		if (busy || this.disposition_opening_call || this.disposition_drain_timer
			|| !this.pending_post_call_dispositions?.size) return;
		this.disposition_drain_timer = setTimeout(() => {
			this.disposition_drain_timer = null;
			if (this.post_call_disposition || this.disposition_opening_call || this.disposition_call_in_progress()) return;
			const [key, args] = this.pending_post_call_dispositions.entries().next().value || [];
			if (!key) return;
			this.pending_post_call_dispositions.delete(key);
			this.open_post_call_disposition_dialog(...args);
		}, 150);
	}

	is_disposition_call_current(callLog) {
		const browserCall = (this.state.softphone || {}).current_call_log;
		const active = this.state.active_call || {};
		return (!browserCall || browserCall === callLog)
			&& (!active.name || active.name === callLog || this.is_terminal_status(active.status));
	}

	maybe_prompt_workdesk_disposition(call) {
		if (!call || !call.name || !this.is_terminal_status(call.status)) return;
		call = this.completed_call_context(call);
		this.post_call_disposition?.waiting_for_end.delete(call.name);
		this.sync_post_call_disposition();
		if (!this.is_disposition_call_current(call.name)) return;
		if ((!call.reference_doctype || !call.reference_name) && call.direction !== 'Incoming') {
			// Compatibility with old workers sending only name/status during deployment.
			if (!call.disposition_reference_checked) this.watch_browser_call_disposition(call.name);
			else this.completed_call_contexts.delete(call.name);
			return;
		}
		if (call.direction === 'Incoming' && !call.reference_name && !call.incoming_reference_checked) {
			this.incoming_disposition_pending = this.incoming_disposition_pending || new Set();
			if (this.incoming_disposition_pending.has(call.name)) return;
			this.incoming_disposition_pending.add(call.name);
			Promise.resolve(frappe.call({method: 'vobiz_system_call.api.webrtc.prepare_incoming_disposition', args: {call_log: call.name}}))
				.then(r => this.maybe_prompt_workdesk_disposition(Object.assign({}, call, r.message || {}, {incoming_reference_checked: true})))
				.catch(() => this.maybe_prompt_workdesk_disposition(Object.assign({}, call, {incoming_reference_checked: true})))
				.finally(() => this.incoming_disposition_pending.delete(call.name));
			return;
		}
		if (this.should_skip_post_call_disposition(call, { doctype: call.reference_doctype })
			|| this.state.ai_disposition_enabled || this.state.disposition_prompted_call_log === call.name
			|| this.state.active_disposition_call_log === call.name) {
			this.completed_call_contexts.delete(call.name);
			return;
		}
		const session = this.state.auto_dial || {};
		const autoCallLog = ((session.current || {}).call_log) || '';
		if (session.running && (session.awaiting_disposition || autoCallLog === call.name)) {
			this.completed_call_contexts.delete(call.name);
			return;
		}

		const selected = this.state.active_workdesk_row || this.state.selected || {};
		const row = (
			selected.doctype === call.reference_doctype && selected.name === call.reference_name
				? selected
				: (this.state.queue || []).find(item => item.doctype === call.reference_doctype && item.name === call.reference_name)
		) || {
			doctype: call.reference_doctype,
			name: call.reference_name,
			title: call.reference_title || call.reference_name,
			phone: call.customer_number_display || ''
		};
		if ((!row.doctype || !row.name) && call.direction !== 'Incoming') return;

		this.state.disposition_prompted_call_log = call.name;
		this.completed_call_contexts.delete(call.name);
		setTimeout(() => {
			if (!this.is_disposition_call_current(call.name)) {
				this.completed_call_context(call);
				if (this.state.disposition_prompted_call_log === call.name) this.state.disposition_prompted_call_log = null;
				return;
			}
			this.open_post_call_disposition_dialog(call, row, null, {
				check_current_call: true,
				force_timer: true,
				timeout_seconds: 60,
				timeout_status: 'Agent Not Available'
			});
		}, 150);
	}

	open_post_call_disposition_dialog(call, row, on_done, options = {}) {
		if (options.check_current_call && !this.is_disposition_call_current(call.name)) {
			this.completed_call_context(call);
			if (this.disposition_opening_call === call.name) this.disposition_opening_call = null;
			if (this.state.disposition_prompted_call_log === call.name) this.state.disposition_prompted_call_log = null;
			return;
		}
		if (this.should_skip_post_call_disposition(call, row)) {
			this.state.active_disposition_call_log = null;
			this.state.disposition_prompted_call_log = call && call.name ? call.name : null;
			if (on_done) on_done();
			return;
		}
		if (this.state.active_disposition_call_log === call.name) return;
		if (this.post_call_disposition || (this.disposition_opening_call && this.disposition_opening_call !== call.name)
			|| this.disposition_call_in_progress()) {
			if (this.disposition_opening_call === call.name) this.disposition_opening_call = null;
			this.queue_post_call_disposition(call, row, on_done, options);
			return;
		}
		if (!call.reference_doctype && !call.reference_name && !options.generic_dispositions) {
			this.disposition_opening_call = call.name;
			frappe.call('vobiz_click_to_call.api.disposition.get_disposition_options_api').then(r => {
				this.open_post_call_disposition_dialog(call, row, on_done, Object.assign({}, options, { generic_dispositions: r.message || [] }));
			}).catch(() => {
				this.state.disposition_prompted_call_log = null;
				if (this.disposition_opening_call === call.name) this.disposition_opening_call = null;
				this.sync_post_call_disposition();
			});
			return;
		}
		if (!options.disposition_context_refreshed && (row.doctype || call.reference_doctype) && (row.name || call.reference_name)) {
			this.disposition_opening_call = call.name;
			frappe.call('vobiz_click_to_call.api.console.get_reference_context', {
				reference_doctype: row.doctype || call.reference_doctype,
				reference_name: row.name || call.reference_name,
				lite: 1
			}).then((r) => {
				this.state.context = r.message || {};
				this.apply_context_dispositions(this.state.context);
			}).always(() => {
				this.open_post_call_disposition_dialog(call, row, on_done, Object.assign({}, options, {
					disposition_context_refreshed: true
				}));
			});
			return;
		}
		if (this.disposition_opening_call === call.name) this.disposition_opening_call = null;
		this.state.active_disposition_call_log = call.name;
		this.state.disposition_prompted_call_log = call.name;
		if (this.state.ai_disposition_enabled) {
			this.state.active_disposition_call_log = null;
			if (on_done) on_done();
			return;
		}
		if (call.disposition) {
			this.state.active_disposition_call_log = null;
			frappe.msgprint({
				title: __('Call Disposed'),
				indicator: 'green',
				message: `
					<div><strong>${__('Disposition')}</strong>: ${frappe.utils.escape_html(call.disposition)}</div>
					${call.ai_disposition ? `<div><strong>${__('AI Suggestion')}</strong>: ${frappe.utils.escape_html(call.ai_disposition)}${call.ai_confidence ? ` (${frappe.utils.escape_html(String(call.ai_confidence))})` : ''}</div>` : ''}
					${call.ai_summary ? `<hr><div>${frappe.utils.escape_html(call.ai_summary)}</div>` : ''}
					${call.disposition_notes ? `<hr><div>${frappe.utils.escape_html(call.disposition_notes)}</div>` : ''}
				`
			});
			if (on_done) on_done();
			return;
		}

		let hasReference = Boolean(call.reference_doctype && call.reference_name);
		const needsIncomingLead = call.direction === 'Incoming' && !hasReference;
		let loadingIncomingLead = false;
		const leadContext = hasReference ? (this.state.lead_disposition_context || {}) : {};
		const isPatientDisposition = this.is_patient_disposition_reference(call, row);
		const patientOptions = this.patient_followup_status_options();
		const shouldRefreshPatientOptions = isPatientDisposition
			&& !options.patient_followup_options_refreshed
			&& (patientOptions.length <= 1 || !patientOptions.includes('Agent Not Available'));
		if (shouldRefreshPatientOptions) {
			frappe.call('vobiz_click_to_call.api.disposition.get_patient_followup_status_options_api')
				.then((r) => {
					const refreshedOptions = r.message || [];
					if (refreshedOptions.length) {
						this.state.patient_followup_status_options = refreshedOptions;
					}
				})
				.always(() => {
					if (this.state.active_disposition_call_log === call.name) {
						this.state.active_disposition_call_log = null;
					}
					this.open_post_call_disposition_dialog(call, row, on_done, Object.assign({}, options, {
						patient_followup_options_refreshed: true
					}));
				});
			return;
		}
		const autoDialDisposition = Boolean(options.auto_dial);
		const timedDisposition = hasReference && Boolean(options.auto_dial || options.force_timer);
		const timeoutStatus = options.timeout_status || 'Agent Not Available';
		const timeoutSeconds = parseInt(options.timeout_seconds, 10) || 60;
		let statusOptions = (leadContext.status_options || []).slice();
		const patientTimeoutStatus = this.patient_followup_status_options().includes(timeoutStatus) ? timeoutStatus : '';
		const leadTimeoutStatus = statusOptions.includes(timeoutStatus) ? timeoutStatus : '';
		const timedAutoSave = timedDisposition && (isPatientDisposition ? Boolean(patientTimeoutStatus) : Boolean(leadTimeoutStatus));
		const currentStatus = statusOptions.includes(leadContext.status || '') ? leadContext.status : '';
		const dispositionOptions = hasReference && !isPatientDisposition
			? (leadContext.options || []).map(item => item.name).filter(Boolean)
			: (options.generic_dispositions || this.state.dispositions || []);
		const suggested = call.ai_disposition && dispositionOptions.includes(call.ai_disposition) ? call.ai_disposition : '';
		const notes = [call.ai_summary, call.ai_next_action].filter(Boolean).join('\n\n');
		let done = false;
		let autoSubmitting = false;
		let dispositionOptionsLoading = false;
		let dispositionOptionsRequest = 0;
		let countdownSeconds = timeoutSeconds;
		let countdownTimer = null;
		const finish = () => {
			if (done) return;
			done = true;
			clearInterval(countdownTimer);
			if (this.state.active_disposition_call_log === call.name) {
				this.state.active_disposition_call_log = null;
			}
			if (this.post_call_disposition === controller) this.post_call_disposition = null;
			if (on_done) on_done();
			this.sync_post_call_disposition();
		};
		const saveDisposition = (values, isAutoSave = false) => {
			if (done || autoSubmitting || loadingIncomingLead || dispositionOptionsLoading
				|| controller.suspended || this.disposition_call_in_progress()) return;
			if (needsIncomingLead && !hasReference) {
				frappe.msgprint(__('Select the matching CRM Lead before saving its status and disposition.'));
				return;
			}
			if (isPatientDisposition && !values.sr_followup_status) {
				frappe.msgprint(__('Select follow-up status.'));
				return;
			}
			if (!isPatientDisposition && statusOptions.length && !values.lead_status) {
				frappe.msgprint(__('Select status.'));
				return;
			}
			autoSubmitting = true;
			clearInterval(countdownTimer);
			dialog.get_primary_btn().prop('disabled', true).text(isAutoSave ? __('Auto Saving...') : __('Saving...'));
			frappe.call('vobiz_click_to_call.api.disposition.save_disposition', {
				call_log: call.name,
				lead_status: isPatientDisposition ? '' : values.lead_status,
				disposition: isPatientDisposition ? values.sr_followup_status : values.disposition,
				sr_followup_status: isPatientDisposition ? values.sr_followup_status : '',
				notes: values.notes
			}).then(() => {
				const savedStatus = isPatientDisposition ? values.sr_followup_status : values.lead_status;
				frappe.show_alert({
					message: isAutoSave
						? __('Disposition auto-saved as {0}', [savedStatus])
						: __('Disposition saved'),
					indicator: isAutoSave ? 'orange' : 'green'
				});
				controller.saved = true;
				if (controller.suspended && !controller.hiding) finish();
				dialog.hide();
				this.load();
			}).always(() => {
				autoSubmitting = false;
				dialog.get_primary_btn().prop('disabled', false).text(__('Save Disposition'));
			});
		};
		const dialog = new frappe.ui.Dialog({
			title: __('Complete Call Disposition'),
			static: true,
			fields: [
				{
					fieldname: 'call_info',
					fieldtype: 'HTML',
					options: `
						<div class="vobiz-workdesk-card">
							<div><strong>${frappe.utils.escape_html(row.title || row.name || call.reference_name || call.customer_number_display || call.customer_number || __('Customer'))}</strong></div>
							<div class="text-muted">${frappe.utils.escape_html(call.status || '')}</div>
							${call.ai_disposition ? `<hr><div><strong>${__('AI Suggestion')}</strong>: ${frappe.utils.escape_html(call.ai_disposition)}${call.ai_confidence ? ` (${frappe.utils.escape_html(String(call.ai_confidence))})` : ''}</div>` : ''}
							${call.ai_summary ? `<div class="vobiz-related-meta">${frappe.utils.escape_html(call.ai_summary)}</div>` : ''}
						</div>
					`
				},
				...(needsIncomingLead ? [{
					fieldname: 'incoming_lead', fieldtype: 'Link', options: 'CRM Lead',
					label: __('CRM Lead'), reqd: 1,
					description: __('Select the matching customer to load Status and Lead Disposition.'),
					onchange: () => loadIncomingLead()
				}] : []),
				{
					fieldname: 'auto_dial_timer',
					fieldtype: 'HTML',
					hidden: !timedDisposition,
					options: `
						<div class="alert alert-warning" style="margin-bottom: 12px;">
							<strong>${autoDialDisposition ? __('Auto Dial') : __('Call Disposition')}</strong>:
							${__('Submit disposition within')}
							<span data-role="auto-disposition-countdown">${timeoutSeconds}</span>
							${isPatientDisposition
								? (patientTimeoutStatus
									? __('seconds, otherwise Follow-up Status will be set automatically.')
									: __('seconds. Please select a Follow-up Status.'))
								: (leadTimeoutStatus
									? __('seconds, otherwise Status will be set automatically.')
									: __('seconds. Please select a Status.'))}
						</div>
					`
				},
				...(isPatientDisposition ? [{
					fieldname: 'sr_followup_status',
					fieldtype: 'Select',
					label: __('Follow-up Status'),
					options: [''].concat(this.patient_followup_status_options()).join('\n'),
					reqd: 1,
					default: row.sr_followup_status || ''
				}] : [{
					fieldname: 'lead_status',
					fieldtype: 'Select',
					label: __('Status'),
					hidden: !needsIncomingLead && (!hasReference || !statusOptions.length),
					options: [''].concat(statusOptions).join('\n'),
					reqd: needsIncomingLead || Boolean(hasReference && statusOptions.length),
					default: currentStatus
				},
				{
					fieldname: 'disposition',
					fieldtype: 'Select',
					label: hasReference || needsIncomingLead ? __('Lead Disposition') : __('Call Disposition'),
					options: [''].concat(dispositionOptions).join('\n'),
					default: suggested
				}]),
				{
					fieldname: 'notes',
					fieldtype: 'Small Text',
					label: __('Notes'),
					default: notes
				}
				],
				primary_action_label: __('Save Disposition'),
				primary_action: (values) => {
					saveDisposition(values);
			}
		});
		const controller = {call_log: call.name, dialog, suspended: false, hiding: false, waiting_for_end: new Set()};
		this.post_call_disposition = controller;
		const loadIncomingLead = async () => {
			const name = dialog.get_value('incoming_lead');
			if (!name || loadingIncomingLead || hasReference) return;
			loadingIncomingLead = true;
			dialog.get_primary_btn().prop('disabled', true);
			try {
				const prepared = await frappe.call({
					method: 'vobiz_system_call.api.webrtc.prepare_incoming_disposition',
					args: {call_log: call.name, reference_name: name}
				});
				const linked = prepared.message || {};
				if (!linked.reference_name) return;
				// Once linked, keep the form on the server-confirmed customer.
				dialog.set_df_property('incoming_lead', 'read_only', 1);
				dialog.set_value('incoming_lead', linked.reference_name);
				Object.assign(call, linked);
				Object.assign(row, {doctype: linked.reference_doctype, name: linked.reference_name});
				const response = await frappe.call({
					method: 'vobiz_click_to_call.api.disposition.get_lead_disposition_context_api',
					args: {reference_doctype: row.doctype, reference_name: row.name}
				});
				const context = response.message || {};
				statusOptions = (context.status_options || []).slice();
				dialog.set_df_property('lead_status', 'options', [''].concat(statusOptions).join('\n'));
				dialog.set_value('lead_status', statusOptions.includes(context.status) ? context.status : '');
				dialog.set_df_property('disposition', 'options', [''].concat((context.options || []).map(item => item.name).filter(Boolean)).join('\n'));
				dialog.set_value('disposition', '');
				hasReference = true;
			} catch (error) {
				// Frappe displays validation errors; keep Notes and permit a retry.
				dialog.set_df_property('incoming_lead', 'read_only', 0);
			} finally {
				loadingIncomingLead = false;
				dialog.get_primary_btn().prop('disabled', false);
			}
		};
		dialog.$wrapper.on('shown.bs.modal', () => {
			// Bootstrap ignores hide() while the opening animation is running.
			if (controller.suspended || controller.saved) {
				controller.hiding = true;
				dialog.hide();
			}
		});
		dialog.$wrapper.on('hidden.bs.modal', () => {
			controller.hiding = false;
			if (controller.saved || !controller.suspended) finish();
			else this.sync_post_call_disposition();
		});
		dialog.show();
		dialog.get_close_btn().hide();
		if (timedDisposition) {
			const $countdown = dialog.$wrapper.find('[data-role="auto-disposition-countdown"]');
			countdownTimer = setInterval(() => {
				if (controller.suspended || this.disposition_call_in_progress()) return;
				countdownSeconds -= 1;
				$countdown.text(String(Math.max(0, countdownSeconds)));
				if (countdownSeconds <= 0) {
					if (timedAutoSave) {
						saveDisposition({
							lead_status: isPatientDisposition ? '' : leadTimeoutStatus,
							// The timeout status differs from the selected status; do not reuse its disposition.
							disposition: '',
							sr_followup_status: isPatientDisposition ? patientTimeoutStatus : '',
							notes: dialog.get_value('notes')
						}, true);
					} else {
						clearInterval(countdownTimer);
					}
				}
			}, 1000);
		}
		if (!isPatientDisposition && (needsIncomingLead || statusOptions.length)) {
			dialog.fields_dict.lead_status.$input.on('change', async () => {
				const leadStatus = dialog.get_value('lead_status');
				if (!hasReference || loadingIncomingLead) return;
				const request = ++dispositionOptionsRequest;
				dispositionOptionsLoading = true;
				dialog.set_value('disposition', '');
				dialog.set_df_property('disposition', 'options', '');
				dialog.get_primary_btn().prop('disabled', true);
				if (!leadStatus) {
					dispositionOptionsLoading = false;
					dialog.get_primary_btn().prop('disabled', false);
					return;
				}
				try {
					const r = await frappe.call({
						method: 'vobiz_click_to_call.api.disposition.get_lead_disposition_context_api',
						args: {reference_doctype: row.doctype || call.reference_doctype,
							reference_name: row.name || call.reference_name, lead_status: leadStatus}
					});
					if (request !== dispositionOptionsRequest || done) return;
					const context = r.message || {};
					const refreshedOptions = (context.options || []).map(item => item.name).filter(Boolean);
					dialog.set_df_property('disposition', 'options', [''].concat(refreshedOptions).join('\n'));
					dialog.set_value('disposition', call.ai_disposition && refreshedOptions.includes(call.ai_disposition) ? call.ai_disposition : '');
				} catch (error) {
					// Keep the old status's choices cleared when the request fails.
				} finally {
					if (request === dispositionOptionsRequest) {
						dispositionOptionsLoading = false;
						dialog.get_primary_btn().prop('disabled', false);
					}
				}
			});
		}

	}

	should_skip_post_call_disposition(call, row = {}) {
		const doctype = (row && row.doctype) || (call && call.reference_doctype) || '';
		return ['Issue', 'Patient Encounter'].includes(doctype);
	}

	save_disposition() {
		const active = this.state.active_call || {};
		const leadStatus = this.page.main.find('[data-role="lead-status"]').val();
		const statusOptions = ((this.state.lead_disposition_context || {}).status_options || []);
		const disposition = this.page.main.find('[data-role="disposition"]').val();
		const notes = this.page.main.find('[data-role="notes"]').val();
		if (!active.name) {
			frappe.msgprint(__('No active call selected.'));
			return;
		}
		if (statusOptions.length && !leadStatus) {
			frappe.msgprint(__('Select status.'));
			return;
		}
		frappe.call('vobiz_click_to_call.api.disposition.save_disposition', {
			call_log: active.name,
			lead_status: leadStatus,
			disposition,
			notes
		}).then(() => {
			frappe.show_alert({ message: __('Disposition saved'), indicator: 'green' });
			this.page.main.find('[data-role="notes"]').val('');
			this.load();
		});
	}

	open_reference() {
		const active = this.state.active_call || {};
		const row = this.state.selected || {};
		const doctype = active.reference_doctype || row.doctype;
		const name = active.reference_name || row.name;
		if (doctype && name) {
			frappe.set_route('Form', doctype, name);
		}
	}
}
