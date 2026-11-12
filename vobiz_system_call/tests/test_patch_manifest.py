"""Validate the manifest using the parser invoked by bench migrate."""
from importlib import import_module
from pathlib import Path
import unittest

from frappe.modules.patch_handler import PatchType, parse_as_configfile


class PatchManifestTests(unittest.TestCase):
    def test_both_migration_phases_parse(self):
        manifest = str(Path(__file__).resolve().parents[1] / "patches.txt")
        before = parse_as_configfile(manifest, PatchType.pre_model_sync)
        after = parse_as_configfile(manifest, PatchType.post_model_sync)
        self.assertEqual(before, [])
        self.assertIn(
            "vobiz_system_call.patches.v1_0.repair_browser_verification_counter_expiry", after
        )
        self.assertEqual(parse_as_configfile(manifest), before + after)

    def test_registered_patch_modules_are_importable(self):
        manifest = str(Path(__file__).resolve().parents[1] / "patches.txt")
        for module in parse_as_configfile(manifest):
            with self.subTest(module=module):
                self.assertTrue(callable(import_module(module).execute))
