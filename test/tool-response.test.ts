import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolActivity } from "../src/model.js";
import { activityLabel, renderToolResponse } from "../src/tool-response.js";
import { image } from "./image-fixtures.js";
import { temporary } from "./helpers.js";

function tool(change: Partial<ToolActivity> = {}): ToolActivity {
  return { id: "call", name: "bash", arguments: { command: "npm test" }, status: "done", output: "", ...change };
}
function render(value: ToolActivity, expanded = false, width = 100): string {
  return renderToolResponse(value, width, expanded, false).map(stripTerminalSequences).join("\n");
}

test("only tool names are bold, never commands, paths, skill names or compaction reasons", () => {
  const cases: [Partial<ToolActivity>, string, string][] = [
    [{ name: "bash", arguments: { command: "npm test" } }, "Bash", "(npm test)"],
    [{ name: "powershell", arguments: { command: "Get-ChildItem" } }, "PowerShell", "(Get-ChildItem)"],
    ...[["read", "Read"], ["edit", "Update"], ["write", "Write"], ["custom", "custom"]].map(([name, label]) =>
      [{ name, arguments: { path: "src/file.ts" } }, label!, "(src/file.ts)"] as [Partial<ToolActivity>, string, string]),
    [{ name: "read", arguments: { path: "/skills/testing/SKILL.md" } }, "Skill", " testing"],
    [{ name: "load_skill", arguments: { name: "testing" } }, "Skill", " testing"],
    [{ name: "compact", arguments: { reason: "manual" } }, "Context compacted", " (manual)"],
    [{ name: "ask_question", arguments: {} }, "Ask question", ""],
    [{ name: "task_update", arguments: {} }, "Update tasks", ""],
  ];
  for (const [change, label, suffix] of cases) {
    for (const expanded of [false, true]) {
      for (const selected of [false, true]) {
        const heading = renderToolResponse(tool(change), 100, expanded, selected)[0]!;
        assert.ok(heading.includes(`\x1b[1m${label}\x1b[22m${suffix}`), heading);
        assert.deepEqual([...heading.matchAll(/\x1b\[1m([^\x1b]*)\x1b\[22m/g)].map((match) => match[1]), [label]);
        assert.equal(activityLabel(tool(change)), label + suffix, "plain labels remain unstyled");
      }
    }
  }
});

test("read, write and update use actual SDK results and display truthful line counts and diffs", async () => {
  const temp = temporary();
  try {
    const api = { env: new NodeExecutionEnv({ cwd: temp.root }) } as unknown as ToolExecutionApi;
    const args = { path: "greet.ts", edits: [{ oldText: 'return "Hello";', newText: 'return "Hello, World!";' }] };
    writeFileSync(join(temp.root, args.path), 'function greet() {\n  return "Hello";\n}\n');
    const result = await createEditTool().execute(args, api, BACKGROUND_CONTEXT);
    const value = tool({ name: "edit", arguments: args, output: "Successfully replaced 1 block(s)", details: { result: result.details } });
    assert.equal(render(value), [
      "\u25cf Update(greet.ts)", "  \u23bf Added 1 line, removed 1 line", "     1 function greet() {",
      '    -2   return "Hello";', '    +2   return "Hello, World!";', "     3 }",
    ].join("\n"));
    const colored = renderToolResponse(value, 100, false, false).join("\n");
    assert.match(colored, /\x1b\[32m[^]*\+2/);
    assert.match(colored, /\x1b\[31m[^]*-2/);
    assert.match(readFileSync(join(temp.root, args.path), "utf8"), /Hello, World!/);
    for (const details of [result.details, { details: result.details }, { result: result.details }]) {
      assert.match(render({ ...value, details }), /Added 1 line, removed 1 line/);
    }
    const read = await createReadTool().execute({ path: args.path }, api, BACKGROUND_CONTEXT);
    const output = read.output?.map((block) => block.type === "text" ? block.text : "").join("\n") ?? "";
    assert.match(render(tool({ name: "read", arguments: { path: args.path }, output })), /Read 3 lines/);
    assert.doesNotMatch(render(tool({ name: "read", output })), /return/);
    assert.match(render(tool({ name: "read", output }), true), /Hello, World!/);
    const writeArgs = { path: "new.ts", content: "first\nsecond\n" };
    await createWriteTool().execute(writeArgs, api, BACKGROUND_CONTEXT);
    assert.equal(render(tool({ name: "write", arguments: writeArgs })), "\u25cf Write(new.ts)\n  \u23bf Wrote 2 lines\n      1 first\n      2 second");
  } finally { temp.cleanup(); }
});

test("each tool lifecycle state is explicit and failed mutations never get a success preview", () => {
  for (const [status, label] of [["pending", "Pending..."], ["running", "Running..."], ["error", "Error"], ["interrupted", "Interrupted; completion not confirmed."]] as const) {
    for (const name of ["write", "edit", "read", "bash", "custom_tool"]) {
      const value = tool({ name, status, output: status === "error" ? "Permission denied" : "", arguments: { path: "file", content: "UNCOMMITTED_CONTENT", edits: [] },
        details: { result: { diff: "-1 old\n+1 UNCOMMITTED_CONTENT" } } });
      assert.ok(render(value).includes(label), `${name}: ${status}`);
      assert.doesNotMatch(render(value), /Wrote|Added \d|Read \d|UNCOMMITTED_CONTENT/);
      if (status === "error") assert.match(render(value), /Permission denied/);
    }
  }
});

test("shell script bodies stay hidden, with output previewed only after success", () => {
  const script = "cat > docs/inventory.md <<'EOF'\n" + "SCRIPT_BODY_MUST_STAY_HIDDEN ".repeat(2000) + "\nEOF";
  for (const name of ["bash", "powershell"]) {
    const value = tool({ name, arguments: { command: script }, output: "RESULT_READY\nmore output" });
    for (const status of ["pending", "running", "done"] as const) {
      value.status = status;
      for (const width of [24, 100, 300]) {
        const lines = renderToolResponse(value, width, false, false);
        assert.ok(lines.length <= 3, "A huge script must not grow the compact card");
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const text = lines.map(stripTerminalSequences).join("\n");
        assert.match(text, /(?:Bash|PowerShell)\(cat >/);
        assert.doesNotMatch(text, /SCRIPT_BODY|EOF\)/);
        assert.equal(text.includes("RESULT_READY"), status === "done");
      }
      assert.match(render(value, true), /Arguments[^]*SCRIPT_BODY_MUST_STAY_HIDDEN[^]*Output[^]*RESULT_READY/);
    }
    value.durationMs = 1200;
    assert.match(render(value).split("\n")[0]!, /\(1\.2s\)$/);
    assert.doesNotMatch(render(value), /Ran 1 shell command/);
    value.output = "";
    assert.equal(renderToolResponse(value, 100, false, false).length, 1);
    assert.match(render(value, true), /No text output/);
  }
});

test("successful shell cards show three literal output rows and expand to the full script and output", () => {
  for (const [name, label] of [["bash", "Bash"], ["powershell", "PowerShell"]]) {
    const value = tool({ name, arguments: { command: "run-script\nHIDDEN_SCRIPT_BODY" },
      output: "one\ntwo\nthree\nfour\nfive", durationMs: 6900 });
    assert.equal(render(value), [
      `\u25cf ${label}(run-script) (6.9s)`, "  \u23bf one", "    two", "    three", "  \u23bf ... more (/expand)",
    ].join("\n"));
    const expanded = render(value, true);
    assert.match(expanded, /Arguments[^]*HIDDEN_SCRIPT_BODY[^]*Output[^]*one[^]*five/);
    assert.equal(expanded.match(/\(6\.9s\)/g)?.length, 1);
    assert.doesNotMatch(expanded, /more \(\/expand\)|Ran 1 shell command/);
    value.output = "one\ntwo\nthree\n";
    assert.equal(renderToolResponse(value, 100, false, false).length, 4);
    assert.doesNotMatch(render(value), /more \(\/expand\)/);
    value.output = "BEGIN " + "word ".repeat(200) + "END";
    for (const width of [1, 2, 4, 12, 24, 80]) {
      const lines = renderToolResponse(value, width, false, false);
      assert.ok(lines.length <= 5, "Preview limits apply to wrapped terminal rows");
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    assert.match(render(value, false, 24), /more \(\/expand\)/);
    assert.doesNotMatch(render(value, false, 24), /END/);
    assert.match(render(value, true, 24), /END/);
    for (const output of ["", "\n", " \t\r\n", "\x1b[32m\x1b[0m"]) {
      value.output = output;
      assert.equal(renderToolResponse(value, 100, false, false).length, 1, "Empty results need no result row");
    }
  }
});

test("normal shell output and summaries are dim while warnings and errors remain highlighted", () => {
  for (const name of ["bash", "powershell"]) {
    const value = tool({ name, output: "NORMAL_OUTPUT\nsecond line", details: { diagnostics: [
      { severity: "warn", message: "IMPORTANT_WARNING" },
    ] } });
    for (const expanded of [false, true]) {
      const lines = renderToolResponse(value, 100, expanded, false);
      assert.ok(lines.some((line) => line.includes("\x1b[2mNORMAL_OUTPUT\x1b[22m")));
      assert.ok(lines.some((line) => line.includes("\x1b[2msecond line\x1b[22m")));
      assert.ok(lines.some((line) => line.includes("\x1b[33mIMPORTANT_WARNING\x1b[39m")));
      assert.ok(lines[0]!.includes(`\x1b[1m${name === "bash" ? "Bash" : "PowerShell"}\x1b[22m`));
    }
    for (const status of ["pending", "running"] as const) {
      const lines = renderToolResponse({ ...value, status }, 100, false, false);
      assert.ok(lines.some((line) => line.includes(`\x1b[2m${status === "pending" ? "Pending" : "Running"}... (/expand)\x1b[22m`)));
    }
    const failed = renderToolResponse({ ...value, status: "error", output: "ERROR_OUTPUT", details: undefined }, 100, false, false);
    assert.ok(failed.some((line) => line.includes("\x1b[33mERROR_OUTPUT\x1b[39m")));
    assert.ok(failed.some((line) => line.includes("\x1b[33mError (/expand)\x1b[39m")));
  }
});

test("successful shell previews keep harness diagnostics visible outside their output limit", () => {
  const value = tool({ output: "one\ntwo\nthree\nfour\n<harness>\n[warn] Output truncated\n</harness>",
    details: { diagnostics: [{ severity: "warn", message: "Output truncated" }, { severity: "info", message: "Full output: /tmp/log.txt" }] } });
  const text = render(value);
  assert.match(text, /one[^]*two[^]*three[^]*more \(\/expand\)[^]*Output truncated[^]*Full output: \/tmp\/log\.txt/);
  assert.doesNotMatch(text, /four|<harness>|Ran 1 shell command/);
  assert.equal(text.match(/Output truncated/g)?.length, 1);
  assert.match(render(value, true), /four/);
});

test("shell durations remain in the bounded heading across lifecycle, selection and expansion states", () => {
  for (const name of ["bash", "powershell"]) {
    for (const status of ["pending", "running", "done", "error", "interrupted"] as const) {
      for (const [durationMs, duration] of [[25, "25ms"], [6900, "6.9s"]] as const) {
        const value = tool({ name, status, durationMs, arguments: { command: "LONG_COMMAND ".repeat(1000) } });
        for (const selected of [false, true]) {
          for (const expanded of [false, true]) {
            const lines = renderToolResponse(value, 40, expanded, selected);
            const heading = stripTerminalSequences(lines[0]!);
            assert.ok(heading.endsWith(` (${duration})`), heading);
            assert.equal(visibleWidth(heading), 40);
            assert.doesNotMatch(lines.slice(1).map(stripTerminalSequences).join("\n"), /\(25ms\)|\(6\.9s\)/);
          }
        }
      }
    }
  }
});

test("shell command headings stay bounded, literal and sanitized across lifecycle and selection states", () => {
  for (const [name, label] of [["bash", "Bash"], ["powershell", "PowerShell"]]) {
    assert.equal(activityLabel(tool({ name })), `${label}(npm test)`);
    for (const command of [undefined, null, 42, "", " \t", "\nHIDDEN_BODY"]) {
      assert.equal(activityLabel(tool({ name, arguments: { command, path: "NOT_A_SHELL_TARGET" } })), label);
    }
    for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      assert.equal(activityLabel(tool({ name, arguments: { command: `  npm\ttest ${separator}HIDDEN_BODY` } })), `${label}(npm test)`);
    }
    const command = '\x1b[2J\x1b]0;injected\x07\u009b2Jecho "**literal** \u754c\u9762 \ud83d\ude00" ' + "long argument ".repeat(2000);
    const value = tool({ name, arguments: { command }, output: "STDOUT_MUST_STAY_HIDDEN" });
    assert.ok(activityLabel(value).includes('echo "**literal** \u754c\u9762 \ud83d\ude00"'));
    for (const status of ["pending", "running", "done", "error", "interrupted"] as const) {
      value.status = status;
      for (const selected of [false, true]) {
        for (const width of [1, 2, 3, 4, 8, 12, 24, 80]) {
          const lines = renderToolResponse(value, width, false, selected);
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
          assert.equal(lines.length, renderToolResponse({ ...value, arguments: {} }, width, false, selected).length,
            "A long single-line command must not wrap the heading");
          assert.ok(lines.every((line) => !line.includes("\x1b[2J") && !line.includes("\x1b]0;") && !line.includes("\u009b")));
          assert.doesNotMatch(stripTerminalSequences(lines[0]!), /STDOUT_MUST_STAY_HIDDEN/);
        }
      }
    }
  }
});

test("complete writes and every diff hunk stay visible regardless of expansion", () => {
  const content = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");
  const diff = [
    ...Array.from({ length: 10 }, (_, i) => ` ${i + 1} context${i + 1}`),
    '-11 const oldValue = "old";', '+11 const newValue = "new";',
    "...", '-95 const lastOld = "before";', '+95 const lastNew = "after";',
  ].join("\n");
  for (const expanded of [false, true]) {
    const written = render(tool({ name: "write", arguments: { path: "long.ts", content } }), expanded);
    assert.match(written, /1 const line1 = 1;/);
    assert.match(written, /30 const line30 = 30;/);
    const edited = render(tool({ name: "edit", details: { result: { diff } } }), expanded);
    for (const source of diff.split("\n")) assert.ok(edited.includes(source), source);
    assert.doesNotMatch(written + edited, /more \(\/expand\)/);
    assert.equal(written.includes("Arguments"), expanded);
  }
});

test("long code lines wrap in full and diff continuation rows retain addition/removal colors", () => {
  const content = "BEGIN " + "word ".repeat(300) + "END";
  const diff = `-1 ${content}\n+1 ${content}`;
  for (const expanded of [false, true]) {
    for (const name of ["write", "edit"]) {
      const value = tool({ name, arguments: { content }, details: { result: { diff } } });
      const lines = renderToolResponse(value, 24, expanded, false);
      assert.ok(lines.length > 60);
      assert.ok(lines.every((line) => visibleWidth(line) <= 24));
      assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /more \(\/expand\)/);
      assert.match(lines.map(stripTerminalSequences).join("\n"), /END/);
      if (name === "edit") {
        const removal = lines.findIndex((line) => stripTerminalSequences(line).includes("-1 BEGIN"));
        const addition = lines.findIndex((line) => stripTerminalSequences(line).includes("+1 BEGIN"));
        assert.ok(removal >= 0 && addition > removal + 6);
        assert.ok(lines.slice(removal, addition).every((line) => line.includes("\x1b[31m")));
        assert.ok(lines.slice(addition, addition + 10).every((line) => line.includes("\x1b[32m")));
      }
    }
  }
});

test("successful edits without SDK diffs show all applied fragments without inventing line numbers", () => {
  const edits = [
    { oldText: "OLD_FIRST\n" + "old context\n".repeat(10), newText: "NEW_FIRST\n" + "new context\n".repeat(10) },
    { oldText: "OLD_LAST", newText: "NEW_LAST" },
    { oldText: "DELETED", newText: "" },
    { oldText: "", newText: "INSERTED" },
  ];
  for (const expanded of [false, true]) {
    const value = tool({ name: "edit", arguments: { path: "old-cache.ts", edits } });
    const text = render(value, expanded);
    assert.match(text, /Updated file \(line numbers unavailable\)/);
    assert.match(text, /Applied replacement 4/);
    for (const source of ["- OLD_FIRST", "+ NEW_FIRST", "- OLD_LAST", "+ NEW_LAST", "- DELETED", "+ INSERTED"]) {
      assert.ok(text.includes(source), source);
    }
    assert.doesNotMatch(text, /Added \d|removed \d|more \(\/expand\)/);
    const legacy = render(tool({ name: "edit", arguments: { oldText: "OLD", newText: "NEW" } }), expanded);
    assert.match(legacy, /- OLD[^]*\+ NEW/);
  }
  assert.match(render(tool({ name: "edit", arguments: { path: "unknown.ts" } })), /Updated file \(diff unavailable\)/);
});

test("diagnostics are shown outside collapsed content, once, including truncation and exit errors", () => {
  const value = tool({ name: "read", output: "one\ntwo\n<harness>\n[warn] Output truncated\n</harness>",
    details: { result: { truncation: { truncated: true } }, diagnostics: [{ severity: "warn", message: "Output truncated" }] } });
  assert.match(render(value), /Read 2 lines \(truncated\)/);
  assert.equal(render(value).match(/Output truncated/g)?.length, 1);
  assert.doesNotMatch(render(value), /<harness>/);
  value.name = "bash"; value.status = "error";
  value.details = { diagnostics: [{ severity: "error", message: "Command exited with code 7" }, { severity: "info", message: "Full output: /tmp/log.txt" }] };
  assert.match(render(value), /Error[^]*Command exited with code 7[^]*Full output: \/tmp\/log.txt/);
});

test("skills, compaction and question tools keep their payloads compact", () => {
  for (const value of [
    tool({ name: "read", arguments: { path: "/skills/testing/SKILL.md" } }),
    tool({ name: "load_skill", arguments: { name: "testing" } }),
    tool({ name: "compact", arguments: { reason: "manual" } }),
    ...["ask_question", "ask_multiple_questions", "ask_user"].map((name) => tool({ name })),
  ]) {
    value.output = "HIDDEN_PAYLOAD";
    assert.doesNotMatch(render(value), /HIDDEN_PAYLOAD/);
    assert.match(render(value, true), /HIDDEN_PAYLOAD/);
  }
  assert.equal(activityLabel(tool({ name: "read", arguments: { path: "C:\\skills\\testing\\SKILL.md" } })), "Skill testing");
});

test("image and unknown tool results have safe, expandable fallbacks", () => {
  assert.match(render(tool({ name: "read", images: [image] })), /Read 1 image[^]*available \(\/expand\)/);
  for (const name of ["custom_tool", "constructor", "__proto__"]) {
    assert.match(render(tool({ name, output: "custom response" })), /custom response/);
    assert.match(render(tool({ name })), /Done \(no text output\)/);
  }
  assert.match(render(tool({ name: "write", arguments: { content: "" } })), /Wrote 0 lines/);
  assert.match(render(tool({ name: "read" })), /Read 0 lines/);
});

test("all tool variants fit tiny widths, sanitize controls, and retain literal source", () => {
  const dirty = "\x1b[2J\x1b]0;injected\x07\u009b2J\t**literal** \u754c\u9762 \ud83d\ude00";
  for (const name of ["read", "write", "edit", "bash", "custom"]) {
    const value = tool({ name, arguments: { path: dirty, content: dirty }, output: dirty, details: { result: { diff: `-1 ${dirty}\n+1 ${dirty}` }, diagnostics: [{ message: dirty }] } });
    for (const width of [1, 2, 3, 4, 8, 12, 24, 80]) {
      for (const expanded of [false, true]) {
        const lines = renderToolResponse(value, width, expanded, true);
        assert.ok(lines.every((line) => visibleWidth(line) <= width), `${name} at ${width}`);
        assert.ok(lines.every((line) => !line.includes("\x1b[2J") && !line.includes("\x1b]0;") && !line.includes("\u009b")));
      }
    }
    assert.match(render(value, true), /\*\*literal\*\*/);
  }
});

test("checklist tools keep raw task data out of compact activity but retain expansion and errors", () => {
  for (const name of ["task_create", "task_update", "task_list", "task_get"]) {
    const value = tool({ name, arguments: { taskId: "2", addBlockedBy: ["1"] },
      output: JSON.stringify({ id: "2", subject: "Test auth", blockedBy: ["1"] }) });
    assert.doesNotMatch(render(value), /blockedBy|addBlockedBy|Test auth/);
    assert.match(render(value), /Task (?:created|updated|details available)/);
    assert.match(render(value, true), /blockedBy/);
    assert.match(render({ ...value, status: "error", output: "Task has unfinished prerequisites" }), /unfinished prerequisites/);
    assert.doesNotMatch(render({ ...value, status: "running" }), /Task created|Task updated/);
  }
});

test("batch task cards show operation counts without exposing raw task data or claiming failed work succeeded", () => {
  const value = tool({ name: "task_update", arguments: { operations: [
    { action: "create", subject: "Do not expose" }, { action: "delete", taskId: "4" },
  ] }, output: '{"results":[{"action":"create","taskId":"5","status":"pending"},{"action":"delete","taskId":"4","status":"deleted"}]}' });
  assert.match(render(value), /Applied 2 task operations/);
  assert.doesNotMatch(render(value), /Do not expose|results|taskId/);
  assert.match(render(value, true), /Do not expose/);
  assert.match(render(value, true), /results/);
  for (const status of ["pending", "running", "error", "interrupted"] as const) {
    assert.doesNotMatch(render({ ...value, status }), /Applied 2/);
  }
  assert.match(render({ ...value, status: "error", output: "Dependency cycle" }), /Dependency cycle/);
  assert.match(render({ ...value, arguments: { operations: [{ action: "delete", taskId: "4" }] } }), /Applied 1 task operation \(/);
});
