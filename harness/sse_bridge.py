"""
SSE bridge connecting harness/graph.py's LangGraph StateGraph to backend/
server.py's existing /generate endpoint, per .claude/plan/week4.md Task 3.

Event shape note: week4.md's own sketch says the harness SSE events use the
"same format as existing" but then lists different type strings (iteration/
result/summary) than frontend/app.js's handleEvent() actually switches on
(attempt/final) — verified by reading frontend/app.js directly rather than
trusting the stale draft (same practice as resolving other plan/code
discrepancies noted in CLAUDE.md). This bridge emits "attempt" once per lap
(at the "track" node, the harness equivalent of one PepForgeAgent attempt)
and "final" once at the end, matching the frontend's real contract, so
harness=true requires zero frontend changes. "hitl" is a genuinely new type
(frontend currently ignores unknown types, which is safe/additive) since
nothing in the legacy path ever pauses mid-generation.

HITL over SSE: interrupt() surfaces identically whether the graph is driven
via .invoke() or .stream() (verified live — a stream() chunk is
{"__interrupt__": (Interrupt(...),)} same payload shape as .invoke()'s
"__interrupt__" key). Resuming requires a second call with
Command(resume=decision) against the same thread_id. Since SSE is one-way
(server -> client), the researcher's decision has to arrive over a separate
channel — a decision_fn blocks (in the executor thread, never on the asyncio
event loop) on a plain thread-safe queue.Queue keyed by thread_id, and the
new POST /resume endpoint in backend/server.py pushes into that same queue.
"""

import asyncio
import json
import queue
import time
import uuid
from typing import AsyncIterator, Optional

from harness.graph import build_graph
from harness.state import create_initial_state

# thread_id -> Queue holding at most one pending researcher decision.
# Module-level since it must outlive any single request coroutine and be
# reachable from backend/server.py's /resume endpoint.
_hitl_decision_queues: dict[str, "queue.Queue"] = {}

# Sentinel marking "the graph run is finished" on the asyncio event queue —
# an object(), not a dict, so it can never collide with a real emitted event.
_DONE = object()


def push_hitl_decision(thread_id: str, decision: dict) -> bool:
    """Called by POST /resume. Returns False if no generation is currently
    paused on this thread_id (nothing to resume)."""
    q = _hitl_decision_queues.get(thread_id)
    if q is None:
        return False
    q.put(decision)
    return True


def _weakest_component(components: dict) -> Optional[str]:
    return min(components, key=components.get) if components else None


def _build_attempt_event(state: dict, last_score: float) -> dict:
    diagnostic = state.get("current_diagnostic")
    score = state.get("current_score", 0.0)
    passed = bool(diagnostic and diagnostic.passed) and score >= state["threshold"]
    last_edit_op = state.get("last_edit_op")

    return {
        "type": "attempt",
        "n": state.get("iteration", 0),
        "sequence": state.get("current_sequence", ""),
        "score": score,
        "rulebook_score": diagnostic.fitness if diagnostic else None,
        "status": "pass" if passed else ("fail" if state.get("current_sequence") else "error"),
        "passed": passed,
        "issues": [v["fix"] for v in diagnostic.violations] if diagnostic else [],
        "components": state.get("current_components", {}),
        "mode": last_edit_op.operation if last_edit_op else "generate",
        "weakest": _weakest_component(state.get("current_components", {})),
        "delta_score": score - last_score,
    }


def _build_final_event(state: dict, elapsed: float) -> dict:
    from harness.tools import peptide_bleu_tool

    best = state.get("best_passing") or state.get("best_overall")
    sequence = best.sequence if best else state.get("current_sequence", "")
    score = best.bleu_score if best else state.get("current_score", 0.0)
    rulebook_score = best.rulebook.fitness if (best and best.rulebook) else None

    reference = state.get("reference", "")
    components = {}
    if reference and sequence:
        bleu = peptide_bleu_tool.invoke(
            {"reference": reference, "sequence": sequence, "activity": state.get("activity") or None}
        )
        components = bleu.get("components", {})

    reference_source = state.get("reference_source", "")
    reference_used = reference_source if reference_source else ("user" if reference else "")

    rag_examples = state.get("rag_examples", [])

    return {
        "type": "final",
        "result": {
            "sequence": sequence,
            "score": score,
            "rulebook_score": rulebook_score,
            "reference_used": reference_used,
            "components": components,
            "iterations": state.get("iteration", 0),
            "time_seconds": elapsed,
            "rag_examples_used": len(rag_examples),
            "rag_sequences": [ex["sequence"] for ex in rag_examples[:3]],
            "plddt_score": state.get("plddt_score"),
            "helix_pct": state.get("helix_pct"),
            "status": state.get("status", "unknown"),
            "thread_id": state.get("_thread_id"),
        },
    }


