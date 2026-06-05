const Groq = require("groq-sdk");
const fetch = require("node-fetch");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const SHOPIFY_STORE = (process.env.SHOPIFY_STORE || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_HEADERS = {
  "X-Shopify-Access-Token": SHOPIFY_TOKEN,
  "Content-Type": "application/json"
};

async function main() {
  console.log("🚀 AI Deployment started");
  console.log("Task:", process.env.TASK_NAME);
  console.log("Description:", process.env.TASK_DESCRIPTION);

  try {
    // STEP 1 — Fetch relevant theme files from GitHub
    console.log("\n📁 [1/4] Fetching theme files...");
    const themeFiles = await fetchThemeFiles();
    console.log(`Found ${Object.keys(themeFiles).length} relevant files`);

    // STEP 2 — Generate AI changes
    console.log("\n🤖 [2/4] Generating AI changes...");
    const changes = await generateWithGroq(themeFiles);
    console.log("Files to update:", changes.files.map(f => f.path));
    console.log("Summary:", changes.summary);

    if (!changes.files || changes.files.length === 0) {
      throw new Error("AI did not generate any changes — please review the task description");
    }
    for (const file of changes.files) {
      if (!file.path || !file.content || file.content.trim().length < 10) {
        throw new Error(`File '${file.path}' has empty or invalid content`);
      }
    }
    console.log("✅ AI changes validated");

    // STEP 3 — Create GitHub branch and push AI changes
    console.log("\n🌿 [3/4] Creating branch and pushing changes...");
    const branchName = await createBranchAndPush(changes);
    console.log("Branch created:", branchName);

    // STEP 4 — Duplicate live theme via API, then apply AI changes on top
    console.log("\n🛍️ [4/4] Creating staging theme...");
    const theme = await duplicateThemeAndApplyChanges(changes);
    console.log("Staging theme:", theme.name);
    console.log("Preview URL:", theme.previewUrl);

    // Post success to ClickUp
    await postClickUpComment({
      themeName: theme.name,
      previewUrl: theme.previewUrl,
      branchName,
      summary: changes.summary
    });

    console.log("\n✅ Deployment complete!");

  } catch (err) {
    console.error("\n❌ Error:", err.message);
    console.error(err.stack);
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

  console.log("Fetching files:", filesToFetch.map(f => f.path));

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

// ─── Generate code changes with Groq ─────────────────────────────────────────
async function generateWithGroq(themeFiles) {
  const filesContext = Object.entries(themeFiles)
    .map(([path, content]) => `=== FILE: ${path} ===\n${content}\n=== END: ${path} ===`)
    .join("\n\n");

  const prompt = `You are an expert Shopify theme developer. Make ONLY the specific changes described in the task below.

TASK NAME: ${process.env.TASK_NAME}
TASK DESCRIPTION: ${process.env.TASK_DESCRIPTION}

CURRENT THEME FILES:
${filesContext}

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
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "You are a Shopify theme developer. Respond with valid JSON only. No markdown, no code blocks, no explanation." },
          { role: "user", content: prompt }
        ],
        max_tokens: 4000,
        temperature: 0.1,
      });

      const text = completion.choices[0].message.content.trim();
      console.log("AI response preview:", text.slice(0, 200));

      const cleaned = text
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No valid JSON found in AI response");

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.files || !Array.isArray(parsed.files)) throw new Error("AI response missing 'files' array");

      return parsed;
    } catch (err) {
      console.warn(`Attempt ${attempt}/3 failed:`, err.message);
      lastError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`AI failed after 3 attempts: ${lastError.message}`);
}

// ─── Create GitHub branch and push AI-changed files ──────────────────────────
async function createBranchAndPush(changes) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO_NAME;

  const safeName = (process.env.TASK_NAME || process.env.TASK_ID)
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  const branchName = `ai/${safeName}`;

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

  for (const file of changes.files) {
    const encoded = Buffer.from(file.content).toString("base64");
    let fileSha = null;
    const existingRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branchName}`,
      { headers: { Authorization: `token ${token}` } }
    );
    if (existingRes.ok) fileSha = (await existingRes.json()).sha;

    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${file.path}`, {
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

// ─── Duplicate live theme via API, apply AI changes on top ───────────────────
async function duplicateThemeAndApplyChanges(changes) {
  // 1. Get live theme
  const themesRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/themes.json`,
    { headers: SHOPIFY_HEADERS }
  );
  if (!themesRes.ok) throw new Error(`Failed to fetch themes: ${themesRes.status} - ${await themesRes.text()}`);
  const { themes } = await themesRes.json();
  const liveTheme = themes.find(t => t.role === "main") || themes[0];
  if (!liveTheme) throw new Error("No live theme found in Shopify store");
  console.log(`  Live theme: ${liveTheme.name} (id: ${liveTheme.id})`);

  // 2. Get all asset keys from live theme
  const assetsRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/themes/${liveTheme.id}/assets.json`,
    { headers: SHOPIFY_HEADERS }
  );
  if (!assetsRes.ok) throw new Error(`Failed to fetch assets list: ${assetsRes.status}`);
  const { assets } = await assetsRes.json();
  console.log(`  Found ${assets.length} assets in live theme`);

  // 3. Create blank staging theme
  const stagingName = `AI: ${process.env.TASK_NAME || process.env.TASK_ID}`.slice(0, 50);
  const newThemeRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/themes.json`,
    {
      method: "POST",
      headers: SHOPIFY_HEADERS,
      body: JSON.stringify({ theme: { name: stagingName, role: "unpublished" } })
    }
  );
  if (!newThemeRes.ok) throw new Error(`Failed to create staging theme: ${newThemeRes.status} - ${await newThemeRes.text()}`);
  const { theme: stagingTheme } = await newThemeRes.json();
  console.log(`  Staging theme created: ${stagingTheme.name} (id: ${stagingTheme.id})`);

  // 4. Copy all live theme assets to staging — in batches to avoid rate limits
  const aiChangedKeys = new Set(changes.files.map(f => f.path));
  const assetsToCopy = assets.filter(a => !aiChangedKeys.has(a.key));
  console.log(`  Copying ${assetsToCopy.length} assets from live theme...`);

  let copied = 0;
  let failed = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < assetsToCopy.length; i += BATCH_SIZE) {
    const batch = assetsToCopy.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (asset) => {
      // Fetch full content of each asset
      const contentRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-01/themes/${liveTheme.id}/assets.json?asset[key]=${encodeURIComponent(asset.key)}`,
        { headers: SHOPIFY_HEADERS }
      );
      if (!contentRes.ok) { failed++; return; }
      const { asset: fullAsset } = await contentRes.json();
      if (!fullAsset) { failed++; return; }

      // Upload to staging theme
      const body = fullAsset.value !== undefined
        ? { asset: { key: asset.key, value: fullAsset.value } }
        : fullAsset.attachment !== undefined
          ? { asset: { key: asset.key, attachment: fullAsset.attachment } }
          : null;

      if (!body) { failed++; return; }

      const uploadRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-01/themes/${stagingTheme.id}/assets.json`,
        { method: "PUT", headers: SHOPIFY_HEADERS, body: JSON.stringify(body) }
      );
      if (uploadRes.ok) { copied++; }
      else { failed++; console.warn(`  ⚠️  Copy failed: ${asset.key} (${uploadRes.status})`); }
    }));

    // Small delay between batches to respect Shopify rate limits (40 req/s)
    if (i + BATCH_SIZE < assetsToCopy.length) await new Promise(r => setTimeout(r, 300));

    if ((i + BATCH_SIZE) % 50 === 0) {
      console.log(`  Progress: ${Math.min(i + BATCH_SIZE, assetsToCopy.length)}/${assetsToCopy.length} assets`);
    }
  }
  console.log(`  ✅ Copied ${copied} assets (${failed} skipped)`);

  // 5. Apply AI-changed files on top
  console.log(`  Applying ${changes.files.length} AI-modified file(s)...`);
  for (const file of changes.files) {
    const uploadRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/themes/${stagingTheme.id}/assets.json`,
      {
        method: "PUT",
        headers: SHOPIFY_HEADERS,
        body: JSON.stringify({ asset: { key: file.path, value: file.content } })
      }
    );
    if (!uploadRes.ok) {
      console.warn(`  ⚠️  AI file upload failed (${file.path}): ${uploadRes.status} - ${await uploadRes.text()}`);
    } else {
      console.log(`  ✅ Applied AI change: ${file.path}`);
    }
  }

  return {
    id: stagingTheme.id,
    name: stagingTheme.name,
    previewUrl: `https://${SHOPIFY_STORE}/?preview_theme_id=${stagingTheme.id}`
  };
}

// ─── Post result to ClickUp ───────────────────────────────────────────────────
async function postClickUpComment({ themeName, previewUrl, branchName, summary, error }) {
  const taskId = process.env.TASK_ID;
  if (!taskId) { console.warn("TASK_ID not set — skipping ClickUp comment"); return; }

  const commentText = error
    ? `❌ AI Automation Failed!\n\nError: ${error}\n\nView logs: https://github.com/${process.env.REPO_NAME}/actions`
    : [
        `✅ AI Staging Theme Ready!`,
        ``,
        `🎨 Theme: ${themeName}`,
        `🔗 Preview: ${previewUrl}`,
        `🌿 Branch: ${branchName}`,
        `📝 Changes: ${summary || "AI applied changes based on the task description"}`,
        ``,
        `Please review and approve before pushing to production.`
      ].join("\n");

  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}/comment`,
    {
      method: "POST",
      headers: { Authorization: process.env.CLICKUP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ comment_text: commentText })
    }
  );

  if (!res.ok) console.warn(`ClickUp comment failed: ${res.status} - ${await res.text()}`);
  else console.log("✅ ClickUp comment posted");
}

main();
