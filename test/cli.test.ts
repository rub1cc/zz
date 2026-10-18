import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { temporary } from "./helpers.js";

for (const mode of ["default", "xdg", "env", "flag"] as const) {
  test(`CLI data directory uses ${mode === "default" || mode === "xdg" ? "~/.zz" : mode} (${mode})`, () => {
    const temp = temporary();
    // Stop at lock acquisition, before loading credentials or starting the TUI.
    const preload = `
      import lockfile from ${JSON.stringify(pathToFileURL(resolve("node_modules/proper-lockfile/index.js")).href)};
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      lockfile.lock = async (root) => { console.log(root); throw new Error("test stop"); };
    `;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: temp.root };
      delete env.ZZ_DATA_DIR;
      delete env.XDG_DATA_HOME;
      if (mode !== "default") env.XDG_DATA_HOME = join(temp.root, "xdg");
      if (mode === "env" || mode === "flag") env.ZZ_DATA_DIR = join(temp.root, "env");
      const args = mode === "flag" ? ["--data-dir", join(temp.root, "flag")] : [];
      const result = spawnSync(process.execPath, ["--import", "tsx", "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`, "src/cli.ts", ...args], {
        env, encoding: "utf8", timeout: 20000,
      });
      assert.equal(result.status, 1, result.stderr);
      const expected = join(temp.root, mode === "flag" ? "flag" : mode === "env" ? "env" : ".zz");
      assert.equal(result.stdout.trim(), expected);
      assert.match(result.stderr, /Another zz owns/);
    } finally { temp.cleanup(); }
  });
}

test("CLI help documents upgrade without running the installer", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "upgrade", "--help"], {
    encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /zz upgrade checks for updates and installs only a newer release/);
  assert.match(result.stdout, /zz --version/);
  assert.doesNotMatch(result.stdout, /Downloading zz/);
});

for (const flag of ["--version", "-v"]) {
  test(`CLI ${flag} prints the package version without a TTY or data directory`, () => {
    const temp = temporary();
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", flag], {
        encoding: "utf8", timeout: 20000,
        env: { ...process.env, ZZ_DATA_DIR: join(temp.root, "unused-data") },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), JSON.parse(readFileSync("package.json", "utf8")).version);
      assert.equal(result.stderr, "");
      assert.equal(existsSync(join(temp.root, "unused-data")), false);
    } finally { temp.cleanup(); }
  });
}

for (const args of [["extra"], ["--model", "provider/model"], ["--thinking", "high"], ["--data-dir", "/tmp/zz"]]) {
  test(`CLI rejects unsupported upgrade arguments: ${args.join(" ")}`, () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "upgrade", ...args], {
      encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage: zz upgrade/);
    assert.doesNotMatch(result.stdout, /Downloading zz/);
  });
}

test("a project named upgrade remains accessible via an explicit path", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "./upgrade"], {
    encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /An interactive terminal is required/);
  assert.doesNotMatch(result.stdout, /Downloading zz/);
});
