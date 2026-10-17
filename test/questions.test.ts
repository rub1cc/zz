import assert from "node:assert/strict";
import { test } from "node:test";
import { askQuestionParameters, askMultipleQuestionsParameters, MAX_QUESTION_OPTIONS, answeredQuestions, answerError, answerText, pendingQuestion, questionnaire, questionText } from "../src/questions.js";
import { structuredQuestions, waitingSession } from "./question-fixtures.js";

test("questions support legacy input and readable structured transcripts", () => {
  const legacy = questionnaire({ question: "Retry?" }, true);
  assert.deepEqual(legacy.questions, [{ id: "answer", question: "Retry?", type: "input" }]);
  assert.equal(questionText(legacy), "Retry?");
  const request = questionnaire(structuredQuestions);
  assert.match(questionText(request), /1\. What should I build\?/);
  assert.match(questionText(request), /CLI: A terminal app/);
  assert.match(questionText(request), /4\. Project name\?/);
});

test("questions reject missing choices, duplicate ids and invalid option values", () => {
  for (const args of [
    {}, { question: " " }, { question: "Build", questions: [] },
    { question: "Build", questions: [{ id: "a", question: "Target?", type: "radio" }] },
    { question: "Build", questions: [structuredQuestions.questions[0], structuredQuestions.questions[0]] },
    { question: "Build", questions: [{ id: "a", question: "Target?", type: "select", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] }] },
  ]) assert.throws(() => questionnaire(args));
});

test("answers validate all steps and preserve exact values and custom text", () => {
  const request = questionnaire(structuredClone(structuredQuestions));
  const answers = { target: "web", language: "go", features: ["tests", "docs"], name: "!do-not-run\nsecond line" };
  assert.equal(answerError(request, answers), undefined);
  const text = answerText(request, answers);
  assert.ok(text.startsWith("Answers to: Build preferences\n"));
  const rows = JSON.parse(text.slice(text.indexOf("\n") + 1));
  assert.equal(rows[0].answer, "web");
  assert.deepEqual(rows[2].answer, ["tests", "docs"]);
  assert.equal(rows[3].answer, answers.name);
  assert.match(answerError(request, { ...answers, name: " " })!, /Project name/);
  assert.match(answerError(request, { ...answers, features: [] })!, /Which features/);
  request.questions[0]!.allowOther = false;
  assert.match(answerError(request, { ...answers, target: "custom" })!, /listed option/);
  assert.equal(answerError(questionnaire({ question: "Prototype?", questions: [{ id: "toString", question: "Name?", type: "input" }] }), {}), 'Answer "Name?" first.');
});

test("pending questions come only from the latest unanswered successful tool", () => {
  const session = waitingSession();
  assert.equal(pendingQuestion(session)?.id, "call-waiting");
  session.messages.push({ role: "user", text: "Build something else", timestamp: 3 });
  assert.equal(pendingQuestion(session), undefined);
  session.messages.pop();
  session.status = "working";
  assert.equal(pendingQuestion(session), undefined);
  session.status = "needs-input";
  session.messages[1]!.tool!.status = "error";
  assert.equal(pendingQuestion(session), undefined);
});

test("answer summaries resolve option labels while retaining custom answers", () => {
  const request = questionnaire(structuredQuestions);
  const answers = { target: "web", language: "custom language", features: ["tests", "docs", "Offline mode"], name: "my **project**" };
  assert.deepEqual(answeredQuestions(answerText(request, answers), request), [
    { question: "What should I build?", answer: "Website" },
    { question: "Choose a language", answer: "custom language" },
    { question: "Which features?", answer: "Tests, Documentation, Offline mode" },
    { question: "Project name?", answer: "my **project**" },
  ]);
});

