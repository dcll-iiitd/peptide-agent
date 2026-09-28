"""
Week 1 verification script.

Run with: python harness/test_week1.py
test_full_run() makes a real call through the configured LLM gateway
(reads .env) — it is a live integration check, not a mock.
"""

import os
import sys

# Allow `python harness/test_week1.py` to find the `harness` package —
# running the file directly puts harness/ itself on sys.path, not its
# parent, so `import harness.xyz` fails without this.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_descriptor_calculator():
    from harness.descriptor import calculate_descriptors

    d = calculate_descriptors("ALWKGIGKFLPKKKFGKAFLGEIMNS")
    assert d.length == 26, f"length {d.length} != 26"
    assert d.net_charge == 5, f"net_charge {d.net_charge} != +5"
    assert abs(d.hydro_pct - 46.2) < 1.0, f"hydro_pct {d.hydro_pct} not ~46%"
    print(
        f"[PASS] test_descriptor_calculator "
        f"(length={d.length}, net_charge={d.net_charge:+d}, hydro_pct={d.hydro_pct}%)"
    )


def test_tools():
    from harness.tools import ALL_TOOLS, descriptor_tool

    # >= 8, not ==: Week 1 wrapped exactly 8 tools, but later weeks add more
    # (e.g. diagnostic_tool in Week 2) without invalidating this check.
    assert len(ALL_TOOLS) >= 8, f"expected at least 8 tools, got {len(ALL_TOOLS)}"

    result = descriptor_tool.invoke({"sequence": "ALWKGIGKFLPKKKFGKAFLGEIMNS"})
    assert "error" not in result, result
    assert result["length"] == 26, result
    assert result["net_charge"] == 5, result
    print(f"[PASS] test_tools ({len(ALL_TOOLS)} tools registered, descriptor_tool.invoke OK)")


def test_graph_build():
    from harness.graph import build_graph

    app = build_graph()
    nodes = set(app.get_graph().nodes.keys())
    expected = {"rag", "generate", "score", "validate", "track", "edit", "post_hoc"}
    assert expected.issubset(nodes), f"missing nodes: {expected - nodes}"
    print(f"[PASS] test_graph_build ({len(nodes)} nodes compiled)")


def test_full_run():
    from dotenv import load_dotenv

    load_dotenv()
    from harness.graph import run_pepforge

    result = run_pepforge(
        activity="anti-bacterial",
        length_min=15,
        length_max=25,
        charge_min=2,
        charge_max=5,
        hydro_min=30.0,
        hydro_max=50.0,
        threshold=0.35,
        max_retries=3,
    )
    assert result["current_sequence"], "run_pepforge() produced no sequence"
    assert result["status"] in ("complete", "failed"), f"unexpected status: {result['status']}"
    print(
        f"[PASS] test_full_run -> sequence={result['current_sequence']} "
        f"score={result['current_score']} status={result['status']} "
        f"iterations={result['iteration']}"
    )


def main():
    tests = [test_descriptor_calculator, test_tools, test_graph_build, test_full_run]
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
