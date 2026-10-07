"""
LangGraph StateGraph definition wiring the harness nodes together.

7 nodes, per .claude/plan/week1.md Task 6:

    START -> rag -> generate -> score -> validate -> track -> (edit | post_hoc)
                                            ^                    |
                                            |____ edit __________|
                                                                  v
                                                              post_hoc -> END

Each node is a plain function(state) -> partial-state-dict, the standard
LangGraph node contract. All backend/harness tool calls are made through
harness/tools.py's @tool wrappers (or, where the wrapped functionality is a
pure/stateless helper like extract_sequence/deterministic_edit, imported
directly) — never duplicated here.
"""

import uuid

from langgraph.graph import END, START, StateGraph

from harness.guardrails import input_guardrail, output_guardrail
from harness.memory import get_checkpointer
from harness.state import AgentState, CandidateResult, EditOperation, create_initial_state
from harness.tools import (
    descriptor_tool,
    diagnostic_tool,
    dssp_tool,
    edit_operator_tool,
    esmfold_tool,
    novelty_tool,
    peptide_bleu_tool,
    rag_retrieval_tool,
    reference_selector_tool,
)


def _build_task(state: AgentState) -> dict:
    """Task dict in the shape backend/prompt_builder.py and backend/rulebook.py expect."""
    length_min = state["length_min"]
    length_max = state["length_max"]
    return {
        "activities": [state["activity"]] if state["activity"] else [],
        "length": (length_min + length_max) // 2,
        "length_min": length_min,
        "length_max": length_max,
        "charge_min": state["charge_min"],
        "charge_max": state["charge_max"],
        "hydro_min": state["hydro_min"],
        "hydro_max": state["hydro_max"],
    }


def _preset(state: AgentState) -> str | None:
    from backend.agent import ACTIVITY_PRESET_MAP

    return ACTIVITY_PRESET_MAP.get(state["activity"])


def rag_node(state: AgentState) -> dict:
    task = _build_task(state)
    rag_result = rag_retrieval_tool.invoke({"task": task, "top_k": 5})
    rag_examples = rag_result.get("examples", [])

    preset = _preset(state)
    reference = ""
    if preset:
        ref_result = reference_selector_tool.invoke(
            {
                "preset": preset,
                "target_length": task["length"],
                "target_charge": (state["charge_min"] + state["charge_max"]) / 2.0,
                "target_hydro_pct": (state["hydro_min"] + state["hydro_max"]) / 2.0,
                "length_min": state["length_min"],
                "length_max": state["length_max"],
            }
        )
        reference = ref_result.get("reference", "") or ""

    return {
        "rag_examples": rag_examples,
        "reference": reference,
        "reference_source": f"auto:{preset}" if reference else "",
        "status": "generating",
    }


def generate_node(state: AgentState) -> dict:
    from backend import models
    from backend.agent import PepForgeAgent
    from backend.prompt_builder import build_prompt, get_system_prompt

    task = _build_task(state)
    target_length = task["length"]

    prompt = build_prompt(task, [], state["rag_examples"], state["reference"])
    gen_max_tokens = (
        max(600, target_length + 400)
        if models.is_reasoning_model()
        else target_length + 5
    )

    raw = models.generate(
        prompt,
        max_tokens=gen_max_tokens,
        system=get_system_prompt(),
    )

    sequence = PepForgeAgent().extract_sequence(raw, target_length)
    if sequence and target_length:
        sequence = sequence[:target_length]

    return {
        "current_sequence": sequence,
        "status": "scoring",
    }


def score_node(state: AgentState) -> dict:
    preset = _preset(state)
    result = peptide_bleu_tool.invoke(
        {
            "reference": state["reference"],
            "sequence": state["current_sequence"],
            "activity": preset,
        }
    )
    descriptors_dict = descriptor_tool.invoke({"sequence": state["current_sequence"]})

    from harness.state import PeptideDescriptors

    descriptors = None
    if "error" not in descriptors_dict:
        descriptors = PeptideDescriptors(**descriptors_dict)

    return {
        "current_score": result.get("score", 0.0),
        "current_components": result.get("components", {}),
        "current_descriptors": descriptors,
        "status": "validating",
    }


