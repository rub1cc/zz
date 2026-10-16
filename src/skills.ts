import { readFile } from "node:fs/promises";
import { DefaultPackageManager, formatSkillsForPrompt, getAgentDir, loadSkills, SettingsManager, type LoadSkillsResult } from "@earendil-works/pi-coding-agent";
import type { PreparedInput, SkillOption } from "./model.js";

export async function discoverSkills(cwd: string, agentDir = getAgentDir()): Promise<LoadSkillsResult> {
  // Only discover Markdown resources. Never execute extensions or install missing packages.
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const errors = settings.drainErrors();
  if (errors.length) throw errors[0]!.error;
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const resolved = await packages.resolve(async () => "skip");
  return loadSkills({ cwd, agentDir, includeDefaults: false,
    skillPaths: resolved.skills.filter((resource) => resource.enabled).map((resource) => resource.path) });
}

export class SkillCatalog {
  private cache = new Map<string, Promise<LoadSkillsResult>>();
  constructor(readonly discover = discoverSkills) {}

  private get(cwd: string, refresh = false): Promise<LoadSkillsResult> {
    if (refresh || !this.cache.has(cwd)) {
      const result = this.discover(cwd).catch((error: unknown) => { this.cache.delete(cwd); throw error; });
      this.cache.set(cwd, result);
    }
    return this.cache.get(cwd)!;
  }

  async list(cwd: string): Promise<SkillOption[]> {
    return (await this.get(cwd, true)).skills.map(({ name, description, filePath }) => ({ name, description, filePath }));
  }

  async prompt(cwd: string): Promise<string> {
    return formatSkillsForPrompt((await this.get(cwd)).skills);
  }

  async prepare(cwd: string, prompt: string): Promise<PreparedInput> {
    const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!match) return { content: prompt };
    const name = match[1]!;
    const skill = (await this.get(cwd)).skills.find((s) => s.name === name);
    if (!skill) throw new Error(`Unknown skill ${name}. Use /skills to view or refresh available skills.`);
    const text = await readFile(skill.filePath, "utf8");
    return {
      content: `Use the following skill instructions. Resolve relative references against ${JSON.stringify(skill.baseDir)}.\n\nSkill: ${skill.name}\nFile: ${skill.filePath}\n\n${text}\n\nUser request:\n${match[2]?.trim() || "Follow this skill."}`,
      skill: { name: skill.name, filePath: skill.filePath, text },
    };
  }
}
