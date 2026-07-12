"""SQLite persistence for Orchestra tasks.

This module owns all task storage. Each task is a single row in the `tasks`
table; a task's lifecycle ("movement") is just an UPDATE of the `status`
column. It replaces the previous markdown-file-per-task store.
"""

import os
import time
import hashlib
import sqlite3
import importlib.util

DEFAULT_DB_PATH = "./orchestra.db"


def _load_db_path(config_path="config.py"):
    """Read DB_PATH from config.py, falling back to the default."""
    if not os.path.exists(config_path):
        return DEFAULT_DB_PATH
    try:
        spec = importlib.util.spec_from_file_location("config", config_path)
        config_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(config_module)
        return getattr(config_module, "DB_PATH", DEFAULT_DB_PATH)
    except Exception:
        return DEFAULT_DB_PATH


def get_connection():
    """Open a connection to the configured database with row access by name."""
    conn = sqlite3.connect(_load_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create the tasks table if it does not already exist."""
    conn = get_connection()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id             TEXT UNIQUE,
                name                TEXT,
                status              TEXT NOT NULL DEFAULT 'pending',
                model               TEXT,
                workspace           TEXT,
                content             TEXT,
                acceptance_criteria TEXT,
                completion_criteria TEXT,
                response            TEXT,
                failure_reason      TEXT,
                parent_task_id      TEXT,
                task_type           TEXT DEFAULT 'root',
                step_number         INTEGER,
                created_at          TEXT,
                updated_at          TEXT
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def _generate_task_id(timestamp):
    """SHA256 hash of the timestamp, used as a stable public task id."""
    return hashlib.sha256(timestamp.encode("utf-8")).hexdigest()


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def create_task(
    name,
    content,
    status="pending",
    model=None,
    workspace=None,
    acceptance_criteria=None,
    completion_criteria=None,
    parent_task_id=None,
    task_type="root",
    step_number=None,
):
    """Insert a new task row and return it as a dict."""
    now = _now()
    # Include a counter so rapidly-created tasks get distinct task_ids.
    task_id = _generate_task_id(f"{now}-{time.perf_counter()}")

    conn = get_connection()
    try:
        cur = conn.execute(
            """
            INSERT INTO tasks (
                task_id, name, status, model, workspace, content,
                acceptance_criteria, completion_criteria, parent_task_id,
                task_type, step_number, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                name,
                status,
                model,
                workspace,
                content,
                acceptance_criteria,
                completion_criteria,
                parent_task_id,
                task_type,
                step_number,
                now,
                now,
            ),
        )
        conn.commit()
        new_id = cur.lastrowid
    finally:
        conn.close()

    return get_task(new_id)


def get_task(identifier):
    """Fetch a task by numeric id or by task_id hash. Returns a dict or None."""
    conn = get_connection()
    try:
        row = None
        # Numeric id lookup first.
        if isinstance(identifier, int) or (
            isinstance(identifier, str) and identifier.isdigit()
        ):
            row = conn.execute(
                "SELECT * FROM tasks WHERE id = ?", (int(identifier),)
            ).fetchone()
        if row is None:
            row = conn.execute(
                "SELECT * FROM tasks WHERE task_id = ?", (str(identifier),)
            ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_tasks(status=None):
    """Return tasks (newest first), optionally filtered by status.

    `status` may be a single string or a list/tuple of statuses.
    """
    conn = get_connection()
    try:
        if status is None:
            rows = conn.execute(
                "SELECT * FROM tasks ORDER BY created_at DESC, id DESC"
            ).fetchall()
        else:
            statuses = [status] if isinstance(status, str) else list(status)
            placeholders = ",".join("?" for _ in statuses)
            rows = conn.execute(
                f"SELECT * FROM tasks WHERE status IN ({placeholders}) "
                "ORDER BY created_at DESC, id DESC",
                statuses,
            ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# Columns that update_task is allowed to set.
_UPDATABLE_COLUMNS = {
    "name",
    "status",
    "model",
    "workspace",
    "content",
    "acceptance_criteria",
    "completion_criteria",
    "response",
    "failure_reason",
    "parent_task_id",
    "task_type",
    "step_number",
}


def update_task(identifier, **fields):
    """Update the given columns on a task and refresh updated_at.

    Accepts a numeric id or a task_id hash. Unknown columns are ignored.
    This is how task "movement" (status changes) is recorded.
    """
    updates = {k: v for k, v in fields.items() if k in _UPDATABLE_COLUMNS}
    if not updates:
        return get_task(identifier)

    updates["updated_at"] = _now()
    set_clause = ", ".join(f"{col} = ?" for col in updates)
    values = list(updates.values())

    key_col = "id" if _is_numeric(identifier) else "task_id"
    key_val = int(identifier) if key_col == "id" else str(identifier)

    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE tasks SET {set_clause} WHERE {key_col} = ?",
            values + [key_val],
        )
        conn.commit()
    finally:
        conn.close()

    return get_task(identifier)


def delete_task(identifier):
    """Delete a task by numeric id or task_id hash."""
    key_col = "id" if _is_numeric(identifier) else "task_id"
    key_val = int(identifier) if key_col == "id" else str(identifier)

    conn = get_connection()
    try:
        conn.execute(f"DELETE FROM tasks WHERE {key_col} = ?", (key_val,))
        conn.commit()
    finally:
        conn.close()


def _is_numeric(identifier):
    return isinstance(identifier, int) or (
        isinstance(identifier, str) and identifier.isdigit()
    )
