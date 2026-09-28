"""
Component 4: structured edit operator menu.

Replaces free-form "rewrite the whole sequence" LLM edits with a single
named {operation, position, from_aa, to_aa} instruction that code applies
deterministically — apply_edit() validates before mutating and falls back
to the unchanged sequence on any mismatch, so an invalid edit is
structurally impossible to apply.

See .claude/plan/week3.md Task 1 for the spec.
"""

import json

VALID_AA = set("ACDEFGHIKLMNPQRSTVWY")
VALID_OPERATIONS = {"substitute", "insert", "delete", "swap"}
REQUIRED_KEYS = {"operation", "position", "from_aa", "to_aa", "reason", "component"}


def apply_edit(sequence: str, op) -> str:
    """Deterministically apply one EditOperation.

    Never raises. Returns the original sequence unchanged on any
    validation failure (out-of-range position, from_aa mismatch, invalid
    operation/to_aa) — matches week3.md's "invalid edits impossible" goal.
    """
    if op is None or op.operation not in VALID_OPERATIONS:
        return sequence

    seq = sequence.upper()
    n = len(seq)

    try:
        if op.operation == "substitute":
            if not (1 <= op.position <= n):
                return sequence
            if op.to_aa not in VALID_AA:
                return sequence
            if seq[op.position - 1] != op.from_aa:
                return sequence
            return seq[: op.position - 1] + op.to_aa + seq[op.position :]

        if op.operation == "insert":
            # position = insert before this index; n+1 means append at the end.
            if not (1 <= op.position <= n + 1):
                return sequence
            if op.to_aa not in VALID_AA:
                return sequence
            return seq[: op.position - 1] + op.to_aa + seq[op.position - 1 :]

        if op.operation == "delete":
            if not (1 <= op.position <= n):
                return sequence
            if seq[op.position - 1] != op.from_aa:
                return sequence
            return seq[: op.position - 1] + seq[op.position :]

        if op.operation == "swap":
            if not (1 <= op.position < n):
                return sequence
            chars = list(seq)
            chars[op.position - 1], chars[op.position] = chars[op.position], chars[op.position - 1]
            return "".join(chars)
    except (TypeError, IndexError):
        return sequence

    return sequence


def _labeled_sequence(sequence: str) -> str:
    return " ".join(f"{i + 1}:{c}" for i, c in enumerate(sequence.upper()))


def _weakest_component(scores: dict):
    if not scores:
        return None
    return min(scores.items(), key=lambda kv: kv[1])


def build_edit_operator_prompt(
    sequence: str,
    task: dict,
    scores: dict | None = None,
    violations: list | None = None,
) -> str:
    lines = [
        "Current peptide sequence, residues labeled with 1-indexed positions:",
        _labeled_sequence(sequence),
        "",
    ]

    weakest = _weakest_component(scores or {})
    if weakest:
        lines.append(f"Weakest scoring component: {weakest[0]} ({weakest[1]:.3f})")
        lines.append("")

    if violations:
        lines.append("Validation issues (exact positions to target):")
        for v in violations:
            positions = v.get("positions") or []
            lines.append(f"- {v['rule']}: {v.get('fix', '')} - positions {positions}")
        lines.append("")

    lines.extend(
        [
            "Return exactly ONE edit as a single-line JSON object, nothing else:",
            '{"operation": "substitute|insert|delete|swap", "position": <int>, '
            '"from_aa": "<letter or empty>", "to_aa": "<letter or empty>", '
            '"reason": "<short reason>", "component": "<component name>"}',
            "",
            "Rules:",
            "- operation is exactly one of: substitute, insert, delete, swap",
            "- position is 1-indexed",
            "- substitute/delete: from_aa MUST exactly match the residue shown at that position above",
            '- insert: to_aa is inserted BEFORE position; from_aa is ""',
            '- swap: swaps position and position+1; from_aa and to_aa are both ""',
            "",
            'Valid example: {"operation": "substitute", "position": 3, "from_aa": "H", '
            '"to_aa": "D", "reason": "add negative charge", "component": "net_charge"}',
            "Invalid example (from_aa does not match the sequence above): "
            '{"operation": "substitute", "position": 3, "from_aa": "X", "to_aa": "D", '
            '"reason": "...", "component": "net_charge"}',
            "",
            "JSON:",
        ]
    )
    return "\n".join(lines)


def _extract_json(raw: str) -> dict | None:
    """Find the first balanced {...} block in raw text that parses as JSON.

    Robust to reasoning-model <think> preambles and stray prose around the
    JSON — scans every '{' as a possible start rather than assuming the
    response is clean JSON with nothing else around it.
    """
    if not raw:
        return None
    for start in (i for i, c in enumerate(raw) if c == "{"):
        depth = 0
        for end in range(start, len(raw)):
            if raw[end] == "{":
                depth += 1
            elif raw[end] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(raw[start : end + 1])
                        if isinstance(parsed, dict):
                            return parsed
                    except json.JSONDecodeError:
                        pass
                    break
    return None


def generate_edit_operation(
    sequence: str,
    task: dict,
    scores: dict | None = None,
    violations: list | None = None,
):
    """Ask the LLM for ONE structured edit instruction.

    Returns an EditOperation, or None on any failure (empty response, bad
    JSON, missing keys, invalid operation/position type) — never raises.
    """
    from backend import models
    from harness.state import EditOperation

    prompt = build_edit_operator_prompt(sequence, task, scores, violations)
    # Reasoning models spend a substantial chunk of the budget on the
    # <think> block itself before ever reaching the JSON answer — a tight
    # budget risks truncating mid-thought with no JSON produced at all
    # (observed: ~455 of 500 tokens consumed by reasoning alone on one
    # live call). Non-reasoning models just emit the bare JSON.
    max_tokens = 1000 if models.is_reasoning_model() else 150

    try:
        raw = models.generate(prompt, max_tokens=max_tokens)
    except Exception:
        return None

    parsed = _extract_json(raw)
    if parsed is None or not REQUIRED_KEYS.issubset(parsed.keys()):
        return None
    if parsed["operation"] not in VALID_OPERATIONS:
        return None

    try:
        return EditOperation(
            operation=str(parsed["operation"]),
            position=int(parsed["position"]),
            from_aa=str(parsed["from_aa"]).upper(),
            to_aa=str(parsed["to_aa"]).upper(),
            reason=str(parsed["reason"]),
            component=str(parsed["component"]),
        )
    except (ValueError, TypeError):
        return None


if __name__ == "__main__":
    from harness.state import EditOperation

    seq = "KKKKKKKKKK"
    op = EditOperation(
        operation="substitute", position=3, from_aa="K", to_aa="Q",
        reason="reduce charge", component="net_charge",
    )
    print(f"sequence: {seq}")
    print(f"op: {op}")
    print(f"result: {apply_edit(seq, op)}")

    bad_op = EditOperation(
        operation="substitute", position=3, from_aa="X", to_aa="Q",
        reason="bad", component="net_charge",
    )
    print(f"invalid from_aa result (should be unchanged): {apply_edit(seq, bad_op)}")
