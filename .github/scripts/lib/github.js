// ─── GitHub integration ──────────────────────────────────────────────────────
// Reads the theme's file tree + file contents, and creates/updates the AI branch.

const fetch = require("node-fetch");
const { GITHUB_TOKEN, REPO_NAME, TASK_NAME, slugify } = require("./config");

const GH_HEADERS = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json"
};

// ─── Fetch the full theme file tree (paths only) ─────────────────────────────
// Returns the list of editable theme paths: Liquid (structure/markup) AND JSON
// (content — templates/*.json + section group JSON). Content like the
// announcement-bar text lives in JSON, NOT in the .liquid section file, so the
// planner MUST be able to see both kinds of files.
async function fetchFileTree() {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_NAME}/git/trees/main?recursive=1`,
    { headers: GH_HEADERS }
  );
  if (!res.ok) throw new Error(`GitHub tree fetch failed: ${res.status} - ${await res.text()}`);

  const { tree } = await res.json();

  return tree
    .filter(f => f.type === "blob")
    .map(f => f.path)
    .filter(isEditableThemeFile);
}

// Liquid markup, template/section-group JSON (where editor content lives), and
// section CSS/JS assets.
function isEditableThemeFile(path) {
  return (
    path.endsWith(".liquid") ||
    (path.startsWith("templates/") && path.endsWith(".json")) ||
    (path.startsWith("sections/") && path.endsWith(".json")) || // *-group.json
    (path.startsWith("assets/") && (path.endsWith(".css") || path.endsWith(".js")))
  );
}

// ─── Fetch the FULL content of the planner's chosen files ────────────────────
// JSON content files are fetched whole (no truncation) so the AI can edit a
// single value without dropping the rest of the file. Large Liquid files are
// capped to keep prompt size sane.
async function fetchFileContents(paths) {
  const files = {};

  for (const path of paths) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_NAME}/contents/${encodeURIComponent(path)}?ref=main`,
      { headers: GH_HEADERS }
    );
    if (!res.ok) {
      console.warn(`  Could not fetch ${path}: ${res.status}`);
      continue;
    }
    const data = await res.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    // JSON files must be sent whole (editing requires the complete object);
    // Liquid files are capped to keep the prompt within token limits.
    files[path] = path.endsWith(".json") ? content : content.slice(0, 8000);
  }

  return files;
}

// ─── Find-or-create the AI branch, then push the changed files ───────────────
// The branch is named ai/<task-name-slug> ("Add Announcement Bar" →
// ai/add-announcement-bar), so re-runs of the same task reuse it.
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
    `https://api.github.com/repos/${REPO_NAME}/git/ref/heads/main`,
    { headers: GH_HEADERS }
  );
  if (!refRes.ok) throw new Error(`Failed to fetch main SHA: ${refRes.status}`);
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

module.exports = { fetchFileTree, fetchFileContents, createBranchAndPush };
