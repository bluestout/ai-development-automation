// ─── ClickUp integration ─────────────────────────────────────────────────────
// Reads task details (name/description/store/repo), stores run state (run count +
// staging theme id) on two custom fields, and posts the result comment.
//
// Ported from the GitHub Actions version: taskId and repoName are now passed in
// per call (the Zapier dispatch used to inject them as env). getTaskDetails() is
// NEW — the server reads the task from ClickUp itself instead of from a payload.

const fetch = require("node-fetch");
const {
  CLICKUP_API_KEY, FIELD_RUN_COUNT, FIELD_THEME_ID, MAX_RUNS
} = require("./config");

const CU_HEADERS = { Authorization: CLICKUP_API_KEY, "Content-Type": "application/json" };

// Custom-field names that carry the per-client store + repo (created via the UI;
// see clickup-ai-fields memory). Matched by name so field-id changes don't break us.
const FIELD_SHOPIFY_STORE = "Shopify Store";
const FIELD_GITHUB_REPO = "GitHub Repository";

// ─── Fetch the full task: name, description, store, repo ──────────────────────
// Replaces the Zapier "get task details" step. Returns everything the pipeline
// needs to build its per-task ctx.
async function getTaskDetails(taskId) {
  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}?custom_task_ids=true`,
    { headers: { Authorization: CLICKUP_API_KEY } }
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch ClickUp task ${taskId}: ${res.status} - ${await res.text()}`);
  }
  const task = await res.json();
  const fields = task.custom_fields || [];
  const fieldValue = (name) => fields.find(f => f.name === name)?.value;

  return {
    taskId,
    listId: task.list?.id || null,
    taskName: task.name || "",
    taskDescription: task.description || task.text_content || "",
    store: (fieldValue(FIELD_SHOPIFY_STORE) || "").trim(),
    repoField: (fieldValue(FIELD_GITHUB_REPO) || "").trim(),
    // Carry the raw fields so loadRunState doesn't re-fetch the task.
    rawFields: fields
  };
}

// ─── Load run state (run count + stored theme id) ────────────────────────────
// Finds (or lazily creates) the two custom fields we manage. Accepts the already-
// fetched task fields + listId so we don't hit the API twice.
async function loadRunState({ taskId, listId, rawFields }) {
  if (!taskId) {
    console.warn("  taskId not set — running stateless (no run limit / reuse).");
    return statelessState();
  }

  const existing = rawFields || [];

  const runCountField = await ensureCustomField(listId, existing, FIELD_RUN_COUNT, "number");
  const themeIdField = await ensureCustomField(listId, existing, FIELD_THEME_ID, "short_text");

  const runCountVal = existing.find(f => f.id === runCountField?.id)?.value;
  const themeIdVal = existing.find(f => f.id === themeIdField?.id)?.value;

  return {
    runCount: Number(runCountVal) || 0,
    themeId: themeIdVal ? String(themeIdVal) : "",
    fields: { runCount: runCountField, themeId: themeIdField }
  };
}

const statelessState = () => ({ runCount: 0, themeId: "", fields: {} });

async function saveRunState(taskId, { runCount, themeId, fields }) {
  if (!taskId) return;
  if (fields.runCount?.id) await setCustomFieldValue(taskId, fields.runCount.id, { value: runCount });
  if (fields.themeId?.id && themeId) await setCustomFieldValue(taskId, fields.themeId.id, { value: String(themeId) });
  console.log(`  Saved state — runCount=${runCount}, themeId=${themeId || "(none)"}`);
}

