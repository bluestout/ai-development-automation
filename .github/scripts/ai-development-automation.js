const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function main() {
    console.log("🚀 AI Deploy started...");
    console.log("Task:", process.env.TASK_NAME);

    try {
        // 1. Theme files fetch karo
        console.log("📁 Fetching theme files...");
        const themeFiles = await fetchThemeFiles();

        // 2. Gemini se changes generate karo
        console.log("🤖 Generating AI changes...");
        const changes = await generateWithGrok(themeFiles);

        // 3. Branch banao aur push karo
        console.log("🌿 Creating branch...");
        const branchName = await createBranchAndPush(changes);

        // 4. Shopify staging theme banao
        console.log("🛍️ Creating staging theme...");
        const theme = await createStagingTheme(branchName);

        // 5. ClickUp mein comment karo
        console.log("💬 Commenting on ClickUp...");
        await commentOnClickUp(theme, branchName);

        console.log("✅ Done!");

    } catch (err) {
        console.error("❌ Error:", err.message);
        await commentOnClickUp({
            error: true,
            message: err.message
        }, "");
        process.exit(1);
    }
}

async function fetchThemeFiles() {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.REPO_NAME;
    const res = await fetch(
        `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`,
        { headers: { Authorization: `token ${token}` } }
    );

    const data = await res.json();
    const liquidFiles = data.tree
        .filter(f => f.path.endsWith(".liquid") && f.type === "blob")
        .slice(0, 5);

    const files = {};
    for (const file of liquidFiles) {
        const contentRes = await fetch(file.url, {
            headers: { Authorization: `token ${token}` }
        });
        const contentData = await contentRes.json();
        files[file.path] = Buffer.from(contentData.content, "base64").toString("utf-8");
    }

    return files;
}

// ─── Groq AI Code Generation ──────────────────────────
async function generateWithGrok(themeFiles) {
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "user",
        content: `
            You are a Shopify theme developer.

            Task Name: ${process.env.TASK_NAME}
            Task Description: ${process.env.TASK_DESCRIPTION}

            Current theme files:
            ${Object.entries(themeFiles).map(([path, content]) => `--- ${path} ---\n${content}`).join("\n\n")}

            Instructions:
                - Make ONLY the changes described in the task
                - Do NOT change anything else
                - Return ONLY valid JSON, no explanation, no markdown

            Response format:
                {
                    "files": [
                      {
                        "path": "sections/header.liquid",
                        "content": "...full updated file content..."
                      }
                    ],
                    "summary": "Brief description of what was changed"
                }
            `
      }
    ],
    max_tokens: 4000,
  });

  const text = completion.choices[0].message.content;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Groq ne valid JSON return nahi kiya");
  return JSON.parse(jsonMatch[0]);
}

// ─── Create Branch and Push Changes ──────────────────────
async function createBranchAndPush(changes) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.REPO_NAME;
    const taskId = process.env.TASK_ID;
    const branchName = `ai-task-${taskId}-${Date.now()}`;

    const refRes = await fetch(
        `https://api.github.com/repos/${repo}/git/ref/heads/main`,
        { headers: { Authorization: `token ${token}` } }
    );
    const refData = await refRes.json();
    const sha = refData.object.sha;

    await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
        method: "POST",
        headers: {
            Authorization: `token ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            ref: `refs/heads/${branchName}`,
            sha
        })
    });

    for (const file of changes.files) {
        const encoded = Buffer.from(file.content).toString("base64");
        let fileSha = null;
        const existingRes = await fetch(
            `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${branchName}`,
            { headers: { Authorization: `token ${token}` } }
        );
        if (existingRes.ok) {
            const existingData = await existingRes.json();
            fileSha = existingData.sha;
        }

        await fetch(
            `https://api.github.com/repos/${repo}/contents/${file.path}`,
            {
                method: "PUT",
                headers: {
                    Authorization: `token ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    message: `AI: ${process.env.TASK_NAME}`,
                    content: encoded,
                    branch: branchName,
                    ...(fileSha && { sha: fileSha })
                })
            }
        );
    }

    return branchName;
}

// ─── Create Shopify Staging Theme ────────────────────────
async function createStagingTheme(branchName) {
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_TOKEN;

    // Live theme ID lo
    const themesRes = await fetch(
        `https://${store}/admin/api/2024-01/themes.json`,
        { headers: { "X-Shopify-Access-Token": token } }
    );
    const { themes } = await themesRes.json();
    const liveTheme = themes.find(t => t.role === "main");

    if (!liveTheme) throw new Error("Live theme nahi mili");

    // Staging theme banao (duplicate)
    const taskId = process.env.TASK_ID;
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
                    name: `AI-Staging-${taskId}`,
                    role: "unpublished"
                }
            })
        }
    );

    const { theme } = await newThemeRes.json();

    return {
        id: theme.id,
        name: theme.name,
        previewUrl: `https://${store}/?preview_theme_id=${theme.id}`
    };
}

// ─── Comment on ClickUp Task ──────────────────────────────
async function commentOnClickUp(theme, branchName) {
    const taskId = process.env.TASK_ID;
    const apiKey = process.env.CLICKUP_API_KEY;
    let commentText = "";
    if (theme.error) {
        commentText = `❌ AI Automation Failed!\n\nError: ${theme.message}\n\nPlease check GitHub Actions logs.`;
    } else {
        commentText = `✅ AI Staging Theme Ready!
        🎨 Theme: ${theme.name}
        🔗 Preview: ${theme.previewUrl}
        🌿 Branch: ${branchName}
        🤖 AI applied the changes — please review.`;
    }

    await fetch(
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
}

main();