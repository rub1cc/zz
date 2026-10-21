import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// Deterministic view notifications, not provider/network throughput or real agents.
const baseline = process.argv.includes("--baseline");
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)] ?? 0;

async function scenario(agents, history) {
  const engine = await import("../src/engine.ts");
  const { Store } = await import("../src/store.ts");
  const root = mkdtempSync(join(tmpdir(), "zz-bench-"));
  const store = new Store(root);
  try {
    const project = store.addProject(root);
    const entries = Array.from({ length: history }, (_, i) => ({ id: i + 1, model: [{
      role: "assistant", content: [{ type: "text", text: `Message ${i}: ${"x".repeat(1024)}` }],
      timestamp: i + 1, stopReason: "stop",
    }] }));
    const sessions = Array.from({ length: agents }, (_, i) => ({ id: String(i), projectId: project.id,
      title: `Agent ${i}`, status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [] }));
    store.state.sessions.push(...sessions);
    // Baseline mode emulates the previous uncached projection and synchronous saving.
    const projectors = sessions.map((session) => !baseline
      ? engine.createViewProjector(session) : (view) => { engine.applyView(session, view); return true; });
    let writes = 0, bytes = 0, dirty = false;
    const projections = [], requests = [], stalls = [];
    const save = async () => {
      const start = performance.now();
      const pending = !baseline ? store.saveAsync() : store.save();
      requests.push(performance.now() - start);
      await pending;
      writes++; bytes += statSync(store.file).size;
    };
    let current = entries;
    const cpu = process.cpuUsage(), started = performance.now();
    for (let frame = 0; frame < 100; frame++) {
      // Four committed boundaries, with 25 live updates per boundary.
      if (frame && frame % 25 === 0) current = [...current, { id: history + frame, model: [{
        role: "user", content: "Next tool round", timestamp: history + frame,
      }] }];
      const batch = performance.now();
      const turn = new Promise((resolve) => setImmediate(() => { stalls.push(performance.now() - batch); resolve(); }));
      for (const project of projectors) {
        const start = performance.now();
        dirty = project({ entries: current, docs: { "pi.live": { run: { taskId: 1 }, generation: {
          message: { role: "assistant", timestamp: history + frame + 1,
            content: [{ type: "text", text: "stream ".repeat(frame + 1) }] },
        } } } }) || dirty;
        projections.push(performance.now() - start);
      }
      // Simulate the 200ms coalescing window over 40ms updates, without wall-clock sleeps.
      if (frame % 5 === 4 && dirty) { const pending = save(); dirty = false; await turn; await pending; }
      else await turn;
    }
    const usage = process.cpuUsage(cpu);
    return { agents, history_entries: history, writes, written_mib: +(bytes / 2 ** 20).toFixed(3),
      projection_p95_ms: +p95(projections).toFixed(3), persistence_request_p95_ms: +p95(requests).toFixed(3),
      main_thread_batch_p95_ms: +p95(stalls).toFixed(3), main_thread_batch_max_ms: +Math.max(...stalls).toFixed(3),
      peak_rss_mib: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      cpu_ms: +((usage.user + usage.system) / 1000).toFixed(1), elapsed_ms: +(performance.now() - started).toFixed(1) };
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}

if (process.argv.includes("--case")) {
  const agents = Number(process.argv[process.argv.indexOf("--agents") + 1]);
  const history = Number(process.argv[process.argv.indexOf("--history") + 1]);
  console.log(JSON.stringify(await scenario(agents, history)));
} else {
  const results = [];
  // Fresh processes prevent previous scenarios' JIT/GC and RSS high-water marks leaking into later cases.
  for (const history of [100, 1000]) for (const agents of [2, 4, 8]) {
    const run = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url),
      "--case", "--agents", String(agents), "--history", String(history), ...(baseline ? ["--baseline"] : [])],
      { encoding: "utf8", timeout: 60_000 });
    if (run.status !== 0) throw new Error(run.stderr || `Benchmark failed: ${run.signal}`);
    results.push(JSON.parse(run.stdout));
  }
  console.log(JSON.stringify({ mode: baseline ? "baseline" : "optimized", node: process.version, results }, null, 2));
}
