/* ── Analyze workflow (Phase 8e, reworked in Phase 8 Analyze v2) ──────────
   Analyze does NOT run the generation agent — it only calls scoring/
   analysis tools on an existing sequence via two slash commands:
     /score SEQUENCE     -> descriptors, rulebook score, PeptideBLEU
                             components, reference_used
     /explain SEQUENCE   -> descriptors again, a richer diagnostic
                             (violations), and a plain-English explanation

   v2 change: the "optional reference" input box has been removed
   entirely. Investigated harness/commands.py's handle_score() before
   removing it: at the time, peptide_bleu_tool was only ever invoked `if
   reference else {}` — PeptideBLEU was all-or-nothing, not partially
   computed, so removing the box didn't lose a "6-component partial
   score" that never existed. handle_score() was then fixed (separately,
   same investigation) to auto-pick a reference via
   reference_selector_tool whenever --ref is omitted, using the
   sequence's own descriptors as the match target — so every /score call
   now gets a real reference_used and the full 7-component breakdown in
   practice. renderPeptideBleuTab() (components/PeptideBLEU.js) still
   degrades to an honest "No reference — PeptideBLEU not computed."
   message in the rare case the auto-pick itself returns nothing
   (unrecognized activity preset) — never hidden, never a fabricated
   score. Both render paths below also show "Scored against
   [reference_used]" as a caption under the PeptideBLEU card whenever
   one is present.

   v2 change: two genuinely different section sets depending on whether
   findBySequence() finds a real stored record (descriptors + score) for
   this exact sequence:
     Path A (agent-generated, found in history) — Sequence, Properties,
       Rulebook, PeptideBLEU, Structure, Novelty, Trace, Explanation.
       Structure loads its PDB text from IndexedDB asynchronously
       (getPdbString); Trace is only shown if edit_stats or trace_url
       exist on the record.
     Path B (new/unknown, not in history) — Sequence, Properties,
       Rulebook, PeptideBLEU, Explanation only. Structure/Novelty/Trace
       are never available from /score+/explain (neither command calls
       esmfold_tool/dssp_tool/novelty_tool/blast_novelty_tool — confirmed
       directly against harness/commands.py), so they are omitted
       entirely rather than shown as "not available" placeholders. One
       combined note + [Generate this sequence] button appears at the
       bottom instead. */
import { slash } from '../services/commands.js';
import { saveExperiment, findBySequence, getPdbString } from '../services/history.js';
import { renderPropertiesTab } from '../components/PropertyCard.js';
import { renderPeptideBleuTab } from '../components/PeptideBLEU.js';
import { renderViolationsHtml } from '../components/DiagnosticCard.js';
import { renderStructureCard } from '../components/StructureViewer.js';
import { renderNoveltyTab } from '../components/NoveltyCard.js';
import { humanizeCommandError, humanizeNetworkError } from '../components/errorMessages.js';
import { escapeHtml } from '../components/ErrorState.js';

let analyzeThreadId = null;

// Bumped on every startAnalyze() call. getPdbString() is async
// (IndexedDB) — renderAnalyzeResultsFromStorage captures the generation
// at call time and checks it again before writing the resolved
// structure, so a slow lookup for a sequence the researcher has since
// navigated away from (or re-analyzed) can never overwrite the section
// for whatever is on screen by the time it resolves.
let analyzeGeneration = 0;

