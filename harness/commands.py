"""
Slash command parser for PepForge harness.
Week 2: /history
Week 3: /generate /score /edit /compare /explain
"""


def parse_command(text: str) -> dict | None:
    text = text.strip()
    if not text.startswith("/"):
        return None
    parts = text.split()
    cmd = parts[0].lower()
    args = parts[1:]
    return {"command": cmd, "args": args}


_TERMINAL_STATUSES = ("complete", "failed")


def _same_result(a: dict, b: dict) -> bool:
    return (
        a.get("current_sequence") == b.get("current_sequence")
        and a.get("status") == b.get("status")
        and a.get("current_score") == b.get("current_score")
    )


def handle_history(thread_id: str, n: int = 5) -> list:
    """Return the last n *completed* generation results for this thread.

    get_session_history() returns every node-level checkpoint under this
    thread_id (~8 per single run_pepforge() call — one per graph node), not
    one entry per generation. Slicing that raw list would mostly surface
    meaningless mid-run snapshots (status="generating", etc.) instead of
    actual results, so this filters to terminal snapshots first.

    Reusing the same thread_id across multiple separate run_pepforge() calls
    (the realistic usage pattern once slash commands support repeated
    /generate) makes LangGraph insert one extra checkpoint at the start of
    each new invoke that just re-persists the *previous* run's final state
    verbatim (plus an internal "__start__" bookkeeping key the original
    doesn't have, so a full-dict equality check never catches it), before
    that run's own pending->...->terminal chain begins — without deduping
    on the actual result fields, that carried-over snapshot double-counts.
    """
    from harness.memory import get_session_history

    history = get_session_history(thread_id)
    results = []
    for i, snap in enumerate(history):
        if snap.get("status") not in _TERMINAL_STATUSES:
            continue
        if i > 0 and _same_result(history[i - 1], snap):
            continue
        results.append(snap)
    return results[-n:] if results else []


def execute_command(text: str, thread_id: str) -> dict | None:
    """Parse and run a slash command. Returns None if text isn't a command."""
    parsed = parse_command(text)
    if parsed is None:
        return None

    if parsed["command"] == "/history":
        n = 5
        if parsed["args"]:
            try:
                n = int(parsed["args"][0])
            except ValueError:
                pass
        return {"command": "/history", "results": handle_history(thread_id, n)}

    return {"command": parsed["command"], "error": f"unknown command: {parsed['command']}"}


if __name__ == "__main__":
    print(parse_command("/history 3"))
    print(parse_command("not a command"))
