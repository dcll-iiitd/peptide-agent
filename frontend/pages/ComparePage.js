/* ── Compare workflow (Phase 8f, extended by Phase 8f v2) ──────────────────
   Verified harness/commands.py's handle_compare() before writing any
   rendering code, per frontend_phase8f_compare.md's explicit instruction
   (and confirmed live): /compare SEQA SEQB [--ref REF] returns
     { sequence_1: {sequence, descriptors, bleu_score, components},
       sequence_2: {...same shape...} }
   — descriptors + PeptideBLEU only. No rulebook_score/valid, no pLDDT/
   pdb, no novelty anywhere in that response. /score is a strict superset
   (same descriptors+bleu_score+components, PLUS rulebook_score/
   rulebook_valid) at the same tool-call cost, so /compare itself is still
   never called — this page calls /score per candidate instead.

   v2 additions (frontend_phase8f_compare_v2.md), layered on top of the
   v1 base already in place (findBySequence() storage reuse for
   structure/novelty, humanizeCommandError()-based error messages, the
   both-candidates-known auto-run from a Generate/Analyze "Compare"
   action):
     - /explain is now also called per candidate (skipped when a stored
       experiment already has a diagnostic) to get real violations detail
       for the Rulebook section, instead of just pass/fail — the same
       tool renderRulebookSectionHtml() (exported from AnalyzePage.js)
       already renders for Analyze/History/the slash-command bar.
       Structure/novelty remain storage-only: no slash command anywhere
       in this codebase runs ESMFold/BLAST/FAISS outside a full /generate
       run, so missing structure/novelty here is reported honestly
       ("Generate this sequence") rather than wiring a dead button.
     - Any newly-fetched /score+/explain data is persisted back via
       saveExperiment() (mirrors AnalyzePage.js's pattern) so a repeat
       Compare on the same sequence is instant next time.
     - Added: visual property bars, target/constraint fit (when a
       candidate carries a stored generation spec), a richer sequence
       comparison (identity % + padded alignment, not just "lengths
       differ"), full PeptideBLEU component tables, rulebook violations,
       a factual strengths/trade-offs list, a same/different-activity-
       aware recommendation, Analyze/Refine/Export actions, and a
       "select from recent experiments" input method alongside pasting a
       sequence directly.
     - buildCompareRows() stays exported with its existing signature even
       though its original second caller is gone: /compare was removed
       from the slash-command surface entirely (harness/commands.py's
       dispatch and the command palette in components/CommandForms.js no
       longer recognize it — typing it now returns the normal "unknown
       command" error). This page never called the /compare command
       itself anyway (see above — it always used /score per candidate),
       so that removal has zero effect on this page's own behavior.

   No manual reference input on this page (removed — handle_score() now
   auto-picks a reference via _pick_reference() whenever none is given,
   so /score per candidate already returns full PeptideBLEU unconditionally;
   PeptideBLEU section visibility is driven by bleu_score presence on the
   candidates, not a user-supplied flag). */
import { slash } from '../services/commands.js';
import { saveExperiment, findBySequence, getExperiments, getPdbString } from '../services/history.js';
import { fmtCharge } from '../components/PropertyCard.js';
import { renderPeptideBleuTab } from '../components/PeptideBLEU.js';
import { renderStructureCard } from '../components/StructureViewer.js';
import { renderNoveltyTab } from '../components/NoveltyCard.js';
import { humanizeCommandError, humanizeNetworkError } from '../components/errorMessages.js';
import { escapeHtml } from '../components/ErrorState.js';
import { renderRulebookSectionHtml } from './AnalyzePage.js';
import { toggleDropdown, closeDropdown } from '../components/Dropdown.js';

let compareThreadId = null;
let lastCandA = null;
let lastCandB = null;

// Bumped on every startCompare() call. getPdbString() is async
// (IndexedDB) — renderCandidateStructureAsync captures the generation at
// call time and checks it again before writing the resolved structure,
// so a slow lookup for a comparison the researcher has since re-run
// can never overwrite whatever is on screen by the time it resolves.
let compareGeneration = 0;

