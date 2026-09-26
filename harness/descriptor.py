"""
Component 1: unified peptide descriptor calculator.

Pure function over a raw sequence string — no backend imports, no I/O.
See .claude/plan/week1.md Task 4 for the spec.
"""

import os
import sys
from dataclasses import asdict

# Allow `python harness/descriptor.py` to find the `harness` package —
# running the file directly puts harness/ itself on sys.path, not its
# parent, so `import harness.xyz` fails without this.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness.state import PeptideDescriptors

# Average molecular weight (Da) of each free amino acid.
_AA_WEIGHTS = {
    "A": 89.09, "R": 174.20, "N": 132.12, "D": 133.10, "C": 121.16,
    "Q": 146.15, "E": 147.13, "G": 75.07, "H": 155.16, "I": 131.17,
    "L": 131.17, "K": 146.19, "M": 149.21, "F": 165.19, "P": 115.13,
    "S": 105.09, "T": 119.12, "W": 204.23, "Y": 181.19, "V": 117.15,
}
_WATER = 18.02

# Kyte-Doolittle hydropathy scale.
_KD_SCALE = {
    "A": 1.8, "R": -4.5, "N": -3.5, "D": -3.5, "C": 2.5,
    "Q": -3.5, "E": -3.5, "G": -0.4, "H": -3.2, "I": 4.5,
    "L": 3.8, "K": -3.9, "M": 1.9, "F": 2.8, "P": -1.6,
    "S": -0.8, "T": -0.7, "W": -0.9, "Y": -1.3, "V": 4.2,
}

_HYDROPHOBIC = set("AILMFWVC")
_AROMATIC = set("FWY")
_POSITIVE = set("RK")
_NEGATIVE = set("DE")


def calculate_descriptors(sequence: str) -> PeptideDescriptors:
    """Compute physicochemical descriptors for a peptide sequence."""
    seq = sequence.strip().upper()
    length = len(seq)

    net_charge = sum(1 for aa in seq if aa in _POSITIVE) - sum(
        1 for aa in seq if aa in _NEGATIVE
    )
    hydro_pct = round(
        sum(1 for aa in seq if aa in _HYDROPHOBIC) / max(length, 1) * 100, 1
    )
    gravy = round(sum(_KD_SCALE.get(aa, 0.0) for aa in seq) / max(length, 1), 3)
    aromaticity = round(
        sum(1 for aa in seq if aa in _AROMATIC) / max(length, 1), 3
    )
    mol_weight = round(
        sum(_AA_WEIGHTS.get(aa, 0.0) for aa in seq) - max(length - 1, 0) * _WATER,
        2,
    )

    return PeptideDescriptors(
        sequence=seq,
        length=length,
        net_charge=net_charge,
        hydro_pct=hydro_pct,
        gravy=gravy,
        aromaticity=aromaticity,
        mol_weight=mol_weight,
        charge_class=_charge_class(net_charge),
        length_class=_length_class(length),
    )


def _charge_class(net_charge: int) -> str:
    if net_charge >= 5:
        return "strongly_positive"
    if net_charge >= 1:
        return "positive"
    if net_charge == 0:
        return "neutral"
    if net_charge > -5:
        return "negative"
    return "strongly_negative"


def _length_class(length: int) -> str:
    if length < 10:
        return "very_short"
    if length <= 19:
        return "short"
    if length <= 35:
        return "medium"
    return "long"


def descriptors_to_dict(descriptors: PeptideDescriptors) -> dict:
    """JSON-serializable dict form of a PeptideDescriptors instance."""
    return asdict(descriptors)


def validate_against_task(descriptors: PeptideDescriptors, task: dict) -> dict:
    """Quick range check of descriptors against a task spec dict.

    `task` is expected to carry a subset of AgentState's task-spec fields:
    length_min/length_max, charge_min/charge_max, hydro_min/hydro_max.
    Missing bounds are treated as unconstrained.
    """
    length_ok = task.get("length_min", descriptors.length) <= descriptors.length <= task.get(
        "length_max", descriptors.length
    )
    charge_ok = task.get("charge_min", descriptors.net_charge) <= descriptors.net_charge <= task.get(
        "charge_max", descriptors.net_charge
    )
    hydro_ok = task.get("hydro_min", descriptors.hydro_pct) <= descriptors.hydro_pct <= task.get(
        "hydro_max", descriptors.hydro_pct
    )
    return {
        "length_ok": length_ok,
        "charge_ok": charge_ok,
        "hydro_ok": hydro_ok,
        "all_ok": length_ok and charge_ok and hydro_ok,
    }


if __name__ == "__main__":
    test_seq = "ALWKGIGKFLPKKKFGKAFLGEIMNS"
    d = calculate_descriptors(test_seq)
    print(f"sequence:      {d.sequence}")
    print(f"length:        {d.length}")
    print(f"net_charge:    {d.net_charge:+d}")
    print(f"hydro_pct:     {d.hydro_pct}%")
    print(f"gravy:         {d.gravy}")
    print(f"aromaticity:   {d.aromaticity}")
    print(f"mol_weight:    {d.mol_weight} Da")
    print(f"charge_class:  {d.charge_class}")
    print(f"length_class:  {d.length_class}")
