import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ComposerDiscovery, composerCommands } from "../src/discovery.js";
import { temporary } from "./helpers.js";

function suggestions(provider: ComposerDiscovery, text: string, force = false) {
  const lines = text.split("\n");
  return provider.getSuggestions(lines, lines.length - 1, lines.at(-1)!.length, { signal: new AbortController().signal, force });
}

function provider(cwd: string, session = false, commands = true, selectedSession = false) {
  return new ComposerDiscovery({ cwd, session, commands, selectedSession }, Promise.resolve(null));
}

test("slash discovery filters available commands and excludes later draft lines and peek commands", async () => {
  const p = provider(process.cwd());
  const all = await suggestions(p, "/");
  assert.deepEqual(all?.items.map((i) => i.value), ["model", "thinking", "skills", "settings", "projects", "workspace", "login", "logout", "help"]);
  assert.equal((await suggestions(p, "/th"))?.items[0]?.value, "thinking");
  assert.equal(await suggestions(p, "/copy"), null);
  assert.equal((await suggestions(provider(process.cwd(), true), "/copy"))?.items[0]?.value, "copy");
  assert.equal(await suggestions(provider(process.cwd(), true, false), "/copy"), null);
  assert.equal(await suggestions(p, "/does-not-exist"), null);
  assert.equal(await suggestions(p, "draft\n/mo"), null);
  assert.equal(await suggestions(provider(process.cwd(), true, false), "/mo"), null);
  const selected = await suggestions(provider(process.cwd(), false, true, true), "/");
  assert.deepEqual(selected?.items.map((i) => i.value), ["model", "thinking", "skills", "settings", "projects", "workspace", "login", "logout", "answer", "copy", "session", "tasks", "compact", "undo", "stop", "help"]);
  const open = await suggestions(provider(process.cwd(), true), "/");
  assert.deepEqual(open?.items.map((i) => i.value), [...selected!.items.map((i) => i.value), "top", "bottom", "expand", "collapse"]);
  assert.deepEqual(composerCommands(true).filter((c) => !composerCommands(false, true).some((base) => base.name === c.name)).map((c) => c.name), ["top", "bottom", "expand", "collapse"]);
  assert.match(composerCommands(false, true).find((c) => c.name === "model")!.description!, /new tasks/);
  assert.match(composerCommands(false, true).find((c) => c.name === "stop")!.description!, /selected session/);
  assert.match(composerCommands(true).find((c) => c.name === "stop")!.description!, /open session/);
  for (const commands of [composerCommands(false), composerCommands(false, true), composerCommands(true)]) {
    assert.ok(commands.every(({ name }) => !["attach", "detach", "reasoning"].includes(name)));
  }
});

test("file completion is project scoped, quotes spaces, preserves cursor suffix and browses without fd", async () => {
  const temp = temporary();
  try {
    const a = join(temp.root, "alpha"); const b = join(temp.root, "beta");
    mkdirSync(a); mkdirSync(b); mkdirSync(join(a, "source dir"));
    writeFileSync(join(a, "source dir", "日本語.ts"), "");
    writeFileSync(join(b, "only-beta.txt"), "");
    const p = provider(a);
    const result = (await suggestions(p, "inspect @sou"))!;
    assert.equal(result.prefix, "@sou");
    assert.equal(result.items[0]?.value, '@"source dir/"');
    const applied = p.applyCompletion(["inspect @sou afterwards"], 0, 12, result.items[0]!, result.prefix);
    assert.deepEqual(applied, { lines: ['inspect @"source dir/" afterwards'], cursorLine: 0, cursorCol: 21 });
    const child = await suggestions(p, 'inspect @"source dir/');
    assert.equal(child?.items[0]?.value, '@"source dir/日本語.ts"');
    assert.equal(await suggestions(p, "@only-beta"), null);
    assert.equal((await suggestions(provider(b), "@only-beta"))?.items[0]?.value, "@only-beta.txt");
    assert.equal((await suggestions(p, "inspect ./sou", true))?.items[0]?.value, '"./source dir/"');
    const absolute = `${a}/sou`;
    const abs = (await suggestions(p, absolute))!;
    assert.ok(abs.items[0]?.value.startsWith(`"${a}/`));
    assert.equal(p.applyCompletion([absolute], 0, absolute.length, abs.items[0]!, abs.prefix).lines[0], `"${a}/source dir/"`);
  } finally { temp.cleanup(); }
});