async def generate_harness_stream(task_overrides: dict, thread_id: Optional[str] = None) -> AsyncIterator[dict]:
    """Drive harness/graph.py's StateGraph to completion, yielding dicts in
    the exact {"data": "<json>"} shape sse_starlette's EventSourceResponse
    requires (a bare {"type": ...} dict gets passed as ServerSentEvent(**d)
    kwargs and raises "unexpected keyword argument 'type'" — the json string
    itself is where "type"/"n"/"sequence"/etc actually live, same as
    backend/server.py's legacy _generate_stream()). Mirrors that function's
    "run blocking work in a thread pool, bridge via an asyncio.Queue" pattern.
    """
    import concurrent.futures

    from langgraph.types import Command

    loop = asyncio.get_event_loop()
    event_queue: asyncio.Queue = asyncio.Queue()
    thread_id = thread_id or str(uuid.uuid4())

    app = build_graph()
    initial_state = create_initial_state(**task_overrides)
    run_config = {"configurable": {"thread_id": thread_id}}

    def emit(event: dict) -> None:
        loop.call_soon_threadsafe(event_queue.put_nowait, {"data": json.dumps(event)})

    def run_graph() -> dict:
        # Accumulate state locally from each node's yielded delta rather than
        # calling app.get_state(run_config) mid-stream — live-testing this
        # bridge surfaced a real SqliteSaver quirk where get_state() queried
        # immediately after a node's update is yielded can return a snapshot
        # missing that very update's channel writes (e.g. score_node's fresh
        # current_score not yet visible even though validate/track already
        # ran on the correct in-memory value, per that node's own yielded
        # delta). No prior harness code had ever called get_state() mid-
        # .stream() before — every earlier use (handle_generate, test_week3)
        # only queried it after the stream loop fully finished, where this
        # never surfaces. Accumulating from deltas sidesteps the checkpoint
        # read-after-write timing question entirely.
        last_score = 0.0
        stream_input = initial_state
        current_state = dict(initial_state)
        start = time.monotonic()
        try:
            while True:
                interrupted = False
                for update in app.stream(stream_input, config=run_config):
                    if "__interrupt__" in update:
                        interrupted = True
                        # thread_id has to ride along in the payload itself —
                        # SSE is one-way, so POST /resume is the client's only
                        # path back, and it needs thread_id to target the
                        # right paused run. harness/hitl.py's own payload
                        # (built with no knowledge of HTTP/thread_id) doesn't
                        # include it, so it's added here at the bridge layer.
                        emit(
                            {
                                "type": "hitl",
                                "data": {**update["__interrupt__"][0].value, "thread_id": thread_id},
                            }
                        )
                        continue
                    for node_name, node_output in update.items():
                        if node_output:
                            current_state.update(node_output)
                        if node_name == "track":
                            event = _build_attempt_event(current_state, last_score)
                            last_score = event["score"]
                            emit(event)

                if not interrupted:
                    break

                # Block this executor thread (never the asyncio loop) until
                # POST /resume pushes a decision for this thread_id.
                q = _hitl_decision_queues.setdefault(thread_id, queue.Queue())
                decision = q.get()
                stream_input = Command(resume=decision)

            current_state["_thread_id"] = thread_id
            return _build_final_event(current_state, time.monotonic() - start)
        finally:
            # A plain sentinel object, not run through emit()/json.dumps —
            # emit() wraps every real event as {"data": "<json>"}, so reusing
            # it here would require unwrapping the sentinel out of that shape
            # just to check for it a few lines down.
            loop.call_soon_threadsafe(event_queue.put_nowait, _DONE)

    result_holder: list[dict] = []
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    loop.run_in_executor(executor, lambda: result_holder.append(run_graph()))

    while True:
        event = await event_queue.get()
        if event is _DONE:
            break
        yield event

    if result_holder:
        yield {"data": json.dumps(result_holder[0])}
