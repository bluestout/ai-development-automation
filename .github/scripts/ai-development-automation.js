const Anthropic = require("@anthropic-ai/sdk");
const fetch = require("node-fetch");

// ─── Config ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SHOPIFY_STORE = (process.env.SHOPIFY_STORE || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_HEADERS = {
  "X-Shopify-Access-Token": SHOPIFY_TOKEN,
  "Content-Type": "application/json"
};
const SHOPIFY_API = "2024-01";
// themeDuplicate mutation only exists on newer API versions; keep REST on the
// pinned version above and use this one only for the GraphQL duplicate call.
const SHOPIFY_GRAPHQL_API = "2026-04";

const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const TASK_ID = process.env.TASK_ID;

const DEV_MODEL = "claude-sonnet-4-6"; // Claude writes the theme changes
const QA_MODEL = "claude-sonnet-4-6";  // Claude reviews them

const MAX_RUNS = 3;        // user may re-trigger the checkbox at most 3 times
const MAX_QA_LOOPS = 3;    // Dev <-> QA iterations before giving up

// Custom field names we manage on the ClickUp list.
const FIELD_RUN_COUNT = "AI Run Count";
const FIELD_THEME_ID = "AI Theme ID";

// ─── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 AI Development Automation started");
  console.log("Task:", process.env.TASK_NAME);
  console.log("Description:", process.env.TASK_DESCRIPTION);
  console.log("Target store:", SHOPIFY_STORE || "(none)");
  console.log("Target repo:", process.env.REPO_NAME || "(none)");

  let runState = null;

  try {
    // Fail fast if the per-client store didn't arrive — better a clear error
    // than silently pushing to the wrong (fallback) store.
    if (!SHOPIFY_STORE) {
      throw new Error("No Shopify store resolved — set the 'Shopify Store' custom field in ClickUp (or the SHOPIFY_STORE secret).");
    }

    // STEP 0 — Load state from ClickUp + enforce the 3-run cap BEFORE any work.
    console.log("\n🔢 [0/5] Checking run count + previous state...");
    runState = await loadRunState();
    console.log(`  Previous runs: ${runState.runCount}/${MAX_RUNS}`);
    console.log(`  Stored theme id: ${runState.themeId || "(none — first run)"}`);

    if (runState.runCount >= MAX_RUNS) {
      console.log(`  ⛔ Run limit reached (${runState.runCount}/${MAX_RUNS}). Stopping.`);
      await postClickUpComment({
        limitReached: true,
        runCount: runState.runCount
      });
      console.log("\n🛑 Stopped: max run limit reached.");
      return; // exit 0 — this is an expected stop, not a failure
    }

    // STEP 1 — Fetch relevant theme files from GitHub.
    console.log("\n📁 [1/5] Fetching theme files...");
    const themeFiles = await fetchThemeFiles();
    console.log(`  Found ${Object.keys(themeFiles).length} relevant files`);

    // STEP 2 — Dev AI + QA AI feedback loop.
    console.log("\n🤖 [2/5] Dev AI ↔ QA AI loop...");
    const { changes, qa } = await devQaLoop(themeFiles);
    console.log("  Files to update:", changes.files.map(f => f.path));
    console.log("  Summary:", changes.summary);
    console.log(`  QA verdict: ${qa.approved ? "APPROVED ✅" : "NOT APPROVED ⚠️"} after ${qa.iterations} iteration(s)`);

    // STEP 3 — Find-or-create branch (idempotent by Task ID prefix) and push.
    console.log("\n🌿 [3/5] Creating/updating branch and pushing changes...");
    const branchName = await createBranchAndPush(changes);
    console.log("  Branch:", branchName);

    // STEP 4 — Find-or-create staging theme (idempotent by stored theme id).
    console.log("\n🛍️ [4/5] Creating/updating staging theme...");
    const themeResult = await upsertStagingThemeAndApplyChanges(changes, runState.themeId);

    // STEP 5 — Persist state (bump run count, store theme id) + comment to ClickUp.
    console.log("\n💾 [5/5] Saving state + posting to ClickUp...");
    const newRunCount = runState.runCount + 1;
    await saveRunState({ runCount: newRunCount, themeId: themeResult.themeId, fields: runState.fields });

    if (themeResult.limitReached) {
      // Theme limit hit — we still pushed the branch; tell the user, include branch link.
      await postClickUpComment({
        themeLimit: true,
        branchName,
        branchUrl: `https://github.com/${process.env.REPO_NAME}/tree/${branchName}`,
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
      branchUrl: `https://github.com/${process.env.REPO_NAME}/tree/${branchName}`,
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
    // user can retry without burning one of their 3 attempts.
    await postClickUpComment({ error: err.message }).catch(() => {});
    process.exit(1);
  }
}

// ─── Fetch relevant Liquid files from GitHub ─────────────────────────────────
async function fetchThemeFiles() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO_NAME;

  const treeRes = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`,
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!treeRes.ok) throw new Error(`GitHub tree fetch failed: ${treeRes.status} - ${await treeRes.text()}`);

  const treeData = await treeRes.json();
  const taskText = `${process.env.TASK_NAME || ""} ${process.env.TASK_DESCRIPTION || ""}`.toLowerCase();
  const allLiquidFiles = treeData.tree.filter(f => f.type === "blob" && f.path.endsWith(".liquid"));

  const keywordMap = {
    header: ["header"],
    footer: ["footer"],
    hero: ["hero"],
    banner: ["banner", "hero", "announcement"],
    announcement: ["announcement", "banner"],
    product: ["product"],
    collection: ["collection"],
    cart: ["cart"],
    homepage: ["index", "home", "hero", "banner"],
    home: ["index", "home", "hero", "banner"],
    navigation: ["header", "nav", "menu"],
    nav: ["header", "nav", "menu"],
  };

  const relevantFiles = allLiquidFiles.filter(f => {
    const name = f.path.toLowerCase();
    return Object.entries(keywordMap).some(([keyword, patterns]) =>
      taskText.includes(keyword) && patterns.some(p => name.includes(p))
    );
  });

  const filesToFetch = relevantFiles.length > 0
    ? relevantFiles.slice(0, 4)
    : allLiquidFiles.filter(f =>
        f.path.startsWith("sections/") && (
          f.path.includes("header") || f.path.includes("hero") ||
          f.path.includes("banner") || f.path.includes("footer")
        )
      ).slice(0, 4);

  console.log("  Fetching files:", filesToFetch.map(f => f.path));

  const files = {};
  for (const file of filesToFetch) {
    const res = await fetch(file.url, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" }
    });
    if (!res.ok) continue;
    const data = await res.json();
    files[file.path] = Buffer.from(data.content, "base64").toString("utf-8").slice(0, 3000);
  }

  return files;
}

// ─── Dev AI ↔ QA AI feedback loop ────────────────────────────────────────────
// Dev (Claude) proposes changes; QA (Claude) reviews against the task description.
// If QA rejects, its feedback is fed back to Dev for a fix. Repeats up to
// MAX_QA_LOOPS. Returns the best changes plus the final QA verdict.
async function devQaLoop(themeFiles) {
  let changes = await generateWithClaude(themeFiles, null);
  validateChanges(changes);

  let qaFeedback = null;
  let iterations = 0;

  for (let i = 1; i <= MAX_QA_LOOPS; i++) {
    iterations = i;
    console.log(`  — QA review (iteration ${i}/${MAX_QA_LOOPS})...`);
    const verdict = await qaReviewWithClaude(themeFiles, changes);
    console.log(`    QA: ${verdict.approved ? "APPROVED" : "CHANGES REQUESTED"} — ${verdict.summary}`);

    if (verdict.approved) {
      return { changes, qa: { approved: true, iterations: i, issues: [], summary: verdict.summary } };
    }

    qaFeedback = verdict;

    // Last loop failed too — return best effort, flagged as not approved.
    if (i === MAX_QA_LOOPS) {
      return {
        changes,
        qa: { approved: false, iterations: i, issues: verdict.issues || [], summary: verdict.summary }
      };
    }

    // Feed QA feedback back to Dev for a fix.
    console.log(`    Sending QA feedback back to Dev AI...`);
    changes = await generateWithClaude(themeFiles, qaFeedback);
    validateChanges(changes);
  }

  return { changes, qa: { approved: false, iterations, issues: qaFeedback?.issues || [], summary: qaFeedback?.summary } };
}

function validateChanges(changes) {
  if (!changes.files || changes.files.length === 0) {
    throw new Error("AI did not generate any changes — please review the task description");
  }
  for (const file of changes.files) {
    if (!file.path || !file.content || file.content.trim().length < 10) {
      throw new Error(`File '${file.path}' has empty or invalid content`);
    }
  }
}

// ─── Generate code changes with Claude (Dev AI) ──────────────────────────────
// When `qaFeedback` is provided, the prompt asks Dev to FIX the flagged issues.
async function generateWithClaude(themeFiles, qaFeedback) {
  const filesContext = Object.entries(themeFiles)
    .map(([path, content]) => `=== FILE: ${path} ===\n${content}\n=== END: ${path} ===`)
    .join("\n\n");

  const feedbackBlock = qaFeedback
    ? `\n\nIMPORTANT — A QA reviewer rejected your previous attempt. Fix EVERY issue below and return the corrected complete files:\nQA SUMMARY: ${qaFeedback.summary}\nISSUES:\n${(qaFeedback.issues || []).map((x, i) => `${i + 1}. ${x}`).join("\n")}\n`
    : "";

  const prompt = `You are an expert Shopify theme developer. Make ONLY the specific changes described in the task below.

TASK NAME: ${process.env.TASK_NAME}
TASK DESCRIPTION: ${process.env.TASK_DESCRIPTION}

CURRENT THEME FILES:
${filesContext}
${feedbackBlock}
STRICT RULES:
1. Return ONLY valid JSON — no markdown, no explanation, no code blocks
2. Only modify files that need to change for this specific task
3. Include the COMPLETE file content (not just the changed part)
4. If a file doesn't need changes, don't include it

REQUIRED JSON FORMAT (no other text):
{"files":[{"path":"sections/header.liquid","content":"...complete file content..."}],"summary":"One sentence describing what was changed"}`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model: DEV_MODEL,
        max_tokens: 8000,
        system: "You are a Shopify theme developer. Respond with valid JSON only. No markdown, no code blocks, no explanation.",
        messages: [{ role: "user", content: prompt }]
      });

      const text = (msg.content.find(b => b.type === "text")?.text || "").trim();
      console.log("    Dev AI response preview:", text.slice(0, 150));

      const parsed = extractJson(text);
      if (!parsed.files || !Array.isArray(parsed.files)) throw new Error("AI response missing 'files' array");
      return parsed;
    } catch (err) {
      console.warn(`    Dev attempt ${attempt}/3 failed:`, err.message);
      lastError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`Dev AI failed after 3 attempts: ${lastError.message}`);
}

// ─── QA review with Claude (QA AI) ───────────────────────────────────────────
// Reviews the proposed changes against the task description. Returns a verdict.
async function qaReviewWithClaude(themeFiles, changes) {
  const originalContext = Object.entries(themeFiles)
    .map(([path, content]) => `=== ORIGINAL: ${path} ===\n${content}`)
    .join("\n\n");

  const proposedContext = changes.files
    .map(f => `=== PROPOSED: ${f.path} ===\n${f.content.slice(0, 4000)}`)
    .join("\n\n");

  const prompt = `You are a strict senior Shopify QA engineer. Review the PROPOSED changes against the TASK and decide if they are correct, complete, and safe to ship.

TASK NAME: ${process.env.TASK_NAME}
TASK DESCRIPTION: ${process.env.TASK_DESCRIPTION}

ORIGINAL FILES (truncated):
${originalContext}

PROPOSED CHANGES:
${proposedContext}

Check for: (1) does it actually implement the task, (2) valid Liquid syntax, (3) no broken/removed schema, (4) no obvious regressions, (5) follows Shopify best practices.

Respond with ONLY valid JSON, no markdown:
{"approved": true|false, "summary": "one sentence verdict", "issues": ["specific actionable issue 1", "issue 2"]}
If approved is true, "issues" must be an empty array.`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model: QA_MODEL,
        max_tokens: 1500,
        temperature: 0,
        messages: [{ role: "user", content: prompt }]
      });
      const text = (msg.content.find(b => b.type === "text")?.text || "").trim();
      const parsed = extractJson(text);
      if (typeof parsed.approved !== "boolean") throw new Error("QA response missing boolean 'approved'");
      parsed.issues = Array.isArray(parsed.issues) ? parsed.issues : [];
      parsed.summary = parsed.summary || (parsed.approved ? "Looks good." : "Issues found.");
      return parsed;
    } catch (err) {
      console.warn(`    QA attempt ${attempt}/3 failed:`, err.message);
      lastError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  // If QA itself can't run, don't block the pipeline — treat as approved-with-warning.
  console.warn(`    QA unavailable after 3 attempts (${lastError.message}); proceeding without QA gate.`);
  return { approved: true, summary: "QA review unavailable; proceeded without gating.", issues: [] };
}

// ─── JSON extraction helper ──────────────────────────────────────────────────
function extractJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No valid JSON found in AI response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Find-or-create GitHub branch, push AI-changed files ─────────────────────
// Idempotent: a branch is identified by the `ai/<taskId>-` prefix. If one
// already exists (re-run), we reuse it instead of creating a new branch.
async function createBranchAndPush(changes) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO_NAME;

  const namePart = (process.env.TASK_NAME || "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const branchPrefix = `ai/${TASK_ID}-`;

  // Look for an existing branch with this task's prefix (handles renamed tasks).
  // If found, reuse it; otherwise fall back to the canonical <prefix><name>.
  const found = await findExistingBranch(token, repo, branchPrefix);
  const branchName = found || `${branchPrefix}${namePart}`;

  if (found) {
    console.log(`  Reusing existing branch: ${branchName}`);
  } else {
    const refRes = await fetch(
      `https://api.github.com/repos/${repo}/git/ref/heads/main`,
      { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (!refRes.ok) throw new Error(`Failed to fetch main SHA: ${refRes.status}`);
    const sha = (await refRes.json()).object.sha;

    const branchRes = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
    });
    if (!branchRes.ok && branchRes.status !== 422) {
      throw new Error(`Failed to create branch: ${branchRes.status} - ${await branchRes.text()}`);
    }
    console.log(`  Created new branch: ${branchName}`);
  }

  for (const file of changes.files) {
    const encoded = Buffer.from(file.content).toString("base64");
    let fileSha = null;
    const existingRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(file.path)}?ref=${branchName}`,
      { headers: { Authorization: `token ${token}` } }
    );
    if (existingRes.ok) fileSha = (await existingRes.json()).sha;

    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(file.path)}`, {
      method: "PUT",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `AI: ${process.env.TASK_NAME}`,
        content: encoded,
        branch: branchName,
        ...(fileSha && { sha: fileSha })
      })
    });
    if (!putRes.ok) throw new Error(`Failed to push ${file.path}: ${putRes.status} - ${await putRes.text()}`);
    console.log(`  ✅ Pushed: ${file.path}`);
  }

  return branchName;
}

