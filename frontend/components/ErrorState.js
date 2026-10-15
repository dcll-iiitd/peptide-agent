/* ── Reusable error card with retry + technical details (Phase 8a
   extraction, logic unchanged from old app.js Phase 7 work). The Retry
   button's onclick="retryGeneration()" is a hardcoded global-function
   reference — same convention already used elsewhere in this codebase
   for dynamically-injected onclick handlers (loadExperiment,
   showHistoryDetail, selectCommandForm, inspectResidue), so GeneratePage.js
   must expose window.retryGeneration. */
export function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function showErrorCard(message, options) {
  const { technical, retry } = options || {};
  let html = `<p>${escapeHtml(message)}</p>`;
  if (retry) {
    html += `<button class="btn-chip" style="margin-top:10px" onclick="retryGeneration()">Retry</button>`;
  }
  if (technical) {
    html += `<details class="error-technical"><summary>Technical details ▾</summary><pre>${escapeHtml(technical)}</pre></details>`;
  }
  document.getElementById('errorMessage').innerHTML = html;
  document.getElementById('errorCard').style.display = 'block';
}

export function hideErrorCard() {
  document.getElementById('errorCard').style.display = 'none';
}
