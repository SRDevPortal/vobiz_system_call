"""Real isolated Redis dispatch tests; provider calls and ERP SQL are simulated."""
import concurrent.futures
import pickle
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import frappe
import redis

from vobiz_system_call.api import conference_jobs as jobs


class TestCache(redis.Redis):
    def make_key(self, key):
        return "test-conference|" + key

    def set_value(self, key, value, expires_in_sec=None):
        self.set(self.make_key(key), pickle.dumps(value), ex=expires_in_sec)

    def get_value(self, key, **kwargs):
        value = self.get(self.make_key(key))
        return pickle.loads(value) if value else None


class DispatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        executable = shutil.which("redis-server")
        if not executable:
            raise unittest.SkipTest("redis-server required for isolated integration tests")
        cls.temp = tempfile.TemporaryDirectory(prefix="vsc-dispatch-")
        socket = str(Path(cls.temp.name) / "redis.sock")
        cls.server = subprocess.Popen(
            [executable, "--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.cache = TestCache(unix_socket_path=socket)
        for _ in range(100):
            if not Path(socket).exists():
                time.sleep(.02)
                continue
            try:
                cls.cache.ping()
                break
            except redis.ConnectionError:
                time.sleep(.02)
        else:
            cls.server.terminate()
            cls.temp.cleanup()
            raise RuntimeError("isolated Redis failed to start")

    @classmethod
    def tearDownClass(cls):
        cls.cache.close()
        cls.server.terminate()
        cls.server.wait(timeout=5)
        cls.temp.cleanup()

    def setUp(self):
        # This is a private Unix-socket Redis created by this test, never ERP Redis.
        self.cache.flushdb()
        self.now = 1000
        self.callbacks = []
        self.db = MagicMock()
        self.db.after_commit.add.side_effect = lambda callback: self.callbacks.append(callback)
        self.db.commit.side_effect = self.commit
        self.enqueued = MagicMock()
        from frappe.utils import background_jobs
        replacements = [
            patch.object(frappe, "cache", lambda: self.cache),
            patch.object(frappe, "db", self.db),
            patch.object(frappe, "enqueue", self.enqueued),
            patch.object(frappe, "logger", MagicMock()),
            patch.object(frappe, "get_all", MagicMock(return_value=[])),
            patch.object(jobs.time, "time", lambda: self.now),
            patch.object(background_jobs, "get_queues_timeout", lambda: {
                jobs.NORMAL_QUEUE: 120, jobs.URGENT_QUEUE: 120}),
        ]
        for p in replacements:
            p.start()
            self.addCleanup(p.stop)

    def commit(self):
        callbacks, self.callbacks = self.callbacks, []
        for callback in callbacks:
            callback()

    def add(self, registry, count, prefix="call", score=999):
        self.cache.zadd(self.cache.make_key(registry), {f"{prefix}-{n}": score for n in range(count)})

    def test_500_simultaneous_deadlines_dispatch_before_routine_work(self):
        self.add(jobs.DEADLINES, 500)
        self.add(jobs.WATCH, 500, prefix="healthy")
        result = jobs.dispatch_due()
        calls = self.enqueued.call_args_list
        self.assertEqual(result[jobs.DEADLINES], 500)
        self.assertEqual(len(calls), 1000)
        self.assertTrue(all(c.kwargs["queue"] == jobs.URGENT_QUEUE for c in calls[:500]))
        self.assertTrue(all(c.kwargs["queue"] == jobs.NORMAL_QUEUE for c in calls[500:]))
        self.assertEqual(len({c.kwargs["call_log"] for c in calls}), 1000)

    def test_backlog_larger_than_batch_is_drained_on_next_tick(self):
        self.add(jobs.URGENT, 1500)
        self.assertEqual(jobs.dispatch_due()[jobs.URGENT], 1000)
        self.now += 1
        self.assertEqual(jobs.dispatch_due()[jobs.URGENT], 500)
        self.assertEqual(len({c.kwargs["call_log"] for c in self.enqueued.call_args_list}), 1500)

    def test_two_dispatchers_cannot_claim_the_same_500_calls(self):
        self.add(jobs.URGENT, 500)
        def claim():
            return self.cache.eval(jobs._CLAIM, 1, self.cache.make_key(jobs.URGENT), 1000, 1005, 1000)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            claimed = list(pool.map(lambda _: claim(), range(2)))
        combined = [name for batch in claimed for name in batch]
        self.assertEqual(len(combined), 500)
        self.assertEqual(len(set(combined)), 500)

    def test_dispatcher_crash_after_claim_retries_after_lease(self):
        self.add(jobs.URGENT, 500)
        self.cache.eval(jobs._CLAIM, 1, self.cache.make_key(jobs.URGENT), 1000, 1005, 1000)
        self.assertEqual(jobs.dispatch_due()[jobs.URGENT], 0)
        self.now = 1005
        self.assertEqual(jobs.dispatch_due()[jobs.URGENT], 500)

    def test_queue_failure_does_not_lose_deadlines_or_block_other_calls(self):
        self.add(jobs.DEADLINES, 500)
        self.enqueued.side_effect = ConnectionError("simulated queue outage")
        self.assertEqual(jobs.dispatch_due()[jobs.DEADLINES], 500)
        self.assertEqual(self.cache.zcard(self.cache.make_key(jobs.DEADLINES)), 500)
        self.enqueued.side_effect = None
        self.now += jobs.RETRY_SECONDS
        self.assertEqual(jobs.dispatch_due()[jobs.DEADLINES], 500)

    def test_routine_watch_never_postpones_already_due_work(self):
        jobs.watch("CALL", 0)
        jobs.watch("CALL", 30)
        self.assertEqual(self.cache.zscore(self.cache.make_key(jobs.WATCH), "CALL"), 1000)

    def test_urgent_job_bypasses_existing_normal_job_id(self):
        jobs.enqueue("CALL")
        jobs.enqueue("CALL", urgent=True)
        normal, urgent = self.enqueued.call_args_list
        self.assertNotEqual(normal.kwargs["job_id"], urgent.kwargs["job_id"])
        self.assertEqual(urgent.kwargs["queue"], jobs.URGENT_QUEUE)
        self.assertTrue(urgent.kwargs["enqueue_after_commit"])

    def test_deadlines_are_registered_only_after_commit(self):
        jobs.schedule_state("CALL", {"deadline": 1120, "expires_at": 4600})
        self.assertIsNone(self.cache.zscore(self.cache.make_key(jobs.DEADLINES), "CALL"))
        self.commit()
        self.assertEqual(self.cache.zscore(self.cache.make_key(jobs.DEADLINES), "CALL"), 1120)

    def test_rejoin_replaces_old_deadline_and_completion_removes_all_timers(self):
        jobs.schedule_state("CALL", {"deadline": 1120, "expires_at": 4600})
        self.commit()
        jobs.schedule_state("CALL", {"deadline": None, "expires_at": 4600})
        self.commit()
        self.assertEqual(self.cache.zscore(self.cache.make_key(jobs.DEADLINES), "CALL"), 4600)
        jobs.enqueue("CALL", urgent=True)
        jobs.schedule_state("CALL", {"customer_ended": True, "legs": {"1": {"ended": True}}})
        self.commit()
        for registry in (jobs.WATCH, jobs.DEADLINES, jobs.URGENT):
            self.assertIsNone(self.cache.zscore(self.cache.make_key(registry), "CALL"))

    def test_closed_call_remains_urgent_until_every_leg_is_confirmed_ended(self):
        jobs.schedule_state("CALL", {"closed": True, "customer_ended": True, "legs": {"1": {}}})
        self.commit()
        self.assertEqual(self.cache.zscore(self.cache.make_key(jobs.URGENT), "CALL"), 1005)

    def test_old_probe_cannot_report_a_stalled_queue_as_healthy(self):
        self.cache.set_value(jobs.SCHEDULER_HEARTBEAT, 1000)
        jobs.worker_probe(jobs.NORMAL_QUEUE, 900)
        jobs.worker_probe(jobs.URGENT_QUEUE, 1000)
        self.assertFalse(jobs.health()["ready"])
        jobs.worker_probe(jobs.NORMAL_QUEUE, 1000)
        self.assertTrue(jobs.health()["ready"])
        self.now = 1061
        self.assertTrue(jobs.health()["ready"])  # Normal minute scheduler gap is healthy.
        self.now = 1151
        self.assertFalse(jobs.health()["ready"])

    def test_proof_for_one_queue_does_not_prove_the_other_queue_is_healthy(self):
        self.cache.set_value(jobs.SCHEDULER_HEARTBEAT, 1000)
        jobs.worker_probe(jobs.NORMAL_QUEUE, 1000)
        self.assertFalse(jobs.health()["ready"])

    def test_tick_uses_only_existing_default_and_short_workers(self):
        self.assertEqual(jobs.NORMAL_QUEUE, "default")
        self.assertEqual(jobs.URGENT_QUEUE, "short")
        jobs.tick()
        probes = [c for c in self.enqueued.call_args_list if c.args[0].endswith("worker_probe")]
        self.assertEqual({c.kwargs["queue"] for c in probes}, {jobs.NORMAL_QUEUE, jobs.URGENT_QUEUE})
        for call in probes:
            self.assertEqual(call.kwargs["queue_name"], call.kwargs["queue"])
            self.assertEqual(call.kwargs["sent_at"], 1000)
        self.assertEqual(self.cache.get_value(jobs.SCHEDULER_HEARTBEAT), 1000)
        # Merely enqueueing the probes does not make the workers healthy.
        self.assertFalse(jobs.health()["ready"])

    def test_existing_scheduler_sweep_updates_health_without_a_daemon(self):
        from vobiz_system_call.api import conference
        with patch.object(jobs.time, "sleep", side_effect=AssertionError("must not occupy a worker waiting")):
            conference.sweep()
        self.assertEqual(self.cache.get_value(jobs.SCHEDULER_HEARTBEAT), 1000)
        self.assertFalse(jobs.health()["ready"])
        for queue in ("default", "short"):
            jobs.worker_probe(queue, 1000)
        self.assertTrue(jobs.health()["ready"])

    def test_scheduler_heartbeat_alone_does_not_accept_a_late_worker_probe(self):
        self.cache.set_value(jobs.SCHEDULER_HEARTBEAT, 1000)
        jobs.worker_probe("default", 960)  # Fresh arrival, but 40 seconds in queue.
        jobs.worker_probe("short", 1000)
        self.assertFalse(jobs.health()["ready"])

    def test_routine_dispatch_does_not_jump_ahead_of_existing_erp_jobs(self):
        jobs.enqueue("CALL", urgent=True)
        self.add(jobs.WATCH, 1)
        jobs.dispatch_due()
        for call in self.enqueued.call_args_list:
            self.assertFalse(call.kwargs.get("at_front", False))

    def test_full_normal_queue_cannot_block_500_urgent_calls_or_urgent_probe(self):
        self.add(jobs.URGENT, 500)
        def submit(*args, **kwargs):
            if kwargs["queue"] == jobs.NORMAL_QUEUE:
                raise RuntimeError("normal queue full")
        self.enqueued.side_effect = submit
        self.assertEqual(jobs.tick()[jobs.URGENT], 500)
        urgent = [c for c in self.enqueued.call_args_list if c.kwargs["queue"] == jobs.URGENT_QUEUE]
        self.assertEqual(len(urgent), 501)  # All calls plus a real worker probe.

    def test_one_call_due_in_all_indexes_only_dispatches_once_to_urgent(self):
        for registry in (jobs.WATCH, jobs.DEADLINES, jobs.URGENT):
            self.add(registry, 1)
        jobs.dispatch_due()
        self.enqueued.assert_called_once()
        self.assertEqual(self.enqueued.call_args.kwargs["queue"], jobs.URGENT_QUEUE)

    def test_rebuild_restores_500_active_calls_after_cache_loss(self):
        import json
        mappings = [frappe._dict(name=f"agent-{n}", current_call_log=f"call-{n}") for n in range(500)]
        rows = [frappe._dict(name=f"call-{n}", request_json=json.dumps({"conference_recovery": {
            "version": 1, "deadline": 1120, "expires_at": 4600}})) for n in range(500)]
        frappe.get_all.side_effect = [mappings, rows]
        jobs.rebuild_active()
        self.commit()
        self.assertEqual(self.cache.zcard(self.cache.make_key(jobs.WATCH)), 500)
        self.assertEqual(self.cache.zcard(self.cache.make_key(jobs.DEADLINES)), 500)
        self.enqueued.assert_not_called()  # No provider calls or blocking work during rebuild.

    def test_real_rq_urgent_worker_runs_while_500_normal_jobs_wait(self):
        from rq import Queue, SimpleWorker
        normal = Queue(jobs.NORMAL_QUEUE, connection=self.cache)
        urgent = Queue(jobs.URGENT_QUEUE, connection=self.cache)
        for n in range(500):
            normal.enqueue(abs, -n)
        urgent.enqueue(jobs.worker_probe, queue_name=jobs.URGENT_QUEUE, sent_at=1000)
        worker = SimpleWorker([urgent], connection=self.cache)
        worker.work(burst=True, logging_level="WARNING")
        self.assertEqual(normal.count, 500)
        self.assertEqual(urgent.count, 0)
        self.assertEqual(self.cache.get_value(jobs.PROBE_PREFIX + jobs.URGENT_QUEUE),
                         {"sent_at": 1000, "completed_at": 1000})


if __name__ == "__main__":
    unittest.main()
