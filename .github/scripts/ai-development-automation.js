const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function main() {
  console.log("🚀 AI Deploy started...");
  console.log("Task:", process.env.TASK_NAME);
  console.log("Description:", process.env.TASK_DESCRIPTION);

  try {
    console.log("📁 Fetching theme files...");
    const themeFiles = await fetchThemeFiles();
    console.log(`Found ${Object.keys(themeFiles).length} theme files`);

    console.log("🤖 Generating AI changes...");
    const changes = await generateWithGroq(themeFiles);
    console.log("Files to update:", changes.files.map(f => f.path));

    console.log("🌿 Creating branch and pushing changes...");
    const branchName = await createBranchAndPush(changes);
    console.log("Branch created:", branchName);

    console.log("🛍️ Creating staging theme...");
    const theme = await createStagingTheme(branchName, changes);
    console.log("Staging theme created:", theme.name);

    console.log("💬 Commenting on ClickUp...");
    await commentOnClickUp(theme, branchName, changes.summary);

    console.log("✅ Done!");
  } catch (err) {
    console.error("❌ Error:", err.message);
    console.error(err.stack);
    await commentOnClickUp({ error: true, message: err.message }, "").catch(() => {});
    process.exit(1);
  }
}

async function fetchThemeFiles() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO_NAME;

  const treeRes = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`,
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
  );

  if (!treeRes.ok) {
    const err = await treeRes.text();
    throw new Error(`GitHub tree fetch failed: ${treeRes.status} - ${err}`);
  }

  const treeData = await treeRes.json();

  // Task description ke keywords se relevant files identify karo
  const taskDesc = (process.env.TASK_DESCRIPTION || "").toLowerCase();
  const taskName = (process.env.TASK_NAME || "").toLowerCase();
  const taskText = taskName + " " + taskDesc;

  // Priority order: task-relevant files pehle, phir important theme files
  const allLiquidFiles = treeData.tree.filter(f => f.type === "blob" && f.path.endsWith(".liquid"));

  const relevantFiles = allLiquidFiles.filter(f => {
    const name = f.path.toLowerCase();
    if (taskText.includes("header") && name.includes("header")) return true;
    if (taskText.includes("footer") && name.includes("footer")) return true;
    if (taskText.includes("hero") && name.includes("hero")) return true;
    if (taskText.includes("banner") && (name.includes("banner") || name.includes("hero"))) return true;
    if (taskText.includes("product") && name.includes("product")) return true;
    if (taskText.includes("collection") && name.includes("collection")) return true;
    if (taskText.includes("cart") && name.includes("cart")) return true;
    if (taskText.includes("homepage") || taskText.includes("home")) {
      if (name.includes("index") || name.includes("home") || name.includes("hero") || name.includes("banner")) return true;
    }
    return false;
  });

  // Agar relevant files nahi mile, default important files lo
  const filesToFetch = relevantFiles.length > 0
    ? relevantFiles.slice(0, 4)
    : allLiquidFiles.filter(f =>
        f.path.includes("sections/") && (
          f.path.includes("header") ||
          f.path.includes("hero") ||
          f.path.includes("banner") ||
          f.path.includes("footer")
        )
      ).slice(0, 4);

  console.log("Fetching files:", filesToFetch.map(f => f.path));

  const files = {};
  for (const file of filesToFetch) {
    const contentRes = await fetch(file.url, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" }
    });
    if (!contentRes.ok) continue;
    const contentData = await contentRes.json();
    const fullContent = Buffer.from(contentData.content, "base64").toString("utf-8");
    // Token limit ke liye 3000 chars max per file
    files[file.path] = fullContent.slice(0, 3000);
  }

  return files;
}

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
3. Include the complete file content (not just the changed part)
4. If a file doesn't need changes, don't include it

REQUIRED JSON FORMAT:
{"files":[{"path":"sections/header.liquid","content":"...complete file content..."}],"summary":"One sentence describing what was changed"}`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are a Shopify theme developer. Always respond with valid JSON only. Never include markdown code blocks or explanations."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 4000,
        temperature: 0.1,
      });

      const text = completion.choices[0].message.content.trim();
      console.log("Groq raw response (first 200 chars):", text.slice(0, 200));

      // JSON extract — markdown blocks bhi handle karo
      const cleaned = text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Valid JSON nahi mila Groq response mein");

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.files || !Array.isArray(parsed.files)) {
        throw new Error("JSON mein 'files' array nahi hai");
      }

      return parsed;
    } catch (err) {
      console.warn(`Attempt ${attempt} failed:`, err.message);
      lastError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw new Error(`Groq 3 attempts ke baad bhi fail: ${lastError.message}`);
}

