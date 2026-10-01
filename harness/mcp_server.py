"""
MCP server exposing PepForge harness capabilities as tools, per
.claude/plan/week4.md Task 2 — so any MCP client (Claude Desktop/Code, a
custom UI) can drive generation/scoring/editing without going through the
SSE endpoint or slash commands.

Every tool here is a thin adapter over existing harness code (harness/graph.py's
run_pepforge, harness/commands.py's slash-command handlers, harness/tools.py's
@tool wrappers) — no scoring/generation/editing logic is duplicated, matching
.claude/harness.md's "harness wraps existing code" rule. Backend/harness
imports are lazy (inside each tool body) for the same reason as tools.py:
keep module import light until a tool is actually invoked.

Run with:
    python -m harness.mcp_server
"""

import uuid
from dataclasses import asdict
from typing import Optional

from dotenv import load_dotenv
from fastmcp import FastMCP

# Unlike test_week*.py (run under pytest, which never loads .env on its own)
# this module is launched standalone (`python -m harness.mcp_server`), so it
# must load .env itself the same way backend/server.py does — otherwise every
# tool that reaches backend/models.py's LLM client fails with "GATEWAY_URL
# environment variable is not set".
load_dotenv(override=True)

mcp = FastMCP("PepForge")


def _candidate_to_dict(candidate) -> Optional[dict]:
    """CandidateResult (and its nested PeptideDescriptors/DiagnosticResult/
    EditOperation dataclasses) -> plain JSON-safe dict, or None."""
    return asdict(candidate) if candidate is not None else None


@mcp.tool()
def generate_peptide(
    activity: str = "",
    length_min: int = 10,
    length_max: int = 50,
    charge_min: int = 2,
    charge_max: int = 5,
    hydro_min: float = 30.0,
    hydro_max: float = 50.0,
    threshold: float = 0.35,
    max_retries: int = 6,
    thread_id: Optional[str] = None,
) -> dict:
    """Run the full PepForge agentic generation loop (generate -> validate ->
    score -> edit, repeated up to max_retries times) for a peptide task.

    activity: one of the 13 valid activity classes (see input_guardrail),
    e.g. "anti-bacterial", "drug-delivery", "signal-peptide". Empty string
    is allowed (no activity-specific PeptideBLEU preset/reference).

    Returns the final sequence/score/status plus the best passing and best
    overall candidates found. thread_id is echoed back so a caller can pass
    it to get_history() to retrieve this run later.
    """
    from harness.graph import run_pepforge

    thread_id = thread_id or str(uuid.uuid4())
    final_state = run_pepforge(
        thread_id=thread_id,
        activity=activity,
        length_min=length_min,
        length_max=length_max,
        charge_min=charge_min,
        charge_max=charge_max,
        hydro_min=hydro_min,
        hydro_max=hydro_max,
        threshold=threshold,
        max_retries=max_retries,
    )

    return {
        "thread_id": thread_id,
        "sequence": final_state.get("current_sequence", ""),
        "score": final_state.get("current_score", 0.0),
        "status": final_state.get("status", "unknown"),
        "iteration": final_state.get("iteration", 0),
        "best_passing": _candidate_to_dict(final_state.get("best_passing")),
        "best_overall": _candidate_to_dict(final_state.get("best_overall")),
        "plddt_score": final_state.get("plddt_score"),
        "helix_pct": final_state.get("helix_pct"),
    }


@mcp.tool()
def score_peptide(sequence: str, reference: str = "", activity: Optional[str] = None) -> dict:
    """Score a peptide sequence: PeptideBLEU (if reference given), physicochemical
    descriptors (length/charge/hydro%/gravy/aromaticity/mol_weight), and
    rulebook validity.
    """
    from harness.commands import handle_score

    args = [sequence]
    if reference:
        args += ["--ref", reference]
    if activity:
        args += ["--activity", activity]
    return handle_score(args)


@mcp.tool()
def edit_peptide(sequence: str, fix: str) -> dict:
    """Apply one structured edit to a sequence targeting a specific weak
    component. fix must be one of: charge, hydro, length, ngram.
    """
    from harness.commands import handle_edit

    return handle_edit([sequence, "--fix", fix])


@mcp.tool()
def explain_peptide(sequence: str) -> dict:
    """Get a plain-English explanation of a peptide's properties and whether
    it passes rulebook validation.
    """
    from harness.commands import handle_explain

    return handle_explain([sequence])


@mcp.tool()
def compare_peptides(sequence_1: str, sequence_2: str, reference: str = "") -> dict:
    """Side-by-side comparison of two sequences' descriptors and (if a
    reference is given) PeptideBLEU scores.
    """
    from harness.commands import handle_compare

    args = [sequence_1, sequence_2]
    if reference:
        args += ["--ref", reference]
    return handle_compare(args)


@mcp.tool()
def novelty_check(sequence: str) -> dict:
    """Assess how novel a sequence is against the known-peptide database
    (BLAST similarity, falling back to a FAISS property-space nearest
    neighbor if BLAST isn't available). Low similarity = more novel.
    """
    from harness.tools import novelty_tool

    return novelty_tool.invoke({"sequence": sequence})


@mcp.tool()
def get_history(thread_id: str, n: int = 5) -> dict:
    """Return the last n completed generation results for a given thread_id
    (the same thread_id returned by generate_peptide), from SQLite-backed
    session memory.
    """
    from harness.commands import handle_history

    return {"results": handle_history(thread_id, n)}


if __name__ == "__main__":
    mcp.run()