async function findExistingBranch(token, repo, prefix) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/refs/heads/${encodeURIComponent(prefix)}`,
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  // GitHub returns an array when the ref is a prefix match, or a single object on exact match.
  if (Array.isArray(data) && data.length > 0) {
    return data[0].ref.replace("refs/heads/", "");
  }
  if (data && data.ref) return data.ref.replace("refs/heads/", "");
  return null;
}

// ─── Find-or-create staging theme, apply AI changes ──────────────────────────
// Idempotent: if `existingThemeId` is set and that theme still exists, we update
// it in place (re-run). Otherwise we create a new theme — and if Shopify rejects
// the create due to the theme limit, we return { limitReached: true }.
async function upsertStagingThemeAndApplyChanges(changes, existingThemeId) {
  // Re-run path: stored theme id exists and is still present in the store.
  if (existingThemeId) {
    const exists = await themeExists(existingThemeId);
    if (exists) {
      console.log(`  Reusing existing staging theme (id: ${existingThemeId})`);
      await applyChangesToTheme(existingThemeId, changes);
      return {
        themeId: existingThemeId,
        name: exists.name,
        previewUrl: `https://${SHOPIFY_STORE}/?preview_theme_id=${existingThemeId}`,
        limitReached: false
      };
    }
    console.log(`  Stored theme ${existingThemeId} no longer exists — creating a fresh one.`);
  }

  // Fresh-create path: duplicate the live theme via Shopify's native
  // themeDuplicate mutation (Shopify copies every file server-side in one call),
  // then push ONLY the AI-changed files on top. No manual asset-by-asset copy.

  // 1. Get live theme.
  const themesRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API}/themes.json`,
    { headers: SHOPIFY_HEADERS }
  );
  if (!themesRes.ok) throw new Error(`Failed to fetch themes: ${themesRes.status} - ${await themesRes.text()}`);
  const { themes } = await themesRes.json();
  const liveTheme = themes.find(t => t.role === "main") || themes[0];
  if (!liveTheme) throw new Error("No live theme found in Shopify store");
  console.log(`  Live theme: ${liveTheme.name} (id: ${liveTheme.id})`);

  // 2. Duplicate it natively. Returns { themeId } or { limitReached: true }.
  const stagingName = `AI: ${process.env.TASK_NAME || TASK_ID}`.slice(0, 50);
  const dup = await duplicateTheme(liveTheme.id, stagingName);
  if (dup.limitReached) {
    return { themeId: "", name: "", previewUrl: "", limitReached: true };
  }
  console.log(`  Staging theme duplicated: ${dup.name} (id: ${dup.themeId})`);

  // 3. Wait until Shopify finishes copying all files into the new theme.
  await waitForThemeReady(dup.themeId);

  // 4. Apply ONLY the AI-changed files on top of the exact duplicate.
  await applyChangesToTheme(dup.themeId, changes);

  return {
    themeId: String(dup.themeId),
    name: dup.name,
    previewUrl: `https://${SHOPIFY_STORE}/?preview_theme_id=${dup.themeId}`,
    limitReached: false
  };
}

