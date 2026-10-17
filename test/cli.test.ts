import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
