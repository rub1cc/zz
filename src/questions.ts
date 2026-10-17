import { Type } from "@earendil-works/pi-ai";
import type { Session, ToolActivity } from "./model.js";

export const MAX_QUESTION_OPTIONS = 5;

const optionSchema = Type.Object({
  value: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1, pattern: "\\S", description: "A concise explanation shown below the option label." }),
});
export const askQuestionParameters = Type.Object({
  question: Type.String({ minLength: 1, pattern: "\\S", description: "The question to show in chat while keeping the normal composer." }),
});

export const askMultipleQuestionsParameters = Type.Object({
  question: Type.String({ minLength: 1, pattern: "\\S", description: "Title for the structured question form." }),
  questions: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, description: "Unique answer key." }),
    question: Type.String({ minLength: 1 }),
    type: Type.Union([Type.Literal("radio"), Type.Literal("select"), Type.Literal("multiselect"), Type.Literal("input")]),
    options: Type.Optional(Type.Array(optionSchema, { minItems: 1, maxItems: MAX_QUESTION_OPTIONS,
      description: "At most 5 choices total, including the custom answer row when allowOther is true. Supply at most 4 listed options with allowOther enabled." })),
    placeholder: Type.Optional(Type.String()),
    allowOther: Type.Optional(Type.Boolean({ description: "Offer a custom text answer for a choice question (default true)." })),
  }), { minItems: 1, maxItems: 12, description: "Ordered steps. radio = single choice; select = single choice (same as radio); multiselect = one or more choices; input = free text. Choice steps require options with a label, value, and description. No searching, filtering, or scrolling of options." }),
});

export interface QuestionOption { value: string; label: string; description?: string }
export interface QuestionStep {
  id: string;
  question: string;
  type: "radio" | "select" | "multiselect" | "input";
  options?: QuestionOption[];
  placeholder?: string;
  allowOther?: boolean;
}
export interface Questionnaire { question: string; questions: QuestionStep[] }
export interface PendingQuestion extends Questionnaire { id: string }
export interface QuestionForm { sessionId: string; request: PendingQuestion }
export type QuestionAnswers = Record<string, string | string[]>;

/** Historical calls remain readable even if they predate today's option/description requirements. */
export function questionnaire(args: Record<string, unknown>, historical = false): Questionnaire {
  if (typeof args.question !== "string" || !args.question.trim()) throw new Error("A nonempty question or form title is required.");
  if (historical && args.questions === undefined) return { question: args.question, questions: [{ id: "answer", question: args.question, type: "input" }] };
  if (!Array.isArray(args.questions) || !args.questions.length || args.questions.length > 12) throw new Error("Provide 1-12 question steps.");
  const ids = new Set<string>();
  const questions = args.questions.map((value: unknown): QuestionStep => {
    if (!value || typeof value !== "object") throw new Error("Invalid question step.");
    const step = value as QuestionStep;
    if (typeof step.id !== "string" || !step.id.trim() || ids.has(step.id)) throw new Error("Question ids must be nonempty and unique.");
    ids.add(step.id);
    if (typeof step.question !== "string" || !step.question.trim() || !["radio", "select", "multiselect", "input"].includes(step.type)) throw new Error("Each step needs a question and a supported type.");
    if (step.placeholder !== undefined && typeof step.placeholder !== "string"
      || step.allowOther !== undefined && typeof step.allowOther !== "boolean") throw new Error("Invalid question settings.");
    if (step.type !== "input" || step.options !== undefined) {
      const limit = historical ? 50 : MAX_QUESTION_OPTIONS;
      if (!Array.isArray(step.options) || !step.options.length || step.options.length > limit) throw new Error(`Choice questions require 1-${limit} options.`);
      const customCount = step.type !== "input" && step.allowOther !== false ? 1 : 0;
      if (!historical && step.options.length + customCount > MAX_QUESTION_OPTIONS) throw new Error("Choice questions allow at most 5 options total, including the custom answer row.");
      const values = new Set<string>();
      for (const option of step.options) {
        if (!option || typeof option.value !== "string" || !option.value.trim() || values.has(option.value)
          || typeof option.label !== "string" || !option.label.trim()
          || option.description !== undefined && typeof option.description !== "string") throw new Error("Options need unique values and nonempty labels.");
        if (!historical && (typeof option.description !== "string" || !option.description.trim())) throw new Error("Every option requires a nonempty description shown below its label.");
        values.add(option.value);
      }
    }
    return step;
  });
  return { question: args.question, questions };
}

