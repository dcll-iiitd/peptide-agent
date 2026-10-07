/* ── Compare workflow (Phase 8f) ────────────────────────────────────────────
   Verified harness/commands.py's handle_compare() before writing any
   rendering code, per frontend_phase8f_compare.md's explicit instruction
   (and confirmed live): /compare SEQA SEQB [--ref REF] returns
     { sequence_1: {sequence, descriptors, bleu_score, components},
       sequence_2: {...same shape...} }
   — descriptors + PeptideBLEU only. No rulebook_score/valid, no pLDDT/
   pdb, no novelty anywhere in that response.

   The doc's own mockup includes a "Rulebook ✓ Passed" row, which /compare
   cannot supply at all. Per the doc's documented fallback ("If /compare
   doesn't support all fields above, make two separate /score calls and
   merge results client-side"), this page calls /score twice instead
   (once per candidate) rather than /compare: /score returns the exact
   same descriptors+bleu_score+components as /compare, PLUS
   rulebook_score/rulebook_valid, at the same tool-call cost (/compare's
   _score_one() internally calls the same two tools /score calls, minus
   rulebook_tool) — so two /score calls are a strict superset of one
   /compare call for identical cost. /compare itself is never called.

   pLDDT/pdb and novelty are NOT available from /score either (same gap
   confirmed in Phase 8e for /score and /explain) — the Structure section
   below therefore always renders its "not available" branch; per
   "Never show fake values" / "Do NOT show structural similarity... it
   does not currently", no [View structure] button branch is written at
   all, since there is currently no real data path that could ever reach
   it. Novelty is omitted from the table entirely for the same reason
   ("If a field is not in the response, omit the row"). */
import { slash } from '../services/commands.js';
import { fmtCharge } from '../components/PropertyCard.js';

let compareThreadId = null;

export function renderCompareView(prefillCandidateA) {
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
            <textarea id="compareSeqA" class="generate-textarea compare-textarea" rows="2" placeholder="peptide sequence"></textarea>
          </div>
          <div class="prop-field">
            <label>Candidate B</label>
            <textarea id="compareSeqB" class="generate-textarea compare-textarea" rows="2" placeholder="peptide sequence"></textarea>
          </div>
        </div>
        <label class="analyze-ref-label">Optional reference (for PeptideBLEU):</label>
        <input id="compareRefInput" class="ref-input" placeholder="reference sequence" />
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
}

async function startCompare() {
  const seqA = document.getElementById('compareSeqA').value.trim().toUpperCase();
  const seqB = document.getElementById('compareSeqB').value.trim().toUpperCase();
  if (!seqA || !seqB) { alert('Enter both Candidate A and Candidate B sequences.'); return; }
  const reference = document.getElementById('compareRefInput').value.trim().toUpperCase();

  document.getElementById('compareEmptyState').style.display = 'none';
  document.getElementById('compareActiveState').style.display = 'block';
  document.getElementById('compareResults').innerHTML = '';
  document.getElementById('compareProgressHeader').style.display = 'flex';

  // /score is a stateless, pure-computation command (no LangGraph
  // checkpointer involved, unlike /generate) — safe to run both calls
  // concurrently under the same thread_id.
  if (!compareThreadId) compareThreadId = crypto.randomUUID();

  try {
    const refArg = reference ? ` --ref ${reference}` : '';
    const [resultA, resultB] = await Promise.all([
      slash(`/score ${seqA}${refArg}`, compareThreadId),
      slash(`/score ${seqB}${refArg}`, compareThreadId),
    ]);
    document.getElementById('compareProgressHeader').style.display = 'none';
    renderCompareResults(resultA, resultB, !!reference);
  } catch (err) {
    document.getElementById('compareProgressHeader').style.display = 'none';
    document.getElementById('compareResults').innerHTML = `
      <div class="result-card">
        <div class="result-card-header" style="color:var(--red)"><span class="result-icon">⚠️</span> ERROR</div>
        <p class="error-message">Could not reach the PepForge server. Make sure the backend is running.</p>
      </div>`;
  }
}

function buildCompareRows(a, b, referenceProvided) {
  const da = (a && a.descriptors) || {};
  const db = (b && b.descriptors) || {};
  const rows = [
    {
      label: 'Length',
      a: da.length != null ? da.length + ' aa' : '–',
      b: db.length != null ? db.length + ' aa' : '–',
    },
    {
      label: 'Net charge',
      a: da.net_charge != null ? fmtCharge(da.net_charge) : '–',
      b: db.net_charge != null ? fmtCharge(db.net_charge) : '–',
    },
    {
      label: 'Hydrophobicity',
      a: da.hydro_pct != null ? da.hydro_pct + '%' : '–',
      b: db.hydro_pct != null ? db.hydro_pct + '%' : '–',
    },
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
  return rows;
}

function renderCompareResults(a, b, referenceProvided) {
  const el = document.getElementById('compareResults');
  const rows = buildCompareRows(a, b, referenceProvided);

  el.innerHTML = `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧪</span> COMPARISON</div>
      <table class="compare-table">
        <thead>
          <tr><th></th><th>Candidate A</th><th>Candidate B</th></tr>
        </thead>
        <tbody>
          <tr>
            <td class="compare-row-label">Sequence</td>
            <td class="compare-seq-cell">${(a && a.sequence) || '–'}</td>
            <td class="compare-seq-cell">${(b && b.sequence) || '–'}</td>
          </tr>
          ${rows.map(r => `
            <tr>
              <td class="compare-row-label">${r.label}</td>
              <td>${r.a}</td>
              <td>${r.b}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧬</span> STRUCTURE</div>
      <div class="compare-structure-row">
        <div class="compare-structure-col">
          <span class="spec-label">Candidate A</span>
          <p class="text-muted">Structure not available</p>
        </div>
        <div class="compare-structure-col">
          <span class="spec-label">Candidate B</span>
          <p class="text-muted">Structure not available</p>
        </div>
      </div>
    </div>
  `;
}

window.startCompare = startCompare;
