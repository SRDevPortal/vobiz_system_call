from __future__ import annotations

from pathlib import Path

import click


def _bench_path() -> Path:
    current = Path.cwd().resolve()
    if (current / "sites" / "apps.txt").exists():
        return current
    if current.name == "sites" and (current / "apps.txt").exists():
        return current.parent
    for parent in current.parents:
        if (parent / "sites" / "apps.txt").exists():
            return parent
    return current


@click.command("fix-frappe-crm-app-name")
def fix_frappe_crm_app_name():
    """Replace stale frappe_crm app-list entries with the real crm app name."""
    apps_file = _bench_path() / "sites" / "apps.txt"
    if not apps_file.exists():
        raise click.ClickException(f"Could not find apps.txt at {apps_file}")

    lines = apps_file.read_text(encoding="utf-8").splitlines()
    updated = []
    changed = False
    for line in lines:
        value = line.strip()
        if value == "frappe_crm":
            updated.append("crm")
            changed = True
        else:
            updated.append(line)

    if changed:
        apps_file.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
        click.echo("Updated sites/apps.txt: frappe_crm -> crm")
    else:
        click.echo("sites/apps.txt already clean")


commands = [fix_frappe_crm_app_name]