export function renderAnalyzeView(prefillSequence) {
  const el = document.getElementById('view-analyze');
  el.innerHTML = `
    <div class="generate-empty" id="analyzeEmptyState">
      <div class="generate-empty-inner">
        <div class="empty-hero-header">
          <div class="empty-hero-icon">🔬</div>
          <div class="empty-hero-tagline">Analyzing existing sequence</div>
        </div>
        <h1 class="generate-title">Analyze Peptide</h1>
        <p class="analyze-subtitle">Inspect an existing peptide sequence using PepForge's scientific analysis tools.</p>

        <div class="generate-input-wrapper">
          <textarea id="analyzeSeqInput" class="generate-textarea" rows="2" placeholder="Paste peptide sequence..."></textarea>
          <div class="generate-input-actions">
            <button class="btn-generate-main" onclick="startAnalyze()">Analyze</button>
          </div>
        </div>
      </div>
    </div>

    <div class="generate-active" id="analyzeActiveState" style="display:none">
      <div class="result-card" id="analyzeProgressCard">
        <div class="result-card-header"><span class="result-icon">⚙️</span> ANALYZING EXISTING SEQUENCE</div>
        <div class="progress-header" id="analyzeProgressHeader" style="display:none">
          <span class="spinner"></span> PepForge is analyzing...
        </div>
        <div class="progress-timeline" id="analyzeProgressTimeline"></div>
      </div>
      <div id="analyzeSections"></div>
    </div>
  `;

  if (prefillSequence) {
    document.getElementById('analyzeSeqInput').value = prefillSequence;
    // Phase 8i: the "Analyze" action button on a candidate result auto-
    // triggers analysis (unlike Refine, which deliberately never
    // auto-starts a real generation) — Analyze is a read-only inspection
    // call, cheap enough to run immediately rather than making the
    // researcher click twice for data they already asked to see.
    startAnalyze();
  }
}

/* ── Loading steps — Analyze's own set, distinct from Generate's
   AgentProgress (different workflow, no shared component listed for this
   in frontend_phase8e_analyze.md). ─────────────────────────────────────── */
const ANALYZE_STEPS = [
  { key: 'validated', label: 'Sequence validated' },
  { key: 'properties', label: 'Properties calculated' },
  { key: 'scoring', label: 'Scoring' },
  { key: 'explanation', label: 'Explanation' },
];

function resetAnalyzeProgress() {
  document.getElementById('analyzeProgressTimeline').innerHTML = ANALYZE_STEPS.map(s => `
    <div class="progress-step" data-step="analyze-${s.key}">
      <span class="progress-step-icon">○</span>
      <span class="progress-step-label">${s.label}</span>
    </div>
  `).join('');
}

function setAnalyzeStep(key, state) {
  // "analyze-" prefix keeps this selector from ever matching Generate's
  // own (hidden, but still-in-DOM) progress-step rows, which use plain
  // unprefixed keys like "input_guardrail".
  const row = document.querySelector(`.progress-step[data-step="analyze-${key}"]`);
  if (!row) return;
  row.classList.remove('completed', 'running', 'failed');
  const icon = row.querySelector('.progress-step-icon');
  if (state === 'completed') { row.classList.add('completed'); icon.textContent = '✓'; }
  else if (state === 'running') { row.classList.add('running'); icon.textContent = '●'; }
  else if (state === 'failed') { row.classList.add('failed'); icon.textContent = '✗'; }
  else { icon.textContent = '○'; }
}

