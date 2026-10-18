import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { upgradePrefix } from "../src/upgrade.js";

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
