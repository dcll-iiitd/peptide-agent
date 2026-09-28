"""
Component 2: actionable diagnostic rule checker.

Replaces the pass/fail-only backend/rulebook.py check (still used elsewhere,
untouched) with violations carrying exact positions and fix hints, so
edit_node can target specific residues instead of "charge too high".

See .claude/plan/week2.md Task 1 for the spec.
"""

import os
import re
import sys

# Allow `python harness/diagnostic.py` to find the `harness` package.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness.descriptor import _HYDROPHOBIC, _NEGATIVE, _POSITIVE, calculate_descriptors
from harness.state import DiagnosticResult

VALID_AA = set("ACDEFGHIKLMNPQRSTVWY")


def _positions(sequence: str, aa_set: set) -> list:
    """1-indexed positions of residues in aa_set."""
    return [i + 1 for i, c in enumerate(sequence) if c in aa_set]


def _check_valid_aa(sequence: str) -> dict | None:
    positions = [i + 1 for i, c in enumerate(sequence) if c not in VALID_AA]
    if not positions:
        return None
    invalid_chars = [sequence[p - 1] for p in positions]
    return {
        "rule": "valid_aa",
        "current": invalid_chars,
        "target": "all chars in ACDEFGHIKLMNPQRSTVWY",
        "excess": len(positions),
        "fix": "replace invalid chars with nearest valid AA",
        "positions": positions,
    }


def _check_length(descriptors, task: dict) -> dict | None:
    length_min = task.get("length_min")
    length_max = task.get("length_max")
    if length_min is None or length_max is None:
        return None
    length = descriptors.length
    if length_min <= length <= length_max:
        return None

    target_mid = (length_min + length_max) // 2
    excess = length - target_mid
    if length < length_min:
        fix = f"add {length_min - length} residues"
    else:
        fix = f"remove {length - length_max} residues from end"

    return {
        "rule": "length",
        "current": length,
        "target": f"{length_min}-{length_max}",
        "excess": excess,
        "fix": fix,
        "positions": [],
    }


def _check_net_charge(sequence: str, descriptors, task: dict) -> dict | None:
    charge_min = task.get("charge_min")
    charge_max = task.get("charge_max")
    if charge_min is None or charge_max is None:
        return None
    charge = descriptors.net_charge
    if charge_min <= charge <= charge_max:
        return None

    if charge > charge_max:
        nearest_bound = charge_max
        excess = charge - nearest_bound
        positions = _positions(sequence, _POSITIVE)
        fix = f"replace {excess} K/R with Q/N"
    else:
        nearest_bound = charge_min
        excess = charge - nearest_bound
        positions = _positions(sequence, _NEGATIVE)
        fix = f"add {abs(excess)} K/R"

    return {
        "rule": "net_charge",
        "current": charge,
        "target": f"{charge_min:+d} to {charge_max:+d}",
        "excess": excess,
        "fix": fix,
        "positions": positions,
    }


def _check_hydrophobicity(sequence: str, descriptors, task: dict) -> dict | None:
    hydro_min = task.get("hydro_min")
    hydro_max = task.get("hydro_max")
    if hydro_min is None or hydro_max is None:
        return None
    hydro_pct = descriptors.hydro_pct
    if hydro_min <= hydro_pct <= hydro_max:
        return None

    if hydro_pct > hydro_max:
        nearest_bound = hydro_max
        excess = round(hydro_pct - nearest_bound, 1)
        positions = _positions(sequence, _HYDROPHOBIC)
        n = max(1, round(abs(excess) / 100.0 * max(descriptors.length, 1)))
        fix = f"replace {n} L/I/V/A with S/T/N/Q"
    else:
        nearest_bound = hydro_min
        excess = round(hydro_pct - nearest_bound, 1)
        positions = [i + 1 for i, c in enumerate(sequence) if c not in _HYDROPHOBIC]
        n = max(1, round(abs(excess) / 100.0 * max(descriptors.length, 1)))
        fix = f"replace {n} S/T/N/Q with L/I/V/F/W/M"

    return {
        "rule": "hydrophobicity",
        "current": hydro_pct,
        "target": f"{hydro_min}% to {hydro_max}%",
        "excess": excess,
        "fix": fix,
        "positions": positions,
    }


