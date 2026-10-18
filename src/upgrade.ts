import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function upgradePrefix(packageRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZZ_INSTALL_PREFIX) return env.ZZ_INSTALL_PREFIX;
  const modules = dirname(packageRoot);
  const lib = dirname(modules);
  // Global npm installs live at <prefix>/lib/node_modules/zz on macOS/Linux.
  if (basename(modules) === "node_modules" && basename(lib) === "lib") return dirname(lib);
  return join(homedir(), ".local");
}

export function upgrade(): void {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync("bash", [join(packageRoot, "install.sh")], {
    stdio: "inherit",
    env: { ...process.env, ZZ_VERSION: "", ZZ_INSTALL_PREFIX: upgradePrefix(packageRoot) },
  });
  if (result.error) throw new Error(`Could not start the installer: ${result.error.message}`);
  if (result.signal) throw new Error(`Upgrade interrupted by ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}
