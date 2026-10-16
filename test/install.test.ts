import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const installer = readFileSync(resolve("install.sh"), "utf8");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zz-installer-"));
  const bin = join(root, "bin");
  const temp = join(root, "temp");
  mkdirSync(bin); mkdirSync(temp);
  const archive = Buffer.from("release archive fixture");
  const checksum = createHash("sha256").update(archive).digest("hex");
  writeFileSync(join(root, "zz.tgz"), archive);
  writeFileSync(join(root, "zz.tgz.sha256"), `${checksum}  zz.tgz\n`);
  const mock = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.TEST_INSTALL_ROOT;
fs.appendFileSync(path.join(root, "calls"), JSON.stringify({command, args}) + "\\n");
if (command === "curl") {
  if (process.env.TEST_DOWNLOAD_FAIL) process.exit(22);
  const url = args.find(arg => arg.startsWith("https://"));
  if (!url?.startsWith("https://github.com/rub1cc/zz/releases/")) process.exit(99);
  const name = url.split("/").at(-1);
  if (!["zz.tgz", "zz.tgz.sha256"].includes(name)) process.exit(99);
  fs.copyFileSync(path.join(root, name), args[args.indexOf("--output") + 1]);
} else if (command === "npm" && process.env.TEST_NPM_FAIL) process.exit(1);
`;
  for (const name of ["curl", "npm"]) {
    writeFileSync(join(bin, name), mock); chmodSync(join(bin, name), 0o755);
  }
  return {
    root, bin,
    run(extra: Record<string, string> = {}) {
      // Feed the script on stdin just like curl | bash; no interactive input.
      return spawnSync("bash", [], { input: installer, encoding: "utf8", env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp,
        ZZ_VERSION: "", ZZ_INSTALL_PREFIX: join(root, "prefix with spaces"),
        TEST_INSTALL_ROOT: root, ...extra,
      } });
    },
    calls(): { command: string; args: string[] }[] {
      try { return readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line)); }
      catch { return []; }
    },
    assertClean() { assert.deepEqual(readdirSync(temp), []); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("piped installer verifies latest release and installs without sudo or scripts", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed zz/);
    assert.match(result.stdout, /export PATH=/);
    const calls = f.calls();
    assert.equal(calls.length, 3);
    assert.ok(calls[0]!.args.includes("https://github.com/rub1cc/zz/releases/latest/download/zz.tgz"));
    const npm = calls[2]!;
    assert.equal(npm.command, "npm");
    assert.deepEqual(npm.args.slice(0, -1), ["install", "--global", "--prefix", join(f.root, "prefix with spaces"),
      "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"]);
    assert.ok(npm.args.at(-1)?.endsWith("/zz.tgz"));
    f.assertClean();
  } finally { f.cleanup(); }
});

test("installer supports a pinned version", () => {
  const f = fixture();
  try {
    const result = f.run({ ZZ_VERSION: "v0.0.1" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls()[0]!.args.includes("https://github.com/rub1cc/zz/releases/download/v0.0.1/zz.tgz"));
    f.assertClean();
  } finally { f.cleanup(); }
});

for (const checksum of ["0".repeat(64) + "  zz.tgz\n", "not a checksum\n"]) {
  test(`installer refuses ${checksum.startsWith("0") ? "mismatched" : "malformed"} checksums`, () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "zz.tgz.sha256"), checksum);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /checksum verification failed/);
      assert.equal(f.calls().some(call => call.command === "npm"), false);
      f.assertClean();
    } finally { f.cleanup(); }
  });
}

const invalidEnvironments: Record<string, string>[] = [{ ZZ_VERSION: "../../bad" }, { ZZ_INSTALL_PREFIX: "relative/path" }];
for (const env of invalidEnvironments) {
  test(`installer validates ${Object.keys(env)[0]} before downloading`, () => {
    const f = fixture();
    try {
      const result = f.run(env);
      assert.notEqual(result.status, 0);
      assert.deepEqual(f.calls(), []);
      f.assertClean();
    } finally { f.cleanup(); }
  });
}

test("installer rejects old Node.js before downloading", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.bin, "node"), "#!/bin/sh\necho 'zz: Node.js 22.19+ is required' >&2\nexit 1\n");
    chmodSync(join(f.bin, "node"), 0o755);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Node.js 22.19/);
    assert.deepEqual(f.calls(), []);
    f.assertClean();
  } finally { f.cleanup(); }
});

for (const key of ["TEST_DOWNLOAD_FAIL", "TEST_NPM_FAIL"]) {
  test(`installer propagates ${key === "TEST_DOWNLOAD_FAIL" ? "download" : "npm"} failures and cleans up`, () => {
    const f = fixture();
    try {
      const result = f.run({ [key]: "1" });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /Installed zz/);
      if (key === "TEST_DOWNLOAD_FAIL") assert.equal(f.calls().length, 1);
      f.assertClean();
    } finally { f.cleanup(); }
  });
}

test("release package includes built CLI and shrinkwrap, excludes source, and has a valid checksum", () => {
  const root = mkdtempSync(join(tmpdir(), "zz-package-test-"));
  try {
    mkdirSync(join(root, "scripts")); mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "src"));
    for (const file of ["package.json", "package-lock.json", "README.md", "install.sh", "scripts/package-release.mjs"]) {
      copyFileSync(resolve(file), join(root, file));
    }
    writeFileSync(join(root, "dist/cli.js"), "#!/usr/bin/env node\nconsole.log('zz');\n");
    writeFileSync(join(root, "src/secret.ts"), "must not ship");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const packed = spawnSync(process.execPath, [join(root, "scripts/package-release.mjs")], {
      encoding: "utf8", env: { ...process.env, RELEASE_TAG: `v${pkg.version}` },
    });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = join(root, "release/zz.tgz");
    const contents = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(contents.status, 0, contents.stderr);
    assert.match(contents.stdout, /package\/dist\/cli\.js/);
    assert.match(contents.stdout, /package\/npm-shrinkwrap\.json/);
    assert.doesNotMatch(contents.stdout, /secret\.ts/);
    const lock = spawnSync("tar", ["-xOzf", archive, "package/npm-shrinkwrap.json"], { encoding: "utf8" });
    assert.equal(lock.status, 0, lock.stderr);
    assert.deepEqual(JSON.parse(lock.stdout), JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")));
    const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    assert.equal(readFileSync(join(root, "release/zz.tgz.sha256"), "utf8"), `${hash}  zz.tgz\n`);
    assert.equal(readFileSync(join(root, "release/install.sh"), "utf8"), installer);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release packaging rejects a tag that does not match the package version", () => {
  const result = spawnSync(process.execPath, ["scripts/package-release.mjs"], {
    encoding: "utf8", env: { ...process.env, RELEASE_TAG: "v999.0.0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match package.json/);
});
