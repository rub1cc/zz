import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${pkg.version}`;
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Release version must be a stable x.y.z version");
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== tag) {
  throw new Error(`Tag ${process.env.RELEASE_TAG} does not match package.json (${tag})`);
}
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
if (lock.version !== pkg.version || lock.packages[""].version !== pkg.version) {
  throw new Error("package-lock.json version does not match package.json; run npm install --package-lock-only");
}

const staging = mkdtempSync(join(tmpdir(), "zz-release-"));
const output = join(root, "release");
try {
  mkdirSync(output, { recursive: true });
  cpSync(join(root, "dist"), join(staging, "dist"), { recursive: true });
  cpSync(join(root, "README.md"), join(staging, "README.md"));
  cpSync(join(root, "install.sh"), join(staging, "install.sh"));
  cpSync(join(root, "package.json"), join(staging, "package.json"));
  // npm includes shrinkwrap files in packages and uses them for global installs.
  // A package-lock alone would be excluded from the tarball by npm pack.
  cpSync(join(root, "package-lock.json"), join(staging, "npm-shrinkwrap.json"));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
    cwd: staging, encoding: "utf8",
  }));
  for (const required of ["dist/cli.js", "install.sh", "npm-shrinkwrap.json"]) {
    if (!packed[0].files.some(file => file.path === required)) {
      throw new Error(`Release archive is missing ${required}`);
    }
  }
  const archive = join(output, "zz.tgz");
  cpSync(join(staging, packed[0].filename), archive);
  const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(output, "zz.tgz.sha256"), `${hash}  zz.tgz\n`);
  cpSync(join(root, "install.sh"), join(output, "install.sh"));
  console.log(`Packaged ${tag}: ${archive}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