test("answer summaries reject malformed JSON, mismatched questions and invalid answer shapes", () => {
  const request = questionnaire(structuredQuestions);
  const text = answerText(request, { target: "web", language: "go", features: ["tests"], name: "builder" });
  for (const candidate of [
    "A normal user reply", "Answers to: Build preferences\nnot JSON", "Answers to: Build preferences\n[]",
    text.replace("Build preferences", "A different questionnaire"),
    text.replace('"id": "target"', '"id": "other"'),
    text.replace('"question": "What should I build?"', '"question": "Something else?"'),
    text.replace('"answer": "web"', '"answer": { "unexpected": true }'),
    text.replace('"answer": "web"', '"answer": ["web"]'),
  ]) assert.equal(answeredQuestions(candidate, request), undefined);
});

test("new questions require descriptions and allow at most five choices including the custom row", () => {
  const options = Array.from({ length: 5 }, (_, i) => ({ value: String(i), label: `Option ${i}`, description: `Description ${i}` }));
  const request = (options: unknown[], allowOther?: boolean) => ({ question: "Choose", questions: [{ id: "choice", question: "Which one?", type: "radio", options, ...(allowOther === undefined ? {} : { allowOther }) }] });
  assert.equal(questionnaire(request(options.slice(0, 4))).questions[0]!.options!.length, 4);
  assert.equal(questionnaire(request(options, false)).questions[0]!.options!.length, 5);
  assert.throws(() => questionnaire(request(options)), /at most 5 options total/);
  assert.throws(() => questionnaire(request(options, true)), /at most 5 options total/);
  assert.throws(() => questionnaire(request([...options, { value: "extra", label: "Extra", description: "Extra choice" }], false)), /1-5 options/);
  assert.throws(() => questionnaire(request([{ value: "a", label: "A" }])), /description/);
  assert.throws(() => questionnaire(request([{ value: "a", label: "A", description: "  " }])), /description/);
  const schema = JSON.parse(JSON.stringify(askMultipleQuestionsParameters)).properties.questions.items.properties.options;
  assert.equal(schema.maxItems, MAX_QUESTION_OPTIONS);
  assert.ok(schema.items.required.includes("description"));
});

test("historical calls remain readable even when they predate descriptions and the five-choice limit", () => {
  const options = Array.from({ length: 6 }, (_, i) => ({ value: String(i), label: `Old option ${i}` }));
  const args = { question: "Old question", questions: [{ id: "old", question: "Choose?", type: "radio", options }] };
  assert.equal(questionnaire(args, true).questions[0]!.options!.length, 6);
  const session = waitingSession(); session.messages[1]!.tool!.name = "ask_user"; session.messages[1]!.tool!.arguments = args;
  assert.equal(pendingQuestion(session)?.questions[0]!.options!.length, 6);
});

test("direct question and question-set tools have separate schemas", () => {
  const direct = JSON.parse(JSON.stringify(askQuestionParameters));
  const multiple = JSON.parse(JSON.stringify(askMultipleQuestionsParameters));
  assert.deepEqual(direct.required, ["question"]);
  assert.equal(direct.properties.questions, undefined);
  assert.ok(multiple.required.includes("question"));
  assert.ok(multiple.required.includes("questions"));
  assert.throws(() => questionnaire({ question: "Retry?" }), /question steps/);
});

test("only structured question sets request a wizard, including legacy structured history", () => {
  const session = waitingSession();
  assert.ok(pendingQuestion(session));
  const tool = session.messages[1]!.tool!;
  tool.name = "ask_user";
  assert.ok(pendingQuestion(session), "Legacy structured calls remain usable");
  tool.arguments = { question: "Retry?" };
  assert.equal(pendingQuestion(session), undefined, "Legacy direct calls do not open forms");
  tool.name = "ask_question";
  assert.equal(pendingQuestion(session), undefined);
  tool.arguments = structuredQuestions;
  assert.equal(pendingQuestion(session), undefined, "Direct questions cannot accidentally open a form even with old structured metadata");
});

test("a newer direct question supersedes an older pending form", () => {
  const session = waitingSession();
  session.messages.push({ role: "tool", text: "", timestamp: 3, tool: {
    id: "direct", name: "ask_question", arguments: { question: "Continue?" }, output: "Continue?", status: "done",
  } });
  assert.equal(pendingQuestion(session), undefined);
});
