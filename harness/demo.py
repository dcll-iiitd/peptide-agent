"""
Automated demo walkthrough for Dr. Bapi (Week 4 task 5).

Run with: python harness/demo.py

Exercises every harness capability built across Weeks 1-4, end-to-end
against the real LLM gateway (reads .env) — no mocks, same practice as
every other verification script in this package (test_week1.py..
test_week4.py). Can run entirely headless (this script alone) or alongside
the frontend (python -m http.server 8080 --directory frontend, with "Use
LangGraph Harness" checked) to show the same generation visually at the
same time.

Each step is wrapped so a single flaky LLM/tunnel call (a known, recurring
issue with this deployment — see .claude/CLAUDE.md's failure-modes table)
prints a [SKIPPED] line and the demo moves on, rather than crashing
mid-presentation.
"""

import os
import sys

# Allow `python harness/demo.py` to find the `harness` package — running the
# file directly puts harness/ itself on sys.path, not its parent.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv(override=True)

_TASK = dict(
    activity="anti-bacterial",
    length_min=10,
    length_max=20,
    charge_min=2,
    charge_max=5,
    hydro_min=30.0,
    hydro_max=50.0,
)

_FALLBACK_SEQUENCE = "KLLKLLKLLK"
_DEMO_REFERENCE = "KFLHSAKKFGKAFVGEIMNS"


def _banner(title: str) -> None:
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)


