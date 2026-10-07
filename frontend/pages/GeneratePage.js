/* ── Generate workflow (Phase 8a extraction) ──────────────────────────────
   Logic below is moved verbatim from the old monolithic app.js (Phases
   3-7) — only reorganized into imports/exports and a few state renames.
   Uses window.navigateTo / window.renderExperimentsList rather than
   static imports of app.js to avoid a circular module dependency (app.js
   imports initGeneratePage() from this file for startup wiring). Both
   window globals are set during app.js's own module evaluation, which
   always completes before any user click could invoke this page's code. */
import { resumeHITL } from '../services/api.js';
import { streamGenerate } from '../services/sse.js';
import { saveExperiment } from '../services/history.js';
import { slash } from '../services/commands.js';
import { resetProgressTimeline, setStepState } from '../components/AgentProgress.js';
import { showLoading, hideLoading } from '../components/LoadingState.js';
import { showErrorCard, hideErrorCard } from '../components/ErrorState.js';
import { showHitlPanel, hideHitlPanel } from '../components/HITLPanel.js';
import { renderHeroCard } from '../components/CandidateCard.js';
import { renderPropertiesTab, fmtCharge } from '../components/PropertyCard.js';
import { renderPeptideBleuTab } from '../components/PeptideBLEU.js';
import { renderStructureTab } from '../components/StructureViewer.js';
import { renderNoveltyTab } from '../components/NoveltyCard.js';
import { renderViolationsHtml } from '../components/DiagnosticCard.js';

/* ── Config ──────────────────────────────────────────────────────────────── */
const ALL_ACTIVITIES = [
  'anti-bacterial', 'anti-cancer', 'anti-fungal', 'anti-parasitic',
  'anti-viral', 'cell-cell-communication', 'drug-delivery',
  'immunological', 'inhibitor', 'metabolic', 'other-functional',
  'signal-peptide', 'toxic',
];

/* ── State ───────────────────────────────────────────────────────────────── */
let currentHitlThreadId = null;
let commandThreadId = null;
let isGenerating = false;
let currentSpec = null;
let lastRunningStepKey = null;
let attemptHistory = [];
let currentResult = null;

export function initGeneratePage() {
  buildActivityDropdown();
}

export function newExperiment() {
  window.navigateTo('generate');
  if (isGenerating) return;
  document.getElementById('generateActive').style.display = 'none';
  document.getElementById('generateEmpty').style.display = '';
  document.getElementById('genInput').value = '';
  document.getElementById('advancedPanel').style.display = 'none';
  document.getElementById('resultTabsCard').style.display = 'none';
  document.querySelector('.view-placeholder-template')?.remove();
  hideHitlPanel();
  currentHitlThreadId = null;
  currentSpec = null;
  currentResult = null;
  attemptHistory = [];
}

/* ── Templates ─────────────────────────────────────────────────────────────
   Pre-fills both the free-text input and the Advanced panel fields so
   either path (NL parse or Advanced) produces the same spec. */
const TEMPLATE_PRESETS = {
  amp: {
    activity: 'anti-bacterial', length_min: 15, length_max: 20, charge_min: 2, charge_max: 5,
    hydro_min: 35, hydro_max: 55,
    text: 'Generate an antimicrobial peptide with 15–20 residues, charge +2 to +5, hydrophobicity 35–55%.',
  },
  cpp: {
    activity: 'drug-delivery', length_min: 12, length_max: 16, charge_min: 4, charge_max: 8,
    hydro_min: 30, hydro_max: 50,
    text: 'Generate a cell-penetrating peptide with 12–16 residues, charge +4 to +8, hydrophobicity 30–50%.',
  },
  antifungal: {
    activity: 'anti-fungal', length_min: 15, length_max: 25, charge_min: 2, charge_max: 6,
    hydro_min: 35, hydro_max: 55,
    text: 'Generate an antifungal peptide with 15–25 residues, charge +2 to +6, hydrophobicity 35–55%.',
  },
  antiviral: {
    activity: 'anti-viral', length_min: 15, length_max: 25, charge_min: 2, charge_max: 6,
    hydro_min: 30, hydro_max: 50,
    text: 'Generate an antiviral peptide with 15–25 residues, charge +2 to +6, hydrophobicity 30–50%.',
  },
  immunological: {
    activity: 'immunological', length_min: 10, length_max: 20, charge_min: 0, charge_max: 4,
    hydro_min: 30, hydro_max: 50,
    text: 'Generate an immunological/epitope peptide with 10–20 residues, charge 0 to +4, hydrophobicity 30–50%.',
  },
};

