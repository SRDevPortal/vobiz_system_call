from __future__ import annotations

import importlib
from pathlib import Path
import unittest


APP_ROOT = Path(__file__).resolve().parents[2]


class TestVobizSystemCallPatchApp(unittest.TestCase):
    def read_text(self, relative_path: str) -> str:
        return (APP_ROOT / relative_path).read_text()

    def test_install_patches_core_doctypes(self):
        install_py = self.read_text("vobiz_system_call/install.py")

        self.assertIn('"Vobiz Settings"', install_py)
        self.assertIn('"Vobiz User Mapping"', install_py)
        self.assertIn('"agent_call_device"', install_py)
        self.assertIn('"browser_softphone_username"', install_py)
        self.assertIn("cleanup_standalone_ui", install_py)

    def test_existing_agent_console_is_overridden_by_patch_app(self):
        page_json = self.read_text("vobiz_system_call/vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.json")
        console_js = self.read_text("vobiz_system_call/vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js")

        self.assertIn('"name": "vobiz-agent-console"', page_json)
        self.assertIn('"title": "Vobiz Agent Console"', page_json)
        self.assertIn("frappe.pages['vobiz-agent-console']", console_js)
        self.assertIn("vobiz_click_to_call.api.webrtc.get_browser_softphone_config", console_js)
        self.assertIn("vobiz_click_to_call.api.webrtc.update_browser_softphone_call", console_js)
        self.assertIn("vobiz_click_to_call.api.call.start_call", console_js)
        self.assertIn("client_context: 'agent_console'", console_js)
        self.assertIn("browser_softphone_live_html", console_js)
        self.assertIn("workdesk_phone_surface_html", console_js)
        self.assertIn("auto_connect_browser_softphone", console_js)
        self.assertIn("answer_browser_softphone", console_js)
        self.assertIn('data-action="softphone-answer"', console_js)
        self.assertNotIn('data-action="softphone-hangup"', console_js)
        self.assertIn("softphone_incoming_matches_row", console_js)
        self.assertIn("vobiz-callback-highlight", console_js)
        self.assertIn("run_softphone_diagnostics", console_js)
        self.assertIn("Test Mic", console_js)
        self.assertIn("Test Audio", console_js)

    def test_no_standalone_workspace_or_console_is_shipped(self):
        self.assertFalse((APP_ROOT / "vobiz_system_call/vobiz_system_call/workspace").exists())
        self.assertFalse(
            (APP_ROOT / "vobiz_system_call/vobiz_system_call/page/vobiz_system_call_console").exists()
        )

    def test_answer_url_belongs_to_patch_app(self):
        webrtc_py = self.read_text("vobiz_system_call/api/webrtc.py")
        hooks_py = self.read_text("vobiz_system_call/hooks.py")

        self.assertIn("vobiz_click_to_call.api.webrtc.answer", webrtc_py)
        self.assertIn('"vobiz_click_to_call.api.webrtc.answer": "vobiz_system_call.api.webrtc.answer"', hooks_py)
        self.assertIn("<Number>{escape(provider_phone_number(destination))}</Number>", webrtc_py)
        self.assertIn("Vobiz User Mapping", webrtc_py)

    def test_frappe_crm_compatibility_shim_is_packaged(self):
        pyproject = self.read_text("pyproject.toml")
        manifest = self.read_text("MANIFEST.in")

        self.assertTrue((APP_ROOT / "frappe_crm/__init__.py").exists())
        self.assertTrue((APP_ROOT / "frappe_crm/hooks.py").exists())
        self.assertTrue((APP_ROOT / "frappe_crm/commands.py").exists())
        self.assertTrue((APP_ROOT / "frappe_crm/modules.txt").exists())
        self.assertIn('"frappe_crm*"', pyproject)
        self.assertIn("recursive-include frappe_crm *.py", manifest)
        self.assertIn("recursive-include frappe_crm *.txt", manifest)
        self.assertIsNotNone(importlib.import_module("frappe_crm"))
        self.assertEqual(importlib.import_module("frappe_crm.commands").commands, [])


if __name__ == "__main__":
    unittest.main()