/* ── Run the analysis ──────────────────────────────────────────────────────── */
// forceRefresh=true (from the "Re-analyze" button on a retrieved-from-
// storage result) always runs a fresh /score+/explain pass and saves a
// NEW record — findBySequence() already always surfaces the newest match,
// so there's no need for an "update in place" verb in history.js.
async function startAnalyze(forceRefresh = false) {
  const seq = document.getElementById('analyzeSeqInput').value.trim().toUpperCase();
  if (!seq) { alert('Paste a peptide sequence to analyze.'); return; }

  analyzeGeneration++;
  const generation = analyzeGeneration;

  document.getElementById('analyzeEmptyState').style.display = 'none';
  document.getElementById('analyzeActiveState').style.display = 'block';
  document.getElementById('analyzeSections').innerHTML = '';

  // Check for an already-saved experiment on this exact sequence before
  // running anything — it may carry real structure/novelty data (from a
  // full generation) that Analyze alone could never produce via
  // /score+/explain. "Sufficient data" = has descriptors and a score;
  // older thin (pre-persistence-fix) records won't have `descriptors`
  // at all and fall through to a fresh Path B run below.
  const existing = forceRefresh ? null : findBySequence(seq);
  if (existing && existing.descriptors && existing.score != null) {
    document.getElementById('analyzeProgressHeader').style.display = 'none';
    renderAnalyzeResultsFromStorage(existing, generation);
    return;
  }

  document.getElementById('analyzeProgressHeader').style.display = 'flex';
  resetAnalyzeProgress();
  setAnalyzeStep('validated', 'running');
  setAnalyzeStep('properties', 'running');
  setAnalyzeStep('scoring', 'running');
  setAnalyzeStep('explanation', 'running');

  if (!analyzeThreadId) analyzeThreadId = crypto.randomUUID();

  try {
    // /score and /explain are independent, stateless commands — run them
    // concurrently (same pattern ComparePage.js already uses) rather
    // than waiting on /score before even starting /explain.
    const scorePromise = slash(`/score ${seq}`, analyzeThreadId).then((r) => {
      if (!r.error) {
        setAnalyzeStep('validated', 'completed');
        setAnalyzeStep('properties', 'completed');
        setAnalyzeStep('scoring', 'completed');
      }
      return r;
    });
    const explainPromise = slash(`/explain ${seq}`, analyzeThreadId).then((r) => {
      if (!r.error) setAnalyzeStep('explanation', 'completed');
      return r;
    });
    const [scoreResult, explainResult] = await Promise.all([scorePromise, explainPromise]);

    if (scoreResult.error) {
      setAnalyzeStep('validated', 'failed');
      document.getElementById('analyzeProgressHeader').style.display = 'none';
      renderAnalyzeErrorHtml(humanizeCommandError('/score', scoreResult.error), scoreResult.error);
      return;
    }
    if (explainResult.error) {
      setAnalyzeStep('explanation', 'failed');
      document.getElementById('analyzeProgressHeader').style.display = 'none';
      renderAnalyzeErrorHtml(humanizeCommandError('/explain', explainResult.error), explainResult.error);
      return;
    }

    document.getElementById('analyzeProgressHeader').style.display = 'none';
    renderAnalyzeResults(seq, scoreResult, explainResult);
  } catch (err) {
    document.getElementById('analyzeProgressHeader').style.display = 'none';
    setAnalyzeStep('validated', 'failed');
    renderAnalyzeErrorHtml(humanizeNetworkError(), String(err));
  }
}

function renderAnalyzeErrorHtml(message, technical) {
  document.getElementById('analyzeSections').innerHTML = `
    <div class="result-card">
      <div class="result-card-header" style="color:var(--red)"><span class="result-icon">⚠️</span> ERROR</div>
      <p class="error-message">${message}</p>
      ${technical ? `<details class="error-technical"><summary>Technical details ▾</summary><pre>${escapeHtml(technical)}</pre></details>` : ''}
    </div>`;
}

/* ── Shared section renderers ──────────────────────────────────────────────── */
function renderSequenceSectionHtml(seq, descriptors) {
  const d = descriptors || {};
  const lengthAa = d.length != null ? d.length : seq.length;
  const chargeClass = d.charge_class ? ' · ' + d.charge_class.replace(/_/g, ' ') : '';
  return `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧬</span> SEQUENCE</div>
      <div class="result-sequence">${seq}</div>
      <div class="hero-subtitle">${lengthAa} amino acids${chargeClass}</div>
    </div>
  `;
}

export function renderRulebookSectionHtml(scoreResult, explainResult) {
  const diag = explainResult && explainResult.diagnostic;
  const passed = diag ? diag.passed : null;
  const violationsHtml = diag && !diag.error
    ? renderViolationsHtml(diag.violations)
    : '<p class="text-muted">Validation not available.</p>';
  const rulebookScore = scoreResult && scoreResult.rulebook_score;
  const rulebookValid = scoreResult && scoreResult.rulebook_valid;
  return `
    <div class="spec-row"><span class="spec-label">Status</span><span class="spec-value">${passed === true ? '✓ Passed' : passed === false ? '✗ Failed' : '–'}</span></div>
    ${diag && diag.fitness != null ? `<div class="spec-row"><span class="spec-label">Fitness</span><span class="spec-value">${diag.fitness.toFixed(2)}</span></div>` : ''}
    ${violationsHtml}
    ${rulebookScore != null ? `<p class="tab-hint">Legacy rulebook score: ${rulebookScore.toFixed(2)} (${rulebookValid ? 'valid' : 'invalid'})</p>` : ''}
  `;
}

