import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "./version.js";

export function upgradePrefix(packageRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZZ_INSTALL_PREFIX) return env.ZZ_INSTALL_PREFIX;
  const modules = dirname(packageRoot);
  const lib = dirname(modules);
  // Global npm installs live at <prefix>/lib/node_modules/zz on macOS/Linux.
  if (basename(modules) === "node_modules" && basename(lib) === "lib") return dirname(lib);
  return join(homedir(), ".local");
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid release version: ${value}`);
    return value.split(".").map(BigInt);
  };
  const next = parse(candidate);
  const installed = parse(current);
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== installed[i]) return next[i]! > installed[i]!;
  }
  return false;
}

export async function latestRelease(fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetcher("https://api.github.com/repos/rub1cc/zz/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `zz/${version}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const release: unknown = await response.json();
    if (!release || typeof release !== "object" || !("tag_name" in release)
      || typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)
      || ("draft" in release && release.draft) || ("prerelease" in release && release.prerelease)) {
      throw new Error("GitHub did not return a stable release tag");
    }
    return release.tag_name;
  } catch (error) {
    throw new Error(`Could not check for updates: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function upgrade(): Promise<void> {
  console.log(`Checking for updates (current: ${version})...`);
  const tag = await latestRelease();
  if (!isNewerVersion(tag.slice(1), version)) {
    console.log(`zz ${version} is up to date (latest release: ${tag}).`);
    return;
  }
  console.log(`Upgrading zz ${version} to ${tag}...`);
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync("bash", [join(packageRoot, "install.sh")], {
    stdio: "inherit",
    env: { ...process.env, ZZ_VERSION: tag, ZZ_INSTALL_PREFIX: upgradePrefix(packageRoot) },
  });
  if (result.error) throw new Error(`Could not start the installer: ${result.error.message}`);
  if (result.signal) throw new Error(`Upgrade interrupted by ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}