export function renderCompareView(prefillCandidateA, prefillCandidateB) {
  const el = document.getElementById('view-compare');
  el.innerHTML = `
    <div class="generate-empty" id="compareEmptyState">
      <div class="generate-empty-inner">
        <div class="empty-hero-header">
          <div class="empty-hero-icon">🧪</div>
        </div>
        <h1 class="generate-title">Compare Candidates</h1>
        <p class="analyze-subtitle">Compare peptide candidates using PepForge's available scientific metrics.</p>

        <div class="compare-input-grid">
          <div class="prop-field">
            <label>Candidate A</label>
            <div class="compare-history-wrap compare-history-wrap-A">
              <button type="button" class="btn-chip compare-history-trigger" onclick="toggleCompareHistoryDropdown(event, 'A')">
                <span>— or select from recent experiments —</span><span>▾</span>
              </button>
              <div class="compare-history-dropdown" id="compareHistoryDropdownA" style="display:none">${buildHistoryDropdownItemsHtml('A')}</div>
            </div>
            <textarea id="compareSeqA" class="generate-textarea compare-textarea" rows="2" placeholder="peptide sequence"></textarea>
          </div>
          <div class="prop-field">
            <label>Candidate B</label>
            <div class="compare-history-wrap compare-history-wrap-B">
              <button type="button" class="btn-chip compare-history-trigger" onclick="toggleCompareHistoryDropdown(event, 'B')">
                <span>— or select from recent experiments —</span><span>▾</span>
              </button>
              <div class="compare-history-dropdown" id="compareHistoryDropdownB" style="display:none">${buildHistoryDropdownItemsHtml('B')}</div>
            </div>
            <textarea id="compareSeqB" class="generate-textarea compare-textarea" rows="2" placeholder="peptide sequence"></textarea>
          </div>
        </div>
        <div class="generate-input-actions" style="justify-content:center">
          <button class="btn-generate-main" onclick="startCompare()">Compare</button>
        </div>
      </div>
    </div>

    <div class="generate-active" id="compareActiveState" style="display:none">
      <div class="result-card" id="compareProgressCard">
        <div class="result-card-header"><span class="result-icon">⚙️</span> COMPARING CANDIDATES</div>
        <div class="progress-header" id="compareProgressHeader" style="display:none">
          <span class="spinner"></span> PepForge is comparing...
        </div>
      </div>
      <div id="compareResults"></div>
    </div>
  `;

  if (prefillCandidateA) {
    document.getElementById('compareSeqA').value = prefillCandidateA;
  }
  if (prefillCandidateB) {
    document.getElementById('compareSeqB').value = prefillCandidateB;
  }
  if (prefillCandidateA && prefillCandidateB) {
    // Both candidates already known (e.g. from the /compare contextual
    // form) — nothing left for the researcher to fill in, so run
    // immediately rather than making them click again.
    startCompare();
  } else if (prefillCandidateA) {
    // Unlike Analyze, Compare can't auto-trigger with only one candidate
    // known — Candidate B is still unknown — so the natural next step is
    // just to focus that input for the researcher.
    document.getElementById('compareSeqB').focus();
  }
}

/* ── Method B: select from history — custom dropdown (Dropdown.js), not a
   native <select>, specifically so it's positionable: native select
   popups can't be styled/repositioned in any browser, which is what let
   the previous version fall back to the browser's own upward flip near
   the bottom of the viewport. ─────────────────────────────────────────── */
function buildHistoryDropdownItemsHtml(which) {
  const experiments = getExperiments().filter(e => e.sequence).slice().reverse().slice(0, 20);
  if (!experiments.length) {
    return `<div class="history-dropdown-item" style="cursor:default;color:var(--text-muted)">No recent experiments</div>`;
  }
  return experiments.map(e => {
    const seq = e.sequence;
    const short = seq.length > 28 ? seq.slice(0, 28) + '…' : seq;
    const label = `${short} · ${e.activity || 'general'} · ${new Date(e.timestamp).toLocaleDateString()}`;
    return `<div class="history-dropdown-item" onclick="pickCompareHistory('${which}', '${seq}')">${label}</div>`;
  }).join('');
}

function toggleCompareHistoryDropdown(event, which) {
  event.stopPropagation();
  toggleDropdown(`compareHistoryDropdown${which}`, `.compare-history-wrap-${which}`);
}

function pickCompareHistory(which, seq) {
  const textarea = document.getElementById(`compareSeq${which}`);
  if (textarea) textarea.value = seq;
  closeDropdown();
}