export function applyTemplate(name) {
  window.navigateTo('generate');
  const preset = TEMPLATE_PRESETS[name];
  if (!preset) {
    // "Custom" — just focus the free-text input, no prefill.
    document.getElementById('genInput').focus();
    return;
  }
  document.getElementById('genInput').value = preset.text;
  document.getElementById('advLenMin').value = preset.length_min;
  document.getElementById('advLenMax').value = preset.length_max;
  document.getElementById('advChargeMin').value = preset.charge_min;
  document.getElementById('advChargeMax').value = preset.charge_max;
  document.getElementById('advHydroMin').value = preset.hydro_min;
  document.getElementById('advHydroMax').value = preset.hydro_max;
  document.getElementById('advActivity').value = preset.activity;
}

/* ── Advanced panel ────────────────────────────────────────────────────────── */
function buildActivityDropdown() {
  const sel = document.getElementById('advActivity');
  sel.innerHTML = '<option value="">(none — general)</option>' +
    ALL_ACTIVITIES.map(a => `<option value="${a}">${a}</option>`).join('');
}

function toggleAdvancedPanel() {
  const panel = document.getElementById('advancedPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function openAdvancedPanel() {
  document.getElementById('advancedPanel').style.display = 'block';
}

function readAdvancedPanel() {
  return {
    activity: document.getElementById('advActivity').value,
    length_min: parseInt(document.getElementById('advLenMin').value) || 10,
    length_max: parseInt(document.getElementById('advLenMax').value) || 50,
    charge_min: parseFloat(document.getElementById('advChargeMin').value) || 0,
    charge_max: parseFloat(document.getElementById('advChargeMax').value) || 5,
    hydro_min: parseFloat(document.getElementById('advHydroMin').value) || 0,
    hydro_max: parseFloat(document.getElementById('advHydroMax').value) || 100,
    max_retries: parseInt(document.getElementById('advMaxRetries').value) || 6,
    threshold: parseFloat(document.getElementById('advThreshold').value) || 0.35,
    hitl_enabled: document.getElementById('advHitlEnabled').checked,
    use_legacy: document.getElementById('advUseLegacy').checked,
  };
}

/* ── Slash command menu ────────────────────────────────────────────────────── */
const COMMAND_MENU_ITEMS = [
  { cmd: '/generate', desc: 'Generate peptide' },
  { cmd: '/score', desc: 'Score sequence' },
  { cmd: '/edit', desc: 'Refine sequence' },
  { cmd: '/compare', desc: 'Compare candidates' },
  { cmd: '/explain', desc: 'Explain sequence' },
  { cmd: '/history', desc: 'Previous experiments' },
];

function toggleCommandMenu() {
  const menu = document.getElementById('commandMenu');
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  menu.innerHTML = COMMAND_MENU_ITEMS.map(c =>
    `<div class="command-menu-item" onclick="insertCommand('${c.cmd}')"><b>${c.cmd}</b>${c.desc}</div>`
  ).join('');
  menu.style.display = 'block';
}

function insertCommand(cmd) {
  const input = document.getElementById('genInput');
  input.value = `${cmd} `;
  input.focus();
  document.getElementById('commandMenu').style.display = 'none';
}

function onGenInputChange() {
  const input = document.getElementById('genInput');
  const menu = document.getElementById('commandMenu');
  if (input.value.startsWith('/') && !input.value.includes(' ')) {
    if (menu.style.display === 'none') toggleCommandMenu();
  } else {
    menu.style.display = 'none';
  }
}

/* ── Natural-language spec parsing (frontend_phase2_decisions.md Decision 6)
   Simple keyword/number extraction, frontend-only — no backend NLP
   endpoint. Falls back to showing the Advanced panel when nothing
   meaningful was parsed, rather than silently guessing defaults. */
const ACTIVITY_KEYWORDS = {
  'anti-bacterial': ['antibacterial', 'antimicrobial', 'amp'],
  'anti-fungal': ['antifungal'],
  'anti-viral': ['antiviral'],
  'anti-cancer': ['anticancer', 'antitumor', 'anti-cancer'],
  'anti-parasitic': ['antiparasitic'],
  'drug-delivery': ['cell-penetrating', 'cell penetrating', 'cpp', 'drug delivery', 'drug-delivery'],
  'signal-peptide': ['signal peptide', 'signal-peptide'],
  'immunological': ['immunological', 'immune', 'epitope'],
  'toxic': ['toxic', 'toxin'],
  'cell-cell-communication': ['cell-cell', 'cell to cell signal'],
  'inhibitor': ['inhibitor', 'inhibitory'],
  'metabolic': ['metabolic'],
};

function parseNaturalLanguage(text) {
  const lower = text.toLowerCase();
  const spec = {
    activity: '', length_min: null, length_max: null,
    charge_min: null, charge_max: null, hydro_min: null, hydro_max: null,
    max_retries: 6, threshold: 0.35, hitl_enabled: false, use_legacy: false,
  };
  let matched = 0;

  for (const [act, keywords] of Object.entries(ACTIVITY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) { spec.activity = act; matched++; break; }
  }

  let m = lower.match(/(\d+)\s*(?:-|to|–)\s*(\d+)\s*(?:residues|amino acids|aa)/);
  if (m) {
    spec.length_min = parseInt(m[1]); spec.length_max = parseInt(m[2]); matched++;
  } else {
    m = lower.match(/(\d+)\s*(?:residues|amino acids|aa)\b/);
    if (m) { spec.length_min = spec.length_max = parseInt(m[1]); matched++; }
  }

  m = lower.match(/charge[^+\-\d]*([+-]?\d+)\s*(?:to|and|–|-)\s*([+-]?\d+)/);
  if (m) { spec.charge_min = parseInt(m[1]); spec.charge_max = parseInt(m[2]); matched++; }

  m = lower.match(/(?:hydrophobicity|hydrophobic|hydro)[^%\d]*(\d+)\s*%?\s*(?:to|and|–|-)\s*(\d+)\s*%/);
  if (m) { spec.hydro_min = parseFloat(m[1]); spec.hydro_max = parseFloat(m[2]); matched++; }

  spec.confidence = matched === 0 ? 'low' : matched === 1 ? 'medium' : 'high';

  if (spec.length_min == null) { spec.length_min = 10; spec.length_max = 50; }
  if (spec.charge_min == null) { spec.charge_min = 2; spec.charge_max = 5; }
  if (spec.hydro_min == null) { spec.hydro_min = 30; spec.hydro_max = 50; }

  return spec;
}

/* ── Client-side input validation (Phase 7) ───────────────────────────────
   Mirrors harness/guardrails.py's input_guardrail() rules exactly, so a
   malformed spec shows the specific violation message immediately rather
   than round-tripping to the backend — which currently has no way to
   surface that message anyway (input_guardrail's "error" string never
   reaches the SSE final event; adding it would mean touching
   harness/sse_bridge.py, out of scope for this frontend-only phase). */
function validateSpecClientSide(spec) {
  const errors = [];
  if (spec.activity && !ALL_ACTIVITIES.includes(spec.activity)) {
    errors.push(`activity '${spec.activity}' is not one of the 13 valid classes`);
  }
  if (!(spec.length_min < spec.length_max)) errors.push(`length_min (${spec.length_min}) must be < length_max (${spec.length_max})`);
  if (!(spec.charge_min <= spec.charge_max)) errors.push(`charge_min (${spec.charge_min}) must be <= charge_max (${spec.charge_max})`);
  if (!(spec.hydro_min < spec.hydro_max)) errors.push(`hydro_min (${spec.hydro_min}) must be < hydro_max (${spec.hydro_max})`);
  if (!(spec.length_min >= 1)) errors.push(`length_min (${spec.length_min}) must be >= 1`);
  if (!(spec.length_max <= 200)) errors.push(`length_max (${spec.length_max}) must be <= 200`);
  if (!(spec.charge_min >= -20)) errors.push(`charge_min (${spec.charge_min}) must be >= -20`);
  if (!(spec.charge_max <= 20)) errors.push(`charge_max (${spec.charge_max}) must be <= 20`);
  if (!(spec.hydro_min >= 0)) errors.push(`hydro_min (${spec.hydro_min}) must be >= 0`);
  if (!(spec.hydro_max <= 100)) errors.push(`hydro_max (${spec.hydro_max}) must be <= 100`);
  if (!(spec.threshold >= 0.0 && spec.threshold <= 1.0)) errors.push(`threshold (${spec.threshold}) must be between 0.0 and 1.0`);
  if (!(spec.max_retries >= 1 && spec.max_retries <= 10)) errors.push(`max_retries (${spec.max_retries}) must be between 1 and 10`);
  return errors;
}

/* ── Generation ─────────────────────────────────────────────────────────────── */
function startGeneration() {
  if (isGenerating) return;

  const text = document.getElementById('genInput').value.trim();
  if (text.startsWith('/')) {
    runSlashCommand(text);
    return;
  }

  const advancedOpen = document.getElementById('advancedPanel').style.display !== 'none';
  let spec;
  if (advancedOpen) {
    spec = readAdvancedPanel();
  } else {
    if (!text) {
      alert('Describe your peptide objective, or open Advanced to set fields directly.');
      return;
    }
    const parsed = parseNaturalLanguage(text);
    if (parsed.confidence === 'low') {
      openAdvancedPanel();
      alert("Couldn't confidently parse that — set the fields in Advanced and click Generate again.");
      return;
    }
    spec = parsed;
  }

  const violations = validateSpecClientSide(spec);
  if (violations.length > 0) {
    openAdvancedPanel();
    alert('Please fix the following before generating:\n\n' + violations.join('\n'));
    return;
  }

  currentSpec = spec;
  showParsedSpecCard(spec);
  runGeneration(spec);
}

function showParsedSpecCard(spec) {
  document.getElementById('specCard').style.display = 'block';
  document.getElementById('progressCard').style.display = 'block';
  document.getElementById('specGrid').innerHTML = `
    <div class="spec-row"><span class="spec-label">Activity</span><span class="spec-value">${spec.activity || '(none — general)'}</span></div>
    <div class="spec-row"><span class="spec-label">Length</span><span class="spec-value">${spec.length_min}–${spec.length_max} aa</span></div>
    <div class="spec-row"><span class="spec-label">Net charge</span><span class="spec-value">${fmtCharge(spec.charge_min)} to ${fmtCharge(spec.charge_max)}</span></div>
    <div class="spec-row"><span class="spec-label">Hydrophobicity</span><span class="spec-value">${spec.hydro_min}–${spec.hydro_max}%</span></div>
    <div class="spec-row"><span class="spec-label">Max rounds</span><span class="spec-value">${spec.max_retries}</span></div>
  `;
}

async function runGeneration(spec) {
  isGenerating = true;
  document.getElementById('generateEmpty').style.display = 'none';
  document.getElementById('generateActive').style.display = 'block';
  document.getElementById('commandResultCard').style.display = 'none';
  document.getElementById('bestCandidateCard').style.display = 'none';
  document.getElementById('resultTabsCard').style.display = 'none';
  hideErrorCard();
  hideHitlPanel();
  attemptHistory = [];
  currentResult = null;
  showLoading();
  resetProgressTimeline();
  setStepState('input_guardrail', 'running');
  lastRunningStepKey = 'input_guardrail';

  const useHarness = !spec.use_legacy;
  const body = {
    activities: spec.activity ? [spec.activity] : [],
    length_min: spec.length_min,
    length_max: spec.length_max,
    charge_min: spec.charge_min,
    charge_max: spec.charge_max,
    hydro_min: spec.hydro_min,
    hydro_max: spec.hydro_max,
    max_retries: spec.max_retries,
    threshold: spec.threshold,
  };
  if (useHarness) body.hitl_enabled = !!spec.hitl_enabled;

  await streamGenerate(body, useHarness, {
    onAttempt: (evt, attemptCount) => {
      attemptHistory.push(evt);
      if (attemptCount === 1) {
        ['input_guardrail', 'rag_retrieval', 'reference_selection', 'generation', 'scoring', 'validation']
          .forEach(k => setStepState(k, 'completed'));
        setStepState('refinement', 'running');
        lastRunningStepKey = 'refinement';
      }
    },
    onHITL: (evt) => {
      currentHitlThreadId = evt.data.thread_id;
      showHitlPanel(evt.data);
    },
    onFinal: (evt) => {
      hideHitlPanel();
      currentHitlThreadId = null;
      hideLoading();
      setStepState('refinement', 'completed');
      setStepState('post_hoc', 'completed');
      setStepState('output_guardrail', 'completed');
      showBestCandidate(evt.result);
      saveExperiment(evt.result, currentSpec);
      window.renderExperimentsList && window.renderExperimentsList();
    },
    onError: (evt) => {
      // The overwhelmingly common real-world cause of a harness "error" SSE
      // event in this project is the LLM gateway tunnel dying mid-run (see
      // CLAUDE.md's failure-modes table) — using that as the primary
      // user-facing message rather than the raw exception, which goes under
      // "Technical details" instead (never shown raw in the primary UI).
      hideLoading();
      const technical = `${evt.message || ''}\n\n${evt.traceback || ''}`.trim();
      if (evt.networkError) {
        setStepState(lastRunningStepKey || 'input_guardrail', 'failed');
        showErrorCard('Could not reach the PepForge server. Make sure the backend is running.', { technical, retry: true });
      } else {
        setStepState(lastRunningStepKey || 'generation', 'failed');
        showErrorCard('PepForge could not reach the model. Your experiment settings are preserved.', { technical, retry: true });
      }
    },
    onComplete: () => {
      isGenerating = false;
    },
  });
}

async function runSlashCommand(text) {
  if (!commandThreadId) commandThreadId = crypto.randomUUID();

  document.getElementById('generateEmpty').style.display = 'none';
  document.getElementById('generateActive').style.display = 'block';
  document.getElementById('specCard').style.display = 'none';
  document.getElementById('progressCard').style.display = 'none';
  document.getElementById('bestCandidateCard').style.display = 'none';
  hideErrorCard();

  const out = document.getElementById('commandResultOutput');
  const card = document.getElementById('commandResultCard');
  out.textContent = 'Running…';
  card.style.display = 'block';

  try {
    const data = await slash(text, commandThreadId);
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = `Error: ${err}`;
  }
}

/* ── Result normalization (Phase 5) ───────────────────────────────────────
   Legacy and harness final events have genuinely different shapes
   (.claude/plan/AUDIT.md Q17-19, Decisions 2/7/8/9) — legacy nests
   secondary_structure/blast_similarity dicts and names the PDB field
   "plddt_pdb"; harness has flat sheet_pct/coil_pct/ss_string/pdb_string
   fields and a possibly-partial `descriptors` (full on harness, rulebook-
   derived partial on legacy, per Decision 9). This normalizes both into one
   shape so the tab renderers below never branch on which path produced
   the result. */
function normalizeResult(result) {
  const ss = result.secondary_structure || null;      // legacy only
  const blast = result.blast_similarity || null;       // legacy only

  let descriptors = result.descriptors || null;        // harness, Decision 9
  let descriptorsPartial = false;
  if (!descriptors && result.rulebook) {
    descriptors = {
      length: result.rulebook.length,
      net_charge: result.rulebook.net_charge,
      hydro_pct: result.rulebook.hydro_percent ?? result.rulebook.hydrophobicity,
      charge_class: result.rulebook.charge_class,
      length_class: result.rulebook.length_class,
      gravy: null, aromaticity: null, mol_weight: null,
    };
    descriptorsPartial = true;
  }

  return {
    sequence: result.sequence || '',
    score: result.score,
    rulebook_score: result.rulebook_score,
    reference_used: result.reference_used,
    components: result.components || {},
    iterations: result.iterations,
    time_seconds: result.time_seconds,
    rag_examples_used: result.rag_examples_used,
    rag_sequences: result.rag_sequences || [],
    status: result.status,
    thread_id: result.thread_id,
    edit_stats: result.edit_stats || {},
    trace_url: result.trace_url || null,

    descriptors,
    descriptors_partial: descriptorsPartial,

    plddt_score: result.plddt_score,
    plddt_confidence: result.plddt_confidence || null,
    plddt_interp: result.plddt_interp || null,
    pdb_string: result.plddt_pdb || result.pdb_string || null,

    helix_pct: ss ? ss.helix_pct : result.helix_pct,
    sheet_pct: ss ? ss.sheet_pct : result.sheet_pct,
    coil_pct: ss ? ss.coil_pct : result.coil_pct,
    ss_string: ss ? ss.ss_string : result.ss_string,
    dssp_available: ss ? ss.dssp_available : (result.helix_pct != null),
    dssp_interp: ss ? ss.interpretation : null,

    novelty_score: blast ? blast.similarity_score : result.novelty_score,
    novelty_label: blast ? blast.novelty_label : result.novelty_label,
    // Phase 8c (frontend_phase8c_novelty.md) — harness/graph.py's
    // post_hoc_node now calls novelty_tool for real; novelty_source is
    // "blast" or "faiss_fallback" from its new "source" field
    // (harness/novelty.py). Legacy has no FAISS fallback at all, so its
    // only source is "blast" when blast_available, else null.
    novelty_source: blast ? (blast.blast_available ? 'blast' : null) : result.novelty_source,
    novelty_is_legacy: !!blast,
    novelty_interp: blast ? blast.interpretation : null,
    novelty_available: blast ? !!blast.blast_available : (result.novelty_score != null),
    // Legacy's blast_similarity has no closest_match field at all (spec:
    // "show 'Not available'") — only the harness path can ever have one.
    closest_match: blast ? null : (result.closest_match || null),

    activity: (currentSpec && currentSpec.activity) || '',
  };
}

/* ── Best candidate hero card + result tabs (Phase 5) ─────────────────────── */
function showBestCandidate(result) {
  const r = normalizeResult(result);
  currentResult = r;

  renderHeroCard(r);

  renderOverviewTab(r);
  renderPropertiesTab(r);
  renderPeptideBleuTab(r);
  renderStructureTab(r);
  renderNoveltyTab(r);
  renderTraceTab(r);

  switchResultTab('overview');
  document.getElementById('bestCandidateCard').style.display = 'block';
  document.getElementById('resultTabsCard').style.display = 'block';
}

function analyzeCandidate() {
  const seq = currentResult && currentResult.sequence;
  window.navigateTo('analyze', seq ? { sequence: seq } : undefined);
}

function compareCandidate() {
  const seq = currentResult && currentResult.sequence;
  window.navigateTo('compare', seq ? { candidateA: seq } : undefined);
}

function refineCandidate() {
  const spec = currentSpec;
  const seq = currentResult && currentResult.sequence;
  if (!spec) return;
  newExperiment();
  openAdvancedPanel();
  document.getElementById('advLenMin').value = spec.length_min;
  document.getElementById('advLenMax').value = spec.length_max;
  document.getElementById('advChargeMin').value = spec.charge_min;
  document.getElementById('advChargeMax').value = spec.charge_max;
  document.getElementById('advHydroMin').value = spec.hydro_min;
  document.getElementById('advHydroMax').value = spec.hydro_max;
  document.getElementById('advActivity').value = spec.activity || '';
  if (seq) document.getElementById('genInput').value = `Refine this candidate: ${seq}`;
}

/* ── Result tabs ─────────────────────────────────────────────────────────── */
function switchResultTab(tab) {
  document.querySelectorAll('.result-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.result-tab-panel').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
}

function renderOverviewTab(r) {
  document.getElementById('tabOverview').innerHTML = `
    <div class="overview-grid">
      <div class="spec-row"><span class="spec-label">Activity</span><span class="spec-value">${r.activity || '(general)'}</span></div>
      <div class="spec-row"><span class="spec-label">Length</span><span class="spec-value">${(r.descriptors && r.descriptors.length != null) ? r.descriptors.length : r.sequence.length} aa</span></div>
      <div class="spec-row"><span class="spec-label">Rulebook</span><span class="spec-value">${r.status === 'complete' ? '✓ Passed' : '○ ' + (r.status || 'unknown')}</span></div>
      <div class="spec-row"><span class="spec-label">PeptideBLEU</span><span class="spec-value">${r.score != null ? r.score.toFixed(4) : '–'}</span></div>
      <div class="spec-row"><span class="spec-label">Iterations</span><span class="spec-value">${r.iterations ?? '–'}</span></div>
      <div class="spec-row"><span class="spec-label">Time</span><span class="spec-value">${r.time_seconds != null ? r.time_seconds.toFixed(1) + 's' : '–'}</span></div>
    </div>
    <div class="overview-structure-summary">
      ${r.pdb_string
        ? `ESMFold pLDDT ${r.plddt_score != null ? r.plddt_score.toFixed(1) : '–'} · <a href="#" onclick="switchResultTab('structure');return false;">View 3D Structure →</a>`
        : `<span class="text-muted">Structural analysis unavailable. The peptide result is still complete.</span>`}
    </div>
  `;
}

function renderTraceTab(r) {
  const el = document.getElementById('tabTrace');
  let html = '';

  if (r.trace_url) {
    html += `<p style="margin-bottom:12px"><a href="${r.trace_url}" target="_blank" rel="noopener" class="trace-link" style="margin-left:0">View in LangSmith →</a></p>`;
  }

  html += '<div class="tab-section-label">ATTEMPT HISTORY</div>';
  if (attemptHistory.length === 0) {
    html += '<p class="text-muted">No attempt history recorded.</p>';
  } else {
    html += '<div class="trace-list">' + attemptHistory.map(a => {
      const seqPreview = a.sequence ? (a.sequence.length > 24 ? a.sequence.slice(0, 24) + '…' : a.sequence) : '—';
      const editHtml = a.edit_op
        ? `<span class="edit-op-detail">Edit: pos ${a.edit_op.position} ${a.edit_op.from_aa || '∅'}→${a.edit_op.to_aa || '∅'} (${a.edit_op.reason})</span>`
        : '';
      return `<div class="trace-row ${a.passed ? 'pass' : (a.sequence ? 'fail' : 'error')}">
        <span class="trace-status">${a.passed ? '✓' : '✗'}</span>
        Attempt ${a.n}: ${seqPreview} | BLEU ${a.score != null ? a.score.toFixed(4) : '–'}
        ${editHtml}
      </div>`;
    }).join('') + '</div>';
  }

  const lastViolations = attemptHistory.length ? attemptHistory[attemptHistory.length - 1].violations : null;
  html += '<div class="tab-section-label" style="margin-top:14px">DIAGNOSTIC VIOLATIONS</div>';
  html += renderViolationsHtml(lastViolations);

  html += '<div class="tab-section-label" style="margin-top:14px">EDIT STATISTICS</div>';
  const stats = r.edit_stats || {};
  if (Object.keys(stats).length === 0) {
    html += '<p class="text-muted">No edits were needed.</p>';
  } else {
    html += '<div class="component-scores">' + Object.entries(stats).map(([op, s]) => {
      const deltaStr = s.avg_delta >= 0 ? `+${s.avg_delta.toFixed(4)}` : s.avg_delta.toFixed(4);
      return `<div class="comp-row"><span class="comp-label">${op}</span><span class="comp-val" style="width:auto">${s.count} used · ${s.improvements} improved · avg Δ ${deltaStr}</span></div>`;
    }).join('') + '</div>';
  }

  el.innerHTML = html;
}

/* ── Export + copy ─────────────────────────────────────────────────────────── */
function copySequence() {
  const seq = document.getElementById('resultSequence').textContent.trim();
  if (!seq) return;
  navigator.clipboard?.writeText(seq).catch(() => {});
}

function exportFasta() {
  const seq = document.getElementById('resultSequence').textContent.trim();
  if (!seq) return;
  const activity = (currentResult && currentResult.activity) || 'unspecified';
  const scoreStr = (currentResult && currentResult.score != null) ? currentResult.score.toFixed(4) : 'NA';
  const fasta = `>PepForge_Candidate_1 | ${activity} | PeptideBLEU=${scoreStr}\n${seq}\n`;
  const blob = new Blob([fasta], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${seq.slice(0, 20)}.fasta`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Error retry ─────────────────────────────────────────────────────────── */
function retryGeneration() {
  if (!currentSpec || isGenerating) return;
  hideErrorCard();
  runGeneration(currentSpec);
}

/* ── HITL decision ─────────────────────────────────────────────────────────── */
async function hitlDecide(action) {
  if (!currentHitlThreadId) return;
  const decision = { action };
  if (action === 'modify') {
    const seq = document.getElementById('hitlModifySequence').value.trim().toUpperCase();
    if (!seq) { alert('Enter a replacement sequence first.'); return; }
    decision.sequence = seq;
  }

  const threadId = currentHitlThreadId;
  document.getElementById('hitlPanel').style.display = 'none';
  // The paused /generate request stays open on its own connection — resuming
  // just unblocks it server-side, after which the same stream keeps yielding
  // attempt/hitl/final events with no further action needed here.
  try {
    await resumeHITL(threadId, decision);
  } catch (err) {
    console.error('resume failed:', err);
  }
}

window.newExperiment = newExperiment;
window.applyTemplate = applyTemplate;
window.onGenInputChange = onGenInputChange;
window.toggleCommandMenu = toggleCommandMenu;
window.insertCommand = insertCommand;
window.toggleAdvancedPanel = toggleAdvancedPanel;
window.startGeneration = startGeneration;
window.copySequence = copySequence;
window.exportFasta = exportFasta;
window.switchResultTab = switchResultTab;
window.hitlDecide = hitlDecide;
window.refineCandidate = refineCandidate;
window.analyzeCandidate = analyzeCandidate;
window.compareCandidate = compareCandidate;
window.retryGeneration = retryGeneration;
