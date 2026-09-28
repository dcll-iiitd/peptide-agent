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

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from harness.state import AgentState, CandidateResult, EditOperation, create_initial_state
from harness.tools import (
    descriptor_tool,
    diagnostic_tool,
    dssp_tool,
    esmfold_tool,
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

    return {
        "candidates": candidates,
        "iteration": iteration,
        "best_overall": best_overall,
        "best_passing": best_passing,
        "consecutive_stuck": consecutive_stuck,
        # Only genuine success (a passing candidate) sets early_stop here —
        # the iteration>=max_retries cap is enforced separately by
        # route_after_track, not folded into this flag.
        "early_stop": best_passing is not None,
        "status": "deciding",
    }


def edit_node(state: AgentState) -> dict:
    from backend.tools.sequence_editor import deterministic_edit

    task = _build_task(state)
    edited = deterministic_edit(state["current_sequence"], task)

    edit_op = EditOperation(
        operation="deterministic_edit",
        position=0,
        from_aa="",
        to_aa="",
        # deterministic_edit fixes length/charge/hydro over the whole
        # sequence in one pass rather than a single named residue swap —
        # Week 3's edit_operator_menu replaces this with real
        # {operation, position, from, to} structured edits.
        reason="length/charge/hydrophobicity fix",
        component="rulebook",
    )

    return {
        "current_sequence": edited if edited else state["current_sequence"],
        "last_edit_op": edit_op,
        "edit_history": state["edit_history"] + [edit_op],
        "status": "editing",
    }


def post_hoc_node(state: AgentState) -> dict:
    best = state["best_passing"] or state["best_overall"]
    sequence = best.sequence if best else state["current_sequence"]

    plddt_result = esmfold_tool.invoke({"sequence": sequence})
    plddt_score = plddt_result.get("mean_plddt")

    helix_pct = None
    pdb = plddt_result.get("pdb")
    if pdb:
        dssp_result = dssp_tool.invoke({"pdb_string": pdb})
        helix_pct = dssp_result.get("helix_pct")

    status = "complete" if (state["best_passing"] is not None) else "failed"

    return {
        "plddt_score": plddt_score,
        "helix_pct": helix_pct,
        # blast_scorer.assess_novelty() has no closest_match field — leaving
        # novelty_score/closest_match as None/None here rather than the
        # tools_spec.md draft's (stale) claim that one exists. Week 2's
        # novelty.py component is where this gets built out properly.
        "novelty_score": None,
        "closest_match": None,
        "status": status,
    }


def route_after_track(state: AgentState) -> str:
    if state["early_stop"] or state["iteration"] >= state["max_retries"]:
        return "post_hoc"
    return "edit"


def build_graph():
    graph = StateGraph(AgentState)

    graph.add_node("rag", rag_node)
    graph.add_node("generate", generate_node)
    graph.add_node("score", score_node)
    graph.add_node("validate", validate_node)
    graph.add_node("track", track_best_node)
    graph.add_node("edit", edit_node)
    graph.add_node("post_hoc", post_hoc_node)

    graph.add_edge(START, "rag")
    graph.add_edge("rag", "generate")
    graph.add_edge("generate", "score")
    graph.add_edge("score", "validate")
    graph.add_edge("validate", "track")
    graph.add_conditional_edges(
        "track", route_after_track, {"post_hoc": "post_hoc", "edit": "edit"}
    )
    graph.add_edge("edit", "score")
    graph.add_edge("post_hoc", END)

    return graph.compile(checkpointer=MemorySaver())


def run_pepforge(thread_id: str | None = None, **task_overrides) -> dict:
    """Run one full peptide generation task end-to-end. Returns the final state."""
    app = build_graph()
    initial_state = create_initial_state(**task_overrides)
    config = {"configurable": {"thread_id": thread_id or str(uuid.uuid4())}}
    return app.invoke(initial_state, config=config)