def _check_poly_proline(sequence: str) -> dict | None:
    runs = list(re.finditer(r"P{4,}", sequence))
    if not runs:
        return None
    positions = [m.start() + 1 for m in runs]
    longest = max(len(m.group()) for m in runs)
    return {
        "rule": "poly_proline",
        "current": longest,
        "target": "< 4 consecutive P",
        "excess": longest - 3,
        "fix": "replace middle P in each run with G or A",
        "positions": positions,
    }


def _check_cysteine_parity(sequence: str) -> dict | None:
    positions = _positions(sequence, {"C"})
    if len(positions) % 2 == 0:
        return None
    return {
        "rule": "cysteine_parity",
        "current": len(positions),
        "target": "even number",
        "excess": 1,
        "fix": "add one C or remove one C",
        "positions": positions,
    }


def _check_activity_specific(descriptors, task: dict) -> list:
    from backend.rulebook import ACTIVITY_CONSTRAINTS

    violations = []
    for activity in task.get("activities", []):
        constraints = ACTIVITY_CONSTRAINTS.get(activity)
        if not constraints:
            continue

        min_len = constraints.get("min_len")
        max_len = constraints.get("max_len")
        if min_len is not None and max_len is not None and not (
            min_len <= descriptors.length <= max_len
        ):
            target_mid = (min_len + max_len) // 2
            violations.append(
                {
                    "rule": f"activity_specific:{activity}:length",
                    "current": descriptors.length,
                    "target": f"{min_len}-{max_len}",
                    "excess": descriptors.length - target_mid,
                    "fix": (
                        f"add {min_len - descriptors.length} residues"
                        if descriptors.length < min_len
                        else f"remove {descriptors.length - max_len} residues from end"
                    ),
                    "positions": [],
                }
            )

        min_charge = constraints.get("min_charge")
        max_charge = constraints.get("max_charge")
        if min_charge is not None and max_charge is not None and not (
            min_charge <= descriptors.net_charge <= max_charge
        ):
            nearest_bound = max_charge if descriptors.net_charge > max_charge else min_charge
            violations.append(
                {
                    "rule": f"activity_specific:{activity}:charge",
                    "current": descriptors.net_charge,
                    "target": f"{min_charge:+d} to {max_charge:+d}",
                    "excess": descriptors.net_charge - nearest_bound,
                    "fix": (
                        f"replace {descriptors.net_charge - max_charge} K/R with Q/N"
                        if descriptors.net_charge > max_charge
                        else f"add {min_charge - descriptors.net_charge} K/R"
                    ),
                    "positions": [],
                }
            )

    return violations


def check_sequence(sequence: str, task: dict) -> DiagnosticResult:
    """Run all diagnostic rules against a sequence and return a DiagnosticResult
    with actionable violations (position + fix hint), not just pass/fail.
    """
    seq = sequence.upper().strip()
    descriptors = calculate_descriptors(seq)

    violations = []

    invalid_aa_violation = _check_valid_aa(seq)
    if invalid_aa_violation:
        violations.append(invalid_aa_violation)

    # Range checks are only meaningful on a sequence made entirely of valid
    # AA chars — calculate_descriptors() silently skips invalid chars in its
    # charge/hydro sums, so range violations on top of an invalid_aa
    # violation would describe stats computed while ignoring the bad chars.
    if not invalid_aa_violation:
        for check in (
            _check_length(descriptors, task),
            _check_net_charge(seq, descriptors, task),
            _check_hydrophobicity(seq, descriptors, task),
            _check_poly_proline(seq),
            _check_cysteine_parity(seq),
        ):
            if check:
                violations.append(check)
        violations.extend(_check_activity_specific(descriptors, task))

    n_violations = len(violations)
    return DiagnosticResult(
        passed=n_violations == 0,
        violations=violations,
        fitness=max(0.0, round(1.0 - 0.2 * n_violations, 2)),
        n_violations=n_violations,
    )


if __name__ == "__main__":
    task = {
        "length_min": 10,
        "length_max": 50,
        "charge_min": 2,
        "charge_max": 5,
        "hydro_min": 30.0,
        "hydro_max": 50.0,
        "activities": ["anti-bacterial"],
    }
    result = check_sequence("KKKKKKKKKKLLLLLLLLLLL", task)
    print(f"passed: {result.passed}")
    print(f"n_violations: {result.n_violations}")
    print(f"fitness: {result.fitness}")
    for v in result.violations:
        print(f"  - {v}")
