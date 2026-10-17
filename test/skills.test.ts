import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { discoverSkills, SkillCatalog } from "../src/skills.js";
import { temporary } from "./helpers.js";

function addSkill(dir: string, name: string, disabled = false): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: Instructions for ${name}\n${disabled ? "disable-model-invocation: true\n" : ""}---\n\nFollow ${name} instructions and read ./references/check.md.\n`);
  return file;
}

test("discovers scoped Pi/Agent skills and installed package skills without running extensions", async () => {
  const temp = temporary();
  const originalHome = process.env.HOME;
  try {
    const home = join(temp.root, "home"); process.env.HOME = home;
    const agentDir = join(home, ".pi", "agent");
    const a = join(temp.root, "repo", "a"); const b = join(temp.root, "repo", "b");
    mkdirSync(join(temp.root, "repo", ".git"), { recursive: true });
    mkdirSync(a); mkdirSync(b);
    addSkill(join(agentDir, "skills", "personal"), "personal");
    addSkill(join(home, ".agents", "skills", "hidden"), "manual-only", true);
    addSkill(join(temp.root, "repo", ".agents", "skills", "ancestor"), "ancestor");
    addSkill(join(a, ".pi", "skills", "local"), "project-a");
    addSkill(join(a, ".pi", "skills", "excluded"), "excluded");
    addSkill(join(b, ".pi", "skills", "local"), "project-b");
    const pkg = join(temp.root, "local-package");
    addSkill(join(pkg, "skills", "packaged"), "packaged");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["skills"], extensions: ["bad.js"] } }));
    writeFileSync(join(pkg, "bad.js"), 'throw new Error("Extensions must not execute during skill discovery")');
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    writeFileSync(join(a, ".pi", "settings.json"), JSON.stringify({ skills: ["-skills/excluded/SKILL.md"] }));
    const skillsA = await discoverSkills(a, agentDir);
    const namesA = skillsA.skills.map((s) => s.name);
    assert.ok(namesA.includes("personal")); assert.ok(namesA.includes("manual-only"));
    assert.ok(namesA.includes("project-a")); assert.ok(namesA.includes("ancestor")); assert.ok(namesA.includes("packaged"));
    assert.ok(!namesA.includes("excluded")); assert.ok(!namesA.includes("project-b"));
    const namesB = (await discoverSkills(b, agentDir)).skills.map((s) => s.name);
    assert.ok(namesB.includes("project-b")); assert.ok(!namesB.includes("project-a"));
    const catalog = new SkillCatalog((cwd) => discoverSkills(cwd, agentDir));
    const prompt = await catalog.prompt(a);
    assert.match(prompt, /<name>project-a<\/name>/);
    assert.doesNotMatch(prompt, /manual-only/);
    const explicit = await catalog.prepare(a, "/skill:manual-only check the files");
    assert.match(explicit.content, /Follow manual-only instructions/);
    assert.match(explicit.content, /User request:\ncheck the files/);
    assert.match(explicit.content, /Resolve relative references against/);
    assert.equal(explicit.skill?.name, "manual-only");
    assert.deepEqual(await catalog.prepare(a, "$manual-only check the files"), explicit);
    assert.deepEqual(await catalog.prepare(a, "  $manual-only\ncheck the files  "), explicit);
    assert.match((await catalog.prepare(a, "$manual-only")).content, /User request:\nFollow this skill\./);
    for (const text of ["$", "use $manual-only here", "!echo $manual-only", "draft\n$manual-only"]) {
      assert.deepEqual(await catalog.prepare(a, text), { content: text });
    }
    await assert.rejects(catalog.prepare(a, "$missing task"), /Unknown skill missing/);
    assert.deepEqual(await catalog.prepare(a, "ordinary task"), { content: "ordinary task" });
    await assert.rejects(catalog.prepare(a, "/skill:missing task"), /Unknown skill missing/);
    addSkill(join(a, ".pi", "skills", "new"), "new-skill");
    assert.doesNotMatch(await catalog.prompt(a), /<name>new-skill/);
    await catalog.list(a);
    assert.match(await catalog.prompt(a), /<name>new-skill/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    temp.cleanup();
  }
});
