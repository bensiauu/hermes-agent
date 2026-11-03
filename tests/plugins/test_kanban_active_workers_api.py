"""Contract tests for GET /workers/active — phase and latest-event extension."""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_db_dispatch as kbd


def _load_plugin_router():
    repo_root = Path(__file__).resolve().parents[2]
    plugin_file = repo_root / "plugins" / "kanban" / "dashboard" / "plugin_api.py"
    assert plugin_file.exists(), f"plugin file missing: {plugin_file}"
    spec = importlib.util.spec_from_file_location(
        "hermes_dashboard_plugin_kanban_active_test", plugin_file,
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod.router


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture
def client(kanban_home):
    app = FastAPI()
    app.include_router(_load_plugin_router(), prefix="/api/plugins/kanban")
    return TestClient(app)


def test_active_workers_lists_running_run_with_phase_and_latest_event(client):
    """A running worker exposes step_key, latest_event.kind/note/created_at,
    plus the pre-existing keys (run_id, profile, started_at, last_heartbeat_at)."""
    now = int(time.time())
    conn = kbc.connect()
    try:
        t = kb.create_task(conn, title="build widgets", assignee="alpha")
        lock = "lock-active-test"
        future = now + 3600
        conn.execute(
            "UPDATE tasks SET status='running', started_at=?, claim_lock=?, "
            "claim_expires=?, worker_pid=? WHERE id=?",
            (now - 120, lock, future, 12345, t),
        )
        conn.execute(
            "INSERT INTO task_runs (task_id, profile, step_key, status, claim_lock, "
            "claim_expires, worker_pid, started_at) "
            "VALUES (?, 'alpha', 'compile', 'running', ?, ?, ?, ?)",
            (t, lock, future, 12345, now - 120),
        )
        run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute("UPDATE tasks SET current_run_id=? WHERE id=?", (run_id, t))
        # Heartbeat with a note — becomes the latest event.
        kbd.heartbeat_worker(conn, t, note="compiling")
        conn.commit()
    finally:
        conn.close()

    r = client.get("/api/plugins/kanban/workers/active")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    w = body["workers"][0]
    assert w["run_id"] == run_id
    assert w["profile"] == "alpha"
    assert w["task_title"] == "build widgets"
    assert isinstance(w["started_at"], int)
    assert isinstance(w["last_heartbeat_at"], int)
    # New contract keys
    assert w["step_key"] == "compile"
    evt = w["latest_event"]
    assert evt is not None
    assert evt["kind"] == "heartbeat"
    assert evt["note"] == "compiling"
    assert isinstance(evt["created_at"], int)


def test_active_workers_excludes_blocked_and_ended_runs(client):
    """Blocked needs_input tasks and ended runs are absent; a run with no
    events has latest_event=None; count matches the returned list."""
    now = int(time.time())
    conn = kbc.connect()
    try:
        # 1. A running worker with NO events — latest_event should be None.
        t_run = kb.create_task(conn, title="clean run", assignee="beta")
        lock = "lock-excl-test"
        future = now + 3600
        conn.execute(
            "UPDATE tasks SET status='running', started_at=?, claim_lock=?, "
            "claim_expires=?, worker_pid=? WHERE id=?",
            (now - 60, lock, future, 11111, t_run),
        )
        conn.execute(
            "INSERT INTO task_runs (task_id, profile, status, claim_lock, "
            "claim_expires, worker_pid, started_at) "
            "VALUES (?, 'beta', 'running', ?, ?, ?, ?)",
            (t_run, lock, future, 11111, now - 60),
        )
        run_id_clean = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute("UPDATE tasks SET current_run_id=? WHERE id=?", (run_id_clean, t_run))

        # 2. A blocked needs_input task — must NOT appear.
        t_blocked = kb.create_task(conn, title="blocked task", assignee="gamma")
        conn.execute(
            "UPDATE tasks SET status='blocked', block_kind='needs_input' WHERE id=?",
            (t_blocked,),
        )

        # 3. An ended run — must NOT appear.
        t_ended = kb.create_task(conn, title="done task", assignee="delta")
        conn.execute(
            "UPDATE tasks SET status='done' WHERE id=?",
            (t_ended,),
        )
        conn.execute(
            "INSERT INTO task_runs (task_id, profile, status, claim_lock, "
            "claim_expires, worker_pid, started_at, ended_at) "
            "VALUES (?, 'delta', 'done', 'lock-e', ?, 22222, ?, ?)",
            (t_ended, future, now - 300, now - 10),
        )

        conn.commit()
    finally:
        conn.close()

    r = client.get("/api/plugins/kanban/workers/active")
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [w["task_id"] for w in body["workers"]]
    assert t_run in ids
    assert t_blocked not in ids
    assert t_ended not in ids
    assert body["count"] == len(body["workers"])

    # The clean run has no events — latest_event is None.
    w = next(w for w in body["workers"] if w["task_id"] == t_run)
    assert w["latest_event"] is None
