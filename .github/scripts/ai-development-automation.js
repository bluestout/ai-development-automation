const Groq = require("groq-sdk");
const fetch = require("node-fetch");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function main() {
  console.log("🚀 AI Deploy started...");
  console.log("Task:", process.env.TASK_NAME);
  console.log("Description:", process.env.TASK_DESCRIPTION);

  try {
    // STEP 1 — Theme files fetch karo
    console.log("\n📁 [1/5] Fetching theme files...");
    const themeFiles = await fetchThemeFiles();
    console.log(`Found ${Object.keys(themeFiles).length} relevant files`);

    // STEP 2 — AI se changes generate karo
    console.log("\n🤖 [2/5] Generating AI changes...");
    const changes = await generateWithGroq(themeFiles);
    console.log("Files to update:", changes.files.map(f => f.path));
    console.log("Summary:", changes.summary);

    // AI changes validate karo — koi files nahi to fail karo
    if (!changes.files || changes.files.length === 0) {
      throw new Error("AI ne koi changes generate nahi kiye — task description check karein");
    }

    // Validate karo k har file mein actual content hai
    for (const file of changes.files) {
      if (!file.path || !file.content || file.content.trim().length < 10) {
        throw new Error(`File '${file.path}' ka content empty ya invalid hai`);
      }
    }

    console.log("✅ AI changes validated — aage process ho raha hai");

    // STEP 3 — Branch banao aur changes push karo (sirf AI success ke baad)
    console.log("\n🌿 [3/5] Creating branch and pushing changes...");
    const branchName = await createBranchAndPush(changes);
    console.log("Branch created:", branchName);

    // STEP 4 — Shopify staging theme banao (sirf branch push ke baad)
    console.log("\n🛍️ [4/5] Creating staging theme...");
    const theme = await createStagingTheme(branchName, changes);
    console.log("Staging theme created:", theme.name);
    console.log("Preview URL:", theme.previewUrl);

    // STEP 5 — ClickUp mein success comment karo (sirf sab kuch ready hone ke baad)
    console.log("\n💬 [5/5] Commenting on ClickUp...");
    await commentOnClickUp(theme, branchName, changes.summary);

    console.log("\n✅ All done!");

  } catch (err) {
    console.error("\n❌ Error:", err.message);
    console.error(err.stack);
    // Sirf ClickUp comment karo failure ka — koi branch ya theme nahi
    await commentOnClickUp({ error: true, message: err.message }, "").catch(() => {});
    process.exit(1);
  }
}

// ─── GitHub se relevant theme files fetch karo ──────────────────────────────
async function fetchThemeFiles() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO_NAME;

  const treeRes = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`,
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
  );

  if (!treeRes.ok) {
    throw new Error(`GitHub tree fetch failed: ${treeRes.status} - ${await treeRes.text()}`);
  }

  const treeData = await treeRes.json();
  const taskText = `${process.env.TASK_NAME || ""} ${process.env.TASK_DESCRIPTION || ""}`.toLowerCase();

  const allLiquidFiles = treeData.tree.filter(f => f.type === "blob" && f.path.endsWith(".liquid"));

  // Task keywords se relevant files identify karo
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

  console.log("Fetching:", filesToFetch.map(f => f.path));

  const files = {};
  for (const file of filesToFetch) {
    const res = await fetch(file.url, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" }
    });
    if (!res.ok) continue;
    const data = await res.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    files[file.path] = content.slice(0, 3000);
  }

  return files;
}

// ─── Groq se code changes generate karo ─────────────────────────────────────
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
          {
            role: "system",
            content: "You are a Shopify theme developer. Respond with valid JSON only. No markdown, no code blocks, no explanation. Just raw JSON."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 4000,
        temperature: 0.1,
      });

      const text = completion.choices[0].message.content.trim();
      console.log("Groq response preview:", text.slice(0, 200));

      // Markdown code blocks strip karo agar ho
      const cleaned = text
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "")
        .trim();

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Valid JSON nahi mila response mein");

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.files || !Array.isArray(parsed.files)) {
        throw new Error("Response mein 'files' array nahi hai");
      }

      return parsed;
    } catch (err) {
      console.warn(`Attempt ${attempt}/3 failed:`, err.message);
      lastError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw new Error(`Groq 3 attempts ke baad bhi fail: ${lastError.message}`);
}

// ─── GitHub branch banao aur files push karo ────────────────────────────────
async function createBranchAndPush(changes) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO_NAME;
  const taskId = process.env.TASK_ID;

  const safeName = (process.env.TASK_NAME || taskId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const branchName = `ai/${safeName}`;

  // Main branch ka latest SHA lo
  const refRes = await fetch(
    `https://api.github.com/repos/${repo}/git/ref/heads/main`,
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!refRes.ok) throw new Error(`Main SHA fetch failed: ${refRes.status} - ${await refRes.text()}`);

  const sha = (await refRes.json()).object.sha;

  // Branch create karo (422 = already exists — theek hai)
  const branchRes = await fetch(
    `https://api.github.com/repos/${repo}/git/refs`,
    {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json" },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
    }
  );
  if (!branchRes.ok && branchRes.status !== 422) {
    throw new Error(`Branch create failed: ${branchRes.status} - ${await branchRes.text()}`);
  }

  // Files push karo
  for (const file of changes.files) {
    const encoded = Buffer.from(file.content).toString("base64");

    // Existing file SHA lo (update ke liye zaroori)
    let fileSha = null;
    const existingRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branchName}`,
      { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (existingRes.ok) fileSha = (await existingRes.json()).sha;

    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${file.path}`,
      {
        method: "PUT",
        headers: { Authorization: `token ${token}`, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json" },
        body: JSON.stringify({
          message: `AI: ${process.env.TASK_NAME}`,
          content: encoded,
          branch: branchName,
          ...(fileSha && { sha: fileSha })
        })
      }
    );
    if (!putRes.ok) throw new Error(`File push failed (${file.path}): ${putRes.status} - ${await putRes.text()}`);
    console.log(`  ✅ Pushed: ${file.path}`);
  }

  return branchName;
}