export function questionText(request: Questionnaire): string {
  if (request.questions.length === 1 && request.questions[0]!.type === "input" && request.questions[0]!.question === request.question) return request.question;
  return [request.question, ...request.questions.map((step, i) => [
    `${i + 1}. ${step.question}`, ...(step.options ?? []).map((option) => `   - ${option.label}${option.description ? `: ${option.description}` : ""}`),
  ].join("\n"))].join("\n\n");
}

/** Legacy names stay recognizable in durable history, but are not advertised as tools. */
export function isQuestionTool(name: string): boolean {
  return name === "ask_question" || name === "ask_multiple_questions" || name === "ask_user";
}

export function formQuestion(tool: Pick<ToolActivity, "name" | "arguments">): Questionnaire | undefined {
  if (tool.name !== "ask_multiple_questions" && !(tool.name === "ask_user" && Array.isArray(tool.arguments.questions))) return;
  try { return questionnaire(tool.arguments, true); } catch { return; }
}

/** The durable tool history is the source of truth, including after restart or undo. */
export function pendingQuestion(session: Session | undefined): PendingQuestion | undefined {
  if (session?.status !== "needs-input") return;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]!;
    if (message.role === "user") return;
    if (!message.tool || !isQuestionTool(message.tool.name)) continue;
    if (message.tool.status !== "done") return;
    const request = formQuestion(message.tool);
    return request && { ...request, id: message.tool.id };
  }
}

export function answerError(request: Questionnaire, answers: QuestionAnswers): string | undefined {
  for (const step of request.questions) {
    const answer = Object.hasOwn(answers, step.id) ? answers[step.id] : undefined;
    const values = Array.isArray(answer) ? answer : [answer];
    if (!values.length || values.some((value) => typeof value !== "string" || !value.trim())) return `Answer "${step.question}" first.`;
    if (step.type === "multiselect" ? !Array.isArray(answer) : typeof answer !== "string") return `Invalid answer for "${step.question}".`;
    if (step.type !== "input" && step.allowOther === false && values.some((value) => !step.options?.some((option) => option.value === value))) return `Choose a listed option for "${step.question}".`;
  }
}

export interface AnsweredQuestion { question: string; answer: string }

/** Recognize wizard replies only when they match the preceding question tool call. */
export function answeredQuestions(text: string, request: Questionnaire): AnsweredQuestion[] | undefined {
  const prefix = `Answers to: ${request.question}\n`;
  if (!text.startsWith(prefix)) return;
  let rows: unknown;
  try { rows = JSON.parse(text.slice(prefix.length)); } catch { return; }
  if (!Array.isArray(rows) || rows.length !== request.questions.length) return;
  const answers: QuestionAnswers = Object.create(null) as QuestionAnswers;
  for (const [index, row] of rows.entries()) {
    const step = request.questions[index]!;
    if (!row || typeof row !== "object" || row.id !== step.id || row.question !== step.question) return;
    answers[step.id] = row.answer;
  }
  if (answerError(request, answers)) return;
  return request.questions.map((step) => {
    const answer = answers[step.id]!;
    const values = Array.isArray(answer) ? answer : [answer];
    return { question: step.question, answer: values.map((value) => step.type === "input" ? value
      : step.options?.find((option) => option.value === value)?.label ?? value).join(", ") };
  });
}

export function answerText(request: Questionnaire, answers: QuestionAnswers): string {
  return `Answers to: ${request.question}\n${JSON.stringify(request.questions.map((step) => ({
    id: step.id, question: step.question, answer: answers[step.id],
  })), null, 2)}`;
}
