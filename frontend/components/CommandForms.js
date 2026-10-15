/* ── Contextual slash-command forms ────────────────────────────────────────
   Replaces the old "select a command -> insert raw text into the input ->
   the user has to remember CLI syntax" flow. Selecting a command from the
   palette now shows the appropriate small form right there in the same
   popover, matching the spec's examples:
     /score    -> sequence input -> Run
     /edit     -> sequence input + fix selector -> Refine
     /explain  -> sequence input -> Explain
     /generate -> no form — just focuses the existing main input

   /compare and /history were removed from this palette (anticopy_fix.md's
   sibling request) — both are reached through their own full pages
   (sidebar nav) instead, which is where their complete workflow already
   lived. /analyze was removed alongside them for the same reason (it was
   never a real backend command either — see harness/commands.py's
   _VALID_COMMANDS — just a shortcut that navigated to the Analyze page);
   the Analyze page itself and its sidebar entry are untouched.

   Pure HTML-string builders only; GeneratePage.js owns all the actual DOM
   wiring (open/close, submit handlers, dispatch) since these forms write
   into GeneratePage's own #commandMenu/#commandResultBody elements. This
   mirrors the existing split elsewhere in the codebase (PropertyCard.js
   builds markup, the page wires ids) rather than introducing a new
   pattern. */

export const COMMAND_MENU_ITEMS = [
  { cmd: '/generate', desc: 'Generate peptide' },
  { cmd: '/score', desc: 'Score sequence' },
  { cmd: '/edit', desc: 'Refine sequence' },
  { cmd: '/explain', desc: 'Explain sequence' },
];

export function renderCommandListHtml() {
  return COMMAND_MENU_ITEMS.map(c =>
    `<div class="command-menu-item" onclick="selectCommandForm('${c.cmd}')"><b>${c.cmd}</b>${c.desc}</div>`
  ).join('');
}

function backRowHtml() {
  return `<div class="command-form-back" onclick="showCommandList()">← All commands</div>`;
}

// null return means "no form" — caller focuses the main input instead.
export function renderCommandFormHtml(cmd) {
  switch (cmd) {
    case '/score':
      return `
        ${backRowHtml()}
        <div class="command-form">
          <textarea id="cfSeq" class="command-form-textarea" rows="2" placeholder="peptide sequence"></textarea>
          <input id="cfRef" class="ref-input" placeholder="optional reference (for PeptideBLEU)" />
          <button class="btn-chip command-form-submit" onclick="submitCommandForm('/score')">Run</button>
        </div>`;
    case '/edit':
      return `
        ${backRowHtml()}
        <div class="command-form">
          <textarea id="cfSeq" class="command-form-textarea" rows="2" placeholder="peptide sequence to refine"></textarea>
          <select id="cfFix" class="ref-input">
            <option value="charge">Fix charge</option>
            <option value="hydro">Fix hydrophobicity</option>
            <option value="length">Fix length</option>
            <option value="ngram">Fix n-gram similarity</option>
          </select>
          <button class="btn-chip command-form-submit" onclick="submitCommandForm('/edit')">Refine</button>
        </div>`;
    case '/explain':
      return `
        ${backRowHtml()}
        <div class="command-form">
          <textarea id="cfSeq" class="command-form-textarea" rows="2" placeholder="peptide sequence"></textarea>
          <button class="btn-chip command-form-submit" onclick="submitCommandForm('/explain')">Explain</button>
        </div>`;
    case '/generate':
    default:
      return `${backRowHtml()}<div class="command-form-hint">Describe your peptide objective in the main input below, or use Advanced, then click Generate.</div>`;
  }
}
