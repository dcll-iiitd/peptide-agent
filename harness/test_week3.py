"""
Week 3 verification script.

Run with: python harness/test_week3.py
test_edit_operator, test_slash_generate, test_slash_score, test_slash_edit,
test_slash_compare, test_slash_explain, and test_edit_statistics make real
live calls through the configured LLM gateway (reads .env) — they are live
integration checks, not mocks. test_input_guardrail/test_output_guardrail
are pure unit tests (no LLM call needed).
"""

import os
import sys
import time

# Allow `python harness/test_week3.py` to find the `harness` package —
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


def test_edit_operator():
    from harness.edit_operator import VALID_OPERATIONS, apply_edit, generate_edit_operation

    sequence = "KKKKKKKKKK"  # charge +10, target +2 to +5
    task = {
        "length_min": 10, "length_max": 20,
        "charge_min": 2, "charge_max": 5,
        "hydro_min": 30.0, "hydro_max": 50.0,
    }
    scores = {"net_charge": 0.05}

    op = None
    for _ in range(5):
        op = generate_edit_operation(sequence, task, scores, [])
        if op is not None:
            break
    assert op is not None, "LLM never returned a usable edit instruction after 5 attempts"
    assert op.operation in VALID_OPERATIONS, f"invalid operation: {op.operation}"

    edited = apply_edit(sequence, op)

    if op.operation == "substitute":
        assert 1 <= op.position <= len(sequence), op
        if edited != sequence:
            # Edit was accepted — from_aa must have matched the real residue
            # (apply_edit's own validation guarantees this) and the position
            # shown in the result must actually carry to_aa now.
            assert sequence[op.position - 1] == op.from_aa, "accepted edit with from_aa mismatch"
            assert edited[op.position - 1] == op.to_aa, "changed position doesn't match operation"
        else:
            assert sequence[op.position - 1] != op.from_aa or op.to_aa not in set(
                "ACDEFGHIKLMNPQRSTVWY"
            ), "edit was rejected but from_aa/to_aa both looked valid"

    print(
        f"[PASS] test_edit_operator (operation={op.operation}, position={op.position}, "
        f"{op.from_aa}->{op.to_aa}, applied={edited != sequence})"
    )


def test_slash_generate():
    from harness.commands import execute_command

    start = time.time()
    result = execute_command(
        "/generate anti-bacterial --length 10-20 --charge +2+4", "test-week3-generate"
    )
    elapsed = time.time() - start

    assert result is not None and result["command"] == "/generate"
    assert result["sequence"], "no sequence returned"
    assert result["score"] is not None

    print(
        f"[PASS] test_slash_generate (sequence={result['sequence']}, score={result['score']}, "
        f"{elapsed:.1f}s{'  [over the 30s guideline]' if elapsed > 30 else ''})"
    )


def test_slash_score():
    from harness.commands import execute_command

    result = execute_command(
        "/score KLLKFLHSAKKFG --ref GIGKFLHSAKKFGKAFVGEIMNS", "test-week3-score"
    )
    required_components = {
        "ngram_bleu", "charge", "hydrophobicity", "functional_group",
        "property_distribution", "structural", "blosum",
    }
    assert result["command"] == "/score"
    assert required_components.issubset(result["components"].keys()), (
        f"missing components: {required_components - result['components'].keys()}"
    )
    assert result["bleu_score"] is not None

    print(f"[PASS] test_slash_score (bleu_score={result['bleu_score']}, 7 components present)")


def test_slash_edit():
    from harness.commands import execute_command

    result = None
    for _ in range(5):
        result = execute_command("/edit KKKKKKKKKK --fix charge", "test-week3-edit")
        if result.get("changed"):
            break
    assert result is not None and result["command"] == "/edit"
    # Structurally valid either way: changed=True with a real operation, or
    # changed=False with a reason_rejected — never a crash either way.
    assert result["changed"] or result["reason_rejected"]

    print(f"[PASS] test_slash_edit (changed={result['changed']}, edited={result['edited']})")


