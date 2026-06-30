// ─── Railway app entry point ──────────────────────────────────────────────────
// Replaces Zapier + GitHub Actions. ClickUp posts a webhook here when a task
// changes; we verify the signature, detect the "AI Ready" checkbox being checked,
// enqueue the task, and return 200 fast (ClickUp needs a quick 2xx). The heavy
// agent run happens in the background via the per-client queue.

const crypto = require("crypto");
const express = require("express");
const { CLICKUP_WEBHOOK_SECRET, FIELD_AI_READY_ID } = require("./lib/config");
const { enqueueTask } = require("./queue");

const app = express();
const PORT = process.env.PORT || 3000;

// We need the RAW body to verify the HMAC signature, so capture it on parse.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ─── Healthcheck (Railway) ────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/", (_req, res) => res.status(200).send("AI Development Automation — alive"));

// ─── ClickUp webhook ──────────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  // 1. Verify X-Signature = HMAC-SHA256(rawBody, secret). Constant-time compare.
  if (!verifySignature(req)) {
    console.warn("⚠️ Webhook rejected: bad or missing signature.");
    return res.status(401).json({ error: "invalid signature" });
  }

  const body = req.body || {};
  const taskId = body.task_id;

  // 2. Only act when the "AI Ready" checkbox was just checked (false → true).
  //    Our own field writes (run count / theme id) won't match → no loops.
  if (!isAiReadyChecked(body)) {
    return res.status(200).json({ ignored: true });
  }
  if (!taskId) {
    return res.status(200).json({ ignored: true, reason: "no task_id" });
  }

  // 3. Enqueue + return immediately. Do not await the run.
  console.log(`📨 Webhook: AI Ready checked on task ${taskId} — enqueuing.`);
  enqueueTask(taskId).catch((e) => console.error("enqueue error:", e.message));

  return res.status(200).json({ queued: true, taskId });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function verifySignature(req) {
  if (!CLICKUP_WEBHOOK_SECRET) {
    console.warn("⚠️ CLICKUP_WEBHOOK_SECRET not set — cannot verify webhook. Rejecting.");
    return false;
  }
  const sig = req.get("X-Signature");
  if (!sig || !req.rawBody) return false;

  const expected = crypto
    .createHmac("sha256", CLICKUP_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  // timingSafeEqual throws if lengths differ — guard first.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// True when a history_items entry shows the AI Ready custom field flipping to
// checked. ClickUp encodes checkbox state as "true"/"false" strings (or bools).
function isAiReadyChecked(body) {
  const items = body.history_items || [];
  return items.some((it) => {
    const fieldId = it.field === "custom_field" ? it.custom_field?.id : it.field;
    if (fieldId !== FIELD_AI_READY_ID && it.custom_field?.id !== FIELD_AI_READY_ID) return false;
    return isChecked(it.after) && !isChecked(it.before);
  });
}

const isChecked = (v) => v === true || v === "true" || v === 1 || v === "1";

app.listen(PORT, () => {
  console.log(`✅ AI Development Automation app listening on :${PORT}`);
  if (!CLICKUP_WEBHOOK_SECRET) console.warn("⚠️ CLICKUP_WEBHOOK_SECRET is unset — webhooks will be rejected.");
});
