"""
Slash command parser for PepForge harness.
Week 2: /history
Week 3: /generate /score /edit /compare /explain
"""

import re

VALID_FIX_TARGETS = {"charge", "hydro", "length", "ngram"}
_FIX_TO_COMPONENT = {
    "charge": "net_charge",
    "hydro": "hydrophobicity",
    "length": "length",
    "ngram": "ngram_bleu",
}
# Wide-open default task bounds for commands (/score, /edit, /compare,
# /explain) that operate on a bare sequence with no task spec of their own —
# only used where a tool genuinely requires a task dict shape.
_OPEN_TASK = {
    "length_min": 1, "length_max": 200,
    "charge_min": -20, "charge_max": 20,
    "hydro_min": 0.0, "hydro_max": 100.0,
}


def parse_command(text: str) -> dict | None:
    text = text.strip()
    if not text.startswith("/"):
        return None
    parts = text.split()
    cmd = parts[0].lower()
    args = parts[1:]
    return {"command": cmd, "args": args}


def _parse_options(args: list) -> tuple[list, dict]:
    """Split args into (positional_args, options). '--flag value' becomes
    options['flag'] = 'value'; a trailing bare '--flag' becomes True."""
    positional = []
    options = {}
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--"):
            key = a[2:]
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                options[key] = args[i + 1]
                i += 2
            else:
                options[key] = True
                i += 1
        else:
            positional.append(a)
            i += 1
    return positional, options


def _parse_range(value: str) -> tuple[float, float]:
    lo_str, hi_str = value.split("-", 1)
    return float(lo_str), float(hi_str)


def _parse_charge_range(value: str) -> tuple[int, int]:
    """'+2+5' or '-3+2' -> (lo, hi). Charge ranges can't split on '-' like
    length/hydro since the sign itself is a '-' — scan for signed ints instead."""
    nums = re.findall(r"[+-]?\d+", value)
    if len(nums) < 2:
        raise ValueError(f"invalid charge range {value!r}, expected e.g. +2+5")
    return int(nums[0]), int(nums[1])


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


def handle_generate(args: list, thread_id: str) -> dict:
    """/generate [activity] [--length LO-HI] [--charge +LO+HI] [--hydro LO-HI]

    Streams each node's output as it runs (via graph.stream()), then returns
    the final merged state alongside the step-by-step trace.
    """
    positional, options = _parse_options(args)
    kwargs: dict = {"activity": positional[0] if positional else ""}

    try:
        if "length" in options:
            lo, hi = _parse_range(options["length"])
            kwargs["length_min"], kwargs["length_max"] = int(lo), int(hi)
        if "charge" in options:
            kwargs["charge_min"], kwargs["charge_max"] = _parse_charge_range(options["charge"])
        if "hydro" in options:
            kwargs["hydro_min"], kwargs["hydro_max"] = _parse_range(options["hydro"])
    except ValueError as e:
        return {
            "error": f"usage: /generate [activity] [--length LO-HI] [--charge +LO+HI] "
            f"[--hydro LO-HI] ({e})"
        }

    import uuid

    from harness.graph import build_graph
    from harness.state import create_initial_state

    app = build_graph()
    initial_state = create_initial_state(**kwargs)
    run_config = {"configurable": {"thread_id": thread_id or str(uuid.uuid4())}}

    steps = []
    for update in app.stream(initial_state, config=run_config):
        for node_name, node_output in update.items():
            # LangGraph reports a node's output as None (not {}) when the
            # node returns an empty dict — e.g. input_guardrail's success
            # path returns {} (no changes needed).
            node_output = node_output or {}
            steps.append(
                {
                    "node": node_name,
                    "sequence": node_output.get("current_sequence"),
                    "score": node_output.get("current_score"),
                    "status": node_output.get("status"),
                }
            )

    final_state = app.get_state(run_config).values
    return {
        "sequence": final_state.get("current_sequence", ""),
        "score": final_state.get("current_score", 0.0),
        "status": final_state.get("status", "unknown"),
        "iteration": final_state.get("iteration", 0),
        "steps": steps,
    }


def handle_score(args: list) -> dict:
    """/score SEQUENCE [--ref REFERENCE] [--activity amp]

    --activity accepts either a PeptideBLEU preset code directly (amp/cpp/
    signal/immunological — unmapped, passed straight through) or a raw
    frontend activity name (e.g. anti-bacterial), mapped through
    backend/agent.py's ACTIVITY_PRESET_MAP first. Mirrors harness/graph.py's
    _preset() so this command's component weighting matches what a full
    generation run would use for the same activity, instead of silently
    falling back to ACTIVITY_WEIGHTS['default'] for every raw activity name
    (frontend_phase8g_score.md gap, confirmed before fixing).
    """
    positional, options = _parse_options(args)
    if not positional:
        return {"error": "usage: /score SEQUENCE [--ref REFERENCE] [--activity amp]"}

    sequence = positional[0].upper()
    reference = options.get("ref", "")
    activity = options.get("activity")
    if activity:
        from backend.agent import ACTIVITY_PRESET_MAP

        activity = ACTIVITY_PRESET_MAP.get(activity, activity)

    from harness.tools import descriptor_tool, peptide_bleu_tool, rulebook_tool

    descriptors = descriptor_tool.invoke({"sequence": sequence})
    bleu = (
        peptide_bleu_tool.invoke({"reference": reference, "sequence": sequence, "activity": activity})
        if reference
        else {}
    )
    rulebook = rulebook_tool.invoke({"sequence": sequence, "task": _OPEN_TASK})

    return {
        "sequence": sequence,
        "descriptors": descriptors,
        "bleu_score": bleu.get("score"),
        "components": bleu.get("components", {}),
        "rulebook_score": rulebook.get("score"),
        "rulebook_valid": rulebook.get("valid"),
    }