def validate_node(state: AgentState) -> dict:
    from harness.state import DiagnosticResult

    task = _build_task(state)
    result = diagnostic_tool.invoke({"sequence": state["current_sequence"], "task": task})

    if "error" in result:
        # diagnostic_tool never raises, but a genuinely broken sequence
        # (e.g. empty extraction) can still surface here — fail closed
        # rather than let a malformed dict propagate into track_best_node.
        diagnostic = DiagnosticResult(passed=False, violations=[], fitness=0.0, n_violations=0)
    else:
        diagnostic = DiagnosticResult(
            passed=result["passed"],
            violations=result["violations"],
            fitness=result["fitness"],
            n_violations=result["n_violations"],
        )

    return {"current_diagnostic": diagnostic, "status": "deciding"}


def track_best_node(state: AgentState) -> dict:
    # track runs once per lap regardless of whether the lap came from
    # generate or edit (edit loops back to score, not generate) — so the
    # attempt counter used by route_after_track's max_retries cap has to
    # live here, not in generate_node, or it would freeze at 1 forever and
    # the cap would never engage.
    iteration = state["iteration"] + 1

    candidate = CandidateResult(
        sequence=state["current_sequence"],
        descriptors=state["current_descriptors"],
        bleu_score=state["current_score"],
        rulebook=state["current_diagnostic"],
        plddt=None,
        helix_pct=None,
        novelty=None,
        closest_match=None,
        iteration=iteration,
        edit_op=state["last_edit_op"],
    )
    candidates = state["candidates"] + [candidate]

    prev_best_overall = state["best_overall"]
    if prev_best_overall is not None and candidate.bleu_score <= prev_best_overall.bleu_score:
        consecutive_stuck = state["consecutive_stuck"] + 1
    else:
        consecutive_stuck = 0

    best_overall = prev_best_overall
    if best_overall is None or candidate.bleu_score > best_overall.bleu_score:
        best_overall = candidate

    diagnostic = state["current_diagnostic"]
    passed = bool(diagnostic and diagnostic.passed) and candidate.bleu_score >= state["threshold"]
    best_passing = state["best_passing"]
    if passed and (best_passing is None or candidate.bleu_score > best_passing.bleu_score):
        best_passing = candidate

    # Which edit operation types actually move the score — only meaningful
    # once an edit has happened (iteration 1's initial generate has no
    # last_edit_op). New dict objects throughout rather than mutating
    # state["edit_stats"] in place, since LangGraph node returns are deltas,
    # not in-place state mutations.
    edit_stats = {k: dict(v) for k, v in state["edit_stats"].items()}
    last_edit_op = state["last_edit_op"]
    if last_edit_op:
        op_type = last_edit_op.operation
        delta = candidate.bleu_score - state["prev_score"]
        stats = dict(edit_stats.get(op_type, {"count": 0, "improvements": 0, "avg_delta": 0.0}))
        stats["count"] += 1
        if delta > 0:
            stats["improvements"] += 1
        stats["avg_delta"] = (stats["avg_delta"] * (stats["count"] - 1) + delta) / stats["count"]
        edit_stats[op_type] = stats

    result = {
        "candidates": candidates,
        "iteration": iteration,
        "best_overall": best_overall,
        "best_passing": best_passing,
        "consecutive_stuck": consecutive_stuck,
        "edit_stats": edit_stats,
        "prev_score": candidate.bleu_score,
        # Only genuine success (a passing candidate) sets early_stop here —
        # the iteration>=max_retries cap is enforced separately by
        # route_after_track, not folded into this flag.
        "early_stop": best_passing is not None,
        "hitl_modified": False,
        "status": "deciding",
    }

    if state["hitl_enabled"] and best_passing is not None:
        from harness.hitl import apply_decision, request_approval

        decision = request_approval(best_passing, iteration)
        result.update(apply_decision(decision, state))

    return result