/* ── Run the comparison ───────────────────────────────────────────────────── */
async function startCompare() {
  const seqA = document.getElementById('compareSeqA').value.trim().toUpperCase();
  const seqB = document.getElementById('compareSeqB').value.trim().toUpperCase();
  if (!seqA || !seqB) { alert('Enter both Candidate A and Candidate B sequences.'); return; }

  compareGeneration++;
  const generation = compareGeneration;

  document.getElementById('compareEmptyState').style.display = 'none';
  document.getElementById('compareActiveState').style.display = 'block';
  document.getElementById('compareResults').innerHTML = '';
  document.getElementById('compareProgressHeader').style.display = 'flex';

  // /score and /explain are stateless, pure-computation commands (no
  // LangGraph checkpointer involved, unlike /generate) — safe to run all
  // four calls concurrently under the same thread_id.
  if (!compareThreadId) compareThreadId = crypto.randomUUID();

  try {
    // Either candidate may already exist as a full saved experiment (from
    // a real /generate run, or a prior Analyze/Compare) — reuse stored
    // structure/novelty/activity/spec/diagnostic data rather than
    // re-deriving it. findBySequence always returns the most recent
    // match, or null if this exact sequence was never saved.
    const expA = findBySequence(seqA);
    const expB = findBySequence(seqB);
    const needExplainA = !expA || !expA.diagnostic;
    const needExplainB = !expB || !expB.diagnostic;

    // No manual reference input anymore — handle_score() auto-picks a
    // reference (_pick_reference()) whenever none is supplied, so /score
    // already returns full PeptideBLEU plus the reference_used it picked.
    const [resultA, resultB, explainA, explainB] = await Promise.all([
      slash(`/score ${seqA}`, compareThreadId),
      slash(`/score ${seqB}`, compareThreadId),
      needExplainA ? slash(`/explain ${seqA}`, compareThreadId) : Promise.resolve(null),
      needExplainB ? slash(`/explain ${seqB}`, compareThreadId) : Promise.resolve(null),
    ]);
    document.getElementById('compareProgressHeader').style.display = 'none';

    if (resultA.error || resultB.error) {
      const rawErr = resultA.error || resultB.error;
      renderCompareErrorHtml(humanizeCommandError('/score', rawErr), rawErr);
      return;
    }

    const candA = buildCandidate(seqA, resultA, expA, explainA);
    const candB = buildCandidate(seqB, resultB, expB, explainB);

    // Persist newly-fetched enrichment so the next Compare on this exact
    // sequence is instant — a pure storage hit shouldn't create a
    // duplicate entry, so this only fires when something was actually
    // (re)computed.
    if (!expA || needExplainA) saveCandidateExperiment(candA);
    if (!expB || needExplainB) saveCandidateExperiment(candB);

    renderCompareResults(candA, candB, generation);
  } catch (err) {
    document.getElementById('compareProgressHeader').style.display = 'none';
    renderCompareErrorHtml(humanizeNetworkError(), String(err));
  }
}

function renderCompareErrorHtml(message, technical) {
  document.getElementById('compareResults').innerHTML = `
    <div class="result-card">
      <div class="result-card-header" style="color:var(--red)"><span class="result-icon">⚠️</span> ERROR</div>
      <p class="error-message">${message}</p>
      ${technical ? `<details class="error-technical"><summary>Technical details ▾</summary><pre>${escapeHtml(technical)}</pre></details>` : ''}
    </div>`;
}

/* ── Merge /score + /explain + stored-experiment data into one candidate ──── */
function buildCandidate(sequence, scoreResult, exp, explainResult) {
  const descriptors = scoreResult.descriptors || (exp && exp.descriptors) || null;
  const diagnostic = explainResult ? explainResult.diagnostic : (exp && exp.diagnostic) || null;
  const explanation = explainResult ? explainResult.explanation : (exp && exp.explanation) || null;
  const spec = (exp && exp.spec) || null;
  return {
    sequence,
    descriptors,
    bleu_score: scoreResult.bleu_score != null ? scoreResult.bleu_score : null,
    components: scoreResult.components || {},
    rulebook_score: scoreResult.rulebook_score != null ? scoreResult.rulebook_score : null,
    rulebook_valid: scoreResult.rulebook_valid != null ? scoreResult.rulebook_valid : null,
    diagnostic,
    explanation,
    reference_used: scoreResult.reference_used || (exp && exp.reference_used) || '',

    thread_id: exp ? exp.thread_id : null,
    has_pdb: !!(exp && exp.has_pdb),
    plddt_score: exp ? exp.plddt_score : null,
    plddt_confidence: exp ? exp.plddt_confidence : null,
    plddt_interp: exp ? exp.plddt_interp : null,
    helix_pct: exp ? exp.helix_pct : null,
    sheet_pct: exp ? exp.sheet_pct : null,
    coil_pct: exp ? exp.coil_pct : null,
    ss_string: exp ? exp.ss_string : null,

    novelty_score: exp ? exp.novelty_score : null,
    novelty_label: exp ? exp.novelty_label : null,
    novelty_source: exp ? exp.novelty_source : null,
    closest_match: exp ? exp.closest_match : null,

    spec,
    activity: (spec && spec.activity) || (exp && exp.activity) || '',

    fromStorage: !!exp,
    storedAt: exp ? exp.timestamp : null,
  };
}