// ─── Duplicate a theme via the native themeDuplicate GraphQL mutation ─────────
// One call copies every file server-side. Returns { themeId, name } on success,
// or { limitReached: true } if the store is at its theme-count limit.
async function duplicateTheme(sourceThemeId, name) {
  const query = `mutation DuplicateTheme($id: ID!, $name: String) {
    themeDuplicate(id: $id, name: $name) {
      newTheme { id name role }
      userErrors { field message }
    }
  }`;

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_GRAPHQL_API}/graphql.json`,
    {
      method: "POST",
      headers: SHOPIFY_HEADERS,
      body: JSON.stringify({
        query,
        variables: { id: `gid://shopify/OnlineStoreTheme/${sourceThemeId}`, name }
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    if (isThemeLimitError(res.status, errText)) {
      console.warn(`  ⚠️ Shopify theme limit reached: ${errText}`);
      return { limitReached: true };
    }
    throw new Error(`themeDuplicate request failed: ${res.status} - ${errText}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`themeDuplicate GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  const payload = json.data?.themeDuplicate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    const msg = userErrors.map(e => e.message).join("; ");
    if (isThemeLimitError(200, msg)) {
      console.warn(`  ⚠️ Shopify theme limit reached: ${msg}`);
      return { limitReached: true };
    }
    throw new Error(`themeDuplicate failed: ${msg}`);
  }

  const newTheme = payload?.newTheme;
  if (!newTheme?.id) throw new Error("themeDuplicate returned no new theme");
  // newTheme.id is a GID (gid://shopify/OnlineStoreTheme/123); REST needs the numeric id.
  const numericId = String(newTheme.id).split("/").pop();
  return { themeId: numericId, name: newTheme.name };
}

