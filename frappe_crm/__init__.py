"""Compatibility shim for benches that list the CRM app as frappe_crm.

The Frappe CRM Python module is named ``crm``. Some benches can still carry
``frappe_crm`` in their app list, which breaks asset builds before our app can
install. This package keeps that import resolvable without changing core apps.
"""

try:
	from crm import __version__  # type: ignore
except Exception:
	__version__ = "0.0.0"
