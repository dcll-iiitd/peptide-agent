"""
SQLite-backed session memory (Week 2 Task 5) — replaces Week 1's in-memory-
only MemorySaver so state survives process restarts.

week2.md's own sketch does `return SqliteSaver.from_conn_string(DB_PATH)`,
but in the installed langgraph-checkpoint-sqlite version from_conn_string()
is a @contextmanager — calling it directly yields a generator object, not a
usable SqliteSaver, which would silently break build_graph()'s contract of
returning a long-lived compiled graph reused across multiple .invoke()
calls. Managing the sqlite3.Connection directly avoids that entirely.
"""

import os
import sqlite3

from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite import SqliteSaver

DB_PATH = os.environ.get("HARNESS_DB_PATH", "data/harness_memory.db")

# harness/state.py's dataclasses (PeptideDescriptors, DiagnosticResult,
# CandidateResult, EditOperation) get msgpack-serialized into checkpoints —
# without this allowlist, deserializing them prints a deprecation warning
# now ("will be blocked in a future version") and would hard-fail once that
# future version lands, since they're custom types the serializer doesn't
# know by default.
_ALLOWED_STATE_TYPES = [
    ("harness.state", "PeptideDescriptors"),
    ("harness.state", "DiagnosticResult"),
    ("harness.state", "CandidateResult"),
    ("harness.state", "EditOperation"),
]


def get_checkpointer() -> SqliteSaver:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    serde = JsonPlusSerializer(allowed_msgpack_modules=_ALLOWED_STATE_TYPES)
    saver = SqliteSaver(conn, serde=serde)
    saver.setup()
    return saver


def get_session_history(thread_id: str) -> list:
    """Return past AgentState snapshots for this thread, oldest first."""
    checkpointer = get_checkpointer()
    config = {"configurable": {"thread_id": thread_id}}
    snapshots = [
        tup.checkpoint.get("channel_values", {}) for tup in checkpointer.list(config)
    ]
    return list(reversed(snapshots))


def clear_session(thread_id: str) -> None:
    """Delete all checkpoints for this thread_id."""
    checkpointer = get_checkpointer()
    checkpointer.delete_thread(thread_id)


if __name__ == "__main__":
    print(f"DB_PATH: {DB_PATH}")
    cp = get_checkpointer()
    print("checkpointer OK:", cp)
