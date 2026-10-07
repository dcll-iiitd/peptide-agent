"""
Component 3: nearest-neighbor novelty with closest-match details.

Extends backend/blast_scorer.py's assess_novelty() (which now also resolves
the top BLAST hit's sequence text, see blast_scorer.py's closest_match_id/
closest_match_sequence fields) with a FAISS property-space fallback via
backend/rag/peptide_retriever.py when BLAST itself isn't installed.

See .claude/plan/week2.md Task 2 for the spec.
"""

import difflib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DATABASE_NAME = "iiitd_105k"


def _label(similarity: float) -> str:
    if similarity >= 0.95:
        return "known"
    if similarity >= 0.70:
        return "similar"
    if similarity >= 0.40:
        return "low_similarity"
    return "novel"


def _lookup_activity_by_sequence(sequence: str) -> str:
    """Look up which activity columns are set for an exact sequence match
    in the source dataset. Best-effort — 'unknown' on any failure
    (dataset missing, pandas unavailable, no exact match)."""
    try:
        import pandas as pd

        from backend.rag.peptide_retriever import ACTIVITY_COLS, DATASET_PATH

        if not os.path.exists(DATASET_PATH):
            return "unknown"
        df = pd.read_csv(DATASET_PATH)
        seq_col = "sequence" if "sequence" in df.columns else df.columns[0]
        match = df[df[seq_col].astype(str).str.upper() == sequence.upper()]
        if match.empty:
            return "unknown"
        row = match.iloc[0]
        activities = [col for col in ACTIVITY_COLS if row.get(col, 0) == 1]
        return ", ".join(activities) if activities else "none"
    except Exception:
        return "unknown"


def _blast_path(sequence: str) -> dict | None:
    from backend.blast_scorer import assess_novelty

    result = assess_novelty(sequence)
    if result.get("error") is not None or result.get("similarity_score") is None:
        return None

    similarity = result["similarity_score"]
    closest_match = result.get("closest_match_sequence")
    if not closest_match:
        return {
            "similarity": similarity,
            "novelty_label": result["novelty_label"],
            "closest_match": "",
            "closest_length": 0,
            "closest_charge": 0,
            "closest_activity": "unknown",
            "is_novel": similarity < 0.40,
            "database": DATABASE_NAME,
            "source": "blast",
        }

    from harness.descriptor import calculate_descriptors

    d = calculate_descriptors(closest_match)
    return {
        "similarity": similarity,
        "novelty_label": result["novelty_label"],
        "closest_match": closest_match,
        "closest_length": d.length,
        "closest_charge": d.net_charge,
        "closest_activity": _lookup_activity_by_sequence(closest_match),
        "is_novel": similarity < 0.40,
        "database": DATABASE_NAME,
        "source": "blast",
    }


def _faiss_fallback(sequence: str) -> dict:
    """Property-space nearest neighbor via the existing RAG FAISS index —
    NOT real sequence alignment. Similarity here is a difflib character-
    overlap ratio against the property-nearest neighbor, a rough proxy used
    only because BLAST itself isn't available; it is not comparable to
    BLAST's identity*coverage score.
    """
    from backend.rag.peptide_retriever import search_similar_peptides
    from harness.descriptor import calculate_descriptors

    d = calculate_descriptors(sequence)
    task = {
        "charge": d.net_charge,
        "hydro_min": d.hydro_pct,
        "hydro_max": d.hydro_pct,
        "length": d.length,
        "activities": [],
    }
    neighbors = search_similar_peptides(task, top_k=1)
    if not neighbors:
        return {
            "similarity": None,
            "novelty_label": "unknown",
            "closest_match": "",
            "closest_length": 0,
            "closest_charge": 0,
            "closest_activity": "unknown",
            "is_novel": True,
            "database": DATABASE_NAME,
            "source": "faiss_fallback",
        }

    nearest = neighbors[0]
    similarity = round(
        difflib.SequenceMatcher(None, sequence.upper(), nearest["sequence"].upper()).ratio(),
        4,
    )
    return {
        "similarity": similarity,
        "novelty_label": _label(similarity),
        "closest_match": nearest["sequence"],
        "closest_length": nearest["length"],
        "closest_charge": nearest["charge"],
        "closest_activity": ", ".join(nearest.get("activities", [])) or "none",
        "is_novel": similarity < 0.40,
        "database": DATABASE_NAME,
        "source": "faiss_fallback",
    }


def assess_novelty_detailed(sequence: str) -> dict:
    """Novelty assessment with full closest-match details.

    Step 1: BLAST against the local 105K database (via the now-extended
    backend/blast_scorer.assess_novelty()).
    Step 2: If BLAST isn't installed/available, fall back to a FAISS
    property-space nearest-neighbor lookup via peptide_retriever.py.
    """
    if not sequence:
        return {
            "similarity": None,
            "novelty_label": "unknown",
            "closest_match": "",
            "closest_length": 0,
            "closest_charge": 0,
            "closest_activity": "unknown",
            "is_novel": True,
            "database": DATABASE_NAME,
            "source": None,
        }

    try:
        from backend.blast_scorer import _check_blast_available

        if _check_blast_available():
            result = _blast_path(sequence)
            if result is not None:
                return result
        return _faiss_fallback(sequence)
    except Exception:
        return _faiss_fallback(sequence)


if __name__ == "__main__":
    result = assess_novelty_detailed("KLLKLLKLLK")
    for k, v in result.items():
        print(f"{k}: {v}")
        
        