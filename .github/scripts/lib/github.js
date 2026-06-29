// ─── GitHub integration ──────────────────────────────────────────────────────
// Reads the agent's working-tree edits and pushes them to the AI branch.

const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { REPO_ROOT, GITHUB_TOKEN, REPO_NAME, BASE_BRANCH, TASK_NAME, slugify } = require("./config");

const GH_HEADERS = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json"
};

// Liquid markup, template/section-group JSON (where editor content lives), and
// section CSS/JS assets — the file kinds the agent is allowed to ship.
function isEditableThemeFile(path) {
  return (
    path.endsWith(".liquid") ||
    (path.startsWith("templates/") && path.endsWith(".json")) ||
    (path.startsWith("sections/") && path.endsWith(".json")) || // *-group.json
    (path.startsWith("assets/") && (path.endsWith(".css") || path.endsWith(".js")))
  );
}

// ─── Read the agent's edits from the git working tree ────────────────────────
// The agent edits files in place; we diff the tree (modified + untracked) to
// learn what it touched. Returns { files: [{path, content}], summary } — the
// shape the push + theme steps expect.
function getChangedFiles(summary) {
  // -z = NUL-separated, robust against spaces/newlines in paths.
  const modified = execFileSync(
    "git", ["-C", REPO_ROOT, "diff", "--name-only", "-z", "HEAD"], { encoding: "utf-8" }
  );
  const untracked = execFileSync(
    "git", ["-C", REPO_ROOT, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf-8" }
  );

  const paths = [...modified.split("\0"), ...untracked.split("\0")]
    .filter(Boolean)
    .filter(isEditableThemeFile)
    .filter((p, i, arr) => arr.indexOf(p) === i);

  const files = paths.map(p => ({
    path: p,
    content: fs.readFileSync(path.join(REPO_ROOT, p), "utf-8")
  }));

  return { files, summary };
}

// Branch is named ai/<task-name-slug> so re-runs of the same task reuse it.
async function createBranchAndPush(changes) {
  const branchName = `ai/${slugify(TASK_NAME)}`;

  if (await findExistingBranch(branchName)) {
    console.log(`  Reusing branch: ${branchName}`);
  } else {
    await createBranch(branchName);
    console.log(`  Created branch: ${branchName}`);
  }

  for (const file of changes.files) {
    await pushFile(branchName, file);
    console.log(`  ✅ Pushed: ${file.path}`);
  }

  return branchName;
}

async function createBranch(branchName) {
  const refRes = await fetch(
    `https://api.github.com/repos/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`,
    { headers: GH_HEADERS }
  );
  if (!refRes.ok) throw new Error(`Failed to fetch ${BASE_BRANCH} SHA: ${refRes.status}`);
  const sha = (await refRes.json()).object.sha;

  const res = await fetch(`https://api.github.com/repos/${REPO_NAME}/git/refs`, {
    method: "POST",
    headers: GH_HEADERS,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
  });
  // 422 = ref already exists (race / re-run) — that's fine.
  if (!res.ok && res.status !== 422) {
    throw new Error(`Failed to create branch: ${res.status} - ${await res.text()}`);
  }
}

async function pushFile(branchName, file) {
  // The Contents API needs the current blob SHA to overwrite an existing file.
  let fileSha = null;
  const existingRes = await fetch(
    `https://api.github.com/repos/${REPO_NAME}/contents/${encodeURIComponent(file.path)}?ref=${branchName}`,
    { headers: GH_HEADERS }
  );
  if (existingRes.ok) fileSha = (await existingRes.json()).sha;

  const res = await fetch(
    `https://api.github.com/repos/${REPO_NAME}/contents/${encodeURIComponent(file.path)}`,
    {
      method: "PUT",
      headers: GH_HEADERS,
      body: JSON.stringify({
        message: `AI: ${TASK_NAME}`,
        content: Buffer.from(file.content).toString("base64"),
        branch: branchName,
        ...(fileSha && { sha: fileSha })
      })
    }
  );
  if (!res.ok) throw new Error(`Failed to push ${file.path}: ${res.status} - ${await res.text()}`);
}

// Returns the branch name if a branch with this EXACT name already exists, else null.
async function findExistingBranch(branchName) {
  const wantRef = `refs/heads/${branchName}`;
  const res = await fetch(
    `https://api.github.com/repos/${REPO_NAME}/git/refs/heads/${encodeURIComponent(branchName)}`,
    { headers: GH_HEADERS }
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