test("recursive @ search delegates to installed fd with the project cwd and supports cancellation", async () => {
  const temp = temporary();
  try {
    // A local stand-in for fd makes this test independent of host tools and network access.
    const fd = join(temp.root, "fd");
    writeFileSync(fd, `#!${process.execPath}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const base = args[args.indexOf('--base-directory') + 1];
process.stdout.write(readFileSync(join(base, 'results.txt'), 'utf8'));
`);
    chmodSync(fd, 0o755);
    writeFileSync(join(temp.root, "results.txt"), "src/deep/needle.ts\n.git/needle\n");
    const p = new ComposerDiscovery({ cwd: temp.root, commands: true, session: false }, Promise.resolve(fd));
    const result = await suggestions(p, "inspect @needle");
    assert.deepEqual(result?.items.map((i) => i.value), ["@src/deep/needle.ts"]);
    const abort = new AbortController(); abort.abort();
    assert.equal(await p.getSuggestions(["@needle"], 0, 7, { signal: abort.signal }), null);
  } finally { temp.cleanup(); }
});

test("$ discovery filters scoped skills, includes manual skills, and preserves draft suffixes", async () => {
  const calls: string[] = [];
  const p = new ComposerDiscovery({ cwd: "/project-a", commands: true, session: false }, new Promise(() => {}), {
    list: async (cwd) => {
      calls.push(cwd);
      return [
        { name: "frontend-design", description: "Build a UI", filePath: "/skills/frontend/SKILL.md" },
        { name: "nf:draft-pr", description: "Draft a PR", filePath: "/skills/pr/SKILL.md" },
        { name: "manual-only", description: "Manual\nonly\x1b[31m", filePath: "/skills/manual/SKILL.md" },
      ];
    },
  });
  assert.ok(p.triggerCharacters.includes("$"));
  const all = (await suggestions(p, "$"))!;
  assert.deepEqual(all.items.map((i) => i.value), ["$frontend-design", "$nf:draft-pr", "$manual-only"]);
  assert.equal(all.items[2]?.description, "Manual only");
  const filtered = (await suggestions(p, "$frd"))!;
  assert.equal(filtered.items[0]?.value, "$frontend-design");
  assert.equal((await suggestions(p, "$nf:d"))?.items[0]?.value, "$nf:draft-pr");
  assert.deepEqual(calls, ["/project-a"], "Filtering reuses the project catalog");
  assert.equal(await suggestions(p, "$no-such-skill"), null);
  for (const text of ["draft $frd", "draft\n$frd", "!echo $frd", "$frontend-design request"]) {
    assert.equal(await suggestions(p, text), null, text);
  }
  assert.deepEqual(p.applyCompletion(["$frdkeep this", "second line"], 0, 4, filtered.items[0]!, filtered.prefix), {
    lines: ["$frontend-design keep this", "second line"], cursorLine: 0, cursorCol: 17,
  });
  assert.equal(p.shouldTriggerFileCompletion(["$frd"], 0, 4), true);
  await suggestions(p, "$");
  assert.deepEqual(calls, ["/project-a", "/project-a"], "Reopening $ refreshes discovery");

  const peek = new ComposerDiscovery({ cwd: "/project-b", commands: false, session: true }, Promise.resolve(null), {
    list: async (cwd) => [{ name: cwd.slice(1), description: "Peek skill", filePath: "/skill/SKILL.md" }],
  });
  assert.equal((await suggestions(peek, "$"))?.items[0]?.value, "$project-b");
  const abort = new AbortController(); abort.abort();
  assert.equal(await peek.getSuggestions(["$"], 0, 1, { signal: abort.signal }), null);
});