// Compare never computes a fresh structure itself (no slash command runs
// ESMFold) — pdb_string is deliberately omitted here rather than copying
// the stored candidate's existing blob forward under a new thread_id,
// which would just duplicate the same structure across two IndexedDB
// entries for no benefit. The original record (and its own IndexedDB
// entry, if any) is untouched; this only adds a new record for whatever
// /score+/explain just computed.
function saveCandidateExperiment(cand) {
  saveExperiment({
    thread_id: crypto.randomUUID(),
    source: 'compare',
    sequence: cand.sequence,
    score: cand.bleu_score,
    status: 'analyzed',
    rulebook_score: cand.rulebook_score,
    rulebook_passed: cand.rulebook_valid,
    reference_used: cand.reference_used,
    components: cand.components,
    descriptors: cand.descriptors,
    descriptors_partial: false,
    diagnostic: cand.diagnostic,
    explanation: cand.explanation,
    novelty_score: cand.novelty_score,
  }, cand.spec);
}

/* ── Section 1: quick summary table ───────────────────────────────────────── */
// Exported and genuinely reused by components/SlashResultCard.js for the
// raw /compare command's own thinner result shape (sequence_1/sequence_2
// — descriptors + bleu_score only). Fields that shape never carries
// (activity, rulebook_valid, novelty_label, plddt_score) are simply
// undefined there, so those rows/cells fall back to '–' or are omitted,
// exactly like the pre-existing rows already did — no behavior change
// for that caller.
export function buildCompareRows(a, b, referenceProvided) {
  const da = (a && a.descriptors) || {};
  const db = (b && b.descriptors) || {};
  const rows = [
    { label: 'Activity', a: (a && a.activity) || '–', b: (b && b.activity) || '–' },
    { label: 'Length', a: da.length != null ? da.length + ' aa' : '–', b: db.length != null ? db.length + ' aa' : '–' },
    { label: 'Net charge', a: da.net_charge != null ? fmtCharge(da.net_charge) : '–', b: db.net_charge != null ? fmtCharge(db.net_charge) : '–' },
    { label: 'Hydrophobicity', a: da.hydro_pct != null ? da.hydro_pct + '%' : '–', b: db.hydro_pct != null ? db.hydro_pct + '%' : '–' },
  ];
  // PeptideBLEU is genuinely absent from the response shape (bleu_score
  // stays null) whenever no reference was given — gated on that, not on
  // per-candidate nullity, since it's a deliberate "not computed" state
  // for the whole comparison rather than a per-candidate failure.
  if (referenceProvided) {
    rows.push({
      label: 'PeptideBLEU',
      a: a && a.bleu_score != null ? a.bleu_score.toFixed(4) : '–',
      b: b && b.bleu_score != null ? b.bleu_score.toFixed(4) : '–',
    });
  }
  rows.push({
    label: 'Rulebook',
    a: a && a.rulebook_valid === true ? '✓ Passed' : a && a.rulebook_valid === false ? '✗ Failed' : '–',
    b: b && b.rulebook_valid === true ? '✓ Passed' : b && b.rulebook_valid === false ? '✗ Failed' : '–',
  });
  if ((a && a.novelty_label) || (b && b.novelty_label)) {
    rows.push({ label: 'Novelty', a: (a && a.novelty_label) || '–', b: (b && b.novelty_label) || '–' });
  }
  if ((a && a.plddt_score != null) || (b && b.plddt_score != null)) {
    rows.push({
      label: 'pLDDT',
      a: a && a.plddt_score != null ? a.plddt_score.toFixed(1) : '–',
      b: b && b.plddt_score != null ? b.plddt_score.toFixed(1) : '–',
    });
  }
  return rows;
}

function renderProvenanceHtml(a, b) {
  const line = (cand, label) => cand.fromStorage
    ? `${label}: from a previous experiment (${new Date(cand.storedAt).toLocaleString()})`
    : `${label}: scored just now (not previously stored)`;
  return `<p class="tab-hint">${line(a, 'Candidate A')}<br>${line(b, 'Candidate B')}</p>`;
}