export function renderExplanationSectionHtml(explainResult) {
  const text = explainResult && explainResult.explanation;
  return `<p class="tab-hint" style="font-size:13px">${text || 'Explanation not available.'}</p>`;
}

// handle_score() (harness/commands.py) now auto-picks a reference via
// reference_selector_tool whenever --ref is omitted, so reference_used
// is populated on essentially every /score response (Path B) as well as
// every stored generation record (Path A) — this caption surfaces which
// canonical reference the score was actually computed against, rather
// than leaving that silent.
function renderBleuCaptionHtml(referenceUsed) {
  return referenceUsed
    ? `<p class="tab-hint" style="margin-top:8px">Scored against <span class="mono-seq">${referenceUsed}</span></p>`
    : '';
}

// Edit-stats/trace-url block — small, local re-implementation of
// HistoryPage.js's renderHistoryTraceHtml() rather than an import:
// HistoryPage.js already imports renderRulebookSectionHtml from THIS
// file, so importing back from HistoryPage.js would create a circular
// module dependency. Same convention already used elsewhere in this
// codebase (components/SlashResultCard.js) when the shared-import path
// is blocked this way.
function renderTraceSectionHtml(exp) {
  let html = '';
  if (exp.trace_url) {
    html += `<p style="margin-bottom:12px"><a href="${exp.trace_url}" target="_blank" rel="noopener" class="trace-link" style="margin-left:0">View in LangSmith →</a></p>`;
  }
  const stats = exp.edit_stats || {};
  if (Object.keys(stats).length === 0) {
    html += '<p class="text-muted">No edit statistics recorded for this experiment.</p>';
  } else {
    html += '<div class="component-scores">' + Object.entries(stats).map(([op, s]) => {
      const deltaStr = s.avg_delta >= 0 ? `+${s.avg_delta.toFixed(4)}` : s.avg_delta.toFixed(4);
      return `<div class="comp-row"><span class="comp-label">${op}</span><span class="comp-val" style="width:auto">${s.count} used · ${s.improvements} improved · avg Δ ${deltaStr}</span></div>`;
    }).join('') + '</div>';
  }
  return html;
}

function renderGenerateSequenceButtonHtml(seq, label) {
  return `<button class="btn-chip" style="margin-top:8px" onclick="generateFromAnalyze('${seq}')">${label || 'Generate this sequence'}</button>`;
}

function generateFromAnalyze(seq) {
  const input = document.getElementById('genInput');
  if (input) input.value = `Generate a sequence similar to: ${seq}`;
  window.navigateTo('generate');
}

/* ── Path B skeleton — Sequence/Properties/Rulebook/PeptideBLEU/
   Explanation only. Structure/Novelty/Trace are never available from
   /score+/explain (confirmed against harness/commands.py — neither
   command calls esmfold_tool/dssp_tool/novelty_tool/blast_novelty_tool
   anywhere), so their containers don't exist in this skeleton at all —
   not hidden via CSS, genuinely absent from the DOM. ─────────────────── */
function renderAnalyzeSkeletonBasic() {
  document.getElementById('analyzeSections').innerHTML = `
    <div id="analyzeSeqSection"></div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧪</span> PHYSICOCHEMICAL PROPERTIES</div>
      <div id="analyzePropertiesSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">✅</span> RULEBOOK VALIDATION</div>
      <div id="analyzeRulebookSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📊</span> PEPTIDEBLEU</div>
      <div id="analyzeBleuSection"></div>
      <div id="analyzeBleuCaption"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">💬</span> EXPLANATION</div>
      <div id="analyzeExplanationSection"></div>
    </div>
    <div id="analyzeGenerateNoteWrap"></div>
  `;
}

/* ── Path A skeleton — full 8-section restore for an agent-generated
   peptide, including Trace (new in v2 — Analyze never showed this
   before). ──────────────────────────────────────────────────────────── */
