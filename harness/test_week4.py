"""
Week 4 verification script.

Run with: python harness/test_week4.py
All 6 tests make real live calls through the configured LLM gateway (reads
.env) — live integration checks, not mocks, same practice as test_week3.py.
Each test drives at least one full generate->edit loop through a reasoning
model, so the whole suite can take several minutes.
"""

import json
import os
import sys

# Allow `python harness/test_week4.py` to find the `harness` package —
# running the file directly puts harness/ itself on sys.path, not its
# parent, so `import harness.xyz` fails without this.
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


def test_hitl_accept():
    from harness.graph import build_graph
    from harness.hitl import run_with_hitl
    from harness.state import create_initial_state

    app = build_graph()
    # threshold=0.1 (not the unreachable 1.1 trick CLAUDE.md warns is now
    # rejected by input_guardrail) makes a passing candidate likely, but
    # "passing" also requires a fully violation-free diagnostic, not just
    # clearing the score threshold — whether the model/edit loop converges to
    # zero violations within the retry budget is itself stochastic (observed
    # live: one run needed 0 edits, another never passed in 5). Retrying the
    # whole run with a fresh thread_id on a genuine "never passed" outcome
    # follows the same live-flakiness-tolerant pattern as test_slash_edit.
    result = None
    decisions_seen = []
    for attempt in range(3):
        state = create_initial_state(hitl_enabled=True, threshold=0.1, max_retries=8, **_TASK)
        config = {"configurable": {"thread_id": f"test-week4-hitl-accept-{attempt}"}}
        decisions_seen = []

        def decision_fn(interrupt_value):
            decisions_seen.append(interrupt_value)
            return {"action": "accept"}

        result = run_with_hitl(app, state, config, decision_fn)
        if decisions_seen:
            break

    assert len(decisions_seen) == 1, (
        f"accept should stop generation at the first pause, saw {len(decisions_seen)} pauses "
        f"after 3 attempts"
    )
    assert result["status"] == "complete"
    assert result["best_passing"] is not None
    assert result["best_passing"].sequence == decisions_seen[0]["sequence"]

    print(
        f"[PASS] test_hitl_accept (sequence={result['best_passing'].sequence}, "
        f"1 pause, stopped immediately)"
    )


def test_hitl_reject():
    from harness.graph import build_graph
    from harness.hitl import run_with_hitl
    from harness.state import create_initial_state

    app = build_graph()
    state = create_initial_state(hitl_enabled=True, threshold=0.1, max_retries=6, **_TASK)
    config = {"configurable": {"thread_id": "test-week4-hitl-reject"}}

    decisions_seen = []

    def decision_fn(interrupt_value):
        decisions_seen.append(interrupt_value)
        # Reject the first pause unconditionally, accept any later one so the
        # test terminates deterministically regardless of how many more
        # passing candidates a live, stochastic LLM happens to produce.
        return {"action": "reject"} if len(decisions_seen) < 2 else {"action": "accept"}

    result = run_with_hitl(app, state, config, decision_fn)

    assert len(decisions_seen) >= 1, "reject path never paused for approval at all"
    if len(decisions_seen) >= 2:
        # Confirms reject didn't just freeze on the same candidate forever —
        # editing genuinely continued and reached a later iteration.
        assert decisions_seen[1]["iteration"] > decisions_seen[0]["iteration"], (
            "iteration did not advance between pauses after a reject"
        )
    assert result["status"] in ("complete", "failed")

    print(
        f"[PASS] test_hitl_reject ({len(decisions_seen)} pause(s) seen, "
        f"final status={result['status']})"
    )


def test_hitl_modify():
    from harness.graph import build_graph
    from harness.hitl import run_with_hitl
    from harness.state import create_initial_state

    app = build_graph()
    state = create_initial_state(hitl_enabled=True, threshold=0.1, max_retries=5, **_TASK)
    config = {"configurable": {"thread_id": "test-week4-hitl-modify"}}

    # A valid, high-scoring sequence that is NOT byte-for-byte the
    # auto-selected canonical reference (output_guardrail would reject an
    # exact copy and fall back to something else, defeating the assertion
    # below that the modified sequence survives to the final result).
    modified_sequence = "RFLHSAKKFGKAFVGEIMNS"
    decisions_seen = []

    def decision_fn(interrupt_value):
        decisions_seen.append(interrupt_value)
        if len(decisions_seen) == 1:
            return {"action": "modify", "sequence": modified_sequence}
        # The modified sequence is itself strong enough to pass again on the
        # next lap (hitl stays enabled) — accept then to end the test.
        return {"action": "accept"}

    result = run_with_hitl(app, state, config, decision_fn)

    assert decisions_seen[0]["sequence"] != modified_sequence, (
        "first pause should show the model's own candidate, not the researcher's"
    )
    assert result["best_passing"] is not None
    assert result["best_passing"].sequence == modified_sequence, (
        f"expected the researcher's modified sequence to be tracked as best_passing, "
        f"got {result['best_passing'].sequence!r}"
    )

    print(
        f"[PASS] test_hitl_modify (researcher sequence={modified_sequence}, "
        f"final status={result['status']})"
    )


