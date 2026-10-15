/* ── Slash command result renderer ─────────────────────────────────────────
   Dedicated per-command renderers for /score, /explain, /edit, /generate —
   never a single generic "COMMAND RESULT" dump. Reuses the same shared
   components/helpers AnalyzePage.js already uses for the equivalent data
   shapes (confirmed via harness/commands.py's execute_command(), which
   always wraps results as {"command": cmd, ...result}).

   /compare and /history are no longer slash commands at all (removed from
   harness/commands.py's dispatch and from the command palette in
   CommandForms.js) — typing either now falls through to the normal
   "unknown command" error shape, rendered by renderErrorCardHtml() below
   same as any other invalid command. No dedicated renderer for either.

   Raw JSON is still available under a collapsible "View raw response"
   toggle (reusing ErrorState.js's .error-technical <details> pattern) —
   never hidden, just not the primary view.

   renderRulebookSummaryHtml used to be imported from the dedicated Score
   page the same way; now inlined below since that page was removed and
   this command-bar /score renderer is its only remaining consumer. */
import { escapeHtml } from './ErrorState.js';
import { renderPeptideBleuTab } from './PeptideBLEU.js';
import { renderPropertiesTab } from './PropertyCard.js';
import { renderRulebookSectionHtml, renderExplanationSectionHtml } from '../pages/AnalyzePage.js';
import { humanizeCommandError } from './errorMessages.js';

function rawToggleHtml(data) {
  return `<details class="error-technical"><summary>View raw response ▾</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;
}

function extractRefArg(text) {
  const m = (text || '').match(/--ref\s+(\S+)/);
  return m ? m[1] : '';
}

/* ── /score ────────────────────────────────────────────────────────────── */
function renderScoreCardHtml(data) {
  return `
    <div class="result-sequence">${data.sequence || ''}</div>
    <div class="tab-section-label" style="margin-top:12px">PEPTIDEBLEU</div>
    <div id="cmdBleuSection"></div>
    <div class="tab-section-label" style="margin-top:14px">PHYSICOCHEMICAL PROPERTIES</div>
    <div id="cmdPropertiesSection"></div>
    <div class="tab-section-label" style="margin-top:14px">RULEBOOK VALIDATION</div>
    <div id="cmdRulebookSection"></div>
  `;
}

function renderScoreRulebookSummaryHtml(data) {
  const passed = data.rulebook_valid;
  const score = data.rulebook_score;
  return `
    <div class="spec-row"><span class="spec-label">Status</span><span class="spec-value">${passed === true ? '✓ Passed' : passed === false ? '✗ Failed' : '–'}</span></div>
    <div class="spec-row"><span class="spec-label">Score</span><span class="spec-value">${score != null ? score.toFixed(2) : '–'}</span></div>
    <p class="tab-hint">Per-violation detail is not available via /score — use Analyze for a full diagnostic breakdown.</p>
  `;
}

function fillScoreCard(data, commandText) {
  renderPeptideBleuTab({
    score: data.bleu_score,
    components: data.components,
    reference_used: extractRefArg(commandText),
  }, 'cmdBleuSection');
  renderPropertiesTab({ descriptors: data.descriptors, descriptors_partial: false }, 'cmdPropertiesSection');
  document.getElementById('cmdRulebookSection').innerHTML = renderScoreRulebookSummaryHtml(data);
}

/* ── /explain ──────────────────────────────────────────────────────────── */
function renderExplainCardHtml(data) {
  return `
    <div class="result-sequence">${data.sequence || ''}</div>
    <div class="tab-section-label" style="margin-top:12px">PHYSICOCHEMICAL PROPERTIES</div>
    <div id="cmdPropertiesSection"></div>
    <div class="tab-section-label" style="margin-top:14px">RULEBOOK VALIDATION</div>
    <div id="cmdRulebookSection"></div>
    <div class="tab-section-label" style="margin-top:14px">EXPLANATION</div>
    <div id="cmdExplanationSection"></div>
  `;
}

function fillExplainCard(data) {
  renderPropertiesTab({ descriptors: data.descriptors, descriptors_partial: false }, 'cmdPropertiesSection');
  document.getElementById('cmdRulebookSection').innerHTML = renderRulebookSectionHtml(null, data);
  document.getElementById('cmdExplanationSection').innerHTML = renderExplanationSectionHtml(data);
}

/* ── /edit ─────────────────────────────────────────────────────────────── */
function renderEditCardHtml(data) {
  return `
    <div class="spec-row"><span class="spec-label">Original</span><span class="spec-value">${data.original || '–'}</span></div>
    <div class="spec-row"><span class="spec-label">Edited</span><span class="spec-value">${data.edited || '–'}</span></div>
    <div class="spec-row"><span class="spec-label">Changed</span><span class="spec-value">${data.changed ? '✓ Yes' : '✗ No'}</span></div>
    ${data.operation ? `<div class="spec-row"><span class="spec-label">Operation</span><span class="spec-value">${escapeHtml(JSON.stringify(data.operation))}</span></div>` : ''}
    ${data.reason_rejected ? `<p class="tab-hint">Rejected: ${escapeHtml(String(data.reason_rejected))}</p>` : ''}
  `;
}

/* ── /generate (rare, reachable via slash input in the chat bar) ─────────── */
function renderGenerateCardHtml(data) {
  return `
    <div class="spec-row"><span class="spec-label">Sequence</span><span class="spec-value">${data.sequence || '–'}</span></div>
    <div class="spec-row"><span class="spec-label">Score</span><span class="spec-value">${data.score != null ? data.score.toFixed(4) : '–'}</span></div>
    <div class="spec-row"><span class="spec-label">Status</span><span class="spec-value">${data.status || '–'}</span></div>
    <div class="spec-row"><span class="spec-label">Iteration</span><span class="spec-value">${data.iteration != null ? data.iteration : '–'}</span></div>
  `;
}

/* ── Error shape (any command) ────────────────────────────────────────── */
function renderErrorCardHtml(data) {
  let html = `<p class="error-message">${escapeHtml(humanizeCommandError(data.command, data.error))}</p>`;
  if (data.valid_commands) {
    html += `<p class="tab-hint">Valid commands: ${data.valid_commands.join(', ')}</p>`;
  }
  return html;
}

/* ── Dispatcher ────────────────────────────────────────────────────────── */
export function renderSlashResult(containerId, data, commandText) {
  const el = document.getElementById(containerId);
  if (!el) return;

  let bodyHtml;
  let fill = null;

  if (data.error) {
    bodyHtml = renderErrorCardHtml(data);
  } else {
    switch (data.command) {
      case '/score':
        bodyHtml = renderScoreCardHtml(data);
        fill = () => fillScoreCard(data, commandText);
        break;
      case '/explain':
        bodyHtml = renderExplainCardHtml(data);
        fill = () => fillExplainCard(data);
        break;
      case '/edit':
        bodyHtml = renderEditCardHtml(data);
        break;
      case '/generate':
        bodyHtml = renderGenerateCardHtml(data);
        break;
      default:
        bodyHtml = `<p class="text-muted">Unrecognized command result shape.</p>`;
    }
  }

  el.innerHTML = bodyHtml + rawToggleHtml(data);
  if (fill) fill();
}