function renderAnalyzeSkeletonFull() {
  document.getElementById('analyzeSections').innerHTML = `
    <div id="analyzeSeqSection"></div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧪</span> PHYSICOCHEMICAL PROPERTIES</div>
      <div id="analyzePropertiesSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">✅</span> RULEBOOK VALIDATION</div>
      <div id="analyzeRulebookSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📊</span> PEPTIDEBLEU</div>
      <div id="analyzeBleuSection"></div>
      <div id="analyzeBleuCaption"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧬</span> STRUCTURE</div>
      <div id="analyzeStructureSection"></div>
      <div id="analyzeStructureActions"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🔎</span> NOVELTY</div>
      <div id="analyzeNoveltySection"></div>
      <div id="analyzeNoveltyActions"></div>
    </div>
    <div id="analyzeTraceWrap"></div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">💬</span> EXPLANATION</div>
      <div id="analyzeExplanationSection"></div>
    </div>
  `;
}

function buildAnalyzeExperimentResult(seq, scoreResult, explainResult) {
  return {
    thread_id: crypto.randomUUID(),
    source: 'analyze',
    sequence: seq,
    score: scoreResult.bleu_score,
    status: 'analyzed',
    rulebook_score: scoreResult.rulebook_score,
    rulebook_passed: scoreResult.rulebook_valid,
    components: scoreResult.components,
    descriptors: scoreResult.descriptors,
    descriptors_partial: false,
    diagnostic: explainResult && explainResult.diagnostic,
    explanation: explainResult && explainResult.explanation,
    pdb_string: null,
    novelty_score: null,
  };
}

/* ── Path B — new/unknown peptide ─────────────────────────────────────────── */
function renderAnalyzeResults(seq, scoreResult, explainResult) {
  renderAnalyzeSkeletonBasic();
  const descriptors = (scoreResult && scoreResult.descriptors) || null;

  document.getElementById('analyzeSeqSection').innerHTML = renderSequenceSectionHtml(seq, descriptors);

  renderPropertiesTab({ descriptors, descriptors_partial: false }, 'analyzePropertiesSection');

  document.getElementById('analyzeRulebookSection').innerHTML = renderRulebookSectionHtml(scoreResult, explainResult);

  // The reference input is gone, but handle_score() now auto-picks a
  // reference via reference_selector_tool whenever --ref is omitted
  // (harness/commands.py), so scoreResult.reference_used is populated
  // and components is a real 7-value breakdown, not {} — the stale
  // "always {} here" assumption from before that backend fix no longer
  // holds. renderPeptideBleuTab() still degrades honestly to "No
  // reference — PeptideBLEU not computed." in the rare case the
  // auto-pick itself comes back empty (unrecognized preset).
  renderPeptideBleuTab({
    score: scoreResult.bleu_score,
    components: scoreResult.components,
    reference_used: scoreResult.reference_used || '',
  }, 'analyzeBleuSection');
  document.getElementById('analyzeBleuCaption').innerHTML = renderBleuCaptionHtml(scoreResult.reference_used);

  document.getElementById('analyzeExplanationSection').innerHTML = renderExplanationSectionHtml(explainResult);

  document.getElementById('analyzeGenerateNoteWrap').innerHTML = `
    <div class="result-card">
      <p class="tab-hint">This sequence has not been generated by PepForge. Generate it to obtain structural prediction, novelty analysis, and refinement trace.</p>
      ${renderGenerateSequenceButtonHtml(seq, 'Generate this sequence →')}
    </div>
  `;

  // Save so this exact sequence can be retrieved instantly next time
  // (Path A), instead of re-running /score+/explain.
  saveExperiment(buildAnalyzeExperimentResult(seq, scoreResult, explainResult), null);
}

/* ── Path A — agent-generated peptide, restored from storage ─────────────── */
function renderRetrievedBannerHtml(exp) {
  const verb = exp.source === 'analyze' ? 'analyzed' : 'generated';
  return `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🕘</span> RETRIEVED FROM EXPERIMENT</div>
      <p class="tab-hint">This sequence was already ${verb} on ${new Date(exp.timestamp).toLocaleString()}. Showing the stored result.</p>
      <button class="btn-chip" onclick="startAnalyze(true)">Re-analyze</button>
    </div>
  `;
}