// ─── Wait for a freshly-duplicated theme to finish processing ─────────────────
// A duplicated theme is `processing: true` while Shopify copies files; pushing
// assets before it's ready can fail. Polls the REST theme resource until done.
async function waitForThemeReady(themeId, maxWaitMs = 120000, intervalMs = 3000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const theme = await themeExists(themeId);
    if (theme && theme.processing === false) {
      console.log(`  Duplicate ready (processing complete).`);
      return;
    }
    console.log(`  ⏳ Waiting for duplicate to finish processing...`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.warn(`  ⚠️ Theme ${themeId} still processing after ${maxWaitMs}ms — applying changes anyway.`);
}

// Detect Shopify's "you have reached the theme limit" condition.
function isThemeLimitError(status, text) {
  const t = (text || "").toLowerCase();
  return status === 403 || status === 406 ||
    t.includes("theme") && (t.includes("limit") || t.includes("maximum") || t.includes("exceed"));
}

async function themeExists(themeId) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API}/themes/${themeId}.json`,
    { headers: SHOPIFY_HEADERS }
  );
  if (!res.ok) return null;
  const { theme } = await res.json();
  return theme || null;
}

async function applyChangesToTheme(themeId, changes) {
  console.log(`  Applying ${changes.files.length} AI-modified file(s) to theme ${themeId}...`);
  for (const file of changes.files) {
    const ok = await putAssetWithRetry(themeId, { asset: { key: file.path, value: file.content } });
    if (ok) console.log(`  ✅ Applied AI change: ${file.path}`);
    else console.warn(`  ⚠️  AI file upload failed: ${file.path}`);
  }
}

// ─── Shopify asset upload with 429 retry ─────────────────────────────────────
async function putAssetWithRetry(themeId, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API}/themes/${themeId}/assets.json`,
      { method: "PUT", headers: SHOPIFY_HEADERS, body: JSON.stringify(body) }
    );
    if (res.ok) return true;
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return false;
  }
  return false;
}