def _edit_valid_aa(sequence: str, v: dict):
    positions = v.get("positions") or []
    if not positions:
        return None
    pos = positions[0]
    from_aa = sequence[pos - 1]
    to_aa = "A"
    new_seq = sequence[: pos - 1] + to_aa + sequence[pos:]
    op = EditOperation(
        operation="substitute", position=pos, from_aa=from_aa, to_aa=to_aa,
        reason=v["fix"], component="valid_aa",
    )
    return new_seq, op


def _edit_length(sequence: str, v: dict):
    try:
        lo, hi = (int(x) for x in v["target"].split("-"))
    except (ValueError, KeyError):
        return None
    current = v["current"]
    if current < lo:
        # Close the whole deficit in one edit, not one residue per lap — the
        # fix hint already gives the exact count needed, and unlike charge/
        # hydro (continuous, risk of overshoot) length is a hard discrete
        # constraint with no benefit to spreading the fix across iterations.
        # A degenerate 4-char extraction against a 15-25 target would
        # otherwise need 11 separate edit laps to ever reach a valid length.
        deficit = lo - current
        padding = "A" * deficit
        new_seq = sequence + padding
        op = EditOperation(
            operation="insert", position=len(sequence) + 1, from_aa="", to_aa=padding,
            reason=v["fix"], component="length",
        )
    elif current > hi:
        excess_len = current - hi
        removed = sequence[-excess_len:]
        new_seq = sequence[:-excess_len]
        op = EditOperation(
            operation="delete", position=len(sequence) - excess_len + 1, from_aa=removed, to_aa="",
            reason=v["fix"], component="length",
        )
    else:
        return None
    return new_seq, op


def _edit_net_charge(sequence: str, v: dict):
    positions = v.get("positions") or []

    if v["excess"] > 0:
        # Too high: neutralize a K/R. No fallback if none are present —
        # that would mean the charge is already <= target, contradicting
        # excess > 0, so positions is never empty on this branch.
        if not positions:
            return None
        pos = positions[0]
        from_aa = sequence[pos - 1]
        to_aa = "Q"
        new_seq = sequence[: pos - 1] + to_aa + sequence[pos:]
        op = EditOperation(
            operation="substitute", position=pos, from_aa=from_aa, to_aa=to_aa,
            reason=v["fix"], component="net_charge",
        )
        return new_seq, op

    # Too low: prefer converting an existing D/E straight to K (a +2 swing,
    # cheaper than inserting). If there are no D/E to convert, insert a new
    # K instead — without this, a sequence with no negative residues could
    # never fix a too-low charge violation and would stay stuck forever.
    if positions:
        pos = positions[0]
        from_aa = sequence[pos - 1]
        to_aa = "K"
        new_seq = sequence[: pos - 1] + to_aa + sequence[pos:]
        op = EditOperation(
            operation="substitute", position=pos, from_aa=from_aa, to_aa=to_aa,
            reason=v["fix"], component="net_charge",
        )
    else:
        to_aa = "K"
        new_seq = sequence + to_aa
        op = EditOperation(
            operation="insert", position=len(sequence) + 1, from_aa="", to_aa=to_aa,
            reason=v["fix"], component="net_charge",
        )
    return new_seq, op


def _edit_hydrophobicity(sequence: str, v: dict):
    positions = v.get("positions") or []
    if not positions:
        return None
    pos = positions[0]
    from_aa = sequence[pos - 1]
    to_aa = "S" if v["excess"] > 0 else "L"
    new_seq = sequence[: pos - 1] + to_aa + sequence[pos:]
    op = EditOperation(
        operation="substitute", position=pos, from_aa=from_aa, to_aa=to_aa,
        reason=v["fix"], component="hydrophobicity",
    )
    return new_seq, op


def _edit_poly_proline(sequence: str, v: dict):
    positions = v.get("positions") or []
    if not positions:
        return None
    start = positions[0]
    run_len = v["current"]
    mid = start + run_len // 2
    if not (1 <= mid <= len(sequence)):
        return None
    from_aa = sequence[mid - 1]
    to_aa = "G"
    new_seq = sequence[: mid - 1] + to_aa + sequence[mid:]
    op = EditOperation(
        operation="substitute", position=mid, from_aa=from_aa, to_aa=to_aa,
        reason=v["fix"], component="poly_proline",
    )
    return new_seq, op


