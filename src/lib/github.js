// ─── GitHub integration ──────────────────────────────────────────────────────
// Reads the agent's worktree edits and pushes them to the AI branch via the
// Contents API. Ported from the GitHub Actions version: the worktree dir, repo
// name, base branch, task name, and token are now passed in (the server runs
// many tasks across many repos) instead of being module-level env constants.

const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { slugify } = require("./config");

const ghHeaders = (token) => ({
  Authorization: `token ${token}`,
  Accept: "application/vnd.github.v3+json"
});

// Liquid markup, template/section-group JSON (where editor content lives), and
// section CSS/JS assets — the file kinds the agent is allowed to ship.
function isEditableThemeFile(p) {
  return (
    p.endsWith(".liquid") ||
    (p.startsWith("templates/") && p.endsWith(".json")) ||
    (p.startsWith("sections/") && p.endsWith(".json")) || // *-group.json
    (p.startsWith("assets/") && (p.endsWith(".css") || p.endsWith(".js")))
  );
}

// ─── Read the agent's edits from the worktree ────────────────────────────────
// The agent edits files in place inside `worktreeDir`; we diff the tree
// (modified + untracked) to learn what it touched. Returns
// { files: [{path, content}], summary } — the shape the push + theme steps expect.
function getChangedFiles(worktreeDir, summary) {
  // -z = NUL-separated, robust against spaces/newlines in paths.
  const modified = execFileSync(
    "git", ["-C", worktreeDir, "diff", "--name-only", "-z", "HEAD"], { encoding: "utf-8" }
  );
  const untracked = execFileSync(
    "git", ["-C", worktreeDir, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf-8" }
  );

  const paths = [...modified.split("\0"), ...untracked.split("\0")]
    .filter(Boolean)
    .filter(isEditableThemeFile)
    .filter((p, i, arr) => arr.indexOf(p) === i);

  const files = paths.map(p => ({
    path: p,
    content: fs.readFileSync(path.join(worktreeDir, p), "utf-8")
  }));

  return { files, summary };
}

// Branch is named ai/<task-name-slug> so re-runs of the same task reuse it.
//   ctx: { repoName, baseBranch, taskName, githubToken }
async function createBranchAndPush(ctx, changes) {
  const branchName = `ai/${slugify(ctx.taskName)}`;

  if (await findExistingBranch(ctx, branchName)) {
    console.log(`  Reusing branch: ${branchName}`);
  } else {
    await createBranch(ctx, branchName);
    console.log(`  Created branch: ${branchName}`);
  }

  for (const file of changes.files) {
    await pushFile(ctx, branchName, file);
    console.log(`  ✅ Pushed: ${file.path}`);
  }

  return branchName;
}

async function createBranch(ctx, branchName) {
  const { repoName, baseBranch, githubToken } = ctx;
  const headers = ghHeaders(githubToken);

  const refRes = await fetch(
    `https://api.github.com/repos/${repoName}/git/ref/heads/${baseBranch}`,
    { headers }
  );
  if (!refRes.ok) throw new Error(`Failed to fetch ${baseBranch} SHA: ${refRes.status}`);
  const sha = (await refRes.json()).object.sha;

  const res = await fetch(`https://api.github.com/repos/${repoName}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
  });
  // 422 = ref already exists (race / re-run) — that's fine.
  if (!res.ok && res.status !== 422) {
    throw new Error(`Failed to create branch: ${res.status} - ${await res.text()}`);
  }
}

async function pushFile(ctx, branchName, file) {
  const { repoName, taskName, githubToken } = ctx;
  const headers = ghHeaders(githubToken);

  // The Contents API needs the current blob SHA to overwrite an existing file.
  let fileSha = null;
  const existingRes = await fetch(
    `https://api.github.com/repos/${repoName}/contents/${encodeURIComponent(file.path)}?ref=${branchName}`,
    { headers }
  );
  if (existingRes.ok) fileSha = (await existingRes.json()).sha;

  const res = await fetch(
    `https://api.github.com/repos/${repoName}/contents/${encodeURIComponent(file.path)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `AI: ${taskName}`,
        content: Buffer.from(file.content).toString("base64"),
        branch: branchName,
        ...(fileSha && { sha: fileSha })
      })
    }
  );
  if (!res.ok) throw new Error(`Failed to push ${file.path}: ${res.status} - ${await res.text()}`);
}

// Returns the branch name if a branch with this EXACT name already exists, else null.
async function findExistingBranch(ctx, branchName) {
  const { repoName, githubToken } = ctx;
  const wantRef = `refs/heads/${branchName}`;
  const res = await fetch(
    `https://api.github.com/repos/${repoName}/git/refs/heads/${encodeURIComponent(branchName)}`,
    { headers: ghHeaders(githubToken) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  // GitHub returns an array when the path is a prefix match, or a single object
  // on an exact match. Only accept the branch whose ref matches exactly.
  if (Array.isArray(data)) {
    return data.some(r => r.ref === wantRef) ? branchName : null;
  }
  return data && data.ref === wantRef ? branchName : null;
}

module.exports = { getChangedFiles, createBranchAndPush };