/* ── Section 2: property comparison with visual bars ──────────────────────── */
function barRowHtml(aDisplay, bDisplay, aVal, bVal, maxScale) {
  const aPct = aVal != null ? Math.min(100, Math.abs(aVal) / maxScale * 100) : 0;
  const bPct = bVal != null ? Math.min(100, Math.abs(bVal) / maxScale * 100) : 0;
  return `
    <div class="comp-row"><span class="comp-label">Candidate A</span><div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${aPct}%"></div></div><span class="comp-val">${aDisplay}</span></div>
    <div class="comp-row"><span class="comp-label">Candidate B</span><div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${bPct}%"></div></div><span class="comp-val">${bDisplay}</span></div>
  `;
}

function renderPropertyBarsHtml(a, b, referenceProvided) {
  const da = a.descriptors || {};
  const db = b.descriptors || {};
  let html = '';

  if (da.net_charge != null || db.net_charge != null) {
    const scale = Math.max(10, Math.abs(da.net_charge || 0), Math.abs(db.net_charge || 0));
    html += `<div class="tab-section-label">CHARGE</div>` + barRowHtml(
      da.net_charge != null ? fmtCharge(da.net_charge) : '–',
      db.net_charge != null ? fmtCharge(db.net_charge) : '–',
      da.net_charge, db.net_charge, scale
    );
  }
  if (da.hydro_pct != null || db.hydro_pct != null) {
    html += `<div class="tab-section-label" style="margin-top:14px">HYDROPHOBICITY</div>` + barRowHtml(
      da.hydro_pct != null ? da.hydro_pct + '%' : '–',
      db.hydro_pct != null ? db.hydro_pct + '%' : '–',
      da.hydro_pct, db.hydro_pct, 100
    );
  }
  if (referenceProvided && (a.bleu_score != null || b.bleu_score != null)) {
    html += `<div class="tab-section-label" style="margin-top:14px">PEPTIDEBLEU</div>` + barRowHtml(
      a.bleu_score != null ? a.bleu_score.toFixed(4) : '–',
      b.bleu_score != null ? b.bleu_score.toFixed(4) : '–',
      a.bleu_score != null ? a.bleu_score * 100 : null,
      b.bleu_score != null ? b.bleu_score * 100 : null,
      100
    );
  }
  if (da.gravy != null || db.gravy != null || da.aromaticity != null || db.aromaticity != null || da.mol_weight != null || db.mol_weight != null) {
    html += `
      <div class="tab-section-label" style="margin-top:14px">ADDITIONAL DESCRIPTORS</div>
      <div class="spec-grid">
        <div class="spec-row"><span class="spec-label">GRAVY (A / B)</span><span class="spec-value">${da.gravy ?? '–'} / ${db.gravy ?? '–'}</span></div>
        <div class="spec-row"><span class="spec-label">Aromaticity (A / B)</span><span class="spec-value">${da.aromaticity != null ? (da.aromaticity * 100).toFixed(1) + '%' : '–'} / ${db.aromaticity != null ? (db.aromaticity * 100).toFixed(1) + '%' : '–'}</span></div>
        <div class="spec-row"><span class="spec-label">Mol. weight (A / B)</span><span class="spec-value">${da.mol_weight != null ? da.mol_weight + ' Da' : '–'} / ${db.mol_weight != null ? db.mol_weight + ' Da' : '–'}</span></div>
      </div>
    `;
  }
  return html || '<p class="text-muted">Descriptor data unavailable for both candidates.</p>';
}

/* ── Section 3: sequence comparison (client-side, no backend) ─────────────── */
function renderSequenceComparisonHtml(seqA, seqB) {
  const maxLen = Math.max(seqA.length, seqB.length);
  let matches = 0;
  let aHtml = '';
  let bHtml = '';
  for (let i = 0; i < maxLen; i++) {
    const ca = seqA[i];
    const cb = seqB[i];
    const bothPresent = ca != null && cb != null;
    const match = bothPresent && ca === cb;
    if (match) matches++;
    const style = bothPresent
      ? (match ? '' : 'background:rgba(239,68,68,0.3);border-radius:2px')
      : 'opacity:0.35';
    aHtml += `<span style="${style}">${ca != null ? ca : '·'}</span>`;
    bHtml += `<span style="${style}">${cb != null ? cb : '·'}</span>`;
  }
  const identity = maxLen > 0 ? (matches / maxLen * 100) : 0;
  return `
    <div class="spec-row"><span class="spec-label">Sequence identity</span><span class="spec-value">${identity.toFixed(1)}% (${matches}/${maxLen} positions)</span></div>
    <div class="spec-row"><span class="spec-label">Length difference</span><span class="spec-value">${Math.abs(seqA.length - seqB.length)} aa</span></div>
    <div class="result-sequence" style="margin-top:10px">${aHtml}</div>
    <div class="result-sequence" style="margin-top:4px">${bHtml}</div>
    <p class="tab-hint">Positions highlighted in red differ between candidates. This is a simple position-by-position comparison (shorter sequence padded with ·), not a biological sequence alignment — no structural or functional correspondence is implied.</p>
  `;
}