def _edit_cysteine_parity(sequence: str, v: dict):
    positions = v.get("positions") or []
    if not positions:
        return None
    pos = positions[-1]
    from_aa = sequence[pos - 1]
    to_aa = "A"
    new_seq = sequence[: pos - 1] + to_aa + sequence[pos:]
    op = EditOperation(
        operation="substitute", position=pos, from_aa=from_aa, to_aa=to_aa,
        reason=v["fix"], component="cysteine_parity",
    )
    return new_seq, op


_VIOLATION_HANDLERS = {
    "valid_aa": _edit_valid_aa,
    "length": _edit_length,
    "net_charge": _edit_net_charge,
    "hydrophobicity": _edit_hydrophobicity,
    "poly_proline": _edit_poly_proline,
    "cysteine_parity": _edit_cysteine_parity,
}


def _apply_targeted_edit(sequence: str, diagnostic, task: dict):
    """Apply one single-residue edit targeting the first violation with a
    usable positional handler (activity_specific:* violations have no
    positions of their own and fall through to the generic fallback below).
    """
    for v in diagnostic.violations:
        rule = v["rule"].split(":")[0]
        handler = _VIOLATION_HANDLERS.get(rule)
        if handler:
            result = handler(sequence, v)
            if result:
                return result

    from backend.tools.sequence_editor import deterministic_edit

    edited = deterministic_edit(sequence, task)
    op = EditOperation(
        operation="deterministic_edit", position=0, from_aa="", to_aa="",
        reason="no targetable violation — generic length/charge/hydro fix",
        component="rulebook",
    )
    return (edited if edited else sequence), op


def _fallback_positional_edit(state: AgentState, task: dict, diagnostic):
    """Week 2's deterministic positional editor. Used when edit_operator_tool's
    LLM call fails, returns unparseable output, or gets rejected by
    apply_edit()'s validation — so a flaky LLM never stalls the loop.
    """
    if diagnostic and diagnostic.violations:
        return _apply_targeted_edit(state["current_sequence"], diagnostic, task)

    from backend.tools.sequence_editor import deterministic_edit

    edited = deterministic_edit(state["current_sequence"], task)
    edit_op = EditOperation(
        operation="deterministic_edit", position=0, from_aa="", to_aa="",
        reason="no violations recorded — generic length/charge/hydro fix",
        component="rulebook",
    )
    return (edited if edited else state["current_sequence"]), edit_op


def edit_node(state: AgentState) -> dict:
    task = _build_task(state)
    diagnostic = state["current_diagnostic"]
    violations = diagnostic.violations if diagnostic else []

    result = edit_operator_tool.invoke(
        {
            "sequence": state["current_sequence"],
            "task": task,
            "scores": state["current_components"],
            "violations": violations,
            "edit_history": state["edit_history"],
            "changed_positions": state["changed_positions"],
        }
    )

    if result.get("valid") and result.get("operation"):
        edited = result["new_sequence"]
        edit_op = EditOperation(**result["operation"])
    else:
        edited, edit_op = _fallback_positional_edit(state, task, diagnostic)

    changed_positions = state["changed_positions"]
    if edit_op.position:
        changed_positions = changed_positions + [edit_op.position]

    return {
        "current_sequence": edited if edited else state["current_sequence"],
        "last_edit_op": edit_op,
        "edit_history": state["edit_history"] + [edit_op],
        "changed_positions": changed_positions,
        "status": "editing",
    }


