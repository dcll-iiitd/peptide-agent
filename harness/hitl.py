"""
Human-in-the-loop interrupt (researcher approval on a passing candidate).

LangGraph's interrupt() pauses graph execution mid-node and surfaces a
value to the caller; app.invoke() returns normally with a "__interrupt__"
key rather than raising. Resuming requires a *second* app.invoke() call —
Command(resume=decision) — against the same thread_id, since the paused
state only exists via the checkpointer. See .claude/plan/week4.md Task 1.

Important LangGraph semantics this module relies on: when a node calls
interrupt() and is later resumed, the node re-executes from the top (not
from the interrupt() call onward) — safe here because everything in
track_best_node before its interrupt() call is a pure function of `state`,
which is unchanged across the pause, so re-running it is idempotent.
"""

from dataclasses import asdict

from langgraph.types import Command, interrupt

VALID_ACTIONS = {"accept", "reject", "modify", "skip"}


def request_approval(best_passing, iteration: int) -> dict:
    """Pause the graph and surface the passing candidate to a researcher.

    Returns the resume value — a dict with at least {"action": ...}, plus
    {"sequence": ...} when action == "modify".
    """
    payload = {
        "sequence": best_passing.sequence,
        "score": best_passing.bleu_score,
        "rulebook": asdict(best_passing.rulebook) if best_passing.rulebook else None,
        "iteration": iteration,
        "message": "Passing candidate found. Accept, reject, modify, or skip?",
    }
    decision = interrupt(payload)
    if not isinstance(decision, dict) or decision.get("action") not in VALID_ACTIONS:
        # Malformed resume value — fail safe by accepting the candidate
        # as-is rather than leaving the loop in an undefined state.
        return {"action": "accept"}
    return decision


def apply_decision(decision: dict, state) -> dict:
    """Translate a researcher's decision into a track_best_node state update.

    accept -> stop, return this candidate as the final result
    reject -> keep editing (don't stop early)
    modify -> use the researcher's own sequence, re-score it directly
              (routed straight back to score_node, not through edit_node —
              the researcher already produced the edit, it shouldn't be
              edited again before being scored)
    skip   -> keep best-so-far as recorded, continue to the next iteration
              (functionally identical to reject here — best_passing/
              best_overall were already resolved before this decision runs)
    """
    action = decision.get("action", "accept")

    if action == "modify":
        return {
            "early_stop": False,
            "current_sequence": decision.get("sequence", state["current_sequence"]),
            "hitl_modified": True,
        }
    if action in ("reject", "skip"):
        return {"early_stop": False}
    return {"early_stop": True}


def resume_with_decision(app, config: dict, decision: dict) -> dict:
    """Resume a paused graph with a researcher's decision."""
    return app.invoke(Command(resume=decision), config=config)


def run_with_hitl(app, initial_state, config: dict, decision_fn) -> dict:
    """Drive a HITL-enabled graph to completion.

    decision_fn(interrupt_value: dict) -> dict is called every time the
    graph pauses for approval; its return value resumes execution. Loops
    until the graph finishes with no "__interrupt__" key in the result.
    """
    result = app.invoke(initial_state, config=config)
    while "__interrupt__" in result:
        interrupt_value = result["__interrupt__"][0].value
        decision = decision_fn(interrupt_value)
        result = resume_with_decision(app, config, decision)
    return result