def test_slash_compare():
    from harness.commands import execute_command

    result = execute_command("/compare KLLKFLHSAKKFG GIGKFLHSAKKFGKAFVGEIMNS", "test-week3-compare")
    assert result["command"] == "/compare"
    assert result["sequence_1"]["sequence"] == "KLLKFLHSAKKFG"
    assert result["sequence_2"]["sequence"] == "GIGKFLHSAKKFGKAFVGEIMNS"
    assert "descriptors" in result["sequence_1"] and "descriptors" in result["sequence_2"]

    print("[PASS] test_slash_compare (side-by-side descriptors present for both sequences)")


def test_slash_explain():
    from harness.commands import execute_command

    result = execute_command("/explain ALWKGIGKFLPKKKFGKAFLGEIMNS", "test-week3-explain")
    assert result["command"] == "/explain"
    assert result["descriptors"]["length"] == 26
    assert result["descriptors"]["net_charge"] == 5
    assert result["explanation"] and isinstance(result["explanation"], str)

    print(f"[PASS] test_slash_explain ({result['explanation'][:70]}...)")


def test_input_guardrail():
    from harness.graph import run_pepforge

    start = time.time()
    result = run_pepforge(
        activity="anti-bacterial",
        length_min=15, length_max=25,
        charge_min=10, charge_max=2,  # reversed — invalid
        hydro_min=30.0, hydro_max=50.0,
        threshold=0.35, max_retries=3,
    )
    elapsed = time.time() - start

    assert result["error"], "expected state['error'] to be set"
    assert result["status"] == "failed"
    assert elapsed < 5, f"took {elapsed:.1f}s — guardrail should fail fast with no LLM call"

    print(f"[PASS] test_input_guardrail (error={result['error']!r}, {elapsed:.2f}s, no LLM call)")


def test_output_guardrail():
    from harness.guardrails import output_guardrail
    from harness.state import CandidateResult, create_initial_state

    reference = "KFLHSAKKFGKAFVGEIMNS"
    state = create_initial_state(length_min=15, length_max=25, reference=reference)

    copy_candidate = CandidateResult(
        sequence=reference, descriptors=None, bleu_score=1.0, rulebook=None,
        plddt=None, helix_pct=None, novelty=None, closest_match=None,
        iteration=1, edit_op=None,
    )
    real_candidate = CandidateResult(
        sequence="KFLHSAKKFGKAFVGDIFFER", descriptors=None, bleu_score=0.6, rulebook=None,
        plddt=None, helix_pct=None, novelty=None, closest_match=None,
        iteration=1, edit_op=None,
    )
    state["best_passing"] = copy_candidate
    state["best_overall"] = real_candidate
    state["current_sequence"] = copy_candidate.sequence
    state["status"] = "complete"

    result = output_guardrail(state)

    assert result["current_sequence"] != reference, "guardrail did not reject the reference copy"
    assert result["current_sequence"] == real_candidate.sequence, "did not fall back to best_overall"

    print(f"[PASS] test_output_guardrail (rejected copy, fell back to {result['current_sequence']})")


def test_edit_statistics():
    from harness.graph import run_pepforge

    combined_stats: dict = {}
    for i in range(3):
        result = run_pepforge(
            thread_id=f"test-week3-stats-{i}",
            threshold=0.99,  # very high but valid — forces multiple edit laps
            max_retries=3,
            **_TASK,
        )
        for op_type, stats in result["edit_stats"].items():
            combined_stats.setdefault(op_type, []).append(stats)

    assert combined_stats, "edit_stats was never populated across 3 generation runs"
    for op_type, runs in combined_stats.items():
        for s in runs:
            assert {"count", "improvements", "avg_delta"}.issubset(s.keys())
            assert s["count"] >= 1

    print(f"[PASS] test_edit_statistics (operation types observed: {sorted(combined_stats.keys())})")


def main():
    tests = [
        test_edit_operator,
        test_slash_generate,
        test_slash_score,
        test_slash_edit,
        test_slash_compare,
        test_slash_explain,
        test_input_guardrail,
        test_output_guardrail,
        test_edit_statistics,
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