function renderAnalyzeResultsFromStorage(exp, generation) {
  renderAnalyzeSkeletonFull();
  const d = exp.descriptors;

  document.getElementById('analyzeSeqSection').innerHTML =
    renderRetrievedBannerHtml(exp) + renderSequenceSectionHtml(exp.sequence, d);

  renderPropertiesTab({ descriptors: d, descriptors_partial: !!exp.descriptors_partial }, 'analyzePropertiesSection');

  document.getElementById('analyzeRulebookSection').innerHTML = renderRulebookSectionHtml(
    { rulebook_score: exp.rulebook_score, rulebook_valid: exp.rulebook_passed },
    { diagnostic: exp.diagnostic }
  );

  renderPeptideBleuTab({
    score: exp.score,
    components: exp.components || {},
    reference_used: exp.reference_used || '',
  }, 'analyzeBleuSection');
  document.getElementById('analyzeBleuCaption').innerHTML = renderBleuCaptionHtml(exp.reference_used);

  const structureBaseProps = {
    meanPlddt: exp.plddt_score,
    confidenceLabel: exp.plddt_confidence,
    helixPct: exp.helix_pct,
    sheetPct: exp.sheet_pct,
    coilPct: exp.coil_pct,
    ssString: exp.ss_string,
    sequence: exp.sequence,
  };
  const structureUnavailableReason = 'Not available or not stored for this experiment.';
  if (exp.has_pdb && exp.thread_id) {
    renderStructureCard('analyzeStructureSection', { ...structureBaseProps, isLoading: true });
    document.getElementById('analyzeStructureActions').innerHTML = '';
    getPdbString(exp.thread_id).then((pdbString) => {
      if (generation !== analyzeGeneration) return; // superseded by a newer analysis
      renderStructureCard('analyzeStructureSection', {
        ...structureBaseProps,
        pdbString,
        error: pdbString ? null : (exp.plddt_interp || 'Stored structure could not be loaded.'),
      });
      document.getElementById('analyzeStructureActions').innerHTML =
        pdbString ? '' : renderGenerateSequenceButtonHtml(exp.sequence);
    });
  } else {
    renderStructureCard('analyzeStructureSection', {
      ...structureBaseProps,
      pdbString: null,
      error: exp.plddt_interp || structureUnavailableReason,
    });
    document.getElementById('analyzeStructureActions').innerHTML = renderGenerateSequenceButtonHtml(exp.sequence);
  }

  const noveltyChecked = exp.novelty_score != null || !!exp.closest_match;
  renderNoveltyTab({
    sequence: exp.sequence,
    novelty_score: exp.novelty_score,
    closest_match: exp.closest_match,
    novelty_label: exp.novelty_label,
    novelty_source: exp.novelty_source,
    novelty_checked: noveltyChecked,
    novelty_not_checked_reason: 'Not available or not stored for this experiment.',
  }, 'analyzeNoveltySection');
  document.getElementById('analyzeNoveltyActions').innerHTML =
    noveltyChecked ? '' : renderGenerateSequenceButtonHtml(exp.sequence);

  // Trace is only shown when there's real data — some agent runs may not
  // have edit_stats/trace_url stored, and an empty "TRACE" card with
  // nothing in it would be worse than no card at all.
  const traceWrap = document.getElementById('analyzeTraceWrap');
  if (exp.edit_stats || exp.trace_url) {
    traceWrap.innerHTML = `
      <div class="result-card">
        <div class="result-card-header"><span class="result-icon">🧾</span> TRACE</div>
        ${renderTraceSectionHtml(exp)}
      </div>
    `;
  } else {
    traceWrap.innerHTML = '';
  }

  document.getElementById('analyzeExplanationSection').innerHTML =
    renderExplanationSectionHtml({ explanation: exp.explanation });
}

window.startAnalyze = startAnalyze;
window.generateFromAnalyze = generateFromAnalyze;
