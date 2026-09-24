"""Reconciliation enqueue deduplication without altering call lifecycle state."""
from contextlib import ExitStack
from unittest import TestCase
from unittest.mock import MagicMock, patch

import frappe
from frappe.utils import CallbackManager
from frappe.utils import background_jobs
from redis.exceptions import LockNotOwnedError

from vobiz_click_to_call.services import recovery_policy
from vobiz_system_call.api import lifecycle


class ReconcileQueueTests(TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.callbacks = CallbackManager()
        self.db = MagicMock(after_commit=self.callbacks)
        stack.enter_context(patch.object(frappe, "db", self.db))
        self.cache = MagicMock()
        self.cache.make_key.side_effect = lambda key: "test-site|" + key
        self.lock = self.cache.lock.return_value
        self.lock.acquire.return_value = True
        stack.enter_context(patch.object(frappe, "cache", lambda: self.cache))
        self.due = stack.enter_context(patch.object(recovery_policy, "due", return_value=True))
        self.exists = stack.enter_context(patch.object(background_jobs, "is_job_enqueued", return_value=False))
        self.enqueue = stack.enter_context(patch.object(frappe, "enqueue"))
        self.error = stack.enter_context(patch.object(frappe, "log_error"))
        stack.enter_context(patch.object(frappe, "get_traceback", return_value="queue failure"))

    def run_request(self):
        lifecycle.enqueue_reconcile("CALL-1")
        self.callbacks.run()

    def test_queue_check_and_enqueue_wait_for_commit(self):
        lifecycle.enqueue_reconcile("CALL-1")
        self.exists.assert_not_called()
        self.enqueue.assert_not_called()
        self.due.assert_not_called()
        self.callbacks.run()
        self.enqueue.assert_called_once_with(
            "vobiz_system_call.api.lifecycle.reconcile_call", call_log="CALL-1",
            queue="short", timeout=240, enqueue_after_commit=False,
            job_id="vsc-reconcile-CALL-1", deduplicate=True,
        )
        self.lock.acquire.assert_called_once_with(blocking=False)
        self.lock.release.assert_called_once()
        self.db.set_value.assert_not_called()

    def test_transaction_rollback_discards_enqueue(self):
        lifecycle.enqueue_reconcile("CALL-1")
        # Database.rollback uses CallbackManager.reset for after_commit hooks.
        self.callbacks.reset()
        self.callbacks.run()
        self.enqueue.assert_not_called()

    def test_queued_or_running_job_is_quietly_skipped(self):
        self.exists.return_value = True
        self.run_request()
        self.enqueue.assert_not_called()
        self.error.assert_not_called()
        self.lock.release.assert_called_once()

    def test_multiple_callbacks_in_one_commit_enqueue_once(self):
        queued = set()
        self.exists.side_effect = lambda job_id: job_id in queued
        self.enqueue.side_effect = lambda *a, **kw: queued.add(kw["job_id"])
        lifecycle.enqueue_reconcile("CALL-1")
        lifecycle.enqueue_reconcile("CALL-1")
        self.callbacks.run()
        self.enqueue.assert_called_once()
        self.error.assert_not_called()

    def test_cooldown_is_respected_after_commit(self):
        lifecycle.enqueue_reconcile("CALL-1")
        self.due.return_value = False
        self.callbacks.run()
        self.cache.lock.assert_not_called()
        self.enqueue.assert_not_called()

    def test_other_enqueue_holder_is_not_waited_on(self):
        self.lock.acquire.return_value = False
        self.run_request()
        self.exists.assert_not_called()
        self.enqueue.assert_not_called()
        self.lock.release.assert_not_called()
        self.error.assert_not_called()

    def test_other_calls_have_separate_site_scoped_guards(self):
        lifecycle.enqueue_reconcile("CALL-1")
        lifecycle.enqueue_reconcile("CALL-2")
        self.callbacks.run()
        keys = [call.args[0] for call in self.cache.lock.call_args_list]
        self.assertEqual(keys, ["test-site|vsc:reconcile-enqueue:CALL-1",
                                "test-site|vsc:reconcile-enqueue:CALL-2"])
        self.assertEqual(self.enqueue.call_count, 2)

    def test_existing_job_that_finished_before_commit_can_be_requeued(self):
        lifecycle.enqueue_reconcile("CALL-1")
        self.exists.return_value = False
        self.callbacks.run()
        self.enqueue.assert_called_once()

    def test_queue_connection_error_is_reported_without_changing_call(self):
        self.enqueue.side_effect = ConnectionError("redis unavailable")
        self.run_request()
        self.error.assert_called_once()
        self.lock.release.assert_called_once()
        self.db.set_value.assert_not_called()
        self.db.commit.assert_not_called()

    def test_status_lookup_failure_is_reported_and_releases_guard(self):
        self.exists.side_effect = ConnectionError("redis unavailable")
        self.run_request()
        self.enqueue.assert_not_called()
        self.error.assert_called_once()
        self.lock.release.assert_called_once()

    def test_expired_enqueue_lease_does_not_fail_successful_enqueue(self):
        self.lock.release.side_effect = LockNotOwnedError("expired")
        self.run_request()
        self.enqueue.assert_called_once()
        self.error.assert_not_called()

    def test_release_connection_failure_is_reported_without_bubbling_to_webhook(self):
        self.lock.release.side_effect = ConnectionError("redis unavailable")
        self.run_request()
        self.enqueue.assert_called_once()
        self.error.assert_called_once()
