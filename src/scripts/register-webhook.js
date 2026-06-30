// ─── One-off: register the ClickUp webhook ────────────────────────────────────
// Run once after deploying. Points ClickUp at the app's /webhook endpoint for
// taskUpdated events. Prints the webhook `secret` — copy it into the Railway
// service var CLICKUP_WEBHOOK_SECRET.
//
// Usage:
//   CLICKUP_API_KEY=pk_... TEAM_ID=<workspaceId> ENDPOINT=https://<app>.up.railway.app/webhook \
//     node src/scripts/register-webhook.js [SPACE_ID]
//
// TEAM_ID is your ClickUp workspace id. Pass a SPACE_ID arg to scope the webhook
// to one space (recommended for the test space). Omit to scope to the whole team.

const fetch = require("node-fetch");

async function main() {
  const apiKey = process.env.CLICKUP_API_KEY;
  const teamId = process.env.TEAM_ID;
  const endpoint = process.env.ENDPOINT;
  const spaceId = process.argv[2];

  if (!apiKey || !teamId || !endpoint) {
    console.error("Missing env. Required: CLICKUP_API_KEY, TEAM_ID, ENDPOINT");
    process.exit(1);
  }

  const body = {
    endpoint,
    events: ["taskUpdated"],
    ...(spaceId && { space_id: Number(spaceId) })
  };

  const res = await fetch(`https://api.clickup.com/api/v2/team/${teamId}/webhook`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("❌ Failed to create webhook:", res.status, JSON.stringify(data));
    process.exit(1);
  }

  console.log("✅ Webhook created.");
  console.log("   id:    ", data.id || data.webhook?.id);
  console.log("   secret:", data.webhook?.secret || data.secret);
  console.log("\n👉 Set CLICKUP_WEBHOOK_SECRET to the secret above in Railway.");
}

main().catch((e) => { console.error(e); process.exit(1); });
