import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBranches, readGitBranch } from "../src/git-branches.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zz-git-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  return { root, repo, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Git branches include unborn branches, nested directories, detached HEAD and linked worktrees", async () => {
  const f = fixture();
  try {
    assert.equal(await readGitBranch(f.repo), "main");
    const nested = join(f.repo, "nested"); mkdirSync(nested);
    assert.equal(await readGitBranch(nested), "main");
    f.git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
    const worktree = join(f.root, "search");
    f.git("worktree", "add", "-b", "feat/search", worktree);
    assert.equal(await readGitBranch(worktree), "feat/search");
    assert.equal(await readGitBranch(f.repo), "main");
    f.git("checkout", "--detach");
    assert.equal(await readGitBranch(f.repo), `detached ${f.git("rev-parse", "--short", "HEAD")}`);
    assert.equal(await readGitBranch(f.root), undefined);
    assert.equal(await readGitBranch(join(f.root, "missing")), undefined);
  } finally { f.cleanup(); }
});

test("branch cache refreshes changes and removals without querying on every sync or redraw", async () => {
  const f = fixture();
  let changes = 0;
  const cache = new GitBranches(() => changes++);
  try {
    cache.sync([f.repo]);
    await cache.refresh();
    assert.equal(cache.value(f.repo), "main");
    assert.equal(changes, 1);
    f.git("symbolic-ref", "HEAD", "refs/heads/fix/login");
    cache.sync([f.repo]);
    assert.equal(cache.value(f.repo), "main", "Sync and rendering only use the cached branch");
    await cache.refresh();
    assert.equal(cache.value(f.repo), "fix/login");
    assert.equal(changes, 2);
    await cache.refresh();
    assert.equal(changes, 2, "Unchanged branches do not trigger redraws");
    rmSync(join(f.repo, ".git"), { recursive: true });
    await cache.refresh();
    assert.equal(cache.value(f.repo), undefined);
    assert.equal(changes, 3);
    cache.sync([]);
    assert.equal(cache.value(f.repo), undefined);
  } finally { cache.close(); f.cleanup(); }
});

test("branch queries are deduplicated and late results cannot revive removed projects or a closed cache", async () => {
  let changes = 0;
  const requests: { signal?: AbortSignal; resolve: (branch: string | undefined) => void }[] = [];
  const cache = new GitBranches(() => changes++, async (_path, signal) => new Promise((resolve) => {
    requests.push({ signal, resolve });
  }));
  try {
    cache.sync(["repo"]);
    cache.sync(["repo"]);
    const first = cache.refresh();
    assert.equal(requests.length, 1);
    cache.sync([]);
    cache.sync(["repo"]);
    assert.equal(requests.length, 2);
    requests[0]!.resolve("stale");
    await first;
    assert.equal(cache.value("repo"), undefined);
    const second = cache.refresh();
    requests[1]!.resolve("current");
    await second;
    assert.equal(cache.value("repo"), "current");
    assert.equal(changes, 1);
    const last = cache.refresh();
    cache.close();
    assert.equal(requests[2]!.signal?.aborted, true);
    requests[2]!.resolve("too late");
    await last;
    cache.sync(["repo"]);
    assert.equal(cache.value("repo"), undefined);
    assert.equal(requests.length, 3);
    assert.equal(changes, 1);
  } finally { cache.close(); }
});

test("unavailable Git is treated as an unknown branch rather than an unhandled failure", async () => {
  const cache = new GitBranches(() => assert.fail("Unknown branches do not trigger redraws"), async () => { throw new Error("git unavailable"); });
  try {
    cache.sync(["repo"]);
    await cache.refresh();
    assert.equal(cache.value("repo"), undefined);
  } finally { cache.close(); }
});

test("branch polling refreshes idle dashboards every five seconds and stops on close", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let branch = "main";
  let reads = 0;
  const cache = new GitBranches(() => {}, async () => { reads++; return branch; });
  try {
    cache.sync(["repo"]);
    await cache.refresh();
    assert.equal(reads, 1);
    branch = "fix/login";
    t.mock.timers.tick(4999);
    assert.equal(cache.value("repo"), "main");
    assert.equal(reads, 1);
    t.mock.timers.tick(1);
    await cache.refresh();
    assert.equal(reads, 2);
    assert.equal(cache.value("repo"), "fix/login");
    cache.close();
    t.mock.timers.tick(5000);
    assert.equal(reads, 2);
  } finally { cache.close(); }
});
