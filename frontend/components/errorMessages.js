/* ── Shared error-translation helper ───────────────────────────────────────
   Backend command errors (harness/commands.py's execute_command()) are
   returned as normal 200-shaped JSON — {"error": "usage: ..."} — never
   thrown, so every caller gets a success-shaped promise regardless of
   whether the command actually worked. This is the single place that
   turns those raw strings (and generic network failures) into messages a
   researcher can act on, so no page shows "usage: /edit SEQUENCE --fix
   [charge|hydro|length|ngram]" verbatim. The raw string is never thrown
   away — callers still show it under their existing raw-JSON/"Technical
   details" toggles. */

export function humanizeCommandError(cmd, rawError) {
  const err = (rawError || '').toLowerCase();

  if (err.startsWith('unknown command')) {
    return "That command isn't recognized. Try /generate, /score, /edit, /compare, /explain, /analyze, or /history.";
  }

  if (err.startsWith('usage:') || err.includes('invalid')) {
    switch (cmd) {
      case '/score':
        return 'Enter a peptide sequence to score.';
      case '/edit':
        return err.includes('--fix') && err.includes('invalid')
          ? 'Choose a valid fix type: charge, hydrophobicity, length, or n-gram.'
          : 'Enter a peptide sequence to refine, and choose what to fix.';
      case '/compare':
        return 'Enter both Candidate A and Candidate B sequences to compare.';
      case '/explain':
        return 'Enter a peptide sequence to explain.';
      case '/generate':
        return 'Check your generation parameters (length, charge, hydrophobicity) and try again.';
      default:
        return 'This command is missing required information — check the sequence and options you entered.';
    }
  }

  return rawError ? 'PepForge could not complete this command.' : 'Something went wrong running this command.';
}

export function humanizeNetworkError() {
  return 'Could not reach the PepForge server. Make sure the backend is running.';
}