def test_mcp_server():
    import asyncio

    from fastmcp import Client

    from harness.mcp_server import mcp

    async def _run():
        async with Client(mcp) as client:
            tools = await client.list_tools()
            names = {t.name for t in tools}
            expected = {
                "generate_peptide", "score_peptide", "edit_peptide", "explain_peptide",
                "compare_peptides", "novelty_check", "get_history",
            }
            missing = expected - names
            assert not missing, f"missing MCP tools: {missing}"

            result = await client.call_tool(
                "generate_peptide",
                {
                    "activity": "anti-bacterial",
                    "length_min": 10, "length_max": 20,
                    "charge_min": 2, "charge_max": 5,
                    "hydro_min": 30.0, "hydro_max": 50.0,
                    "threshold": 0.99,
                    "max_retries": 2,
                },
            )
            return result.data

    data = asyncio.run(_run())
    assert data["sequence"], "generate_peptide returned no sequence"
    assert data["score"] is not None

    print(
        f"[PASS] test_mcp_server (7 tools registered, generate_peptide -> "
        f"sequence={data['sequence']}, score={data['score']})"
    )


def _sse_event_types(response) -> set:
    types = set()
    for line in response.iter_lines():
        if line.startswith("data: "):
            types.add(json.loads(line[len("data: "):])["type"])
    return types


def test_sse_bridge():
    from starlette.testclient import TestClient

    from backend.server import app

    client = TestClient(app)
    body = {
        "activities": ["anti-bacterial"],
        "length_min": 10, "length_max": 20,
        "charge_min": 2, "charge_max": 5,
        "hydro_min": 30, "hydro_max": 50,
        "threshold": 0.99,
        "max_retries": 2,
    }

    with client.stream("POST", "/generate?harness=true", json=body) as resp:
        assert resp.status_code == 200
        harness_types = _sse_event_types(resp)
    assert "attempt" in harness_types, f"no attempt events in harness=true stream: {harness_types}"
    assert "final" in harness_types, f"no final event in harness=true stream: {harness_types}"

    with client.stream("POST", "/generate", json={**body, "max_retries": 1}) as resp:
        assert resp.status_code == 200
        legacy_types = _sse_event_types(resp)
    assert "attempt" in legacy_types and "final" in legacy_types, (
        f"legacy harness=false path broken: {legacy_types}"
    )

    print(
        f"[PASS] test_sse_bridge (harness=true events={sorted(harness_types)}, "
        f"harness=false events={sorted(legacy_types)})"
    )


def test_full_harness_end_to_end():
    from harness.commands import execute_command
    from harness.graph import build_graph
    from harness.hitl import run_with_hitl
    from harness.memory import get_session_history
    from harness.state import create_initial_state
    from harness.tools import novelty_tool

    thread_id = "test-week4-e2e"
    app = build_graph()
    state = create_initial_state(hitl_enabled=True, threshold=0.1, max_retries=5, **_TASK)
    config = {"configurable": {"thread_id": thread_id}}

    result = run_with_hitl(app, state, config, lambda _interrupt: {"action": "accept"})

    assert result["rag_examples"], "RAG retrieval (Week 1) produced no examples"
    assert result["current_descriptors"] is not None, "descriptor calculator (Week 1) never ran"
    assert result["candidates"], "no candidates tracked (Week 1 track_best_node)"
    assert result["status"] in ("complete", "failed")

    history = get_session_history(thread_id)
    assert history, "SQLite memory (Week 2) has no snapshots for this thread"

    compare = execute_command(
        f"/compare {result['current_sequence']} {result['current_sequence']}", thread_id
    )
    assert compare["command"] == "/compare", "slash commands (Week 3) broken"

    novelty = novelty_tool.invoke({"sequence": result["current_sequence"]})
    assert "error" not in novelty, f"novelty tool (Week 2) failed: {novelty}"

    print(
        f"[PASS] test_full_harness_end_to_end (sequence={result['current_sequence']}, "
        f"status={result['status']}, candidates={len(result['candidates'])}, "
        f"rag_examples={len(result['rag_examples'])})"
    )


def main():
    tests = [
        test_hitl_accept,
        test_hitl_reject,
        test_hitl_modify,
        test_mcp_server,
        test_sse_bridge,
        test_full_harness_end_to_end,
    ]
    failures = []
    for t in tests:
        try:
            t()
        except Exception as e:
            failures.append(t.__name__)
            print(f"[FAIL] {t.__name__}: {e}")

    if failures:
        print(f"\n{len(failures)}/{len(tests)} tests failed: {', '.join(failures)}")
        sys.exit(1)

    print(f"\nAll {len(tests)} tests passed")


if __name__ == "__main__":
    main()
