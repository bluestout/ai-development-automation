// ─── Per-client serial queue ─────────────────────────────────────────────────
// Different clients run concurrently; tasks for the SAME client repo run one at
// a time. That serialization is what makes the shared persistent clone safe —
// two tasks never `git fetch`/branch the same clone at once (each still gets its
// own worktree for isolation).
//
// The lane key is the client's repo. We resolve the task (one ClickUp read) up
// front to pick the lane, then hand the already-fetched task to the pipeline so
// it isn't fetched twice.

const PQueue = require("p-queue").default;
const { getTaskDetails } = require("./lib/clickup");
const { parseRepoSlug } = require("./lib/repo");
const { processTask } = require("./pipeline");

// One PQueue per repo lane (concurrency 1). Lanes are created on demand.
const lanes = new Map();

function laneFor(key) {
  if (!lanes.has(key)) lanes.set(key, new PQueue({ concurrency: 1 }));
  return lanes.get(key);
}

// Enqueue a task by id. Returns immediately after the lane is chosen; the actual
// run happens in the background. Errors are handled inside processTask (it posts
// an error comment), so we just log here as a backstop.
async function enqueueTask(taskId) {
  let task;
  try {
    task = await getTaskDetails(taskId);
  } catch (e) {
    console.error(`  ⚠️ Could not read task ${taskId} to pick a queue lane: ${e.message}`);
    // Fall back to a per-task lane so the pipeline can still run and comment the error.
    laneFor(`task:${taskId}`).add(() => processTask(taskId));
    return;
  }

  // Pick the lane by repo when we can; otherwise isolate by task.
  let laneKey;
  try {
    laneKey = `repo:${parseRepoSlug(task.repoField)}`;
  } catch {
    laneKey = `task:${taskId}`;
  }

  console.log(`  Queued task ${taskId} on lane ${laneKey}`);
  laneFor(laneKey)
    .add(() => processTask(taskId, task))
    .catch((e) => console.error(`  ⚠️ Lane error for ${taskId}: ${e.message}`));
}

module.exports = { enqueueTask };
