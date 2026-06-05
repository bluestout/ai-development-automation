const fetch = require("node-fetch");

async function main() {
  const taskId = process.env.TASK_ID;
  if (!taskId) { console.warn("TASK_ID not set — skipping ClickUp comment"); return; }

  const store = (process.env.SHOPIFY_STORE || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const themeId = process.env.THEME_ID;
  const branchName = process.env.BRANCH_NAME;
  const themeName = process.env.THEME_NAME;
  const summary = process.env.TASK_SUMMARY;

  let commentText;

  if (!themeId) {
    // Shopify push step failed — post error
    commentText = [
      `❌ AI Automation Failed!`,
      ``,
      `The AI branch was created but Shopify theme push failed.`,
      ``,
      `🌿 Branch: ${branchName}`,
      ``,
      `View logs: https://github.com/${process.env.REPO_NAME}/actions`
    ].join("\n");
  } else {
    commentText = [
      `✅ AI Staging Theme Ready!`,
      ``,
      `🎨 Theme: ${themeName}`,
      `🔗 Preview: https://${store}/?preview_theme_id=${themeId}`,
      `🌿 Branch: ${branchName}`,
      `📝 Changes: ${summary || "AI applied changes based on the task description"}`,
      ``,
      `Please review and approve before pushing to production.`
    ].join("\n");
  }

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