async function createBranchAndPush(changes) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO_NAME;
  const taskId = process.env.TASK_ID;

  // Task name se branch name banao — lowercase, spaces ko hyphens
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

  if (!refRes.ok) {
    throw new Error(`Main branch SHA fetch failed: ${refRes.status}`);
  }

  const refData = await refRes.json();
  const sha = refData.object.sha;

  // Branch banao — already exist kare to skip
  const createBranchRes = await fetch(
    `https://api.github.com/repos/${repo}/git/refs`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json"
      },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
    }
  );

  if (!createBranchRes.ok && createBranchRes.status !== 422) {
    const err = await createBranchRes.text();
    throw new Error(`Branch create failed: ${createBranchRes.status} - ${err}`);
  }

  // Files push karo
  for (const file of changes.files) {
    const encoded = Buffer.from(file.content).toString("base64");

    // Existing file ka SHA lo (update ke liye zaroori)
    let fileSha = null;
    const existingRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branchName}`,
      { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (existingRes.ok) {
      const existingData = await existingRes.json();
      fileSha = existingData.sha;
    }

    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${file.path}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github.v3+json"
        },
        body: JSON.stringify({
          message: `AI: ${process.env.TASK_NAME}`,
          content: encoded,
          branch: branchName,
          ...(fileSha && { sha: fileSha })
        })
      }
    );

    if (!putRes.ok) {
      const err = await putRes.text();
      throw new Error(`File push failed for ${file.path}: ${putRes.status} - ${err}`);
    }

    console.log(`✅ Pushed: ${file.path}`);
  }

  return branchName;
}

async function createStagingTheme(branchName, changes) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;
  const taskId = process.env.TASK_ID;

  // Existing themes fetch karo
  const themesRes = await fetch(
    `https://${store}/admin/api/2024-01/themes.json`,
    { headers: { "X-Shopify-Access-Token": token } }
  );

  if (!themesRes.ok) {
    const err = await themesRes.text();
    throw new Error(`Shopify themes fetch failed: ${themesRes.status} - ${err}`);
  }

  const { themes } = await themesRes.json();
  if (!themes || themes.length === 0) {
    throw new Error("Shopify store mein koi theme nahi mili");
  }

  // Main/live theme dhundo, warna pehli theme use karo
  const liveTheme = themes.find(t => t.role === "main") || themes[0];
  console.log("Live theme:", liveTheme.name, "(id:", liveTheme.id + ")");

  // Staging theme banao — blank (Shopify direct duplication API support nahi karta)
  const stagingName = `AI: ${process.env.TASK_NAME || taskId}`.slice(0, 50);

  const newThemeRes = await fetch(
    `https://${store}/admin/api/2024-01/themes.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        theme: {
          name: stagingName,
          role: "unpublished"
        }
      })
    }
  );

  if (!newThemeRes.ok) {
    const err = await newThemeRes.text();
    throw new Error(`Staging theme create failed: ${newThemeRes.status} - ${err}`);
  }

  const { theme: newTheme } = await newThemeRes.json();
  if (!newTheme || !newTheme.id) {
    throw new Error("Shopify ne theme create nahi ki — response mein id nahi");
  }

  // Theme files ko staging theme mein upload karo (AI ke changes)
  console.log(`Uploading ${changes.files.length} changed files to staging theme...`);

  // Shopify theme processing ka intezaar karo
  await new Promise(r => setTimeout(r, 3000));

  for (const file of changes.files) {
    // Shopify theme asset key format: "sections/header.liquid"
    const assetKey = file.path;

    const assetRes = await fetch(
      `https://${store}/admin/api/2024-01/themes/${newTheme.id}/assets.json`,
      {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          asset: {
            key: assetKey,
            value: file.content
          }
        })
      }
    );

    if (!assetRes.ok) {
      const err = await assetRes.text();
      console.warn(`Asset upload failed for ${assetKey}: ${assetRes.status} - ${err}`);
      // Fatal nahi — baaki files continue karein
    } else {
      console.log(`✅ Asset uploaded: ${assetKey}`);
    }
  }

  return {
    id: newTheme.id,
    name: newTheme.name,
    previewUrl: `https://${store}/?preview_theme_id=${newTheme.id}`
  };
}

async function commentOnClickUp(theme, branchName, summary) {
  const taskId = process.env.TASK_ID;
  const apiKey = process.env.CLICKUP_API_KEY;

  if (!taskId) {
    console.warn("TASK_ID nahi hai — ClickUp comment skip");
    return;
  }

  let commentText;
  if (theme.error) {
    commentText = `❌ AI Automation Failed!\n\nError: ${theme.message}\n\nGitHub Actions logs check karein:\nhttps://github.com/${process.env.REPO_NAME}/actions`;
  } else {
    commentText = [
      `✅ AI Staging Theme Ready!`,
      ``,
      `🎨 Theme: ${theme.name}`,
      `🔗 Preview: ${theme.previewUrl}`,
      `🌿 Branch: ${branchName}`,
      `📝 Changes: ${summary || "AI ne task description ke mutabiq changes apply kiye"}`,
      ``,
      `Please review karein aur approve karein live karne se pehle.`
    ].join("\n");
  }

  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}/comment`,
    {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ comment_text: commentText })
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.warn(`ClickUp comment failed: ${res.status} - ${err}`);
  } else {
    console.log("✅ ClickUp comment posted");
  }
}

main();
