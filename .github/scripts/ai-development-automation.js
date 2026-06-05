const Groq = require("groq-sdk");
const fetch = require("node-fetch");
const fs = require("fs");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Write value to GitHub Actions output
function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

async function main() {
  console.log("🚀 AI Deployment started");
  console.log("Task:", process.env.TASK_NAME);
  console.log("Description:", process.env.TASK_DESCRIPTION);

  try {
    // STEP 1 — Fetch relevant theme files
    console.log("\n📁 [1/3] Fetching theme files...");
    const themeFiles = await fetchThemeFiles();
    console.log(`Found ${Object.keys(themeFiles).length} relevant files`);

    // STEP 2 — Generate code changes with AI
    console.log("\n🤖 [2/3] Generating AI changes...");
    const changes = await generateWithGroq(themeFiles);
    console.log("Files to update:", changes.files.map(f => f.path));
    console.log("Summary:", changes.summary);

    // Validate AI changes — fail early if nothing was generated
    if (!changes.files || changes.files.length === 0) {
      throw new Error("AI did not generate any changes — please review the task description");
    }
    for (const file of changes.files) {
      if (!file.path || !file.content || file.content.trim().length < 10) {
        throw new Error(`File '${file.path}' has empty or invalid content`);
      }
    }
    console.log("✅ AI changes validated — proceeding");

    // STEP 3 — Create branch and push AI changes
    console.log("\n🌿 [3/3] Creating branch and pushing changes...");
    const branchName = await createBranchAndPush(changes);
    console.log("Branch created:", branchName);

    // Pass branch name and theme name to next workflow steps via GitHub outputs
    const themeName = `AI: ${process.env.TASK_NAME || process.env.TASK_ID}`.slice(0, 50);
    setOutput("branch_name", branchName);
    setOutput("theme_name", themeName);
    setOutput("task_summary", changes.summary || "");

    console.log("\n✅ AI changes pushed — handing off to Shopify CLI step");

  } catch (err) {
    console.error("\n❌ Error:", err.message);
    console.error(err.stack);
    await postClickUpError(err.message).catch(() => {});
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
      console.log("AI response preview:", text.slice(0, 200));

      const cleaned = text
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "")
        .trim();

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No valid JSON found in AI response");

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.files || !Array.isArray(parsed.files)) {
        throw new Error("AI response is missing the 'files' array");
      }

      return parsed;
    } catch (err) {
      console.warn(`Attempt ${attempt}/3 failed:`, err.message);
      lastError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`AI failed after 3 attempts: ${lastError.message}`);
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

  const refRes = await fetch(
    `https://api.github.com/repos/${repo}/git/ref/heads/main`,
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!refRes.ok) throw new Error(`Failed to fetch main branch SHA: ${refRes.status} - ${await refRes.text()}`);
  const sha = (await refRes.json()).object.sha;

  const branchRes = await fetch(
    `https://api.github.com/repos/${repo}/git/refs`,
    {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json" },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
    }
  );
  if (!branchRes.ok && branchRes.status !== 422) {
    throw new Error(`Failed to create branch: ${branchRes.status} - ${await branchRes.text()}`);
  }

  for (const file of changes.files) {
    const encoded = Buffer.from(file.content).toString("base64");

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
    if (!putRes.ok) throw new Error(`Failed to push file (${file.path}): ${putRes.status} - ${await putRes.text()}`);
    console.log(`  ✅ Pushed: ${file.path}`);
  }

  return branchName;
}

// ─── Post error to ClickUp if script fails before workflow handoff ───────────
async function postClickUpError(message) {
  const taskId = process.env.TASK_ID;
  if (!taskId) return;

  const commentText = `❌ AI Automation Failed!\n\nError: ${message}\n\nView logs: https://github.com/${process.env.REPO_NAME}/actions`;

  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}/comment`,
    {
      method: "POST",
      headers: { Authorization: process.env.CLICKUP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ comment_text: commentText })
    }
  );
  if (!res.ok) console.warn(`ClickUp error comment failed: ${res.status}`);
}

main();
