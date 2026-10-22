import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { displayStatus, rows, type Session } from "../src/model.js";
import { Store } from "../src/store.js";
import { Dashboard } from "../src/ui.js";
import { Transcript, workLabel } from "../src/transcript.js";
import { FakeEngine, FakeTerminal, temporary } from "./helpers.js";

function fixture() {
  const temp = temporary(); const path = join(temp.root, "project"); mkdirSync(path);
  const store = new Store(join(temp.root, "data")); const project = store.addProject(path);
  const c = new Controller(store, new FakeEngine());
  const make = (id: string, parentId?: string, status: Session["status"] = "completed"): Session => ({
    id, projectId: project.id, title: id, status, preview: status === "needs-input" ? "Which currency?" : "Task result",
    createdAt: 1, updatedAt: 1, messages: [], ...(parentId ? { delegation: { parentId, taskId: `task-${id}` } } : {}),
  });
  const coordinator = make("Checkout flow"); coordinator.waitingFor = ["Backend", "Frontend"];
  const backend = make("Backend", coordinator.id, "working"); const frontend = make("Frontend", coordinator.id, "needs-input");
  const review = make("Review", coordinator.id); const independent = make("Fix flaky tests");
  store.state.sessions.push(coordinator, backend, frontend, review, independent); store.save();
  const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal, false);
  const app = new Dashboard(c, tui, () => {}); tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
  const screen = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  return { ...temp, store, project, c, terminal, tui, app, coordinator, backend, frontend, review, independent, screen,
    async cleanup() { app.dispose(); await c.close(); tui.stop(); temp.cleanup(); } };
}

test("dashboard nests normal worker sessions and distinguishes waiting from working/completed", async () => {
  const f = fixture();
  try {
    const all = f.c.currentRows.filter((row) => row.kind === "session");
    const index = all.findIndex((row) => row.session.id === f.coordinator.id);
    assert.ok(all.slice(index + 1, index + 4).every((row) => row.depth === 1));
    assert.equal(displayStatus(f.coordinator), "waiting"); assert.match(workLabel(f.coordinator)!, /Waiting on 2 sessions/);
    const screen = f.screen();
    assert.match(screen, /Checkout flow \[3 workers\]/); assert.match(screen, /1 waiting/);
    assert.match(screen, /├─ .*Frontend/); assert.match(screen, /├─ .*Backend/);
    assert.match(screen, /└─ .*Review/); assert.match(screen, /Waiting on 2 sessions/);
    for (const width of [1, 12, 32, 80, 120]) {
      f.terminal.columns = width; f.terminal.onResize(); f.screen();
      assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
    }
    f.coordinator.stopped = true; assert.equal(displayStatus(f.coordinator), "completed");
  } finally { await f.cleanup(); }
});

test("tree gutters continue ancestor branches and reset between top-level sessions and projects", async () => {
  const f = fixture();
  try {
    const grandchild: Session = { ...f.review, id: "API review", title: "API review",
      delegation: { parentId: f.frontend.id, taskId: "api-review" } };
    const lastGrandchild: Session = { ...grandchild, id: "Final review", title: "Final review",
      delegation: { parentId: f.review.id, taskId: "final-review" } };
    const otherPath = join(f.root, "other-project"); mkdirSync(otherPath);
    const otherProject = f.store.addProject(otherPath);
    const otherRoot: Session = { ...f.independent, id: "Other root", title: "Other root", projectId: otherProject.id };
    const otherChild: Session = { ...grandchild, id: "Other worker", title: "Other worker", projectId: otherProject.id,
      delegation: { parentId: otherRoot.id, taskId: "other-worker" } };
    f.store.state.sessions.push(grandchild, lastGrandchild, otherRoot, otherChild);
    const lines = f.app.body.render(160).map(stripTerminalSequences);
    assert.match(lines.find((line) => line.includes("API review"))!, /^  │  └─ .*API review/);
    assert.match(lines.find((line) => line.includes("Final review"))!, /^     └─ .*Final review/);
    assert.match(lines.find((line) => line.includes("Fix flaky tests"))!, /^  ∙ Fix flaky tests/);
    assert.match(lines.find((line) => line.includes("Other worker"))!, /^  └─ .*Other worker/);
    assert.ok(lines.every((line) => !line.includes("|-")));
  } finally { await f.cleanup(); }
});

