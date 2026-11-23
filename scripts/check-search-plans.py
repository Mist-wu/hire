"""Run with python3 scripts/check-search-plans.py (SQLite with FTS5 required)."""

import sqlite3
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
SEARCHES = {
    "jobs": (
        """SELECT j.*, c.name AS company_name, c.active_at AS recruiter_active_at
           FROM jobs j JOIN companies c ON c.id = j.company_id
           WHERE j.status = 'open' AND (j.deadline IS NULL OR j.deadline >= ?)""",
        "j.created_at", "j.id", ("2026-01-01",),
    ),
    "candidates": (
        "SELECT c.* FROM candidates c WHERE c.resume_public = 1 AND c.name IS NOT NULL",
        "c.created_at", "c.account_id", (),
    ),
}


def check_plans(db, stage, require_index_order):
    for name, (query, timestamp, key, params) in SEARCHES.items():
        for page in ("first", "cursor"):
            sql = query
            bindings = params
            if page == "cursor":
                sql += f" AND ({timestamp} < ? OR ({timestamp} = ? AND {key} < ?))"
                bindings += ("2026-01-01", "2026-01-01", "cursor-id")
            sql += f" ORDER BY {timestamp} DESC, {key} DESC LIMIT ?"
            rows = db.execute("EXPLAIN QUERY PLAN " + sql, bindings + (21,))
            details = [row[3] for row in rows]
            print(f"{stage} {name} {page}:", *details, sep="\n  ")
            if require_index_order and any("TEMP B-TREE" in d for d in details):
                raise SystemExit(f"Unexpected temporary sort for {name} ({page})")


with sqlite3.connect(":memory:") as db:
    for migration in sorted(MIGRATIONS.glob("*.sql")):
        db.executescript(migration.read_text())
        if migration.name == "0002_signals.sql":
            check_plans(db, "before 0003", False)
    check_plans(db, "current", True)
