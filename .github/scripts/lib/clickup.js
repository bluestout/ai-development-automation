// ─── ClickUp integration ─────────────────────────────────────────────────────
// Stores run state (run count + staging theme id) on two custom fields, and
// posts the result comment back to the task.

const fetch = require("node-fetch");
const {
  CLICKUP_API_KEY, TASK_ID, FIELD_RUN_COUNT, FIELD_THEME_ID,
  MAX_RUNS, REPO_NAME
} = require("./config");

const CU_HEADERS = { Authorization: CLICKUP_API_KEY, "Content-Type": "application/json" };

// ─── Load run state (run count + stored theme id) ────────────────────────────
// Reads the task, finds (or lazily creates) the two custom fields we manage.
// Falls back to a stateless run if anything is missing.
async function loadRunState() {
  if (!TASK_ID) {
    console.warn("  TASK_ID not set — running stateless (no run limit / reuse).");
    return statelessState();
  }

  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${TASK_ID}?custom_task_ids=true`,
    { headers: { Authorization: CLICKUP_API_KEY } }
  );
  if (!res.ok) {
    console.warn(`  Failed to fetch ClickUp task (${res.status}) — running stateless.`);
    return statelessState();
  }

  const task = await res.json();
  const listId = task.list?.id;
  const existing = task.custom_fields || [];

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

async function saveRunState({ runCount, themeId, fields }) {
  if (!TASK_ID) return;
  if (fields.runCount?.id) await setCustomFieldValue(fields.runCount.id, { value: runCount });
  if (fields.themeId?.id && themeId) await setCustomFieldValue(fields.themeId.id, { value: String(themeId) });
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

async function setCustomFieldValue(fieldId, body) {
  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${TASK_ID}/field/${fieldId}`,
    { method: "POST", headers: CU_HEADERS, body: JSON.stringify(body) }
  );
  if (!res.ok) console.warn(`  Failed to set field ${fieldId}: ${res.status} - ${await res.text()}`);
}

// ─── Post the result comment to the task ─────────────────────────────────────
async function postClickUpComment(opts) {
  if (!TASK_ID) { console.warn("  TASK_ID not set — skipping ClickUp comment"); return; }

  const commentText = buildCommentText(opts);

  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${TASK_ID}/comment`,
    { method: "POST", headers: CU_HEADERS, body: JSON.stringify({ comment_text: commentText }) }
  );
  if (!res.ok) console.warn(`  ClickUp comment failed: ${res.status} - ${await res.text()}`);
  else console.log("  ✅ ClickUp comment posted");
}

// Pick the right message for each outcome (limit hit / error / theme limit / success).
function buildCommentText(opts) {
  const { themeName, previewUrl, branchName, branchUrl, summary, error, qa, runCount, reused, themeLimit, limitReached } = opts;

  if (limitReached) {
    return [
      `🛑 AI Automation Stopped — Run Limit Reached`,
      ``,
      `This task has already been processed ${MAX_RUNS} times (the maximum).`,
      `Unchecking and re-checking "AI Ready" will no longer trigger the automation.`,
      ``,
      `If you need more changes, please create a new task.`
    ].join("\n");
  }

  if (error) {
    return [
      `❌ AI Automation Failed!`,
      ``,
      `Error: ${error}`,
      ``,
      `View logs: https://github.com/${REPO_NAME}/actions`
    ].join("\n");
  }

  if (themeLimit) {
    return [
      `⚠️ AI Changes Ready — but Shopify Theme Limit Reached`,
      ``,
      `The AI changes were generated and pushed, but a new staging theme could not be created because your Shopify store has reached its theme limit.`,
      ``,
      `🌿 Branch: ${branchName}`,
      `🔗 Branch link: ${branchUrl}`,
      `📝 Changes: ${summary || "AI applied changes based on the task description"}`,
      qaLine(qa),
      ``,
      `👉 Please delete an unused theme in Shopify, then re-check "AI Ready" to create the preview theme. (Run ${runCount}/${MAX_RUNS})`
    ].filter(Boolean).join("\n");
  }

  return [
    `✅ AI Staging Theme Ready!${reused ? " (updated existing theme & branch)" : ""}`,
    ``,
    `🎨 Theme: ${themeName}`,
    `🔗 Preview: ${previewUrl}`,
    `🌿 Branch: ${branchName}`,
    `🔗 Branch link: ${branchUrl}`,
    `📝 Changes: ${summary || "AI applied changes based on the task description"}`,
    qaLine(qa),
    ``,
    `🔁 Run ${runCount}/${MAX_RUNS}. Uncheck and re-check "AI Ready" to re-run on the SAME branch & theme.`,
    ``,
    `Please review and approve before pushing to production.`
  ].filter(Boolean).join("\n");
}

function qaLine(qa) {
  if (!qa) return "";
  if (qa.approved) return `🧪 QA: Passed ✅ (${qa.iterations} iteration${qa.iterations > 1 ? "s" : ""})`;
  const issues = (qa.issues || []).slice(0, 5).map(x => `   • ${x}`).join("\n");
  return `🧪 QA: Flagged ⚠️ after ${qa.iterations} iterations — manual review recommended:\n${issues}`;
}

module.exports = { loadRunState, saveRunState, postClickUpComment };
