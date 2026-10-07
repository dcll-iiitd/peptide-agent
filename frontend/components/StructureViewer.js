/* ── 3Dmol.js structure viewer + DSSP bars + residue strip (Phase 8a
   extraction, logic unchanged from Phase 5). Module-local state
   (currentPdb/structureViewer/lastResult) replaces what were page-global
   variables in the old monolithic app.js — same lifetime, just scoped to
   this file since only its own exports touch them. lastResult is set once
   per renderStructureTab() call (i.e. once per finished generation,
   before any residue chip could be clicked), so inspectResidue() always
   reads the result that produced the strip it was clicked from. */
let currentPdb = null;
let structureViewer = null;
let lastResult = null;

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

export function renderResidueStripHtml(r) {
  if (!r.ss_string) return `<p class="text-muted">Per-residue structure not available.</p>`;
  const seq = r.sequence || '';
  return r.ss_string.split('').map((c, i) => {
    // pydssp 3-state codes, verified against backend/dssp_scorer.py: 'H' =
    // helix, 'E' = sheet, everything else (incl. '-') = coil.
    const cls = c === 'H' ? 'residue-helix' : c === 'E' ? 'residue-sheet' : 'residue-coil';
    const aa = seq[i] || '?';
    return `<span class="residue-chip ${cls}" onclick="inspectResidue(${i})">${aa}</span>`;
  }).join('');
}

export function renderStructureTab(r, containerId = 'tabStructure') {
  // containerId is parametrized (Phase 8e, for Analyze's reuse) but the
  // nested ids below (structureViewer/residueStrip/residueInfo) are still
  // literal constants — safe today because every caller other than
  // Generate's own tab always has pdb_string=null and returns via the
  // branch below before reaching them. True multi-instance support (two
  // real structure viewers live in the DOM at once) is Phase 8h's job.
  lastResult = r;
  const el = document.getElementById(containerId);
  if (!r.pdb_string) {
    el.innerHTML = `<p class="text-muted">${r.plddt_interp || 'Structural analysis unavailable. The peptide result is still complete.'}</p>`;
    return;
  }

  el.innerHTML = `
    <div class="structure-layout">
      <div class="structure-viewer-col">
        <div class="structure-viewer" id="structureViewer"></div>
        <div class="structure-viewer-actions">
          <button class="btn-chip" onclick="resetStructureView()">Reset</button>
          <button class="btn-chip" onclick="downloadPdb()">Download PDB</button>
        </div>
      </div>
      <div class="structure-info-col">
        <div class="tab-section-label">STRUCTURAL CONFIDENCE</div>
        <div class="spec-row"><span class="spec-label">ESMFold pLDDT</span><span class="spec-value">${r.plddt_score != null ? r.plddt_score.toFixed(1) : '–'}</span></div>
        <div class="spec-row"><span class="spec-label">Confidence</span><span class="spec-value">${r.plddt_confidence || '–'}</span></div>
        <div class="tab-section-label" style="margin-top:14px">PREDICTED SECONDARY STRUCTURE (DSSP)</div>
        ${renderSsBarsHtml(r)}
      </div>
    </div>
    <div class="tab-section-label" style="margin-top:16px">RESIDUE INSPECTION</div>
    <div id="residueStrip" class="residue-strip">${renderResidueStripHtml(r)}</div>
    <div id="residueInfo" class="residue-info">Select a residue above to inspect it.</div>
  `;

  renderStructureViewer(r.pdb_string);
}

export function renderStructureViewer(pdbText) {
  currentPdb = pdbText || null;
  const container = document.getElementById('structureViewer');
  if (!container) return;
  container.innerHTML = '';

  if (typeof $3Dmol === 'undefined') {
    container.innerHTML = '<div class="trace-empty">3Dmol.js failed to load (check network/CDN access)</div>';
    return;
  }

  structureViewer = $3Dmol.createViewer(container, { backgroundColor: '#000000' });
  structureViewer.addModel(pdbText, 'pdb');
  structureViewer.setStyle({}, {
    cartoon: {
      colorfunc: (atom) => {
        const b = atom.b;
        if (b >= 90) return '#00e5c3';
        if (b >= 70) return '#3b82f6';
        if (b >= 50) return '#fbbf24';
        return '#ef4444';
      },
    },
  });
  structureViewer.zoomTo();
  structureViewer.render();
}

export function resetStructureView() {
  if (!structureViewer) return;
  structureViewer.zoomTo();
  structureViewer.render();
}

export function inspectResidue(index) {
  const r = lastResult;
  const info = document.getElementById('residueInfo');
  if (!r || !info) return;
  const aa = (r.sequence || '')[index] || '?';
  const code = r.ss_string ? r.ss_string[index] : null;
  const ssLabel = code === 'H' ? 'Helix' : code === 'E' ? 'Sheet' : code ? 'Coil' : 'Not available';
  info.innerHTML = `
    <div class="spec-row"><span class="spec-label">Residue</span><span class="spec-value">${index + 1}</span></div>
    <div class="spec-row"><span class="spec-label">Amino acid</span><span class="spec-value">${aa} — ${AA_NAMES[aa] || 'Not available'}</span></div>
    <div class="spec-row"><span class="spec-label">Secondary structure</span><span class="spec-value">${ssLabel}</span></div>
    <div class="spec-row"><span class="spec-label">PDB chain</span><span class="spec-value">A:${index + 1}</span></div>
  `;
}

export function downloadPdb() {
  if (!currentPdb) return;
  const blob = new Blob([currentPdb], { type: 'chemical/x-pdb' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const seq = document.getElementById('resultSequence')?.textContent.trim();
  a.download = `${seq || 'structure'}.pdb`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

window.resetStructureView = resetStructureView;
window.downloadPdb = downloadPdb;
window.inspectResidue = inspectResidue;
