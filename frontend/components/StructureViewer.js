/* ── StructureViewer shared component (Phase 8h) ──────────────────────────
   One component, genuinely multi-instance: used by Generate's Structure
   tab, Analyze, and Compare (two simultaneous instances, Candidate A/B) —
   per-instance state is keyed by containerId in `instances`, replacing
   the old single-instance module-level currentPdb/structureViewer/
   lastResult (which only ever worked because, before this phase, every
   caller except Generate always had pdbString=null and returned before
   creating a real viewer at all).

   Interface matches frontend_phase8h_structure.md's prop list, adapted
   to vanilla JS as renderStructureCard(containerId, props) — a plain
   object of named props rather than a framework component, writing into
   a container element the caller already put in the DOM, exactly like
   every other shared component in this codebase (PropertyCard,
   PeptideBLEU, NoveltyCard).

   pdb field-name normalization (harness=pdb_string, legacy=plddt_pdb)
   happens in the page that calls this component (GeneratePage.js's
   normalizeResult()), per the doc's explicit instruction — not here. */
const instances = new Map(); // containerId -> { viewer, pdbString, sequence, ssString }

export const AA_NAMES = {
  A: 'Alanine', R: 'Arginine', N: 'Asparagine', D: 'Aspartate', C: 'Cysteine',
  E: 'Glutamate', Q: 'Glutamine', G: 'Glycine', H: 'Histidine', I: 'Isoleucine',
  L: 'Leucine', K: 'Lysine', M: 'Methionine', F: 'Phenylalanine', P: 'Proline',
  S: 'Serine', T: 'Threonine', W: 'Tryptophan', Y: 'Tyrosine', V: 'Valine',
};

const SS_BAR_COLORS = {
  helix_pct: '#00e5c3',
  sheet_pct: '#3b82f6',
  turn_pct: '#fbbf24',
  coil_pct: '#64748b',
};
const SS_BAR_LABELS = {
  helix_pct: 'Alpha Helix',
  sheet_pct: 'Beta Sheet',
  turn_pct: 'Turn',
  coil_pct: 'Coil',
};

// Real tiers verified against backend/esmfold_scorer.py's _build_result()/
// _empty() — "very_high"(>=90)/"high"(>=70)/"low"(>=50)/"very_low"(<50)/
// "unknown" (on failure). frontend_phase8h_structure.md's mockup says
// "Very High / High / Medium / Low" with "green >70, amber 50-70, red
// <50" — there is no "medium" tier and no 3-band split in the real data,
// so this uses the actual 4 tiers instead of fabricating a "medium" the
// backend never produces.
const PLDDT_TIERS = {
  very_high: { label: 'Very High', color: '#00e5c3' },
  high: { label: 'High', color: '#34d399' },
  low: { label: 'Low', color: '#fbbf24' },
  very_low: { label: 'Very Low', color: '#ef4444' },
  unknown: { label: 'Unknown', color: '#64748b' },
};

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function renderSsBarsHtml(r) {
  if (!r.dssp_available || r.helix_pct == null) {
    return `<p class="text-muted">Predicted secondary structure not available.</p>`;
  }
  const bar = (key, val) => `
    <div class="comp-row">
      <span class="comp-label">${SS_BAR_LABELS[key]}</span>
      <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(val || 0)}%;background:${SS_BAR_COLORS[key]}"></div></div>
      <span class="comp-val">${(val ?? 0).toFixed(1)}%</span>
    </div>`;
  return bar('helix_pct', r.helix_pct) + bar('sheet_pct', r.sheet_pct) + bar('coil_pct', r.coil_pct);
}

function renderConfidenceHtml(meanPlddt, confidenceLabel) {
  if (meanPlddt == null) {
    return `<p class="text-muted">Confidence not available.</p>`;
  }
  const tier = PLDDT_TIERS[confidenceLabel] || PLDDT_TIERS.unknown;
  return `
    <div class="plddt-hero-row">
      <span class="plddt-hero-value" style="color:${tier.color}">${meanPlddt.toFixed(1)}</span>
      <span class="plddt-badge" style="background:${tier.color}22;color:${tier.color};border-color:${tier.color}">${tier.label}</span>
    </div>
  `;
}

function renderResidueStripHtml(ssString, sequence, containerId) {
  // pydssp 3-state codes, verified against backend/dssp_scorer.py: 'H' =
  // helix, 'E' = sheet, everything else (incl. '-') = coil.
  return ssString.split('').map((c, i) => {
    const cls = c === 'H' ? 'residue-helix' : c === 'E' ? 'residue-sheet' : 'residue-coil';
    const aa = (sequence || '')[i] || '?';
    return `<span class="residue-chip ${cls}" onclick="inspectResidue('${containerId}', ${i})">${aa}</span>`;
  }).join('');
}

