import type { Session } from "../src/model.js";
import type { ToolCall } from "@earendil-works/pi-ai";

export const structuredQuestions: { question: string; questions: ToolCall["arguments"][] } = {
  question: "Build preferences",
  questions: [
    { id: "target", question: "What should I build?", type: "radio", options: [
      { value: "cli", label: "CLI", description: "A terminal app" }, { value: "web", label: "Website", description: "A browser app" },
    ] },
    { id: "language", question: "Choose a language", type: "select", options: [
      { value: "ts", label: "TypeScript", description: "A typed JavaScript project" }, { value: "go", label: "Go", description: "A compiled Go project" },
    ] },
    { id: "features", question: "Which features?", type: "multiselect", options: [
      { value: "tests", label: "Tests", description: "Automated checks" }, { value: "docs", label: "Documentation", description: "Usage instructions" },
    ] },
    { id: "name", question: "Project name?", type: "input", placeholder: "my-project" },
  ],
};

export function waitingSession(id = "waiting"): Session {
  return { id, projectId: "project", title: "Build", status: "needs-input", preview: "Build preferences",
    createdAt: 1, updatedAt: 2, messages: [
      { role: "user", text: "Build", timestamp: 1 },
      { role: "tool", text: "", timestamp: 2, tool: { id: `call-${id}`, name: "ask_multiple_questions", arguments: structuredQuestions, output: "Build preferences", status: "done" } },
      { role: "assistant", text: "Build preferences", timestamp: 2 },
    ] };
}

