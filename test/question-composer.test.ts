import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { Composer } from "../src/composer.js";
import { QuestionComposer } from "../src/question-composer.js";
import { pendingQuestion } from "../src/questions.js";
import { Store } from "../src/store.js";
import { FakeEngine, FakeTerminal, temporary, tick } from "./helpers.js";
import { waitingSession } from "./question-fixtures.js";

const options = [{ value: "a", label: "Option A", description: "Description option A" },
  { value: "b", label: "Option B", description: "Description option B" }];

function setup(arguments_: Record<string, unknown>) {
  const temp = temporary();
  const store = new Store(join(temp.root, "data"));
  const project = store.addProject(temp.root);
  const session = waitingSession(); session.projectId = project.id;
  session.messages[1]!.tool!.arguments = arguments_;
  store.state.sessions.push(session);
  const engine = new FakeEngine();
  const controller = new Controller(store, engine);
  const terminal = new FakeTerminal();
  const tui = new TuiAltScreen(terminal, false);
  const view = new QuestionComposer(controller, tui, { sessionId: session.id, request: pendingQuestion(session)! });
  tui.setLayoutRoot(view); tui.setFocus(view); tui.start();
  const text = (width = 80) => view.render(width).map(stripTerminalSequences).join("\n");
  return { ...temp, session, engine, controller, terminal, tui, view, text,
    async cleanup() { await controller.close(); tui.stop(); temp.cleanup(); } };
}

function submitted(engine: FakeEngine): unknown[] {
  const prompt = engine.calls[0]!.prompt;
  return JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).map((entry: { answer: unknown }) => entry.answer);
}

test("numbered single choices put descriptions underneath and accept inline custom text", async () => {
  const f = setup({ question: "Target", questions: [{ id: "target", question: "Choose a target", type: "radio", options }] });
  try {
    assert.match(f.text(), /1\. Option A\n {5}Description option A\n\n {2}2\. Option B\n {5}Description option B/);
    assert.match(f.text(), /3\. type something/);
    f.view.handleInput("\x1b[B"); f.view.handleInput("\x1b[B");
    f.view.handleInput("A custom target");
    assert.match(f.text(), /3\. A custom target/);
    assert.match(f.text(), /1\. Option A/);
    assert.match(f.text(), /2\. Option B/);
    assert.equal(f.engine.calls.length, 0);
    f.view.handleInput("\t");
    assert.match(f.text(), /Review your answers/);
    assert.match(f.text(), /A custom target/);
    assert.match(f.text(), /1\. Submit answers/);
    assert.match(f.text(), /2\. Cancel/);
    assert.equal(f.engine.calls.length, 0);
    f.view.handleInput("\r"); await tick();
    assert.deepEqual(submitted(f.engine), ["A custom target"]);
  } finally { await f.cleanup(); }
});

test("multiselect has numbered checkboxes, indented descriptions, inline auto-check and an explicit Next action", async () => {
  const f = setup({ question: "Features", questions: [{ id: "features", question: "Choose features", type: "multiselect", options }] });
  try {
    assert.match(f.text(), /1\. \[ \] Option A\n {9}Description option A/);
    assert.match(f.text(), /2\. \[ \] Option B\n {9}Description option B/);
    assert.match(f.text(), /3\. \[ \] type something/);
    assert.match(f.text(), /\n {2}Next\n/);
    f.view.handleInput(" ");
    f.view.handleInput("\x1b[B"); f.view.handleInput("\x1b[B");
    f.view.handleInput("Offline"); f.view.handleInput(" "); f.view.handleInput("mode");
    assert.match(f.text(), /1\. \[x\] Option A/);
    assert.match(f.text(), /3\. \[x\] Offline mode/);
    f.view.handleInput("\x1b[B"); f.view.handleInput("\x1b[A"); f.view.handleInput(" ");
    assert.match(f.text(), /3\. \[ \] Offline mode/);
    f.view.handleInput(" ");
    assert.match(f.text(), /3\. \[x\] Offline mode/);
    f.view.handleInput("\x15");
    assert.match(f.text(), /3\. \[ \] type something/);
    assert.match(f.text(), /1\. \[x\] Option A/);
    f.view.handleInput("New custom");
    const lines = f.view.render(80).map(stripTerminalSequences);
    const y = lines.findIndex((line) => line.trim() === "Next");
    assert.ok(y >= 0);
    f.view.handleMouse({ type: "click", button: "left", x: 3, y, screenX: 3, screenY: y,
      width: 80, height: 32, shift: false, ctrl: false, alt: false });
    assert.match(f.text(), /Review your answers/);
    assert.match(f.text(), /Option A, New custom/);
    assert.equal(f.engine.calls.length, 0);
    f.view.handleInput("\r"); await tick();
    assert.deepEqual(submitted(f.engine), [["a", "New custom"]]);
  } finally { await f.cleanup(); }
});

