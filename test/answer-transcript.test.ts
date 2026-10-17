import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { answerText, questionnaire } from "../src/questions.js";
import { Store } from "../src/store.js";
import { renderAnsweredQuestions, Transcript } from "../src/transcript.js";
import { FakeEngine, temporary } from "./helpers.js";
import { structuredQuestions, waitingSession } from "./question-fixtures.js";

const answers = { target: "web", language: "go", features: ["tests", "docs"], name: "builder" };

function setup() {
  const temp = temporary();
  const store = new Store(join(temp.root, "data"));
  const project = store.addProject(temp.root);
  const session = waitingSession(); session.projectId = project.id; session.status = "completed";
  session.messages[1]!.tool!.arguments = structuredClone(structuredQuestions);
  const text = answerText(questionnaire(structuredQuestions), answers);
  session.messages.push({ role: "user", text, timestamp: 3 });
  store.state.sessions.push(session);
  const controller = new Controller(store, new FakeEngine());
  controller.mode = "session"; controller.openedSessionId = session.id;
  const transcript = new Transcript(controller, () => {});
  const render = () => transcript.render(160).map(stripTerminalSequences).join("\n");
  return { ...temp, store, session, controller, transcript, render, text,
    async cleanup() { await controller.close(); temp.cleanup(); } };
}

test("submitted answers render as a compact question-and-answer summary, not a JSON user bubble", async () => {
  const f = setup();
  try {
    const original = structuredClone(f.session.messages);
    const lines = f.transcript.render(160);
    const text = lines.map(stripTerminalSequences).join("\n");
    assert.match(text, /User answered the agent's questions:/);
    assert.match(text, /What should I build\? \u2192 Website/);
    assert.match(text, /Choose a language \u2192 Go/);
    assert.match(text, /Which features\? \u2192 Tests, Documentation/);
    assert.match(text, /Project name\? \u2192 builder/);
    assert.doesNotMatch(text, /Answers to:|"answer"|"id"|"question"/);
    const start = lines.findIndex((line) => line.includes("User answered"));
    assert.ok(start >= 0);
    assert.ok(lines.slice(start).every((line) => !line.includes("\x1b[48;")), "Answer summaries have no ordinary user-bubble background");
    assert.deepEqual(f.session.messages, original, "Rendering must not rewrite the model input");
  } finally { await f.cleanup(); }
});

test("saved answer messages render the same summary after reopening and refresh changed option labels", async () => {
  const f = setup();
  let restoredController: Controller | undefined;
  try {
    const expected = f.render();
    f.store.save();
    const restored = new Store(f.store.root);
    restoredController = new Controller(restored, new FakeEngine());
    restoredController.mode = "session"; restoredController.openedSessionId = f.session.id;
    const transcript = new Transcript(restoredController, () => {});
    assert.equal(transcript.render(160).map(stripTerminalSequences).join("\n"), expected);
    assert.equal(restoredController.opened!.messages.at(-1)!.text, f.text);
    const arguments_ = f.session.messages[1]!.tool!.arguments;
    const steps = arguments_.questions as { options?: { value: string; label: string }[] }[];
    steps[0]!.options![1]!.label = "Web application";
    assert.match(f.render(), /What should I build\? \u2192 Web application/);
  } finally { await restoredController?.close(); await f.cleanup(); }
});

test("ordinary or unmatched messages are not mistaken for wizard replies", async () => {
  const f = setup();
  try {
    f.session.messages[1]!.tool!.status = "error";
    assert.doesNotMatch(f.render(), /User answered the agent's questions/);
    assert.match(f.render(), /Answers to:/);
    f.session.messages[1]!.tool!.status = "done";
    f.session.messages.splice(3, 0, { role: "user", text: "A normal reply", timestamp: 3 });
    assert.doesNotMatch(f.render(), /User answered the agent's questions/);
    f.session.messages.splice(3, 1);
    f.session.messages.at(-1)!.role = "assistant";
    assert.doesNotMatch(f.render(), /User answered the agent's questions/);
    f.session.messages.at(-1)!.role = "user";
    f.session.messages.at(-1)!.text = f.text.replace('"id": "target"', '"id": "unrelated"');
    assert.doesNotMatch(f.render(), /User answered the agent's questions/);
    assert.match(f.render(), /Answers to:/);
  } finally { await f.cleanup(); }
});

test("answer summaries wrap safely, escape terminal controls, and preserve literal text", () => {
  const answers = [{ question: "Question **with markdown**\x1b[2J?", answer: "custom\nanswer \x1b[31m".repeat(10) }];
  for (const width of [1, 4, 8, 12, 24, 80]) {
    const lines = renderAnsweredQuestions(answers, width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !line.includes("\x1b[2J") && !line.includes("\x1b[31m")));
  }
  assert.match(renderAnsweredQuestions(answers, 160).map(stripTerminalSequences).join("\n"), /\*\*with markdown\*\*/);
});

test("legacy form answers keep their summary but direct questions never turn replies into form summaries", async () => {
  const f = setup();
  try {
    f.session.messages[1]!.tool!.name = "ask_user";
    assert.match(f.render(), /User answered the agent's questions:/);
    assert.match(f.render(), /Which features\? \u2192 Tests, Documentation/);
    f.session.messages[1]!.tool!.name = "ask_question";
    assert.doesNotMatch(f.render(), /User answered the agent's questions:/);
    assert.match(f.render(), /Answers to:/);
  } finally { await f.cleanup(); }
});
