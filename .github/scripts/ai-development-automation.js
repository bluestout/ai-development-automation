// ─── AI Development Automation — entry point ─────────────────────────────────
// Orchestrates the pipeline. Each integration lives in its own module:
//   lib/config.js   — env vars, model, limits
//   lib/agent.js    — the Dev AI (Claude Agent SDK: real tools + Figma/Shopify MCP)
//   lib/github.js   — read the agent's working-tree edits, create branch + push
//   lib/shopify.js  — create/update the staging preview theme
//   lib/clickup.js  — run-state custom fields + result comment

const { SHOPIFY_STORE, MAX_RUNS, TASK_NAME, REPO_NAME } = require("./lib/config");
const { getChangedFiles, createBranchAndPush } = require("./lib/github");
const { runAgent } = require("./lib/agent");
const { upsertStagingThemeAndApplyChanges } = require("./lib/shopify");
const { loadRunState, saveRunState, postClickUpComment } = require("./lib/clickup");

const branchUrlFor = (branch) => `https://github.com/${REPO_NAME}/tree/${branch}`;

async function main() {
  console.log(`🚀 AI Development Automation — "${TASK_NAME}" → ${SHOPIFY_STORE || "(no store)"}`);

  try {
    // Fail fast rather than silently pushing to the wrong (fallback) store.
    if (!SHOPIFY_STORE) {
      throw new Error("No Shopify store resolved — set the 'Shopify Store' custom field in ClickUp (or the SHOPIFY_STORE secret).");
    }

    // STEP 0 — Load state + enforce the run cap before doing any work.
    console.log("\n🔢 [0/4] Checking run count + previous state...");
    const runState = await loadRunState();
    console.log(`  Runs: ${runState.runCount}/${MAX_RUNS}, stored theme: ${runState.themeId || "none (first run)"}`);

    if (runState.runCount >= MAX_RUNS) {
      await postClickUpComment({ limitReached: true, runCount: runState.runCount });
      console.log("🛑 Run limit reached — stopping.");
      return; // exit 0 — expected stop, not a failure
    }

    // STEP 1 — Dev AI agent edits the theme in place (Figma + shopify-dev MCP).
    console.log("\n🤖 [1/4] Running Dev AI agent...");
    const { summary } = await runAgent();

    // STEP 2 — Collect exactly what the agent changed from the working tree.
    console.log("\n📁 [2/4] Collecting the agent's edits...");
    const changes = getChangedFiles(summary);
    if (changes.files.length === 0) {
      throw new Error("Agent produced no theme file changes — please review the task description.");
    }
    console.log(`  ${changes.summary} → ${changes.files.map(f => f.path).join(", ")}`);

    // STEP 3 — Find-or-create the branch and push the changes.
    console.log("\n🌿 [3/4] Pushing changes to branch...");
    const branchName = await createBranchAndPush(changes);

    // STEP 4 — Find-or-create the staging theme, persist state, comment.
    console.log("\n🛍️ [4/4] Creating/updating staging theme...");
    const themeResult = await upsertStagingThemeAndApplyChanges(changes, runState.themeId);

    console.log("\n💾 Saving state + posting to ClickUp...");
    const newRunCount = runState.runCount + 1;
    await saveRunState({ runCount: newRunCount, themeId: themeResult.themeId, fields: runState.fields });

    if (themeResult.limitReached) {
      // Theme limit hit — we still pushed the branch; send the branch link.
      await postClickUpComment({
        themeLimit: true,
        branchName,
        branchUrl: branchUrlFor(branchName),
        summary: changes.summary,
        runCount: newRunCount
      });
      console.log("\n⚠️ Done — but Shopify theme limit was reached. Branch link sent to ClickUp.");
      return;
    }

    await postClickUpComment({
      themeName: themeResult.name,
      previewUrl: themeResult.previewUrl,
      branchName,
      branchUrl: branchUrlFor(branchName),
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
    await postClickUpComment({ error: err.message }).catch(() => {});
    process.exit(1);
  }
}

main();