test("Tab and Shift+Tab navigate steps, preserve drafts, and never submit at the review step", async () => {
  const f = setup({ question: "Details", questions: [
    { id: "first", question: "First answer?", type: "input" },
    { id: "second", question: "Second answer?", type: "input" },
    { id: "target", question: "Target?", type: "radio", options },
  ] });
  try {
    f.view.handleInput("Alpha"); f.view.handleInput("\t");
    f.view.handleInput("Beta"); f.view.handleInput("\x1b[Z");
    assert.match(f.text(), /Question 1 of 3/);
    assert.equal(f.view.input.getValue(), "Alpha");
    f.view.handleInput("\x1b[Z");
    assert.match(f.text(), /Question 1 of 3/);
    f.view.handleInput("\t");
    assert.equal(f.view.input.getValue(), "Beta");
    f.view.handleInput("\t"); f.view.handleInput("\t");
    assert.match(f.text(), /Review your answers/);
    assert.match(f.text(), /You have not answered all questions/);
    f.view.handleInput("\x1b[6~");
    assert.match(f.text(), /Not answered/);
    f.view.handleInput("\t"); f.view.handleInput("\r");
    assert.equal(f.engine.calls.length, 0, "Incomplete forms cannot be submitted");
    f.view.handleInput("\x1b[Z");
    assert.match(f.text(), /Question 3 of 3/);
    f.view.handleInput("\r");
    assert.doesNotMatch(f.text(), /You have not answered all questions/);
    f.view.handleInput("\t");
    assert.equal(f.engine.calls.length, 0, "Tab at Submit does not send");
    f.view.handleInput("\r"); await tick();
    assert.deepEqual(submitted(f.engine), ["Alpha", "Beta", "a"]);
  } finally { await f.cleanup(); }
});