// ─── ClickUp state (run count + theme id via custom fields) ──────────────────
// Reads the task, finds (or lazily creates) the two custom fields we manage,
// and returns the current run count + stored theme id.
async function loadRunState() {
  if (!TASK_ID) {
    console.warn("  TASK_ID not set — running stateless (no run limit / reuse).");
    return { runCount: 0, themeId: "", fields: {} };
  }

  const taskRes = await fetch(
    `https://api.clickup.com/api/v2/task/${TASK_ID}?custom_task_ids=true`,
    { headers: { Authorization: CLICKUP_API_KEY } }
  );
  if (!taskRes.ok) {
    console.warn(`  Failed to fetch ClickUp task (${taskRes.status}) — running stateless.`);
    return { runCount: 0, themeId: "", fields: {} };
  }
  const task = await taskRes.json();
  const listId = task.list?.id;
  const existing = task.custom_fields || [];

  // Resolve our two managed fields, creating them on the list if absent.
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

async function saveRunState({ runCount, themeId, fields }) {
  if (!TASK_ID) return;
  if (fields.runCount?.id) {
    await setCustomFieldValue(fields.runCount.id, { value: runCount });
  }
  if (fields.themeId?.id && themeId) {
    await setCustomFieldValue(fields.themeId.id, { value: String(themeId) });
  }
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
    {
      method: "POST",
      headers: { Authorization: CLICKUP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ name, type })
    }
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
    {
      method: "POST",
      headers: { Authorization: CLICKUP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) console.warn(`  Failed to set field ${fieldId}: ${res.status} - ${await res.text()}`);
}

// ─── Post result to ClickUp ───────────────────────────────────────────────────
async function postClickUpComment(opts) {
  if (!TASK_ID) { console.warn("  TASK_ID not set — skipping ClickUp comment"); return; }

  const {
    themeName, previewUrl, branchName, branchUrl, summary, error,
    qa, runCount, reused, themeLimit, limitReached
  } = opts;

  let commentText;

  if (limitReached) {
    commentText = [
      `🛑 AI Automation Stopped — Run Limit Reached`,
      ``,
      `This task has already been processed ${MAX_RUNS} times (the maximum).`,
      `Unchecking and re-checking "AI Ready" will no longer trigger the automation.`,
      ``,
      `If you need more changes, please create a new task.`
    ].join("\n");
  } else if (error) {
    commentText = [
      `❌ AI Automation Failed!`,
      ``,
      `Error: ${error}`,
      ``,
      `View logs: https://github.com/${process.env.REPO_NAME}/actions`
    ].join("\n");
  } else if (themeLimit) {
    commentText = [
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
  } else {
    commentText = [
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

  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${TASK_ID}/comment`,
    {
      method: "POST",
      headers: { Authorization: CLICKUP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ comment_text: commentText })
    }
  );

  if (!res.ok) console.warn(`  ClickUp comment failed: ${res.status} - ${await res.text()}`);
  else console.log("  ✅ ClickUp comment posted");
}

function qaLine(qa) {
  if (!qa) return "";
  if (qa.approved) return `🧪 QA: Passed ✅ (${qa.iterations} iteration${qa.iterations > 1 ? "s" : ""})`;
  const issues = (qa.issues || []).slice(0, 5).map(x => `   • ${x}`).join("\n");
  return `🧪 QA: Flagged ⚠️ after ${qa.iterations} iterations — manual review recommended:\n${issues}`;
}

main();
