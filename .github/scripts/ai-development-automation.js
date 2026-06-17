// ─── AI Development Automation — entry point ─────────────────────────────────
// Orchestrates the 5-step pipeline. Each integration lives in its own module:
//   lib/config.js   — env vars, API clients, models, limits
//   lib/github.js   — read theme files, create branch + push changes
//   lib/ai.js       — planner + Dev/QA loop (the AI brain)
//   lib/shopify.js  — create/update the staging preview theme
//   lib/clickup.js  — run-state custom fields + result comment

const { SHOPIFY_STORE, MAX_RUNS, TASK_NAME, TASK_DESCRIPTION, REPO_NAME } = require("./lib/config");
const { fetchFileTree, fetchFileContents, createBranchAndPush } = require("./lib/github");
const { planChange, devQaLoop } = require("./lib/ai");
const { upsertStagingThemeAndApplyChanges } = require("./lib/shopify");
const { loadRunState, saveRunState, postClickUpComment } = require("./lib/clickup");

const branchUrlFor = (branch) => `https://github.com/${REPO_NAME}/tree/${branch}`;

async function main() {
  console.log(`🚀 AI Development Automation — "${TASK_NAME}" → ${SHOPIFY_STORE || "(no store)"}`);

  try {
    // Fail fast if the per-client store didn't arrive — better a clear error
    // than silently pushing to the wrong (fallback) store.
    if (!SHOPIFY_STORE) {
      throw new Error("No Shopify store resolved — set the 'Shopify Store' custom field in ClickUp (or the SHOPIFY_STORE secret).");
    }

    // STEP 0 — Load state + enforce the run cap before doing any work.
    console.log("\n🔢 [0/5] Checking run count + previous state...");
    const runState = await loadRunState();
    console.log(`  Runs: ${runState.runCount}/${MAX_RUNS}, stored theme: ${runState.themeId || "none (first run)"}`);

    if (runState.runCount >= MAX_RUNS) {
      await postClickUpComment({ limitReached: true, runCount: runState.runCount });
      console.log("🛑 Run limit reached — stopping.");
      return; // exit 0 — expected stop, not a failure
    }

    // STEP 1 — Plan (content vs structure) + fetch only the chosen files.
    console.log("\n📁 [1/5] Planning + fetching theme files...");
    const fileTree = await fetchFileTree();
    const plan = await planChange(fileTree);
    console.log(`  ${plan.change_type} → ${plan.target_files.join(", ")} (${plan.reasoning})`);
    const themeFiles = await fetchFileContents(plan.target_files);

    // STEP 2 — Dev AI ↔ QA AI loop.
    console.log("\n🤖 [2/5] Dev AI ↔ QA AI loop...");
    const { changes, qa } = await devQaLoop(themeFiles, plan);
    console.log(`  ${changes.summary} → ${changes.files.map(f => f.path).join(", ")}`);

    // STEP 3 — Find-or-create the branch and push the changes.
    console.log("\n🌿 [3/5] Pushing changes to branch...");
    const branchName = await createBranchAndPush(changes);

    // STEP 4 — Find-or-create the staging theme.
    console.log("\n🛍️ [4/5] Creating/updating staging theme...");
    const themeResult = await upsertStagingThemeAndApplyChanges(changes, runState.themeId);

    // STEP 5 — Persist state + comment back to ClickUp.
    console.log("\n💾 [5/5] Saving state + posting to ClickUp...");
    const newRunCount = runState.runCount + 1;
    await saveRunState({ runCount: newRunCount, themeId: themeResult.themeId, fields: runState.fields });

    if (themeResult.limitReached) {
      // Theme limit hit — we still pushed the branch; send the branch link.
      await postClickUpComment({
        themeLimit: true,
        branchName,
        branchUrl: branchUrlFor(branchName),
        summary: changes.summary,
        qa,
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
      qa,
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
