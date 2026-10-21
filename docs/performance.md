# Multi-Agent Performance

## Changes

- An observer-local committed-history projection is reused while durable entries retain their identity. Live updates copy the message array and overlay unresolved tool cards and partial output, without re-reading historical model/tool content. Entry replacement, compaction, and undo rebuild the projection. Cached messages are never mutated by live overlays.
- Live-only view/context notifications repaint without scheduling a JSON snapshot. Entry, session-status, agent, inbox, usage, task, and workspace changes still request persistence. Direct shell output remains persisted because it is not backed by the conversation database.
- Background snapshots use one lazily created worker to serialize and write a private temporary file. There is one in-flight snapshot and at most one coalesced successor. Each request waits until the queue drains. No worker is created for an unused Store.
- The main thread publishes a current worker result with an atomic rename. The revision check and rename deliberately have no intervening await, preventing a stale worker result from overtaking a newer synchronous checkpoint. Superseded temporary files are removed.
- Async engine/workspace operations await checkpoints before proceeding with dependent side effects. Prompt acceptance, synchronous UI mutations with rollback, startup, and migration retain synchronous saves for their existing guarantees. Accepted input is on disk before synchronous `send()` returns. This is not a blanket removal of synchronous filesystem operations.
- Shutdown flushes pending snapshots and terminates the worker. Snapshot format, full cached history, file permissions, and existing SQLite recovery remain unchanged. Writes still do not use fsync, matching the previous durability contract.

## Reproduce

```sh
npm ci --ignore-scripts
npm run bench:multi-agent -- --baseline
npm run bench:multi-agent
```

The deterministic benchmark runs each scenario in a fresh process, with 2, 4, or 8 simulated agent views, 100 or 1000 historical entries per view, and approximately 1 KiB of text per entry. It emits 100 live-update batches with four committed-history boundaries. A logical 200 ms save window is simulated over five updates; the benchmark does not sleep for those intervals. Initial project setup is outside the measured workload.

Baseline mode emulates the former uncached projection, unconditional persistence notifications, and synchronous snapshot saves. Optimized mode uses the cached projector, persistence classification, and worker-backed saves. Both modes retain the same complete presentation snapshot. This is an application-path comparison, not an exact execution of an older checkout.

Metrics:

- `written_mib` counts successfully published state-file bytes, not physical device traffic or SQLite writes. There are no superseded writes in this sequential fixture; real overlapping requests can also write discarded temporary snapshots.
- `projection_p95_ms` measures one agent's view projection, including committed rebuilds.
- `persistence_request_p95_ms` measures save request/enqueue time, not worker completion or structured-clone overhead. Worker dispatch happens in a microtask and is included in batch delay.
- `main_thread_batch_p95_ms` and `main_thread_batch_max_ms` measure delay to a scheduled `setImmediate` while projecting all agents and dispatching any save. They are not terminal frame times or standard continuous event-loop-lag measurements.
- `cpu_ms` measures process CPU during the workload, including worker activity/startup but excluding SDK imports; it is not CPU utilization. `peak_rss_mib` includes imports and worker memory and is sampled from the process high-water mark.

There is no real model/provider, terminal rendering, tool execution, or SQLite traffic in this benchmark. Each save completes before the next batch, so worker overlap/coalescing correctness is tested separately. Repeat runs on a quiet host; do not interpret one run's timing as a CI threshold or convert its bytes into a live MiB/s rate.

## Observed Before/After

One run on macOS arm64, Node.js 24.22.0, an 8-logical-CPU/16 GiB host with substantial existing swap usage. Numbers are illustrative and vary with host pressure.

| Agents | Entries Each | Snapshot Writes | Snapshot MiB | Batch Delay p95 (ms) | CPU (ms) | Peak RSS (MiB) |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 100 | 20 -> 4 | 4.40 -> 0.88 | 2.21 -> 0.18 | 120 -> 89 | 205 -> 199 |
| 4 | 100 | 20 -> 4 | 8.78 -> 1.76 | 2.16 -> 0.21 | 120 -> 85 | 201 -> 197 |
| 8 | 100 | 20 -> 4 | 17.55 -> 3.51 | 3.19 -> 0.50 | 163 -> 104 | 221 -> 213 |
| 2 | 1000 | 20 -> 4 | 43.47 -> 8.69 | 9.50 -> 2.02 | 262 -> 165 | 254 -> 237 |
| 4 | 1000 | 20 -> 4 | 86.92 -> 17.38 | 25.62 -> 4.93 | 460 -> 216 | 278 -> 287 |
| 8 | 1000 | 20 -> 4 | 173.84 -> 34.76 | 37.71 -> 4.91 | 698 -> 285 | 335 -> 377 |

This fixture achieves approximately 80% fewer snapshot writes/bytes. In the largest case, per-agent projection p95 drops from 0.84 ms to 0.06 ms, and maximum batch delay drops from 77.7 ms to 27.0 ms. Save enqueue p95 drops from 76.2 ms of synchronous work to 0.06 ms; this last comparison deliberately excludes deferred worker-dispatch cost, captured by batch delay instead.

Memory is a trade-off, not an across-the-board improvement: the largest case peaks approximately 42 MiB higher because off-thread serialization needs a cloned state and worker heap. A single writer is shared across all sessions, not created per agent. Cold worker startup can also dominate CPU/latency in very short workloads. Long-term leak behavior and production UI responsiveness still require a live run of the new build.

## Correctness Checks

Tests cover queue coalescing, stale-write suppression against both newer async snapshots and synchronous checkpoints, write/serialization failures and retry, temporary-file cleanup, private permissions, shutdown flushing, history projection reuse, tool-overlay isolation, question/compaction/history-reset parity, and real streaming followed by restart. Existing suites exercise queued input recovery, cancellation, interrupted undo, compaction, workspace handoffs, and CLI shutdown.

The remaining large-history costs include copying message-reference arrays, snapshot structured cloning, full snapshot size at committed boundaries, synchronous acceptance/UI checkpoints, transcript equality checks, and terminal rendering. This change does not claim those costs are eliminated.