/* ── Section 4: PeptideBLEU comparison ────────────────────────────────────── */
function renderBleuWrapHtml(a, b) {
  const hasAny = (a.components && Object.keys(a.components).length) || (b.components && Object.keys(b.components).length);
  if (!hasAny) {
    return `<p class="text-muted">PeptideBLEU not computed for these candidates.</p>`;
  }
  return `
    <div class="compare-structure-row">
      <div class="compare-structure-col"><div class="structure-candidate-label">Candidate A</div><div id="compareBleuA"></div></div>
      <div class="compare-structure-col"><div class="structure-candidate-label">Candidate B</div><div id="compareBleuB"></div></div>
    </div>
  `;
}

/* ── Section 8: actions ────────────────────────────────────────────────────── */
function renderGenerateSequenceButtonHtml(seq, label) {
  return `<button class="btn-chip" style="margin-top:8px" onclick="generateFromCompare('${seq}')">${label || 'Generate this sequence'}</button>`;
}

function generateFromCompare(seq) {
  const input = document.getElementById('genInput');
  if (input) input.value = `Generate a sequence similar to: ${seq}`;
  window.navigateTo('generate');
}

function analyzeFromCompare(which) {
  const cand = which === 'A' ? lastCandA : lastCandB;
  if (!cand) return;
  window.navigateTo('analyze', { sequence: cand.sequence });
}

function refineFromCompare(which) {
  const cand = which === 'A' ? lastCandA : lastCandB;
  if (!cand) return;
  const input = document.getElementById('genInput');
  if (input) {
    const s = cand.spec;
    const specNote = s ? ` (target: ${s.activity || 'general'}, length ${s.length_min}-${s.length_max}, charge ${s.charge_min}..${s.charge_max}, hydro ${s.hydro_min}-${s.hydro_max}%)` : '';
    input.value = `Refine this candidate: ${cand.sequence}${specNote}`;
  }
  window.navigateTo('generate');
}

