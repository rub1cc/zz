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
  assert.deepEqual(all?.items.map((i) => i.value), ["model", "thinking", "skills", "help"]);
  assert.equal((await suggestions(p, "/th"))?.items[0]?.value, "thinking");
  assert.equal(await suggestions(p, "/does-not-exist"), null);
  assert.equal(await suggestions(p, "draft\n/mo"), null);
  assert.equal(await suggestions(provider(process.cwd(), true, false), "/mo"), null);
  const selected = await suggestions(provider(process.cwd(), false, true, true), "/");
  assert.deepEqual(selected?.items.map((i) => i.value), ["model", "thinking", "skills", "session", "compact", "stop", "help"]);
  const open = await suggestions(provider(process.cwd(), true), "/");
  assert.deepEqual(open?.items.map((i) => i.value), [...selected!.items.map((i) => i.value), "bottom", "expand", "collapse"]);
  assert.deepEqual(composerCommands(true).filter((c) => !composerCommands(false, true).some((base) => base.name === c.name)).map((c) => c.name), ["bottom", "expand", "collapse"]);
  assert.match(composerCommands(false, true).find((c) => c.name === "model")!.description!, /new tasks/);
  assert.match(composerCommands(false, true).find((c) => c.name === "stop")!.description!, /selected session/);
  assert.match(composerCommands(true).find((c) => c.name === "stop")!.description!, /open session/);
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
