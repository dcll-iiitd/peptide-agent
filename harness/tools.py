"""
@tool-wrapped functions over the existing backend/ modules.

See .claude/plan/tools_spec.md for the original spec and .claude/harness.md's
rules: backend modules are imported lazily (inside each function body, not
at module scope) and no tool ever raises — failures come back as a plain
{"error": "..."} dict instead, matching how every wrapped backend function
already fails open.

Signatures below were verified against the actual backend source (not the
tools_spec.md draft, which is stale for esmfold_tool/dssp_tool/
blast_novelty_tool — see .claude/plan/tools_spec.md discrepancies noted in
harness dev notes).
"""

from typing import Optional

from langchain_core.tools import tool


@tool
def rag_retrieval_tool(task: dict, top_k: int = 5) -> dict:
    """Retrieve the top-k most similar peptides from the local dataset for a task.

    task: dict with any of charge, hydro_min, hydro_max, length, activities.
    Returns {"examples": [...]} — each example has sequence/length/charge/
    hydro_pct/activities. Empty list if the RAG index/dataset isn't available.
    """
    try:
        from backend.rag.peptide_retriever import search_similar_peptides

        return {"examples": search_similar_peptides(task, top_k=top_k)}
    except Exception as e:
        return {"error": str(e)}


@tool
def descriptor_tool(sequence: str) -> dict:
    """Compute physicochemical descriptors (length, charge, hydro%, gravy,
    aromaticity, mol_weight, charge_class, length_class) for a peptide sequence.
    """
    try:
        from harness.descriptor import calculate_descriptors, descriptors_to_dict

        return descriptors_to_dict(calculate_descriptors(sequence))
    except Exception as e:
        return {"error": str(e)}


@tool
def peptide_bleu_tool(
    reference: str, sequence: str, activity: Optional[str] = None
) -> dict:
    """Score a generated sequence against a reference with PeptideBLEU.

    Returns {"score": float, "components": {ngram_bleu, charge,
    hydrophobicity, functional_group, property_distribution, structural,
    blosum}}.
    """
    try:
        from backend.peptide_bleu import peptide_metric, score_components

        return {
            "score": peptide_metric(reference, sequence, activity=activity),
            "components": score_components(reference, sequence),
        }
    except Exception as e:
        return {"error": str(e)}


@tool
def rulebook_tool(sequence: str, task: dict) -> dict:
    """Validate a sequence against task constraints (length/charge/hydro/etc).

    Returns the validation dict (valid/issues/...) plus a "score" key
    (0-1, deducts 0.2 per issue) from rulebook_score().
    """
    try:
        from backend.rulebook import rulebook_score, validate_sequence

        validation = validate_sequence(sequence, task)
        validation["score"] = rulebook_score(validation)
        return validation
    except Exception as e:
        return {"error": str(e)}


@tool
def esmfold_tool(sequence: str) -> dict:
    """Fold a peptide sequence with ESMFold and return pLDDT confidence.

    Returns {mean_plddt, per_residue, confidence, passes, interpretation,
    error, pdb}. mean_plddt is None on any failure (timeout, bad sequence,
    endpoint down) — this never raises.
    """
    try:
        from backend.esmfold_scorer import get_plddt

        return get_plddt(sequence)
    except Exception as e:
        return {"error": str(e)}


@tool
def dssp_tool(
    pdb_string: str,
    reference_pdb: Optional[str] = None,
    activities: Optional[list] = None,
) -> dict:
    """Compute secondary structure (helix/sheet/coil %) from an ESMFold PDB string.

    Returns {ss_string, helix_pct, sheet_pct, turn_pct, coil_pct, n_helix,
    n_sheet, interpretation, dssp_available, error, ...}. turn_pct is always
    0 (pydssp's 3-state output has no separate turn category).
    """
    try:
        from backend.dssp_scorer import get_secondary_structure

        return get_secondary_structure(
            pdb_string, reference_pdb=reference_pdb, activities=activities
        )
    except Exception as e:
        return {"error": str(e)}


@tool
def blast_novelty_tool(sequence: str, top_k: int = 1) -> dict:
    """Assess novelty of a sequence via BLAST similarity against the known-peptide DB.

    Returns {similarity_score, all_scores, novelty_label, interpretation,
    blast_available, db_exists, error}. Low similarity = novel.
    """
    try:
        from backend.blast_scorer import assess_novelty

        return assess_novelty(sequence, top_k=top_k)
    except Exception as e:
        return {"error": str(e)}


@tool
def reference_selector_tool(
    preset: str,
    target_length: int,
    target_charge: float,
    target_hydro_pct: Optional[float] = None,
    length_min: Optional[int] = None,
    length_max: Optional[int] = None,
) -> dict:
    """Pick the canonical reference peptide closest to the target task in
    (length, charge, hydro%) space for a given activity preset.

    Returns {"reference": "<sequence>"} — empty string if the preset is unknown.
    """
    try:
        from backend.agent import _pick_reference

        return {
            "reference": _pick_reference(
                preset,
                target_length,
                target_charge,
                target_hydro_pct=target_hydro_pct,
                length_min=length_min,
                length_max=length_max,
            )
        }
    except Exception as e:
        return {"error": str(e)}


ALL_TOOLS = [
    rag_retrieval_tool,
    descriptor_tool,
    peptide_bleu_tool,
    rulebook_tool,
    esmfold_tool,
    dssp_tool,
    blast_novelty_tool,
    reference_selector_tool,
]