function exportCompareReport() {
  if (!lastCandA || !lastCandB) return;
  const a = lastCandA;
  const b = lastCandB;
  const da = a.descriptors || {};
  const db = b.descriptors || {};
  const row = (label, av, bv) => `${label}: A=${av}  B=${bv}`;

  const lines = [
    'PepForge Candidate Comparison',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    '>CandidateA',
    a.sequence,
    '>CandidateB',
    b.sequence,
    '',
    row('Length', da.length ?? '–', db.length ?? '–'),
    row('Net charge', da.net_charge != null ? fmtCharge(da.net_charge) : '–', db.net_charge != null ? fmtCharge(db.net_charge) : '–'),
    row('Hydrophobicity', da.hydro_pct != null ? da.hydro_pct + '%' : '–', db.hydro_pct != null ? db.hydro_pct + '%' : '–'),
    row('Rulebook', a.rulebook_valid === true ? 'Passed' : a.rulebook_valid === false ? 'Failed' : '–', b.rulebook_valid === true ? 'Passed' : b.rulebook_valid === false ? 'Failed' : '–'),
    row('PeptideBLEU', a.bleu_score != null ? a.bleu_score.toFixed(4) : '–', b.bleu_score != null ? b.bleu_score.toFixed(4) : '–'),
    row('Novelty', a.novelty_label || '–', b.novelty_label || '–'),
    row('pLDDT', a.plddt_score != null ? a.plddt_score.toFixed(1) : '–', b.plddt_score != null ? b.plddt_score.toFixed(1) : '–'),
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pepforge_compare_${a.sequence.slice(0, 8)}_vs_${b.sequence.slice(0, 8)}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function renderActionsHtml() {
  return `
    <div class="generate-input-actions" style="justify-content:center;flex-wrap:wrap;gap:10px">
      <button class="btn-chip" onclick="analyzeFromCompare('A')">Analyze A</button>
      <button class="btn-chip" onclick="analyzeFromCompare('B')">Analyze B</button>
      <button class="btn-chip" onclick="refineFromCompare('A')">Refine A</button>
      <button class="btn-chip" onclick="refineFromCompare('B')">Refine B</button>
      <button class="btn-chip" onclick="exportCompareReport()">Export</button>
    </div>
  `;
}

// Renders one candidate's structure card, loading the actual PDB text
// from IndexedDB asynchronously when has_pdb says it exists. `generation`
// guards against a slow lookup from a superseded comparison overwriting
// whatever's currently on screen (see compareGeneration above).
function renderCandidateStructureAsync(containerId, actionsId, cand, label, unavailableReasonFn, generation) {
  const baseProps = {
    meanPlddt: cand.plddt_score, confidenceLabel: cand.plddt_confidence,
    helixPct: cand.helix_pct, sheetPct: cand.sheet_pct, coilPct: cand.coil_pct,
    ssString: cand.ss_string, sequence: cand.sequence, candidateLabel: label,
  };
  if (cand.has_pdb && cand.thread_id) {
    renderStructureCard(containerId, { ...baseProps, isLoading: true });
    document.getElementById(actionsId).innerHTML = '';
    getPdbString(cand.thread_id).then((pdbString) => {
      if (generation !== compareGeneration) return; // superseded by a newer comparison
      renderStructureCard(containerId, {
        ...baseProps,
        pdbString,
        error: pdbString ? null : (cand.plddt_interp || 'Stored structure could not be loaded.'),
      });
      document.getElementById(actionsId).innerHTML = pdbString ? '' : renderGenerateSequenceButtonHtml(cand.sequence);
    });
  } else {
    renderStructureCard(containerId, {
      ...baseProps,
      pdbString: null,
      error: cand.plddt_interp || unavailableReasonFn(cand),
    });
    document.getElementById(actionsId).innerHTML = renderGenerateSequenceButtonHtml(cand.sequence);
  }
}

/* ── Orchestrator — assembles all 8 sections ──────────────────────────────── */
function renderCompareResults(a, b, generation) {
  // Both candidates go through /score, which now auto-picks a reference
  // (handle_score() → _pick_reference()) whenever none is stored, so
  // PeptideBLEU availability is read off the candidates themselves rather
  // than a user-supplied flag.
  const bleuAvailable = a.bleu_score != null || b.bleu_score != null;
  lastCandA = a;
  lastCandB = b;
  const el = document.getElementById('compareResults');

  el.innerHTML = `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧪</span> QUICK SUMMARY</div>
      <div id="compareProvenance"></div>
      <div id="compareQuickTable"></div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📈</span> PROPERTY COMPARISON</div>
      <div id="comparePropertyBars"></div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧬</span> SEQUENCE COMPARISON</div>
      <div id="compareSeqCompare"></div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📊</span> PEPTIDEBLEU</div>
      <div id="compareBleuWrap"></div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">✅</span> RULEBOOK VALIDATION</div>
      <div class="compare-structure-row" id="compareRulebookWrap"></div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧬</span> STRUCTURE</div>
      <div class="compare-structure-row">
        <div class="compare-structure-col"><div id="compareStructureA"></div><div id="compareStructureActionsA"></div></div>
        <div class="compare-structure-col"><div id="compareStructureB"></div><div id="compareStructureActionsB"></div></div>
      </div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🔎</span> NOVELTY</div>
      <div class="compare-structure-row" id="compareNoveltyWrap"></div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">⚡</span> ACTIONS</div>
      ${renderActionsHtml()}
    </div>
  `;

  // Section 1
  document.getElementById('compareProvenance').innerHTML = renderProvenanceHtml(a, b);
  document.getElementById('compareQuickTable').innerHTML = `
    <table class="compare-table">
      <thead><tr><th></th><th>Candidate A</th><th>Candidate B</th></tr></thead>
      <tbody>
        <tr>
          <td class="compare-row-label">Sequence</td>
          <td class="compare-seq-cell">${a.sequence}</td>
          <td class="compare-seq-cell">${b.sequence}</td>
        </tr>
        ${buildCompareRows(a, b, bleuAvailable).map(r => `
          <tr>
            <td class="compare-row-label">${r.label}</td>
            <td>${r.a}</td>
            <td>${r.b}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // Section 2
  document.getElementById('comparePropertyBars').innerHTML = renderPropertyBarsHtml(a, b, bleuAvailable);

  // Section 3
  document.getElementById('compareSeqCompare').innerHTML = renderSequenceComparisonHtml(a.sequence, b.sequence);

  // Section 4
  document.getElementById('compareBleuWrap').innerHTML = renderBleuWrapHtml(a, b);
  if (document.getElementById('compareBleuA')) {
    renderPeptideBleuTab({ score: a.bleu_score, components: a.components, reference_used: a.reference_used }, 'compareBleuA');
    renderPeptideBleuTab({ score: b.bleu_score, components: b.components, reference_used: b.reference_used }, 'compareBleuB');
  }

  // Section 5
  document.getElementById('compareRulebookWrap').innerHTML = `
    <div class="compare-structure-col"><div class="structure-candidate-label">Candidate A</div><div id="compareRulebookA"></div></div>
    <div class="compare-structure-col"><div class="structure-candidate-label">Candidate B</div><div id="compareRulebookB"></div></div>
  `;
  document.getElementById('compareRulebookA').innerHTML = renderRulebookSectionHtml(
    { rulebook_score: a.rulebook_score, rulebook_valid: a.rulebook_valid }, { diagnostic: a.diagnostic }
  );
  document.getElementById('compareRulebookB').innerHTML = renderRulebookSectionHtml(
    { rulebook_score: b.rulebook_score, rulebook_valid: b.rulebook_valid }, { diagnostic: b.diagnostic }
  );

  // Section 6 — structure: real shared component, reused stored data,
  // never a fresh ESMFold call (no such slash command exists). The PDB
  // text itself lives in IndexedDB (services/history.js) — has_pdb is
  // the synchronous signal; the two candidates load independently so one
  // slow/failed lookup never blocks the other.
  const structureUnavailable = (cand) => cand.fromStorage
    ? 'This candidate was not generated with structural prediction, or that data was not stored.'
    : 'Structural prediction is only available for sequences generated with PepForge — paste a previously generated sequence, or generate this one, to see its structure.';
  renderCandidateStructureAsync('compareStructureA', 'compareStructureActionsA', a, 'Candidate A', structureUnavailable, generation);
  renderCandidateStructureAsync('compareStructureB', 'compareStructureActionsB', b, 'Candidate B', structureUnavailable, generation);

  // Section 7 — novelty, storage-only (no slash command computes it)
  document.getElementById('compareNoveltyWrap').innerHTML = `
    <div class="compare-structure-col"><div class="structure-candidate-label">Candidate A</div><div id="compareNoveltyA"></div><div id="compareNoveltyActionsA"></div></div>
    <div class="compare-structure-col"><div class="structure-candidate-label">Candidate B</div><div id="compareNoveltyB"></div><div id="compareNoveltyActionsB"></div></div>
  `;
  const noveltyReason = 'Novelty is not computed via /score or /explain — only available for sequences already generated as a full peptide.';
  const noveltyCheckedA = a.novelty_score != null || !!a.closest_match;
  renderNoveltyTab({
    sequence: a.sequence, novelty_score: a.novelty_score, closest_match: a.closest_match,
    novelty_label: a.novelty_label, novelty_source: a.novelty_source,
    novelty_checked: noveltyCheckedA, novelty_not_checked_reason: noveltyReason,
  }, 'compareNoveltyA');
  document.getElementById('compareNoveltyActionsA').innerHTML = noveltyCheckedA ? '' : renderGenerateSequenceButtonHtml(a.sequence);

  const noveltyCheckedB = b.novelty_score != null || !!b.closest_match;
  renderNoveltyTab({
    sequence: b.sequence, novelty_score: b.novelty_score, closest_match: b.closest_match,
    novelty_label: b.novelty_label, novelty_source: b.novelty_source,
    novelty_checked: noveltyCheckedB, novelty_not_checked_reason: noveltyReason,
  }, 'compareNoveltyB');
  document.getElementById('compareNoveltyActionsB').innerHTML = noveltyCheckedB ? '' : renderGenerateSequenceButtonHtml(b.sequence);
}

window.startCompare = startCompare;
window.toggleCompareHistoryDropdown = toggleCompareHistoryDropdown;
window.pickCompareHistory = pickCompareHistory;
window.generateFromCompare = generateFromCompare;
window.analyzeFromCompare = analyzeFromCompare;
window.refineFromCompare = refineFromCompare;
window.exportCompareReport = exportCompareReport;
