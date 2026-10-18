import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isNewerVersion, latestRelease, upgradePrefix } from "../src/upgrade.js";

for (const prefix of ["/usr/local", "/home/user/.local", "/opt/custom prefix", "/home/user/.nvm/versions/node/v24.0.0"]) {
  test(`upgrade keeps the global npm prefix ${prefix}`, () => {
    const root = join(prefix, "lib/node_modules/zz");
    assert.equal(upgradePrefix(root, {}), prefix);
    assert.equal(upgradePrefix(`${root}/`, {}), prefix);
  });
}

test("upgrade prefix can be overridden explicitly", () => {
  assert.equal(upgradePrefix("/usr/local/lib/node_modules/zz", { ZZ_INSTALL_PREFIX: "/custom prefix" }), "/custom prefix");
});

test("source and local installs fall back to the installer default", () => {
  for (const root of ["/work/zz", "/work/app/node_modules/zz"]) {
    assert.equal(upgradePrefix(root, {}), join(homedir(), ".local"));
    assert.equal(upgradePrefix(root, { ZZ_INSTALL_PREFIX: "" }), join(homedir(), ".local"));
  }
});

for (const [candidate, current, newer] of [
  ["0.0.10", "0.0.9", true], ["0.10.0", "0.9.99", true], ["1.0.0", "0.99.99", true],
  ["0.0.9", "0.0.9", false], ["0.0.9", "0.0.10", false], ["0.9.99", "0.10.0", false],
  ["0.99.99", "1.0.0", false], ["1.0.9007199254740993", "1.0.9007199254740992", true],
] as const) {
  test(`version comparison: ${candidate} ${newer ? ">" : "<="} ${current}`, () => {
    assert.equal(isNewerVersion(candidate, current), newer);
  });
}

test("version comparison rejects malformed and non-stable versions", () => {
  for (const invalid of ["", "v1.0.0", "1.0", "1.0.0-beta.1", "1.0.0+build", "../1.0.0"]) {
    assert.throws(() => isNewerVersion(invalid, "1.0.0"), /Invalid release version/);
    assert.throws(() => isNewerVersion("1.0.0", invalid), /Invalid release version/);
  }
});

test("update check requests GitHub metadata with a timeout and returns the stable tag", async () => {
  const tag = await latestRelease(async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/rub1cc/zz/releases/latest");
    assert.equal(new Headers(options?.headers).get("Accept"), "application/vnd.github+json");
    assert.match(new Headers(options?.headers).get("User-Agent")!, /^zz\/\d+\.\d+\.\d+$/);
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return Response.json({ tag_name: "v1.2.3", draft: false, prerelease: false });
  });
  assert.equal(tag, "v1.2.3");
});

for (const release of [null, {}, { tag_name: 123 }, { tag_name: "v1.0.0-beta.1" },
  { tag_name: "v1.0.0", draft: true }, { tag_name: "v1.0.0", prerelease: true }]) {
  test(`update check rejects invalid release metadata: ${JSON.stringify(release)}`, async () => {
    await assert.rejects(latestRelease(async () => Response.json(release)), /Could not check for updates.*stable release tag/);
  });
}

for (const status of [403, 404, 500]) {
  test(`update check reports HTTP ${status}`, async () => {
    await assert.rejects(latestRelease(async () => new Response("", { status })), new RegExp(`Could not check for updates.*HTTP ${status}`));
  });
}

test("update check reports connection, timeout, and JSON errors", async () => {
  for (const error of [new Error("Network unavailable"), new DOMException("Timed out", "TimeoutError")]) {
    await assert.rejects(latestRelease(async () => { throw error; }), /Could not check for updates/);
  }
  await assert.rejects(latestRelease(async () => new Response("invalid JSON")), /Could not check for updates/);
});