test("Tab folds workers without hiding questions; Enter and Space still open and reply to real sessions", async () => {
  const f = fixture();
  try {
    f.c.select(`session:${f.coordinator.id}`); f.app.composer.setValue("keep draft");
    f.terminal.onInput("\t"); assert.equal(f.c.collapsedSessions.size, 0);
    f.app.composer.setValue(""); f.terminal.onInput("\t");
    assert.equal(f.c.collapsedSessions.has(f.coordinator.id), true);
    assert.equal(f.c.currentRows.some((row) => row.kind === "session" && row.session.id === f.backend.id), false);
    assert.equal(f.c.currentRows.some((row) => row.kind === "session" && row.session.id === f.frontend.id), true);
    assert.match(f.screen(), /\[\+3 workers\]/);
    assert.match(f.screen(), /└─ .*Frontend/);
    assert.doesNotMatch(f.screen(), /├─/);
    f.c.select(`session:${f.frontend.id}`); f.terminal.onInput(" ");
    assert.equal(f.c.dialog?.kind, "peek"); f.c.dialog = undefined; f.c.changed();
    f.terminal.onInput("\r"); assert.equal(f.c.openedSessionId, f.frontend.id);
    assert.match(f.screen(), /worker for Checkout flow/);
    f.c.back(); assert.equal(f.c.collapsedSessions.has(f.coordinator.id), false);
    assert.equal(f.c.selected?.kind, "session");
    f.c.select(`session:${f.coordinator.id}`); assert.equal(f.c.canStop(f.coordinator), true);
  } finally { await f.cleanup(); }
});

test("peer messages and orchestration notices are distinguishable from human messages in the transcript", async () => {
  const f = fixture();
  try {
    f.backend.status = "completed";
    f.backend.messages = [{ role: "user", text: "Human instruction", timestamp: 1 },
      { role: "user", text: "What's the API?", timestamp: 2, source: { sessionId: f.frontend.id, title: "Frontend", kind: "message" } },
      { role: "user", text: "Review completed", timestamp: 3, source: { sessionId: f.coordinator.id, title: "zz orchestration", kind: "notification" } }];
    f.c.openedSessionId = f.backend.id; f.c.mode = "session";
    const transcript = new Transcript(f.c, () => {});
    const text = transcript.render(100).map(stripTerminalSequences).join("\n");
    assert.match(text, /Human instruction/); assert.match(text, /From Frontend \(agent\)/); assert.match(text, /Session update/);
    assert.doesNotMatch(text, /❯ Review completed/);
    assert.deepEqual([...transcript.prompts.values()], ["Human instruction"], "Sticky prompts must not relabel peer messages as human instructions");
    for (const width of [1, 12, 40]) assert.ok(transcript.render(width).every((line) => visibleWidth(line) <= width));
    f.store.save(); const stored = new Store(f.store.root);
    assert.equal(stored.state.sessions.find((s) => s.id === f.backend.id)?.messages[1]?.source?.kind, "message");
  } finally { await f.cleanup(); }
});

test("orphans, cycles and sibling reordering cannot hide or reparent sessions", async () => {
  const f = fixture();
  try {
    f.c.select(`session:${f.review.id}`); f.c.reorderSession(-1);
    assert.equal(f.review.delegation?.parentId, f.coordinator.id);
    assert.equal(f.independent.delegation, undefined);
    f.store.state.sessions = f.store.state.sessions.filter((s) => s.id !== f.coordinator.id);
    assert.equal(rows(f.store.state).filter((r) => r.kind === "session").length, 4);
    f.backend.delegation = { parentId: f.review.id, taskId: "cycle-a" };
    f.review.delegation = { parentId: f.backend.id, taskId: "cycle-b" };
    assert.equal(rows(f.store.state).filter((r) => r.kind === "session").length, 4);
    assert.equal(new Set(rows(f.store.state).filter((r) => r.kind === "session").map((r) => r.session.id)).size, 4);
  } finally { await f.cleanup(); }
});