def post_hoc_node(state: AgentState) -> dict:
    best = state["best_passing"] or state["best_overall"]
    sequence = best.sequence if best else state["current_sequence"]

    plddt_result = esmfold_tool.invoke({"sequence": sequence})
    plddt_score = plddt_result.get("mean_plddt")

    helix_pct = None
    sheet_pct = None
    coil_pct = None
    ss_string = None
    pdb = plddt_result.get("pdb")
    if pdb:
        dssp_result = dssp_tool.invoke({"pdb_string": pdb})
        helix_pct = dssp_result.get("helix_pct")
        sheet_pct = dssp_result.get("sheet_pct")
        coil_pct = dssp_result.get("coil_pct")
        # Decision 8 (frontend_phase2_decisions.md) — verified dssp_tool
        # actually returns this (backend/dssp_scorer.py's
        # _compute_ss_percentages() spreads it into the result dict) before
        # adding it here, per that decision's explicit verify-first step.
        ss_string = dssp_result.get("ss_string")

    status = "complete" if (state["best_passing"] is not None) else "failed"

    # Phase 8c (frontend_phase8c_novelty.md) — novelty_tool wraps
    # harness/novelty.py's assess_novelty_detailed(): BLAST against the
    # local 105K DB, falling back to a FAISS property-space nearest
    # neighbor if BLAST isn't installed. Never raises (catches internally,
    # same as esmfold_tool/dssp_tool above) — a failure just yields an
    # {"error": ...} dict, and every .get() below degrades to None.
    novelty_result = novelty_tool.invoke({"sequence": sequence})
    novelty_score = novelty_result.get("similarity")
    closest_match = novelty_result.get("closest_match") or None
    novelty_label = novelty_result.get("novelty_label")
    novelty_source = novelty_result.get("source")

    return {
        "plddt_score": plddt_score,
        "helix_pct": helix_pct,
        "sheet_pct": sheet_pct,
        "coil_pct": coil_pct,
        "ss_string": ss_string,
        # esmfold_tool's actual keys are "pdb"/"confidence" (verified against
        # backend/esmfold_scorer.py's get_plddt() return dict directly) — not
        # "pdb_string"/"confidence_label" as frontend_phase2_decisions.md's
        # sketch named them. Stored here under the new state field names the
        # plan specifies; only the *source* keys read from plddt_result
        # needed correcting.
        "pdb_string": pdb,
        "plddt_confidence": plddt_result.get("confidence"),
        "novelty_score": novelty_score,
        "closest_match": closest_match,
        "novelty_label": novelty_label,
        "novelty_source": novelty_source,
        "status": status,
    }


def route_after_track(state: AgentState) -> str:
    # A researcher's "modify" decision (HITL) provides an already-edited
    # sequence — route straight back to score_node, not through edit_node,
    # since it shouldn't be edited again before being scored.
    if state["hitl_modified"]:
        return "score"
    if state["early_stop"] or state["iteration"] >= state["max_retries"]:
        return "post_hoc"
    return "edit"


def route_after_input_guardrail(state: AgentState) -> str:
    # Fail fast on a malformed task spec — don't waste an LLM call.
    return "end" if state["error"] else "rag"


def build_graph():
    graph = StateGraph(AgentState)

    graph.add_node("input_guardrail", input_guardrail)
    graph.add_node("rag", rag_node)
    graph.add_node("generate", generate_node)
    graph.add_node("score", score_node)
    graph.add_node("validate", validate_node)
    graph.add_node("track", track_best_node)
    graph.add_node("edit", edit_node)
    graph.add_node("post_hoc", post_hoc_node)
    graph.add_node("output_guardrail", output_guardrail)

    graph.add_edge(START, "input_guardrail")
    graph.add_conditional_edges(
        "input_guardrail", route_after_input_guardrail, {"rag": "rag", "end": END}
    )
    graph.add_edge("rag", "generate")
    graph.add_edge("generate", "score")
    graph.add_edge("score", "validate")
    graph.add_edge("validate", "track")
    graph.add_conditional_edges(
        "track", route_after_track, {"post_hoc": "post_hoc", "edit": "edit", "score": "score"}
    )
    graph.add_edge("edit", "score")
    graph.add_edge("post_hoc", "output_guardrail")
    graph.add_edge("output_guardrail", END)

    return graph.compile(checkpointer=get_checkpointer())


def run_pepforge(thread_id: str | None = None, **task_overrides) -> dict:
    """Run one full peptide generation task end-to-end. Returns the final state."""
    app = build_graph()
    initial_state = create_initial_state(**task_overrides)
    config = {"configurable": {"thread_id": thread_id or str(uuid.uuid4())}}
    return app.invoke(initial_state, config=config)
