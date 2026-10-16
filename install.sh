#!/usr/bin/env bash
# Install the latest GitHub release, or set ZZ_VERSION=vX.Y.Z to pin a release.
# Node.js/npm must already be installed. Never invokes sudo or dependency scripts.
set -euo pipefail

# Keep EXIT cleanup in the same scope as the function's local variables.
main() (
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) echo "zz: this installer supports macOS and Linux." >&2; exit 1 ;;
  esac
  local command
  for command in node npm curl mktemp; do
    command -v "$command" >/dev/null 2>&1 || {
      echo "zz: $command is required. Install Node.js 22.19+ (including npm) and curl, then retry." >&2
      exit 1
    }
  done
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) {
      console.error("zz: Node.js 22.19+ is required; found " + process.versions.node);
      process.exit(1);
    }
  '

  local version="${ZZ_VERSION:-}" prefix="${ZZ_INSTALL_PREFIX:-$HOME/.local}"
  local base="https://github.com/rub1cc/zz/releases/latest/download"
  if [[ -n "$version" ]]; then
    if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "zz: ZZ_VERSION must be a release tag such as v0.0.1." >&2
      exit 1
    fi
    base="https://github.com/rub1cc/zz/releases/download/$version"
  fi
  if [[ "$prefix" != /* ]]; then
    echo "zz: ZZ_INSTALL_PREFIX must be an absolute path." >&2
    exit 1
  fi

  local temp
  temp="$(mktemp -d)"
  trap 'rm -rf -- "$temp"' EXIT
  echo "Downloading zz ${version:-latest}..."
  curl --fail --silent --show-error --location --retry 3 "$base/zz.tgz" --output "$temp/zz.tgz"
  curl --fail --silent --show-error --location --retry 3 "$base/zz.tgz.sha256" --output "$temp/zz.tgz.sha256"
  node --input-type=module - "$temp" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const checksum = readFileSync(join(dir, "zz.tgz.sha256"), "utf8").trim();
const expected = /^([a-f0-9]{64})  zz\.tgz$/.exec(checksum)?.[1];
const actual = createHash("sha256").update(readFileSync(join(dir, "zz.tgz"))).digest("hex");
if (!expected || actual !== expected) {
  console.error("zz: release checksum verification failed; nothing was installed.");
  process.exit(1);
}
NODE

  # The release contains built JavaScript and a shrinkwrap, so no compiler or
  # source checkout is needed. npm installs the locked production dependencies.
  npm install --global --prefix "$prefix" --ignore-scripts --omit=dev --no-audit --no-fund "$temp/zz.tgz" </dev/null
  echo "Installed zz to $prefix/bin/zz. Run: zz"
  case ":$PATH:" in
    *":$prefix/bin:"*) ;;
    *) printf 'Add this to your shell profile, then open a new terminal:\n  export PATH=%q:"$PATH"\n' "$prefix/bin" ;;
  esac
  rm -rf -- "$temp"
  trap - EXIT
)

main "$@"
