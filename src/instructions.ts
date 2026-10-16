import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

const DEFAULT_PREAMBLE = "You are a coding assistant working in a project directory. Inspect before editing, preserve existing changes, and verify your work.";
// Operational behavior stays in force even when SYSTEM.md replaces the coding preamble.
export const INTERACTION_POLICY = "Use ask_user whenever you ask the user a question and expect an answer, including conversational or random questions, clarification, decisions, and approval requests. Put the question in the tool call rather than only in ordinary response text so the session waits for input. Do not use ask_user for rhetorical questions, quoted questions, or examples that do not need an answer. Otherwise finish with a concise report.";

/** Markdown only: selecting a project opts its instruction files into model context, not executable resources. */
export class InstructionCatalog {
  constructor(readonly agentDir = getAgentDir()) {}

  private async override(cwd: string, name: string): Promise<string | undefined> {
    for (const path of [join(cwd, ".pi", name), join(this.agentDir, name)]) {
      try { return (await readFile(path, "utf8")).replace(/^\uFEFF/, ""); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read instructions: ${path}`, { cause: error }); }
    }
  }

  async preamble(cwd: string): Promise<string> {
    return await this.override(cwd, "SYSTEM.md") ?? DEFAULT_PREAMBLE;
  }

  async append(cwd: string): Promise<string | undefined> { return this.override(cwd, "APPEND_SYSTEM.md"); }

  context(cwd: string): string | undefined {
    // Pi supplies variant precedence, ancestor ordering, deduplication and linked-worktree shadowing.
    const files = loadProjectContextFiles({ cwd, agentDir: this.agentDir });
    return files.length ? ["Project-specific instructions and guidelines. Resolve relative references against each file's directory.",
      ...files.map(({ path, content }) => `<project_instructions path=${JSON.stringify(path)}>\n${content}\n</project_instructions>`)].join("\n\n") : undefined;
  }
}