// Find a custom field by name on the task; if missing, create it on the list.
async function ensureCustomField(listId, existingFields, name, type) {
  const found = existingFields.find(f => f.name === name);
  if (found) return found;
  if (!listId) return null;

  console.log(`  Creating missing ClickUp field "${name}" (${type}) on list ${listId}...`);
  const res = await fetch(
    `https://api.clickup.com/api/v2/list/${listId}/field`,
    { method: "POST", headers: CU_HEADERS, body: JSON.stringify({ name, type }) }
  );
  if (!res.ok) {
    console.warn(`  Could not create field "${name}": ${res.status} - ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return data.field || data;
}

async function setCustomFieldValue(taskId, fieldId, body) {
  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}/field/${fieldId}`,
    { method: "POST", headers: CU_HEADERS, body: JSON.stringify(body) }
  );
  if (!res.ok) console.warn(`  Failed to set field ${fieldId}: ${res.status} - ${await res.text()}`);
}

// ─── Post the result comment to the task ─────────────────────────────────────
async function postClickUpComment(taskId, opts) {
  if (!taskId) { console.warn("  taskId not set — skipping ClickUp comment"); return; }

  const commentText = buildCommentText(opts);

  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}/comment`,
    { method: "POST", headers: CU_HEADERS, body: JSON.stringify({ comment_text: commentText }) }
  );
  if (!res.ok) console.warn(`  ClickUp comment failed: ${res.status} - ${await res.text()}`);
  else console.log("  ✅ ClickUp comment posted");
}

// A thin divider line for visual separation (ClickUp comments are plain text,
// so we lay out structure manually instead of relying on markdown rendering).
const DIVIDER = "────────────────────────────";

// Join an array of "sections" (each itself a line or array of lines) into one
// comment, separating each section with a blank line. Falsy entries are dropped.
function layout(sections) {
  return sections
    .filter(Boolean)
    .map(s => (Array.isArray(s) ? s.filter(Boolean).join("\n") : s))
    .join("\n\n");
}

// Pick the right message for each outcome (limit hit / error / theme limit / success).
function buildCommentText(opts) {
  const { themeName, previewUrl, branchName, branchUrl, summary, error, runCount, reused, themeLimit, limitReached, repoName } = opts;

  if (limitReached) {
    return layout([
      `🛑  AI Automation Stopped — Run Limit Reached`,
      DIVIDER,
      [
        `This task has already been processed ${MAX_RUNS} times (the maximum).`,
        `Unchecking and re-checking "AI Ready" will no longer trigger the automation.`
      ],
      `💡  Need more changes? Please create a new task.`
    ]);
  }

  if (error) {
    return layout([
      `❌  AI Automation Failed`,
      DIVIDER,
      `Error: ${error}`,
      repoName ? `🔍  Repo: https://github.com/${repoName}` : null
    ]);
  }

  if (themeLimit) {
    return layout([
      `⚠️  AI Changes Ready — Shopify Theme Limit Reached`,
      DIVIDER,
      `The AI changes were generated and pushed, but a new staging theme could not be created because your Shopify store has reached its theme limit.`,
      [
        `🌿  Branch:  ${branchName}`,
        `🔗  Link:    ${branchUrl}`,
        `📝  Changes: ${summary || "AI applied changes based on the task description"}`
      ],
      DIVIDER,
      [
        `👉  Next step: delete an unused theme in Shopify, then re-check "AI Ready" to create the preview.`,
        `🔁  Run ${runCount}/${MAX_RUNS}`
      ]
    ]);
  }

  return layout([
    `✅  AI Staging Theme Ready${reused ? "  (updated existing theme & branch)" : ""}`,
    DIVIDER,
    [
      `🎨  Theme:   ${themeName}`,
      `🔗  Preview: ${previewUrl}`
    ],
    [
      `🌿  Branch:  ${branchName}`,
      `🔗  Link:    ${branchUrl}`,
      `📝  Changes: ${summary || "AI applied changes based on the task description"}`
    ],
    DIVIDER,
    [
      `🔁  Run ${runCount}/${MAX_RUNS} — uncheck & re-check "AI Ready" to re-run on the same branch & theme.`,
      `👀  Please review and approve before pushing to production.`
    ]
  ]);
}

module.exports = { getTaskDetails, loadRunState, saveRunState, postClickUpComment };
