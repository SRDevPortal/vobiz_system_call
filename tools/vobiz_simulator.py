#!/usr/bin/env python3
"""Local-only Vobiz simulation. No provider requests, SIP registrations or real calls.
Run with the bench Python. Dashboard: http://127.0.0.1:8766
The state model is synthetic; HTTP throttling uses the installed Frappe code.
"""
import argparse
import concurrent.futures
import json
import os
import threading
import time
import uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

BENCH = Path(__file__).resolve().parents[3]
SITE = "site1.local"
LOCK = threading.RLock()
STATE = {"requests": [], "calls": {}, "agents": {}, "results": [], "phase": "idle"}
RUN = uuid.uuid4().hex[:12]


def model(payload):
    """Synthetic agent actions: cancel retains ownership until final provider event."""
    agent, call, event = payload.get("agent", "agent-1"), payload.get("call", "call-1"), payload.get("event", "probe")
    with LOCK:
        if event == "probe":
            return {"ok": True}
        row = STATE["calls"].get(call)
        if event == "start":
            if row:
                return {"state": row["state"], "duplicate": True}
            if STATE["agents"].get(agent):
                return {"blocked": "agent_has_active_call"}
            row = {"agent": agent, "state": "initiated", "seen": [], "answered": False}
            STATE["calls"][call] = row
            STATE["agents"][agent] = call
        elif not row or row["agent"] != agent:
            return {"ignored": "unmatched_call"}
        elif row["state"] == "ended":
            return {"state": "ended", "ignored": "duplicate_or_late_event"}
        elif event in ("cancel", "close_tab"):
            row["state"] = "pending_provider"
        elif event == "answer":
            if row["state"] != "pending_provider":
                row["state"], row["answered"] = "connected", True
        elif event == "ring":
            if row["state"] not in ("pending_provider", "connected"):
                row["state"] = "ringing"
        elif event == "hangup":
            row["state"] = "ended"
            if STATE["agents"].get(agent) == call:
                del STATE["agents"][agent]
        row["seen"].append(event)
        return {"state": row["state"]}