def handle_edit(args: list) -> dict:
    """/edit SEQUENCE --fix [charge|hydro|length|ngram]"""
    positional, options = _parse_options(args)
    if not positional or "fix" not in options:
        return {"error": "usage: /edit SEQUENCE --fix [charge|hydro|length|ngram]"}

    sequence = positional[0].upper()
    fix_target = options["fix"]
    if fix_target not in VALID_FIX_TARGETS:
        return {
            "error": f"invalid --fix target {fix_target!r}, must be one of "
            f"{sorted(VALID_FIX_TARGETS)}"
        }

    from harness.tools import edit_operator_tool

    component = _FIX_TO_COMPONENT[fix_target]
    result = edit_operator_tool.invoke(
        {
            "sequence": sequence,
            "task": _OPEN_TASK,
            # A single synthetic "this is the weakest component" score steers
            # edit_operator_tool's prompt toward the requested fix without
            # needing a full diagnostic_tool violations list.
            "scores": {component: 0.0},
            "violations": [],
        }
    )

    return {
        "original": sequence,
        "edited": result.get("new_sequence", sequence),
        "changed": result.get("valid", False),
        "operation": result.get("operation"),
        "reason_rejected": result.get("reason_rejected"),
    }


def handle_compare(args: list) -> dict:
    """/compare SEQUENCE1 SEQUENCE2 [--ref REFERENCE]"""
    positional, options = _parse_options(args)
    if len(positional) < 2:
        return {"error": "usage: /compare SEQUENCE1 SEQUENCE2 [--ref REFERENCE]"}

    seq1, seq2 = positional[0].upper(), positional[1].upper()
    reference = options.get("ref", "")

    from harness.tools import descriptor_tool, peptide_bleu_tool

    def _score_one(seq: str) -> dict:
        descriptors = descriptor_tool.invoke({"sequence": seq})
        bleu = (
            peptide_bleu_tool.invoke({"reference": reference, "sequence": seq}) if reference else {}
        )
        return {
            "sequence": seq,
            "descriptors": descriptors,
            "bleu_score": bleu.get("score"),
            "components": bleu.get("components", {}),
        }

    return {"sequence_1": _score_one(seq1), "sequence_2": _score_one(seq2)}


def _build_explanation(descriptors: dict, diagnostic: dict) -> str:
    if "error" in descriptors:
        return "Could not analyze this sequence."

    parts = [
        f"This peptide is {descriptors['length']} amino acids long "
        f"({descriptors['length_class'].replace('_', ' ')}).",
        f"Its net charge is {descriptors['net_charge']:+d} "
        f"({descriptors['charge_class'].replace('_', ' ')}).",
        f"Its hydrophobicity is {descriptors['hydro_pct']}% "
        f"(GRAVY score {descriptors['gravy']}).",
        f"Approximate molecular weight: {descriptors['mol_weight']} Da.",
    ]
    if diagnostic.get("passed"):
        parts.append("It passes all rulebook checks.")
    elif diagnostic.get("violations"):
        issues = "; ".join(f"{v['rule']} ({v['fix']})" for v in diagnostic["violations"])
        parts.append(f"It has {diagnostic['n_violations']} validation issue(s): {issues}.")
    return " ".join(parts)


def handle_explain(args: list) -> dict:
    """/explain SEQUENCE"""
    positional, _ = _parse_options(args)
    if not positional:
        return {"error": "usage: /explain SEQUENCE"}

    sequence = positional[0].upper()

    from harness.tools import descriptor_tool, diagnostic_tool

    descriptors = descriptor_tool.invoke({"sequence": sequence})
    diagnostic = diagnostic_tool.invoke({"sequence": sequence, "task": _OPEN_TASK})

    return {
        "sequence": sequence,
        "descriptors": descriptors,
        "diagnostic": diagnostic,
        "explanation": _build_explanation(descriptors, diagnostic),
    }


_VALID_COMMANDS = ("/generate", "/score", "/edit", "/compare", "/history", "/explain")


def execute_command(text: str, thread_id: str) -> dict | None:
    """Parse and run a slash command. Returns None if text isn't a command."""
    parsed = parse_command(text)
    if parsed is None:
        return None

    cmd, args = parsed["command"], parsed["args"]

    if cmd == "/generate":
        result = handle_generate(args, thread_id)
    elif cmd == "/score":
        result = handle_score(args)
    elif cmd == "/edit":
        result = handle_edit(args)
    elif cmd == "/compare":
        result = handle_compare(args)
    elif cmd == "/explain":
        result = handle_explain(args)
    elif cmd == "/history":
        n = 5
        if args:
            try:
                n = int(args[0])
            except ValueError:
                pass
        result = {"results": handle_history(thread_id, n)}
    else:
        result = {"error": f"unknown command: {cmd}", "valid_commands": list(_VALID_COMMANDS)}

    return {"command": cmd, **result}


if __name__ == "__main__":
    print(parse_command("/history 3"))
    print(parse_command("not a command"))