test("review Cancel leaves the question pending without sending any answers", async () => {
  const f = setup({ question: "Features", questions: [{ id: "features", question: "Choose features", type: "multiselect", options }] });
  try {
    f.view.handleInput("\x1b[A"); f.view.handleInput("\r");
    assert.match(f.text(), /Select at least one option/);
    f.view.handleInput("\t");
    assert.match(f.text(), /Submit/);
    assert.match(f.text(), /You have not answered all questions/);
    f.view.handleInput("\x1b[B"); f.view.handleInput("\r"); await tick();
    assert.equal(f.controller.questionForm, undefined);
    assert.equal(f.session.status, "needs-input");
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("editing a custom value equal to a listed value does not remove a separately checked option", async () => {
  const f = setup({ question: "Features", questions: [{ id: "features", question: "Choose features", type: "multiselect", options }] });
  try {
    f.view.handleInput(" "); f.view.handleInput("\x1b[B"); f.view.handleInput("\x1b[B");
    f.view.handleInput("a"); f.view.handleInput("\x15");
    assert.match(f.text(), /1\. \[x\] Option A/);
    f.view.handleInput("\t"); f.view.handleInput("\r"); await tick();
    assert.deepEqual(submitted(f.engine), [["a"]]);
  } finally { await f.cleanup(); }
});

test("all five options and descriptions stay rendered without an internal choice viewport", async () => {
  const choices = Array.from({ length: 5 }, (_, i) => ({ value: String(i), label: `Option ${i + 1}`, description: `Details for option ${i + 1}` }));
  const f = setup({ question: "Features", questions: [{ id: "features", question: "Choose features", type: "multiselect", allowOther: false, options: choices }] });
  try {
    for (const height of [12, 16, 24, 32]) {
      f.terminal.rows = height;
      for (const width of [24, 40, 80]) {
        for (let i = 0; i < 6; i++) {
          const lines = f.view.render(width);
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
          const text = lines.map(stripTerminalSequences).join("\n").replace(/\s+/g, " ");
          for (const choice of choices) {
            assert.ok(text.includes(choice.label));
            assert.ok(text.includes(choice.description));
          }
          assert.match(text, /Next/);
          f.view.handleInput("\x1b[B");
        }
      }
    }
    f.view.handleInput("\t");
    assert.match(f.text(), /Submit/);
    assert.match(f.text(), /Cancel/);
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("clicking the custom row starts inline typing and clicking Cancel leaves the session waiting", async () => {
  const f = setup({ question: "Target", questions: [{ id: "target", question: "Choose a target", type: "radio", options }] });
  const click = (y: number, x: number) => f.view.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y,
    width: 80, height: 32, shift: false, ctrl: false, alt: false });
  try {
    const lines = f.view.render(80).map(stripTerminalSequences);
    click(lines.findIndex((line) => line.includes("3. type something")), 12);
    f.view.handleInput("Mouse custom answer");
    assert.match(f.text(), /3\. Mouse custom answer/);
    f.view.handleInput("\t");
    const review = f.view.render(80).map(stripTerminalSequences);
    click(review.findIndex((line) => line.includes("2. Cancel")), 8);
    assert.equal(f.session.status, "needs-input");
    assert.equal(f.engine.calls.length, 0);
    assert.equal(f.controller.questionForm, undefined);
  } finally { await f.cleanup(); }
});

test("Ctrl+N and Ctrl+P select Submit or Cancel without sending until Enter", async () => {
  const f = setup({ question: "Name", questions: [{ id: "name", question: "Project name?", type: "input" }] });
  try {
    f.view.handleInput("project"); f.view.handleInput("\t");
    assert.match(f.text(), /> 1\. Submit answers/);
    f.view.handleInput("\x0e");
    assert.match(f.text(), /> 2\. Cancel/);
    f.view.handleInput("\x0e");
    assert.match(f.text(), /> 1\. Submit answers/);
    f.view.handleInput("\x10");
    assert.match(f.text(), /> 2\. Cancel/);
    f.view.handleInput("\x10");
    assert.match(f.text(), /> 1\. Submit answers/);
    assert.equal(f.engine.calls.length, 0);
    f.view.handleInput("\r"); await tick();
    assert.deepEqual(submitted(f.engine), ["project"]);
  } finally { await f.cleanup(); }
});

test("question and review borders exactly match the normal composer at every width", async () => {
  const f = setup({ question: "Target", questions: [{ id: "target", question: "Choose a target", type: "radio", options }] });
  try {
    const composer = new Composer(f.tui, "reply", () => {});
    for (const review of [false, true]) {
      if (review) f.view.handleInput("\t");
      for (const height of [12, 16, 32]) {
        f.terminal.rows = height;
        for (const width of [1, 4, 10, 24, 80]) {
          const normal = composer.render(width);
          const questions = f.view.render(width);
          assert.equal(questions[0], normal[0]);
          assert.equal(questions.at(-1), normal.at(-1));
          if (review) assert.ok(questions.length <= Math.max(3, Math.min(18, Math.floor(height * 0.6))));
          assert.ok(questions.every((line) => visibleWidth(line) <= width));
        }
      }
    }
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("select is an unfiltered single-choice list and typing never hides options or their descriptions", async () => {
  const f = setup({ question: "Target", questions: [{ id: "target", question: "Choose a target", type: "select", options }] });
  try {
    assert.doesNotMatch(f.text(), /Filter|Search/);
    f.view.handleInput("my own target");
    assert.match(f.text(), /1\. Option A\n {5}Description option A/);
    assert.match(f.text(), /2\. Option B\n {5}Description option B/);
    assert.match(f.text(), /3\. my own target/);
    f.view.handleInput("\t"); f.view.handleInput("\r"); await tick();
    assert.deepEqual(submitted(f.engine), ["my own target"]);
  } finally { await f.cleanup(); }
});

test("legacy options without descriptions still reserve a truthful description line", async () => {
  const f = setup({ question: "Target", questions: [{ id: "target", question: "Choose a target", type: "radio", options: [{ value: "old", label: "Old option" }] }] });
  try {
    assert.match(f.text(), /1\. Old option\n {5}No description provided\./);
    assert.match(f.text(), /2\. type something *\n {5}Type your own answer\./);
  } finally { await f.cleanup(); }
});
