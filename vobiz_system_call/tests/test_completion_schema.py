from unittest import TestCase
from unittest.mock import MagicMock, patch

import frappe
from vobiz_system_call import install
from vobiz_system_call.patches.v1_0 import repair_completion_provider_schema as repair


class CompletionSchemaTests(TestCase):
    columns = [("completion_provider_status",), ("completion_provider_due",)]

    def test_missing_fields_are_created_before_columns_are_checked(self):
        db = MagicMock()
        db.exists.return_value = True
        db.sql.return_value = []
        def create(fields, **kwargs):
            self.assertEqual(set(fields), {"Vobiz Call Log"})
            self.assertEqual({f["fieldname"] for f in fields["Vobiz Call Log"]}, {c[0] for c in self.columns})
            self.assertTrue(kwargs["update"])
            db.sql.return_value = self.columns
        with patch.object(frappe, "db", db), patch.object(frappe, "clear_cache"), \
             patch.object(install, "create_custom_fields", side_effect=create):
            install.ensure_completion_fields()
        db.updatedb.assert_not_called()

    def test_unchanged_metadata_with_missing_physical_column_is_repaired(self):
        db = MagicMock()
        db.exists.return_value = True
        db.sql.side_effect = [[("completion_provider_due",)], self.columns]
        with patch.object(frappe, "db", db), patch.object(frappe, "clear_cache"), \
             patch.object(install, "create_custom_fields"):
            install.ensure_completion_fields()
        db.updatedb.assert_called_once_with("Vobiz Call Log")

    def test_repeated_repair_avoids_unnecessary_schema_updates(self):
        db = MagicMock()
        db.exists.return_value = True
        db.sql.return_value = self.columns
        with patch.object(frappe, "db", db), patch.object(frappe, "clear_cache"), \
             patch.object(install, "create_custom_fields"):
            install.ensure_completion_fields()
            install.ensure_completion_fields()
        db.updatedb.assert_not_called()
        db.set_value.assert_not_called()

    def test_failed_physical_repair_is_reported(self):
        db = MagicMock()
        db.exists.return_value = True
        db.sql.return_value = []
        def fail(message):
            raise RuntimeError(message)
        with patch.object(frappe, "db", db), patch.object(frappe, "clear_cache"), \
             patch.object(install, "create_custom_fields"), patch.object(install, "_", side_effect=lambda s: s), \
             patch.object(frappe, "throw", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "completion_provider_status"):
                install.ensure_completion_fields()

    def test_completion_setup_is_not_skipped_by_optional_settings_guard(self):
        db = MagicMock()
        db.exists.return_value = False
        with patch.object(frappe, "db", db), patch.object(install, "ensure_completion_fields") as ensure:
            install.ensure_patch_fields()
        ensure.assert_called_once_with()

    def test_patch_creates_columns_before_indexes(self):
        calls = []
        with patch.object(repair, "ensure_completion_fields", side_effect=lambda: calls.append("fields")), \
             patch.object(repair, "ensure_indexes", side_effect=lambda: calls.append("indexes")):
            repair.execute()
        self.assertEqual(calls, ["fields", "indexes"])

    def test_patch_does_not_continue_after_field_setup_failure(self):
        with patch.object(repair, "ensure_completion_fields", side_effect=RuntimeError("failed")), \
             patch.object(repair, "ensure_indexes") as indexes:
            with self.assertRaises(RuntimeError):
                repair.execute()
        indexes.assert_not_called()