// ─── Shopify mein staging theme banao ───────────────────────────────────────
async function createStagingTheme(branchName, changes) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  // Staging theme banao
  const stagingName = `AI: ${process.env.TASK_NAME || process.env.TASK_ID}`.slice(0, 50);

  const newThemeRes = await fetch(
    `https://${store}/admin/api/2024-01/themes.json`,
    {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ theme: { name: stagingName, role: "unpublished" } })
    }
  );
  if (!newThemeRes.ok) throw new Error(`Staging theme create failed: ${newThemeRes.status} - ${await newThemeRes.text()}`);

  const { theme: newTheme } = await newThemeRes.json();
  if (!newTheme?.id) throw new Error("Shopify response mein theme ID nahi");

  console.log(`  Theme created: ${newTheme.name} (id: ${newTheme.id})`);

  // Shopify ko theme initialize karne ka waqt do
  await new Promise(r => setTimeout(r, 4000));

  // AI ke changed files staging theme mein upload karo
  console.log(`  Uploading ${changes.files.length} files to staging theme...`);
  for (const file of changes.files) {
    const assetRes = await fetch(
      `https://${store}/admin/api/2024-01/themes/${newTheme.id}/assets.json`,
      {
        method: "PUT",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ asset: { key: file.path, value: file.content } })
      }
    );
    if (!assetRes.ok) {
      console.warn(`  ⚠️ Asset upload failed (${file.path}): ${assetRes.status} - ${await assetRes.text()}`);
    } else {
      console.log(`  ✅ Asset uploaded: ${file.path}`);
    }
  }

  return {
    id: newTheme.id,
    name: newTheme.name,
    previewUrl: `https://${store}/?preview_theme_id=${newTheme.id}`
  };
}

// ─── ClickUp task pe comment karo ───────────────────────────────────────────
async function commentOnClickUp(theme, branchName, summary) {
  const taskId = process.env.TASK_ID;
  if (!taskId) { console.warn("TASK_ID nahi — ClickUp comment skip"); return; }

  const commentText = theme.error
    ? `❌ AI Automation Failed!\n\nError: ${theme.message}\n\nLogs: https://github.com/${process.env.REPO_NAME}/actions`
    : [
        `✅ AI Staging Theme Ready!`,
        ``,
        `🎨 Theme: ${theme.name}`,
        `🔗 Preview: ${theme.previewUrl}`,
        `🌿 Branch: ${branchName}`,
        `📝 Changes: ${summary || "AI ne task ke mutabiq changes apply kiye"}`,
        ``,
        `Please review karein aur approve karein live karne se pehle.`
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
