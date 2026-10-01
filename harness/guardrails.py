"""
Guardrail nodes — input validation before generation starts (fail fast,
don't waste an LLM call on a malformed task spec), output validation before
returning the final sequence to the user.

See .claude/plan/week3.md Task 4 for the spec.
"""

from harness.state import AgentState

# backend/rag/peptide_retriever.py's ACTIVITY_COLS — the 13 binary activity
# columns in data/peptides.csv, the authoritative "13 valid classes" already
# used everywhere else in this codebase.
VALID_ACTIVITIES = {
    "anti-bacterial", "anti-cancer", "anti-fungal", "anti-parasitic",
    "anti-viral", "cell-cell-communication", "drug-delivery",
    "immunological", "inhibitor", "metabolic", "other-functional",
    "signal-peptide", "toxic",
}
VALID_AA = set("ACDEFGHIKLMNPQRSTVWY")


def input_guardrail(state: AgentState) -> dict:
    """Validate the task spec before generation starts.

    Returns a partial state update: {"error": str, "status": "failed"} on
    any violation, or {} (no change) when everything checks out — the
    graph's conditional edge routes on whether "error" ended up set.
    """
    errors = []

    activity = state["activity"]
    if activity and activity not in VALID_ACTIVITIES:
        errors.append(f"activity {activity!r} is not one of the 13 valid classes")

    length_min, length_max = state["length_min"], state["length_max"]
    charge_min, charge_max = state["charge_min"], state["charge_max"]
    hydro_min, hydro_max = state["hydro_min"], state["hydro_max"]

    if not (length_min < length_max):
        errors.append(f"length_min ({length_min}) must be < length_max ({length_max})")
    if not (charge_min <= charge_max):
        errors.append(f"charge_min ({charge_min}) must be <= charge_max ({charge_max})")
    if not (hydro_min < hydro_max):
        errors.append(f"hydro_min ({hydro_min}) must be < hydro_max ({hydro_max})")

    if not (length_min >= 1):
        errors.append(f"length_min ({length_min}) must be >= 1")
    if not (length_max <= 200):
        errors.append(f"length_max ({length_max}) must be <= 200")
    if not (charge_min >= -20):
        errors.append(f"charge_min ({charge_min}) must be >= -20")
    if not (charge_max <= 20):
        errors.append(f"charge_max ({charge_max}) must be <= 20")
    if not (hydro_min >= 0):
        errors.append(f"hydro_min ({hydro_min}) must be >= 0")
    if not (hydro_max <= 100):
        errors.append(f"hydro_max ({hydro_max}) must be <= 100")
    if not (0.0 <= state["threshold"] <= 1.0):
        errors.append(f"threshold ({state['threshold']}) must be between 0.0 and 1.0")
    if not (1 <= state["max_retries"] <= 10):
        errors.append(f"max_retries ({state['max_retries']}) must be between 1 and 10")

    if errors:
        return {"error": "; ".join(errors), "status": "failed"}
    return {}


def _violations(sequence: str, state: AgentState) -> list:
    if not sequence:
        return ["sequence is empty"]

    violations = []
    if not all(c in VALID_AA for c in sequence.upper()):
        violations.append("sequence contains invalid amino acid characters")
    if not (state["length_min"] <= len(sequence) <= state["length_max"]):
        violations.append(
            f"sequence length {len(sequence)} outside requested range "
            f"{state['length_min']}-{state['length_max']}"
        )
    if state["reference"] and sequence.upper() == state["reference"].upper():
        violations.append("sequence is identical to the reference (no copying)")
    if any(
        sequence.upper() == ex.get("sequence", "").upper() for ex in state["rag_examples"]
    ):
        violations.append("sequence is identical to a RAG example (no copying)")
    return violations


def output_guardrail(state: AgentState) -> dict:
    """Validate the final sequence before returning it to the user.

    Resolves current_sequence to the best candidate that passes every check
    — best_passing first, then best_overall, then the raw current_sequence
    — since nothing upstream otherwise guarantees the *last* edit lap was
    actually the *best* one found. Falls back to a non-empty candidate even
    with violations rather than ever returning an empty sequence.
    """
    candidates = []
    if state["best_passing"]:
        candidates.append(("best_passing", state["best_passing"].sequence))
    if state["best_overall"]:
        candidates.append(("best_overall", state["best_overall"].sequence))
    if state["current_sequence"]:
        candidates.append(("current_sequence", state["current_sequence"]))

    for source, seq in candidates:
        if not _violations(seq, state):
            status = "complete" if source == "best_passing" else state["status"]
            return {"current_sequence": seq, "status": status}

    for _source, seq in candidates:
        if seq:
            return {
                "current_sequence": seq,
                "status": "failed",
                "error": "; ".join(_violations(seq, state)),
            }

    placeholder = "A" * max(state["length_min"], 1)
    return {
        "current_sequence": placeholder,
        "status": "failed",
        "error": "no sequence was ever generated — synthetic placeholder",
    }
