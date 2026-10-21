#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import lockfile from "proper-lockfile";
import { matchesKey, ProcessTerminal, TuiAltScreen, type TerminalColors } from "@earendil-works/pi-tui";
import { Controller } from "./controller.js";
import { DurableEngine } from "./engine.js";
import { Store } from "./store.js";
import { Dashboard, scrollToEndIndicator } from "./ui.js";
import { displayStatus } from "./model.js";
import { loadPi } from "./pi.js";
import { cancelExternalEditor, isExternalEditorOpen } from "./external-editor.js";
import { statusRefreshInterval } from "./format.js";
import { createShutdown } from "./shutdown.js";
import { setDiffBackground } from "./diff-background.js";
import { upgrade } from "./upgrade.js";
import { version } from "./version.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, model: { type: "string" }, thinking: { type: "string" }, "data-dir": { type: "string" } },
});

if (values.help) {
  console.log(`zz - project-grouped durable agent sessions

Usage: zz [project-directory] [--model provider/model-id] [--thinking level] [--data-dir path]
       zz upgrade
       zz --version

zz upgrade checks for updates and installs only a newer release.
Use zz ./upgrade to open a directory named upgrade.

New tasks run in the selected project. Up/down or ctrl+p/ctrl+n navigates the list.
With an empty composer: enter opens a session; space peeks and lets you reply.
ctrl+j inserts a newline; enter sends. ctrl+g edits the draft in $VISUAL/$EDITOR (default vim).
/projects manages projects; Escape returns to the dashboard.
/workspace selects main, new worktree, or existing checkout for new tasks.
Git tasks default to separate worktrees from committed HEAD; existing sessions stay put unless asked to switch.
Ask the agent to create/enter a worktree or return to main; the same conversation continues.
/workspace approve or /workspace deny decides a pending external-checkout request.
On the dashboard, shift+up/down reorders sessions within a project; ctrl+r renames the selected session.
ctrl+x twice deletes a session or all sessions in the selected project. ctrl+c quits.
If shutdown stalls, press ctrl+c again to force exit (automatic after 5 seconds).
Escape dismisses suggestions and dialogs without stopping running work; use /stop.
Left Arrow returns to the dashboard when the composer is empty; work continues.
/settings (or /config) configures busy replies, reasoning display and auto-compaction token budgets.
/stop cancels the open or selected session without deleting its history.
/copy [N] copies the Nth-latest assistant or shell response from the open or selected session (default 1).
!command runs a local shell in this session's workspace (e.g. !pwd), without sending it to the model.
Shell output streams inline as a saved response. /stop stops all work in that session.
/compact [instructions] summarizes older context, even with auto-compaction Off in /settings.
/undo opens a checkpoint picker; Enter restores the selection, Escape cancels (not shell effects).

Uses your existing Pi login and saved default model. No separate API key needed.
Model override: --model or ZZ_MODEL (provider/model-id).
Thinking override: --thinking or ZZ_THINKING (off/minimal/low/medium/high/xhigh/max).
In the UI: /model, /thinking. Open a session to change it;
on the dashboard these controls change defaults for new sessions.
/skills lists skills; $skill-name [task] loads one (type $ to autocomplete).
/bottom jumps to the newest chat output and resumes following it.
/login [provider] signs in; /logout [provider] removes credentials shared with Pi.
Ctrl+V or dragged paths stage images; @image.png attaches on send.
Backspace with empty draft text removes the last staged image.
/settings controls reasoning visibility. Project instruction Markdown loads automatically.
Data: --data-dir, ZZ_DATA_DIR, or ~/.zz (default).
Agents can edit files and run commands. Project directories are not sandboxes.`);
} else if (values.version) {
  console.log(version);
} else {
  void main().catch((error: unknown) => {
    console.error(`zz: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  if (positionals[0] === "upgrade") {
    if (positionals.length !== 1 || values.model !== undefined || values.thinking !== undefined || values["data-dir"] !== undefined) {
      throw new Error("Usage: zz upgrade");
    }
    await upgrade();
    return;
  }
  if (positionals.length > 1) throw new Error("Pass at most one project directory.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive terminal is required. Use zz --help for usage.");
  const root = resolve(values["data-dir"] ?? process.env.ZZ_DATA_DIR ?? join(homedir(), ".zz"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try { release = await lockfile.lock(root, { realpath: true, stale: 10_000, update: 2_000 }); }
  catch { throw new Error(`Another zz owns ${root}. After a crash, wait 10 seconds before reopening.`); }
  let engine: DurableEngine | undefined;
  let controller: Controller | undefined;
  let tui: TuiAltScreen | undefined;
  let app: Dashboard | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let editorClosed = Promise.resolve();
  const shutdown = createShutdown({
    prepare: () => {
      if (tui) editorClosed = cancelExternalEditor(tui);
      if (controller) { controller.notice = "Pausing running work..."; controller.changed(); }
      app?.dispose();
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
    const { models, model, thinkingLevel, auth } = await loadPi(project.path,
      values.model ?? process.env.ZZ_MODEL ?? (saved?.model && `${saved.model.provider}/${saved.model.modelId}`),
      undefined, values.thinking ?? process.env.ZZ_THINKING ?? saved?.thinkingLevel);
    if (shutdown.isClosing) return;
    store.state.defaults = { model, thinkingLevel };
    store.save();
    const reports: unknown[] = [];
    engine = await DurableEngine.open(store, model,
      (error) => { if (controller) controller.fail(error); else reports.push(error); }, models, thinkingLevel);
    controller = new Controller(store, engine, auth);
    if (!model) controller.notice = "No Pi login found. Use /login, then /model to choose a provider and model.";
    tui = new TuiAltScreen(new ProcessTerminal(), false, root, { mouse: true, scrollToEndIndicator });
    app = new Dashboard(controller, tui, () => shutdown.request());
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
    const updateDiffBackground = (colors: TerminalColors) => {
      if (shutdown.isClosing || !setDiffBackground(colors.background)) return;
      app?.body.transcript.invalidate();
      tui?.requestRender();
    };
    void tui.queryTerminalColors({ timeoutMs: 200, onLateReply: updateDiffBackground }).then(updateDiffBackground, () => {});
    app.sync();
    for (const error of reports) controller.fail(error);
    let lastRefresh = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      const working = controller?.mode === "session"
        ? !!controller.opened && displayStatus(controller.opened) === "working"
        : controller?.currentRows.some((row) => row.kind === "session" && displayStatus(row.session) === "working");
      if (now - lastRefresh >= statusRefreshInterval(!!working)) {
        tui?.requestRender();
        lastRefresh = now;
      }
    }, 80);
  } catch (error) {
    if (!shutdown.isClosing) shutdown.request(1, error);
  }
}