def _run_step(fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        print(f"  [SKIPPED] {fn.__name__} failed: {e}")
        return None


def step_1_generate() -> dict:
    """/generate command -> peptide generated with full trace."""
    _banner("STEP 1 — /generate: full agentic generation loop")
    from harness.commands import execute_command

    result = execute_command(
        "/generate anti-bacterial --length 10-20 --charge +2+5", "demo-session"
    )
    print(f"Sequence:  {result['sequence']}")
    print(f"Score:     {result['score']}")
    print(f"Status:    {result['status']}  (iteration {result['iteration']})")
    node_sequence = " -> ".join(step["node"] for step in result["steps"])
    print(f"Trace:     {len(result['steps'])} node steps recorded")
    print(f"  {node_sequence}")
    return result


def step_2_langsmith():
    """LangSmith dashboard -> every node traced."""
    _banner("STEP 2 — LangSmith trace")
    has_key = bool(os.environ.get("LANGCHAIN_API_KEY"))
    tracing_on = os.environ.get("LANGCHAIN_TRACING_V2", "").lower() == "true"
    if not (has_key and tracing_on):
        print(
            "LangSmith not configured (set LANGCHAIN_TRACING_V2=true + "
            "LANGCHAIN_API_KEY in .env) — skipping."
        )
        return None

    from langchain_core.tracers.context import tracing_v2_enabled

    from harness.graph import run_pepforge

    project = os.environ.get("LANGCHAIN_PROJECT", "pepforge")
    with tracing_v2_enabled(project_name=project) as tracer:
        result = run_pepforge(thread_id="demo-langsmith", max_retries=2, **_TASK)
    try:
        url = tracer.get_run_url()
    except Exception:
        url = f"(open the '{project}' project at smith.langchain.com)"
    print(f"Sequence:  {result['current_sequence']}")
    print(f"Trace URL: {url}")
    return url


def step_3_score(sequence: str) -> dict:
    """/score SEQUENCE -> all 7 PeptideBLEU components."""
    _banner("STEP 3 — /score: PeptideBLEU component breakdown")
    from harness.commands import execute_command

    result = execute_command(f"/score {sequence} --ref {_DEMO_REFERENCE}", "demo-session")
    print(f"Sequence:   {result['sequence']}")
    print(f"BLEU score: {result['bleu_score']}")
    for name, val in result["components"].items():
        print(f"  {name:>24}: {val:.4f}")
    return result


def step_4_compare(seq_a: str, seq_b: str) -> dict:
    """/compare SEQ1 SEQ2 -> side-by-side descriptors."""
    _banner("STEP 4 — /compare: side-by-side comparison")
    from harness.commands import execute_command

    result = execute_command(f"/compare {seq_a} {seq_b}", "demo-session")
    for key in ("sequence_1", "sequence_2"):
        d = result[key]["descriptors"]
        print(
            f"{result[key]['sequence']}: len={d['length']} "
            f"charge={d['net_charge']:+d} hydro={d['hydro_pct']}%"
        )
    return result


def step_5_history() -> dict:
    """/history -> past session results from SQLite."""
    _banner("STEP 5 — /history: SQLite-backed session memory")
    from harness.commands import execute_command

    result = execute_command("/history 3", "demo-session")
    print(f"{len(result['results'])} past result(s) found for this session:")
    for r in result["results"]:
        print(
            f"  {r.get('current_sequence')}  score={r.get('current_score')}  "
            f"status={r.get('status')}"
        )
    return result


def step_6_hitl() -> dict:
    """HITL -> researcher modifying a candidate mid-generation."""
    _banner("STEP 6 — Human-in-the-loop: researcher modifies a candidate")
    from harness.graph import build_graph
    from harness.hitl import run_with_hitl
    from harness.state import create_initial_state

    app = build_graph()
    state = create_initial_state(hitl_enabled=True, threshold=0.1, max_retries=5, **_TASK)
    config = {"configurable": {"thread_id": "demo-hitl"}}

    # "modify" re-scores the researcher's sequence and, since it's strong
    # enough to pass again, immediately re-triggers another pause — accept
    # on the second pause onward or this loops forever modifying the same
    # already-passing candidate (hit live during Week 4 task 5 testing: a
    # single-branch decision_fn that only ever returns "modify" never
    # terminates, since every subsequent pause is just the same candidate).
    paused_count = 0

    def decision_fn(interrupt_value: dict) -> dict:
        nonlocal paused_count
        paused_count += 1
        print(f"  [PAUSED] candidate={interrupt_value['sequence']} score={interrupt_value['score']}")
        if paused_count == 1:
            print("  Researcher decision: MODIFY -> substituting a stronger variant")
            return {"action": "modify", "sequence": "RFLHSAKKFGKAFVGEIMNS"}
        print("  Researcher decision: ACCEPT -> modified candidate confirmed")
        return {"action": "accept"}

    result = run_with_hitl(app, state, config, decision_fn)
    print(f"Final sequence:   {result['current_sequence']}")
    print(f"Final status:     {result['status']}")
    return result


def step_7_mcp() -> dict:
    """MCP -> calling PepForge tools over the Model Context Protocol."""
    _banner("STEP 7 — MCP server: PepForge tools from any MCP client")
    import asyncio

    from fastmcp import Client

    from harness.mcp_server import mcp

    async def _run():
        async with Client(mcp) as client:
            tools = await client.list_tools()
            print(f"Registered MCP tools: {', '.join(sorted(t.name for t in tools))}")
            result = await client.call_tool(
                "score_peptide",
                {"sequence": _FALLBACK_SEQUENCE, "reference": _DEMO_REFERENCE},
            )
            return result.data

    data = asyncio.run(_run())
    print(f"score_peptide via MCP -> bleu_score={data['bleu_score']}")
    return data


def step_8_edit_stats() -> dict:
    """Edit statistics -> which edit operation types actually help."""
    _banner("STEP 8 — Edit statistics: which operations improve the score")
    from harness.graph import run_pepforge

    result = run_pepforge(thread_id="demo-edit-stats", threshold=0.99, max_retries=4, **_TASK)
    stats = result.get("edit_stats", {})
    if not stats:
        print("No edits were needed this run (passed on the first attempt).")
        return stats
    for op, s in stats.items():
        print(
            f"  {op:<20} used={s['count']:<3} improved={s['improvements']:<3} "
            f"avg_delta={s['avg_delta']:+.4f}"
        )
    return stats


def main() -> None:
    print("PepForge — LangGraph Harness Demo (Weeks 1-4)")
    print("Live run against the configured LLM gateway — no mocks.")

    gen = _run_step(step_1_generate) or {}
    sequence = gen.get("sequence") or _FALLBACK_SEQUENCE

    _run_step(step_2_langsmith)
    _run_step(step_3_score, sequence)
    _run_step(step_4_compare, sequence, _DEMO_REFERENCE)
    _run_step(step_5_history)
    _run_step(step_6_hitl)
    _run_step(step_7_mcp)
    _run_step(step_8_edit_stats)

    _banner("DEMO COMPLETE")
    print("All Week 1-4 harness capabilities exercised.")


if __name__ == "__main__":
    main()
