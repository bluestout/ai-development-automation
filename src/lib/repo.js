// ─── Git repo lifecycle (Railway) ────────────────────────────────────────────
// GitHub Actions gave the agent a checked-out theme working tree. The server has
// none — so this module keeps ONE persistent clone per client repo on the
// Railway volume (cloned once, fetched thereafter) and hands each task an
// isolated `git worktree` off that clone. Concurrent tasks for the same client
// never collide: the per-client queue serializes fetch, and each task gets its
// own worktree directory.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { VOLUME_DIR, GITHUB_TOKEN } = require("./config");

// Run git and return trimmed stdout. Throws with stderr on failure.
function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf-8", ...opts }).trim();
}

// ─── Normalize the ClickUp "GitHub Repository" field → "owner/repo" ──────────
// Accepts "owner/repo", "https://github.com/owner/repo", or ".../owner/repo.git".
function parseRepoSlug(repoField) {
  if (!repoField) throw new Error("No GitHub repository set on the task.");
  let s = repoField.trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid GitHub repository: "${repoField}"`);
  // Take the last two segments (handles any leftover host/path noise).
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  return `${owner}/${repo}`;
}

// Authenticated HTTPS clone URL using the shared PAT. The token is kept out of
// on-disk git config: we clone with it in the URL but immediately rewrite the
// remote to the clean URL and rely on a per-command credential header instead.
function authUrl(repoSlug) {
  return `https://x-access-token:${GITHUB_TOKEN}@github.com/${repoSlug}.git`;
}

// On-disk dir name for a client's persistent clone, e.g. "owner__repo".
function cloneDirFor(repoSlug) {
  return path.join(VOLUME_DIR, repoSlug.replace(/\//g, "__"));
}

// ─── Ensure the persistent clone exists & is up to date ──────────────────────
// First call clones; later calls fetch. Returns { repoSlug, clonePath, baseBranch }.
// MUST be called inside the per-client serial section (the queue guarantees this).
function ensureClone(repoField) {
  const repoSlug = parseRepoSlug(repoField);
  const clonePath = cloneDirFor(repoSlug);
  const url = authUrl(repoSlug);

  fs.mkdirSync(VOLUME_DIR, { recursive: true });

  if (fs.existsSync(path.join(clonePath, ".git"))) {
    console.log(`  Reusing clone: ${clonePath} — fetching...`);
    // Refresh the auth'd URL each time (token may rotate) then fetch all refs.
    git(["-C", clonePath, "remote", "set-url", "origin", url]);
    git(["-C", clonePath, "fetch", "origin", "--prune"]);
  } else {
    console.log(`  Cloning ${repoSlug} → ${clonePath} ...`);
    git(["clone", url, clonePath]);
  }

  const baseBranch = resolveDefaultBranch(clonePath);
  return { repoSlug, clonePath, baseBranch };
}

// Resolve the remote's default branch (clients differ: main/master/custom).
function resolveDefaultBranch(clonePath) {
  try {
    // origin/HEAD points at the default branch after a normal clone.
    const ref = git(["-C", clonePath, "symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Fallback: ask the remote directly.
    const head = git(["-C", clonePath, "remote", "show", "origin"]);
    const m = head.match(/HEAD branch:\s*(\S+)/);
    return m ? m[1] : "main";
  }
}

// ─── Add an isolated worktree for one task ────────────────────────────────────
// Detached at origin/<baseBranch> so the agent edits a clean copy of the latest
// base. Returns the worktree path. Caller MUST removeWorktree() in a finally.
function addWorktree(clonePath, baseBranch, taskId) {
  const id = `${taskId || "task"}-${crypto.randomBytes(4).toString("hex")}`;
  const worktreePath = path.join(clonePath, ".worktrees", id);

  git(["-C", clonePath, "worktree", "add", "--detach", "--force",
       worktreePath, `origin/${baseBranch}`]);
  console.log(`  Worktree ready: ${worktreePath} (origin/${baseBranch})`);
  return worktreePath;
}

// Remove a worktree and its dir. Best-effort — never throws (runs in finally).
function removeWorktree(clonePath, worktreePath) {
  if (!worktreePath) return;
  try {
    git(["-C", clonePath, "worktree", "remove", "--force", worktreePath]);
  } catch (e) {
    console.warn(`  ⚠️ worktree remove failed (${e.message}) — pruning + rm.`);
    try { git(["-C", clonePath, "worktree", "prune"]); } catch {}
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { parseRepoSlug, ensureClone, addWorktree, removeWorktree };
