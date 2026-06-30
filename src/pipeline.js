// ─── AI Development Automation — pipeline ────────────────────────────────────
// processTask(taskId) is the server-side equivalent of the old main(): it builds
// a per-task ctx from ClickUp, runs the Dev AI agent in an isolated worktree,
// pushes a branch, creates/updates the Shopify staging theme, and comments back.
//
// Same control flow + error semantics as the GitHub Actions version:
//   • run cap enforced before any work (limit-reached comment, no bump)
//   • hard failures post an error comment and do NOT bump the run count
//   • only successful / theme-limit runs increment the count

const { MAX_RUNS, GITHUB_TOKEN, shopifyTokenFor } = require("./lib/config");
const { getTaskDetails, loadRunState, saveRunState, postClickUpComment } = require("./lib/clickup");
const { ensureClone, addWorktree, removeWorktree } = require("./lib/repo");
const { runAgent } = require("./lib/agent");
const { getChangedFiles, createBranchAndPush } = require("./lib/github");
const { upsertStagingThemeAndApplyChanges } = require("./lib/shopify");

const branchUrlFor = (repoName, branch) => `https://github.com/${repoName}/tree/${branch}`;

// processTask(taskId, prefetchedTask?) — the queue passes the task it already
// read to pick the lane, so we don't fetch it twice. Falls back to fetching.
async function processTask(taskId, prefetchedTask) {
  console.log(`\n🚀 AI Development Automation — task ${taskId}`);

  let task = null;       // ClickUp task details (for error-comment context)
  let repoName = null;   // resolved owner/repo, once known (for error-comment link)
  let clonePath = null;  // persistent clone dir (for worktree cleanup)
  let worktree = null;   // per-task isolated checkout

  try {
    // STEP 0 — Pull the task + validate the per-client config (store, repo, token).
    console.log("\n📋 [0/5] Reading task from ClickUp...");
    task = prefetchedTask || await getTaskDetails(taskId);
    console.log(`  "${task.taskName}" → store=${task.store || "(none)"} repo=${task.repoField || "(none)"}`);

    if (!task.store) {
      throw new Error("No Shopify store on the task — set the 'Shopify Store' custom field (must be <store>.myshopify.com).");
    }
    if (!task.repoField) {
      throw new Error("No GitHub repository on the task — set the 'GitHub Repository' custom field.");
    }
    const shopifyToken = shopifyTokenFor(task.store);
    if (!shopifyToken) {
      throw new Error(`No Shopify token configured for "${task.store}". Add it to SHOPIFY_TOKENS.`);
    }
    if (!GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN is not set — the app cannot clone or push.");
    }

    // STEP 1 — Run state + run cap (before doing any work).
    console.log("\n🔢 [1/5] Checking run count + previous state...");
    const runState = await loadRunState(task);
    console.log(`  Runs: ${runState.runCount}/${MAX_RUNS}, stored theme: ${runState.themeId || "none (first run)"}`);

    if (runState.runCount >= MAX_RUNS) {
      await postClickUpComment(taskId, { limitReached: true, runCount: runState.runCount });
      console.log("🛑 Run limit reached — stopping.");
      return;
    }

    // STEP 2 — Ensure the persistent clone + an isolated worktree for this task.
    console.log("\n📦 [2/5] Preparing repo clone + worktree...");
    const clone = ensureClone(task.repoField);
    clonePath = clone.clonePath;
    repoName = clone.repoSlug;
    worktree = addWorktree(clone.clonePath, clone.baseBranch, taskId);

    // The ctx every lib step reads from.
    const ctx = {
      taskId,
      taskName: task.taskName,
      taskDescription: task.taskDescription,
      store: task.store,
      shopifyToken,
      repoName: clone.repoSlug,
      baseBranch: clone.baseBranch,
      githubToken: GITHUB_TOKEN,
      worktree
    };

    // STEP 3 — Dev AI agent edits the theme in place (Figma + shopify-dev MCP).
    console.log("\n🤖 [3/5] Running Dev AI agent...");
    const { summary } = await runAgent(ctx);

    // Collect exactly what the agent changed from the worktree.
    const changes = getChangedFiles(ctx.worktree, summary);
    if (changes.files.length === 0) {
      throw new Error("Agent produced no theme file changes — please review the task description.");
    }
    console.log(`  Changed: ${changes.files.map(f => f.path).join(", ")}`);

    // STEP 4 — Find-or-create the branch and push the changes.
    console.log("\n🌿 [4/5] Pushing changes to branch...");
    const branchName = await createBranchAndPush(ctx, changes);

    // STEP 5 — Find-or-create the staging theme, persist state, comment.
    console.log("\n🛍️ [5/5] Creating/updating staging theme...");
    const themeResult = await upsertStagingThemeAndApplyChanges(ctx, changes, runState.themeId);

    console.log("\n💾 Saving state + posting to ClickUp...");
    const newRunCount = runState.runCount + 1;
    await saveRunState(taskId, { runCount: newRunCount, themeId: themeResult.themeId, fields: runState.fields });

    if (themeResult.limitReached) {
      await postClickUpComment(taskId, {
        themeLimit: true,
        branchName,
        branchUrl: branchUrlFor(ctx.repoName, branchName),
        summary: changes.summary,
        runCount: newRunCount
      });
      console.log("\n⚠️ Done — but Shopify theme limit was reached. Branch link sent to ClickUp.");
      return;
    }

    await postClickUpComment(taskId, {
      themeName: themeResult.name,
      previewUrl: themeResult.previewUrl,
      branchName,
      branchUrl: branchUrlFor(ctx.repoName, branchName),
      summary: changes.summary,
      runCount: newRunCount,
      reused: !!runState.themeId
    });

    console.log("\n✅ Deployment complete!");

  } catch (err) {
    console.error("\n❌ Error:", err.message);
    console.error(err.stack);
    // Best-effort error comment. Don't bump run count on hard failures so the
    // user can retry without burning one of their attempts.
    await postClickUpComment(taskId, {
      error: err.message,
      repoName // may be null if we failed before resolving the repo — comment omits the link then
    }).catch(() => {});
  } finally {
    // Clone stays for next time; only the throwaway worktree is removed.
    if (clonePath && worktree) removeWorktree(clonePath, worktree);
  }
}

module.exports = { processTask };
