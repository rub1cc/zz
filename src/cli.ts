#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import lockfile from "proper-lockfile";
import { matchesKey, ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { Controller } from "./controller.js";
import { DurableEngine } from "./engine.js";
import { Store } from "./store.js";
import { Dashboard, scrollToEndIndicator } from "./ui.js";
import { loadPi } from "./pi.js";
import { cancelExternalEditor, isExternalEditorOpen } from "./external-editor.js";
import { motionEnabled } from "./format.js";
import { createShutdown } from "./shutdown.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { help: { type: "boolean", short: "h" }, model: { type: "string" }, thinking: { type: "string" }, "data-dir": { type: "string" } },
});

if (values.help) {
  console.log(`zz - project-grouped durable agent sessions

Usage: zz [project-directory] [--model provider/model-id] [--thinking level] [--data-dir path]

New tasks run in the selected project. Up/down or ctrl+p/ctrl+n navigates the list.
With an empty composer: enter opens a session; space peeks and lets you reply.
ctrl+j inserts a newline; enter sends. ctrl+g edits the draft in $VISUAL/$EDITOR (default vim).
ctrl+o manages projects. ctrl+x twice deletes a session or all sessions in the selected project. ctrl+c quits.
If shutdown stalls, press ctrl+c again to force exit (automatic after 5 seconds).
Inside a session, Escape stops running work and stays in the session.
Left Arrow returns to the dashboard when the composer is empty; work continues.
/stop cancels the open or selected session without deleting its history.
/compact [instructions] summarizes its older context; automatic compaction is enabled.

Uses your existing Pi login and saved default model. No separate API key needed.
Model override: --model or ZZ_MODEL (provider/model-id).
Thinking override: --thinking or ZZ_THINKING (off/minimal/low/medium/high/xhigh/max).
In the UI: /model (ctrl+l), /thinking (ctrl+t). Open a session to change it;
on the dashboard these controls change defaults for new sessions.
Shift+Tab cycles thinking. /skills lists skills; /skill:name [task] loads one.
Ctrl+End or /bottom jumps to the newest chat output and resumes following it.
If not logged in, run pi and use /login first.
Data: --data-dir, ZZ_DATA_DIR, or $XDG_DATA_HOME/zz (~/.local/share/zz).
Agents can edit files and run commands. Project directories are not sandboxes.`);
} else {
  void main().catch((error: unknown) => {
    console.error(`zz: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  if (positionals.length > 1) throw new Error("Pass at most one project directory.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive terminal is required. Use zz --help for usage.");
  const root = resolve(values["data-dir"] ?? process.env.ZZ_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "zz"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try { release = await lockfile.lock(root, { realpath: true, stale: 10_000, update: 2_000 }); }
  catch { throw new Error(`Another zz owns ${root}. After a crash, wait 10 seconds before reopening.`); }
  let engine: DurableEngine | undefined;
  let controller: Controller | undefined;
  let tui: TuiAltScreen | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let editorClosed = Promise.resolve();
  const shutdown = createShutdown({
    prepare: () => {
      if (tui) editorClosed = cancelExternalEditor(tui);
      if (controller) { controller.notice = "Pausing running work..."; controller.changed(); }
      if (timer) clearInterval(timer);
    },
    close: async () => {
      await Promise.all([controller ? controller.close() : engine?.close(), editorClosed]);
    },
    restoreTerminal: () => {
      tui?.stop({ preserveScreen: true });
      process.stdin.pause();
    },
    release,
    report: (error) => console.error(`zz: ${error instanceof Error ? error.message : String(error)}`),
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => shutdown.request());
  // The foreground editor owns SIGINT, except once zz itself is shutting down.
  process.on("SIGINT", () => {
    if (shutdown.isClosing || !tui || !isExternalEditorOpen(tui)) shutdown.request();
  });
  try {
    const store = new Store(root);
    const project = store.addProject(positionals[0] ?? process.cwd());
    const saved = store.state.defaults;
    const { models, model, thinkingLevel } = await loadPi(project.path,
      values.model ?? process.env.ZZ_MODEL ?? (saved?.model && `${saved.model.provider}/${saved.model.modelId}`),
      undefined, values.thinking ?? process.env.ZZ_THINKING ?? saved?.thinkingLevel);
    if (shutdown.isClosing) return;
    store.state.defaults = { model, thinkingLevel };
    store.save();
    const reports: unknown[] = [];
    engine = await DurableEngine.open(store, model,
      (error) => { if (controller) controller.fail(error); else reports.push(error); }, models, thinkingLevel);
    controller = new Controller(store, engine);
    if (!model) controller.notice = "No Pi login found. Run pi and /login, then restart zz.";
    tui = new TuiAltScreen(new ProcessTerminal(), false, root, { mouse: true, scrollToEndIndicator });
    const app = new Dashboard(controller, tui, () => shutdown.request());
    tui.setLayoutRoot(app);
    tui.setFocus(app);
    // Keep ctrl+c available even when an overlay owns focus.
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) { shutdown.request(); return { consume: true }; }
      if (shutdown.isClosing) return { consume: true };
      return undefined;
    });
    await engine.restore(() => controller?.changed(true));
    if (shutdown.isClosing) return;
    tui.start();
    app.sync();
    for (const error of reports) controller.fail(error);
    let lastRefresh = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      const animating = motionEnabled() && (controller?.mode === "session"
        ? controller.opened?.status === "working"
        : controller?.currentRows.some((row) => row.kind === "session" && row.session.status === "working"));
      if (animating || now - lastRefresh >= 30_000) {
        tui?.requestRender();
        lastRefresh = now;
      }
    }, 80);
  } catch (error) {
    if (!shutdown.isClosing) shutdown.request(1, error);
  }
}
