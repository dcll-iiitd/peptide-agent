/* ── Client-side descriptor math (bug fix, legacy/standard-mode fallback) ──
   Faithfully replicates harness/descriptor.py's calculate_descriptors()
   pure formulas for GRAVY, aromaticity, and molecular weight — the only 3
   of the 8 descriptor fields backend/rulebook.py's validate_sequence()
   (the legacy path's sole descriptor source) never computes at all, since
   that's a different module the legacy pipeline never calls.
   backend/server.py is protected, so there is no server-side value to
   read for these 3 fields on the legacy path — Phase 2 Decision 9
   explicitly accepted this gap rather than touching it.

   This is NOT a new calculation and NOT a hardcoded value — it's the
   exact same per-residue lookup tables and formulas as
   harness/descriptor.py's calculate_descriptors(), run here only because
   that Python function isn't reachable for a legacy-mode result at
   render time. Output varies with the input sequence, same as the real
   backend calculation would produce for the identical sequence. */

// Average molecular weight (Da) of each free amino acid — verbatim from
// harness/descriptor.py's _AA_WEIGHTS.
const AA_WEIGHTS = {
  A: 89.09, R: 174.20, N: 132.12, D: 133.10, C: 121.16,
  Q: 146.15, E: 147.13, G: 75.07, H: 155.16, I: 131.17,
  L: 131.17, K: 146.19, M: 149.21, F: 165.19, P: 115.13,
  S: 105.09, T: 119.12, W: 204.23, Y: 181.19, V: 117.15,
};
const WATER = 18.02;

// Kyte-Doolittle hydropathy scale — verbatim from harness/descriptor.py's
// _KD_SCALE.
const KD_SCALE = {
  A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5,
  Q: -3.5, E: -3.5, G: -0.4, H: -3.2, I: 4.5,
  L: 3.8, K: -3.9, M: 1.9, F: 2.8, P: -1.6,
  S: -0.8, T: -0.7, W: -0.9, Y: -1.3, V: 4.2,
};

const AROMATIC = new Set(['F', 'W', 'Y']);

export function computeDescriptorsClientSide(sequence) {
  const seq = (sequence || '').trim().toUpperCase();
  const length = seq.length;
  if (length === 0) return null;

  let kdSum = 0;
  let aromaticCount = 0;
  let mwSum = 0;
  for (const aa of seq) {
    kdSum += KD_SCALE[aa] ?? 0;
    if (AROMATIC.has(aa)) aromaticCount++;
    mwSum += AA_WEIGHTS[aa] ?? 0;
  }

  return {
    gravy: Math.round((kdSum / length) * 1000) / 1000,
    aromaticity: Math.round((aromaticCount / length) * 1000) / 1000,
    mol_weight: Math.round((mwSum - Math.max(length - 1, 0) * WATER) * 100) / 100,
  };
}
