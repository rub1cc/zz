# Tool execution

zz accepts multiple native tool calls in one model response. A batch is not a
single transaction, and does not imply every call executes concurrently. No extra
model-facing batch tool is needed.

## Scheduling policy

`src/tool-scheduling.ts` gates top-level calls within each conversation's tool
round using the model's original call order:

- `read`, `task_list`, and `task_get` are the only parallel-safe tools.
- Consecutive safe calls run in fixed windows of at most four. A window waits for
  all calls before it to settle, not just the fastest sibling in the prior window.
- Every other tool is exclusive, including Bash, edits, writes, checklist updates,
  questions, and unknown tools. It waits for preceding calls; following calls
  wait for it. Replay safety is not treated as concurrency safety.
- Bash is always exclusive, even when its command appears read-only. zz does not
  attempt a shell safety classifier.
- Separate conversations remain independent. This is not a cross-session or
  cross-process filesystem lock, sandbox, or permission policy. User `!` commands
  and external processes do not participate.

For example:

```text
read A + read B   -> together
write C          -> alone, after both reads settle
bash             -> alone, after the write settles
read D + read E  -> together, after Bash settles
```

The allowlist is deliberately closed. New tools must be reviewed before they can
join it. The engine installs the scheduling extension after registering its tools;
its execution wrappers cover that registry loadout. There is currently no dynamic
custom-tool or MCP extension host.

Nested calls execute within their top-level parent's reservation. They do not
wait on the parent's receipt, which would deadlock. A parallel-safe tool must not
launch state-changing nested calls. Currently zz's allowlisted tools do not make
nested calls; custom nested fan-out is not independently concurrency-limited.

## Persistence, failures, and cancellation

Pi Durable still creates, owns, and settles each tool task. The gate runs before
execution intent is committed, so calls waiting behind a barrier have not started
and retain their original `call` checkpoint. Dependencies come from persisted
`pi.live.tools` slots, with waits on durable task receipts rather than an in-memory
semaphore or completion callback.

Execution wrappers also apply the gate during recovery: replay-safe intents skip
`beforeTool`, including intents left by older versions without this scheduler.
The tool's existing replay policy remains unchanged. Completed calls are not
repeated; interrupted unsafe calls report that they may have partially run rather
than being automatically repeated. This is not an exactly-once side-effect
guarantee.

A failed dependency settles normally for scheduling purposes. Other calls keep
their own results and errors; neither siblings nor later windows are cancelled
merely because one tool failed. Cancellation and shutdown cancel admission waits
through the invocation's context. Pi Durable supplies aborted results and resumes
unfinished checkpoints according to its existing policy.

The next model request waits for the whole tool round. Tool IDs, individual result
entries, output limits, and undo tracking remain owned by the existing runtime.
Compact transcript groups remain presentation-only: a grouped row does not claim
that its calls ran simultaneously.

## Claude Code research

Research checked official documentation/changelog and the locally installed
Claude Code 2.1.301 executable, without an authenticated session or paid request.

- [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use):
  multiple `tool_use` blocks may appear in one assistant response; the harness
  chooses execution order and returns an individually matched result per call.
- The installed executable contains input-dependent `isConcurrencySafe` gates,
  exclusive-call barriers, and parallel-safe grouping. These are implementation
  observations for that version, not a stable public SDK contract.
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md),
  version 2.1.161: failed Bash calls no longer cancel other calls in the same batch.

zz adopts conservative safety-aware scheduling, not exact Claude Code parity:
fixed four-call windows, no read-only Bash classifier, and Pi Durable's existing
persistence/replay semantics.

## Verification

`test/tool-scheduling.test.ts` exercises bounded overlap, exclusive barriers,
out-of-order hooks, committed-result waits, independent failures, invalid and
unavailable calls, cancellation, nested calls, and restart recovery (including
legacy already-recorded intents). `test/engine.test.ts` verifies the engine's
installed gate with a real shell mutation followed by a file read.
