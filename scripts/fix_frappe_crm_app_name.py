#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path


def bench_path() -> Path:
    current = Path.cwd().resolve()
    if (current / "sites" / "apps.txt").exists():
        return current
    if current.name == "sites" and (current / "apps.txt").exists():
        return current.parent
    for parent in current.parents:
        if (parent / "sites" / "apps.txt").exists():
            return parent
    return current


def main() -> None:
    apps_file = bench_path() / "sites" / "apps.txt"
    if not apps_file.exists():
        raise SystemExit(f"Could not find apps.txt at {apps_file}")

    lines = apps_file.read_text(encoding="utf-8").splitlines()
    updated = ["crm" if line.strip() == "frappe_crm" else line for line in lines]
    if updated != lines:
        apps_file.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
        print("Updated sites/apps.txt: frappe_crm -> crm")
    else:
        print("sites/apps.txt already clean")


if __name__ == "__main__":
    main()