/* ── Main entry point ──────────────────────────────────────────────────────── */
export function renderStructureCard(containerId, props) {
  const {
    pdbString = null,
    meanPlddt = null,
    confidenceLabel = null,
    helixPct = null,
    sheetPct = null,
    coilPct = null,
    ssString = null,
    sequence = '',
    candidateLabel = '',
    isLoading = false,
    error = null,
  } = props || {};

  const el = document.getElementById(containerId);
  if (!el) return;

  const labelHtml = candidateLabel ? `<div class="structure-candidate-label">${escapeHtml(candidateLabel)}</div>` : '';

  if (isLoading) {
    el.innerHTML = `${labelHtml}<div class="structure-loading"><span class="spinner"></span> Predicting structure...</div>`;
    return;
  }

  if (!pdbString) {
    el.innerHTML = labelHtml + (error
      ? `<p class="text-muted">Structure unavailable: ${escapeHtml(error)}</p>`
      : `<p class="text-muted">Structural prediction was not performed for this candidate.</p>`);
    return;
  }

  instances.set(containerId, { viewer: null, pdbString, sequence, ssString });

  const viewerId = `${containerId}-viewer`;
  const stripId = `${containerId}-residueStrip`;
  const infoId = `${containerId}-residueInfo`;

  el.innerHTML = `
    ${labelHtml}
    <div class="structure-layout">
      <div class="structure-viewer-col">
        <div class="structure-viewer-label">Predicted structure (ESMFold)</div>
        <div class="structure-viewer" id="${viewerId}"></div>
        <div class="structure-viewer-actions">
          <button class="btn-chip" onclick="resetStructureView('${containerId}')">Reset</button>
          <button class="btn-chip" onclick="toggleStructureFullscreen('${containerId}')">Fullscreen</button>
          <button class="btn-chip" onclick="downloadStructurePdb('${containerId}')">Download PDB</button>
        </div>
      </div>
      <div class="structure-info-col">
        <div class="tab-section-label">ESMFOLD PLDDT</div>
        ${renderConfidenceHtml(meanPlddt, confidenceLabel)}
        <div class="tab-section-label" style="margin-top:14px">PREDICTED SECONDARY STRUCTURE (DSSP)</div>
        ${renderSsBarsHtml({ dssp_available: helixPct != null, helix_pct: helixPct, sheet_pct: sheetPct, coil_pct: coilPct })}
      </div>
    </div>
    ${ssString ? `
      <div class="tab-section-label" style="margin-top:16px">RESIDUE INSPECTION</div>
      <div id="${stripId}" class="residue-strip">${renderResidueStripHtml(ssString, sequence, containerId)}</div>
      <div id="${infoId}" class="residue-info">Select a residue above to inspect it.</div>
    ` : ''}
  `;

  createViewer(containerId, pdbString);
}

function createViewer(containerId, pdbText) {
  const container = document.getElementById(`${containerId}-viewer`);
  if (!container) return;
  container.innerHTML = '';

  if (typeof $3Dmol === 'undefined') {
    container.innerHTML = '<div class="trace-empty">3Dmol.js failed to load (check network/CDN access)</div>';
    return;
  }

  const viewer = $3Dmol.createViewer(container, { backgroundColor: '#000000' });
  viewer.addModel(pdbText, 'pdb');
  viewer.setStyle({}, {
    cartoon: {
      // Colors by per-residue B-factor, which ESMFold's output PDB uses
      // to carry pLDDT confidence (standard AlphaFold/ESMFold convention)
      // — kept over frontend_phase8h_structure.md's plainer "color:
      // spectrum" (rainbow-by-chain-position, ignores confidence
      // entirely) since this is strictly more informative for the same
      // "Predicted structure (ESMFold)" view and was already built/tested.
      colorfunc: (atom) => {
        const b = atom.b;
        if (b >= 90) return '#00e5c3';
        if (b >= 70) return '#3b82f6';
        if (b >= 50) return '#fbbf24';
        return '#ef4444';
      },
    },
  });
  viewer.zoomTo();
  viewer.render();

  const inst = instances.get(containerId);
  if (inst) inst.viewer = viewer;
}

/* ── Per-instance actions (window-exposed for inline onclick) ────────────── */
export function resetStructureView(containerId) {
  const inst = instances.get(containerId);
  if (!inst || !inst.viewer) return;
  inst.viewer.zoomTo();
  inst.viewer.render();
}

export function toggleStructureFullscreen(containerId) {
  const viewerEl = document.getElementById(`${containerId}-viewer`);
  if (!viewerEl) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (viewerEl.requestFullscreen) {
    viewerEl.requestFullscreen();
  }
}

export function downloadStructurePdb(containerId) {
  const inst = instances.get(containerId);
  if (!inst || !inst.pdbString) return;
  const blob = new Blob([inst.pdbString], { type: 'chemical/x-pdb' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const seqPrefix = (inst.sequence || 'structure').slice(0, 10);
  a.download = `pepforge_candidate_${seqPrefix}.pdb`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function inspectResidue(containerId, index) {
  const inst = instances.get(containerId);
  const info = document.getElementById(`${containerId}-residueInfo`);
  if (!inst || !info) return;
  const aa = (inst.sequence || '')[index] || '?';
  const code = inst.ssString ? inst.ssString[index] : null;
  const ssLabel = code === 'H' ? 'Helix' : code === 'E' ? 'Sheet' : code ? 'Coil' : 'Not available';
  info.innerHTML = `
    <div class="spec-row"><span class="spec-label">Residue</span><span class="spec-value">${index + 1}</span></div>
    <div class="spec-row"><span class="spec-label">Amino acid</span><span class="spec-value">${aa} — ${AA_NAMES[aa] || 'Not available'}</span></div>
    <div class="spec-row"><span class="spec-label">Secondary structure</span><span class="spec-value">${ssLabel}</span></div>
    <div class="spec-row"><span class="spec-label">PDB chain</span><span class="spec-value">A:${index + 1}</span></div>
  `;
}

window.resetStructureView = resetStructureView;
window.toggleStructureFullscreen = toggleStructureFullscreen;
window.downloadStructurePdb = downloadStructurePdb;
window.inspectResidue = inspectResidue;