def request_handler(payload):
    import frappe
    from frappe.rate_limiter import rate_limit
    from vobiz_click_to_call.services.callback_limits import callback_rate_limit
    from werkzeug.test import EnvironBuilder
    from werkzeug.wrappers import Request as WRequest
    frappe.init(site=SITE, sites_path=str(BENCH / "sites"))
    try:
        # Per-request in-memory config only. Never write site_config or clear live counters.
        frappe.local.conf = frappe._dict(dict(frappe.conf))
        limit = min(2000, max(1, int(payload.get("limit", 20))))
        frappe.conf.vobiz_answer_requests_per_minute = limit
        frappe.conf.vobiz_event_requests_per_minute = max(1, limit // 2)
        frappe.local.request = WRequest(EnvironBuilder(method="POST").get_environ())
        frappe.local.request_ip = "127.0.0.1"
        frappe.local.form_dict = frappe._dict(cmd="vobiz_simulator." + RUN + "." + payload["phase"])
        body = lambda: model(payload)
        if payload.get("mode") == "legacy":
            nested = rate_limit(limit=max(1, limit // 2), seconds=60)(body)
            handler = rate_limit(limit=limit, seconds=60)(nested)
        else:
            nested = callback_rate_limit("event")(body)
            handler = callback_rate_limit("answer")(nested)
        return 200, handler()
    except frappe.RateLimitExceededError:
        return 429, {"error": "RateLimitExceededError"}
    finally:
        frappe.destroy()


DASHBOARD = """<!doctype html><meta charset='utf-8'><title>Local Vobiz Simulator</title>
<style>body{font:16px system-ui;background:#101823;color:#e8edf3;max-width:1100px;margin:40px auto}h1{font-size:28px}pre{white-space:pre-wrap;background:#1c2837;padding:24px;border-radius:12px}small{color:#a9bbcd}</style>
<h1>Local Vobiz Simulator</h1><p>Real Frappe limiter | Synthetic calls | No Vobiz traffic</p>
<small>Loopback only. Virtual agents do not register SIP endpoints or dial telephone numbers.</small><pre id='m'>Loading...</pre>
<script>async function refresh(){try{const r=await fetch('/metrics');document.querySelector('#m').textContent=JSON.stringify(await r.json(),null,2)}catch(e){document.querySelector('#m').textContent='Simulator stopped'}}setInterval(refresh,1500);refresh()</script>"""


def metrics():
    with LOCK:
        rows = list(STATE["requests"])
        return {"run": RUN, "phase": STATE["phase"], "requests": len(rows),
                "http_statuses": dict(Counter(x["status"] for x in rows)),
                "active_reservations": len(STATE["agents"]), "synthetic_calls": len(STATE["calls"]),
                "results": list(STATE["results"]), "recent_requests": rows[-8:]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value, html=False):
        data = value.encode() if html else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html" if html else "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, metrics() if self.path == "/metrics" else DASHBOARD, self.path != "/metrics")

    def do_POST(self):
        if self.path != "/event":
            return self.reply(404, {"error": "not_found"})
        started = time.monotonic()
        payload = {}
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 8192:
                return self.reply(400, {"error": "invalid_size"})
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict) or not isinstance(payload.get("phase"), str):
                return self.reply(400, {"error": "invalid_payload"})
            status, result = request_handler(payload)
        except (ValueError, TypeError):
            return self.reply(400, {"error": "invalid_payload"})
        except Exception as exc:
            status, result = 500, {"error": type(exc).__name__, "detail": str(exc)[:200]}
        elapsed = round((time.monotonic() - started) * 1000, 1)
        with LOCK:
            STATE["requests"].append({"phase": payload.get("phase"), "event": payload.get("event"), "status": status, "ms": elapsed})
        self.reply(status, result)


def send(port, payload):
    started = time.monotonic()
    req = Request(f"http://127.0.0.1:{port}/event", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=30) as r:
            return r.status, json.load(r), (time.monotonic() - started) * 1000
    except HTTPError as exc:
        return exc.code, json.load(exc), (time.monotonic() - started) * 1000


def burst(port, phase, mode, limit, count, concurrency):
    STATE["phase"] = phase
    payload = {"phase": phase, "mode": mode, "limit": limit, "event": "probe"}
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        rows = list(pool.map(lambda _: send(port, payload), range(count)))
    statuses = dict(Counter(r[0] for r in rows))
    latencies = sorted(r[2] for r in rows)
    expected = limit // 4 if mode == "legacy" else limit
    result = {"phase": phase, "model": "actual Frappe limiter, synthetic handler",
              "requests": count, "concurrency": concurrency, "outer_limit": limit,
              "nested_limit": limit // 2, "statuses": statuses,
              "expected_accepted": min(count, expected), "passed": statuses.get(200, 0) == min(count, expected) and 500 not in statuses,
              "p95_ms": round(latencies[int((len(latencies)-1)*.95)], 1)}
    STATE["results"].append(result)
    print(json.dumps(result), flush=True)


def scenarios(port, agents):
    phase = "agent_scenarios"
    STATE["phase"] = phase
    def actor(i):
        common = {"phase": phase, "mode": "patched", "limit": 2000, "agent": f"agent-{i}", "call": f"scenario-{i}"}
        pattern = i % 4
        events = ["start", "start", "ring", "answer", "hangup", "hangup", "answer"] if pattern == 0 else ["start", "cancel", "ring", "answer", "hangup"] if pattern == 1 else ["start", "ring", "close_tab", "hangup"] if pattern == 2 else ["start", "ring", "hangup", "answer", "hangup"]
        rows = []
        for e in events:
            rows.append(send(port, dict(common, event=e)))
            if e in ("cancel", "close_tab"):
                blocked = send(port, dict(common, call=f"overlap-{i}", event="start"))
                if blocked[1].get("blocked") != "agent_has_active_call":
                    raise AssertionError("pending call lost reservation")
        return all(r[0] == 200 for r in rows)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(agents, 20)) as pool:
        passed = all(pool.map(actor, range(agents)))
    passed = passed and not STATE["agents"] and len(STATE["calls"]) == agents
    result = {"phase": phase, "model": "synthetic state machine, not production lifecycle integration",
              "agents": agents, "passed": passed, "active_reservations": len(STATE["agents"]),
              "cases": ["double click", "cancel before answer", "tab close", "duplicate hangup", "late answer", "overlapping calls"]}
    STATE["results"].append(result)
    print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--agents", type=int, default=20, choices=range(1, 51))
    parser.add_argument("--output", default=str(BENCH / "test-results/vobiz-simulator"))
    parser.add_argument("--keep-open", action="store_true")
    args = parser.parse_args()
    os.chdir(BENCH / "sites")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"Dashboard: http://127.0.0.1:{args.port}", flush=True)
    try:
        burst(args.port, "legacy_low_limit", "legacy", 20, 30, 1)
        burst(args.port, "patched_low_limit", "patched", 20, 30, 1)
        scenarios(args.port, args.agents)
        burst(args.port, "patched_2000_limit", "patched", 2000, 2100, 20)
        STATE["phase"] = "complete"
        output = Path(args.output) / RUN
        output.mkdir(parents=True, exist_ok=True)
        (output / "report.json").write_text(json.dumps(metrics(), indent=2))
        (output / "requests.jsonl").write_text("\n".join(json.dumps(x) for x in STATE["requests"]))
        print("Report: " + str(output / "report.json"), flush=True)
        if args.keep_open:
            while True:
                time.sleep(1)
    finally:
        server.shutdown()
        server.server_close()
    if not all(x["passed"] for x in STATE["results"]):
        raise SystemExit(1)

if __name__ == "__main__":
    main()
