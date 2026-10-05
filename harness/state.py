"""
AgentState schema shared across all LangGraph nodes.

See .claude/plan/state_schema.md for the field-by-field spec.
"""

from dataclasses import dataclass, field
from typing import Annotated, Optional, TypedDict

from langgraph.graph.message import add_messages


@dataclass
class PeptideDescriptors:
    sequence: str
    length: int
    net_charge: int
    hydro_pct: float
    gravy: float
    aromaticity: float
    mol_weight: float
    charge_class: str
    length_class: str


@dataclass
class DiagnosticResult:
    passed: bool
    violations: list
    fitness: float
    n_violations: int


@dataclass
class EditOperation:
    operation: str
    position: int
    from_aa: str
    to_aa: str
    reason: str
    component: str


@dataclass
class CandidateResult:
    sequence: str
    descriptors: Optional[PeptideDescriptors]
    bleu_score: float
    rulebook: Optional[DiagnosticResult]
    plddt: Optional[float]
    helix_pct: Optional[float]
    novelty: Optional[float]
    closest_match: Optional[str]
    iteration: int
    edit_op: Optional[EditOperation]


class AgentState(TypedDict):
    # Task specification
    activity: str
    length_min: int
    length_max: int
    charge_min: int
    charge_max: int
    hydro_min: float
    hydro_max: float
    threshold: float
    max_retries: int

    # Generation state
    iteration: int
    current_sequence: str
    current_score: float
    current_components: dict  # PeptideBLEU per-component breakdown (Week 3 edit_operator_tool needs this)
    current_descriptors: Optional[PeptideDescriptors]
    current_diagnostic: Optional[DiagnosticResult]

    # RAG context
    rag_examples: list
    reference: str
    reference_source: str

    # Candidates
    candidates: list
    best_passing: Optional[CandidateResult]
    best_overall: Optional[CandidateResult]

    # Edit tracking
    last_edit_op: Optional[EditOperation]
    edit_history: list
    consecutive_stuck: int
    # set[int] would need custom merge handling in LangGraph state
    # updates — using list[int] instead per state_schema.md's
    # implementation note.
    changed_positions: list
    # {operation_type: {count, improvements, avg_delta}} — which edit
    # operations actually improve the score (Week 3 task 5).
    edit_stats: dict
    # current_score as of the previous lap, so track_best_node can compute
    # this lap's score delta for edit_stats.
    prev_score: float

    # Post-hoc
    plddt_score: Optional[float]
    helix_pct: Optional[float]
    novelty_score: Optional[float]
    closest_match: Optional[str]
    # Frontend redesign Phase 2 decision 2 — close the harness/legacy
    # Structure+Novelty field gap documented in frontend/AUDIT.md Q17-19.
    # novelty_label stays None for now (see sse_bridge.py note): wiring
    # blast_novelty_tool into the graph is a larger architectural change,
    # out of scope here.
    pdb_string: Optional[str]
    plddt_confidence: Optional[str]
    sheet_pct: Optional[float]
    coil_pct: Optional[float]
    novelty_label: Optional[str]

    # Control flow
    early_stop: bool
    error: Optional[str]
    status: str
    # pending -> generating -> scoring -> validating
    # -> deciding -> editing -> complete -> failed

    # Human-in-the-loop (Week 4 task 1) — default False, opt-in only.
    hitl_enabled: bool
    # Transient one-lap flag: a researcher's "modify" decision routes
    # straight back to score_node instead of edit_node, then resets.
    hitl_modified: bool

    # Messages (for slash commands, Week 3)
    messages: Annotated[list, add_messages]


def create_initial_state(**overrides) -> AgentState:
    """Build an AgentState dict populated with defaults, overridden by kwargs.

    TypedDict has no runtime defaults, so callers use this factory instead
    of instantiating AgentState() directly.
    """
    state: AgentState = {
        "activity": "",
        "length_min": 10,
        "length_max": 50,
        "charge_min": 2,
        "charge_max": 5,
        "hydro_min": 30.0,
        "hydro_max": 50.0,
        "threshold": 0.35,
        "max_retries": 6,
        "iteration": 0,
        "current_sequence": "",
        "current_score": 0.0,
        "current_components": {},
        "current_descriptors": None,
        "current_diagnostic": None,
        "rag_examples": [],
        "reference": "",
        "reference_source": "",
        "candidates": [],
        "best_passing": None,
        "best_overall": None,
        "last_edit_op": None,
        "edit_history": [],
        "consecutive_stuck": 0,
        "changed_positions": [],
        "edit_stats": {},
        "prev_score": 0.0,
        "plddt_score": None,
        "helix_pct": None,
        "novelty_score": None,
        "closest_match": None,
        "pdb_string": None,
        "plddt_confidence": None,
        "sheet_pct": None,
        "coil_pct": None,
        "novelty_label": None,
        "early_stop": False,
        "error": None,
        "status": "pending",
        "hitl_enabled": False,
        "hitl_modified": False,
        "messages": [],
    }
    state.update(overrides)
    return state
