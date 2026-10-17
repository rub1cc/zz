import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { InstructionCatalog, INTERACTION_POLICY } from "../src/instructions.js";
import { temporary } from "./helpers.js";

test("instruction hierarchy uses Pi variant precedence, global-first ordering and project isolation", () => {
  const f = temporary();
  try {
    const agent = join(f.root, "agent"); const parent = join(f.root, "repo"); const a = join(parent, "a"); const b = join(parent, "b");
    for (const path of [agent, a, b]) mkdirSync(path, { recursive: true });
    writeFileSync(join(agent, "AGENTS.md"), "USER_RULE");
    writeFileSync(join(parent, "CLAUDE.md"), "ANCESTOR_RULE");
    writeFileSync(join(a, "AGENTS.override.md"), "\uFEFFOVERRIDE_A");
    writeFileSync(join(a, "AGENTS.md"), "SHADOWED_A");
    writeFileSync(join(a, "CLAUDE.md"), "SHADOWED_CLAUDE");
    writeFileSync(join(b, "AGENTS.MD"), "ONLY_B");
    const catalog = new InstructionCatalog(agent);
    const first = catalog.context(a)!;
    assert.ok(first.indexOf("USER_RULE") < first.indexOf("ANCESTOR_RULE"));
    assert.ok(first.indexOf("ANCESTOR_RULE") < first.indexOf("OVERRIDE_A"));
    assert.doesNotMatch(first, /SHADOWED|ONLY_B|\uFEFF/);
    assert.ok(first.includes(join(a, "AGENTS.override.md")));
    assert.match(catalog.context(b)!, /ONLY_B/);
    assert.doesNotMatch(catalog.context(b)!, /OVERRIDE_A/);
    unlinkSync(join(a, "AGENTS.override.md"));
    assert.match(catalog.context(a)!, /SHADOWED_A/);
    assert.doesNotMatch(catalog.context(a)!, /OVERRIDE_A|SHADOWED_CLAUDE/);
  } finally { f.cleanup(); }
});

test("SYSTEM and APPEND_SYSTEM have independent project-over-user precedence and reload on every read", async () => {
  const f = temporary();
  try {
    const agent = join(f.root, "agent"); const a = join(f.root, "a"); const b = join(f.root, "b");
    for (const path of [agent, join(a, ".pi"), b]) mkdirSync(path, { recursive: true });
    const catalog = new InstructionCatalog(agent);
    assert.match(await catalog.preamble(a), /Inspect before editing/);
    assert.equal(await catalog.append(a), undefined);
    writeFileSync(join(agent, "SYSTEM.md"), "USER_SYSTEM");
    writeFileSync(join(agent, "APPEND_SYSTEM.md"), "USER_APPEND");
    writeFileSync(join(a, ".pi", "SYSTEM.md"), "PROJECT_SYSTEM");
    assert.match(await catalog.preamble(a), /PROJECT_SYSTEM/);
    assert.doesNotMatch(await catalog.preamble(a), /USER_SYSTEM|Inspect before editing/);
    assert.match(INTERACTION_POLICY, /Use ask_question whenever/);
    assert.equal(await catalog.append(a), "USER_APPEND");
    writeFileSync(join(a, ".pi", "APPEND_SYSTEM.md"), "PROJECT_APPEND");
    assert.equal(await catalog.append(a), "PROJECT_APPEND");
    assert.match(await catalog.preamble(b), /USER_SYSTEM/);
    assert.equal(await catalog.append(b), "USER_APPEND");
    writeFileSync(join(a, ".pi", "SYSTEM.md"), "UPDATED_SYSTEM");
    assert.match(await catalog.preamble(a), /UPDATED_SYSTEM/);
    unlinkSync(join(a, ".pi", "SYSTEM.md"));
    assert.match(await catalog.preamble(a), /USER_SYSTEM/);
    mkdirSync(join(a, ".pi", "SYSTEM.md"));
    await assert.rejects(catalog.preamble(a), /Could not read instructions/);
  } finally { f.cleanup(); }
});

test("instruction loading does not execute project extensions or package code", async () => {
  const f = temporary();
  try {
    mkdirSync(join(f.root, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(f.root, ".pi", "extensions", "bad.js"), 'throw new Error("EXECUTED_PROJECT_CODE");');
    writeFileSync(join(f.root, ".pi", "settings.json"), JSON.stringify({ extensions: ["./extensions/bad.js"] }));
    writeFileSync(join(f.root, "AGENTS.md"), "MARKDOWN_ONLY");
    const catalog = new InstructionCatalog(join(f.root, "absent-agent"));
    assert.match(catalog.context(f.root)!, /MARKDOWN_ONLY/);
    assert.match(await catalog.preamble(f.root), /coding assistant/);
  } finally { f.cleanup(); }
});
