// ─── Shared config: server-level env + constants ─────────────────────────────
// On Railway this is a long-running multi-client server, so ONLY true
// server-wide values live here. Per-task values (store, repo, task name, the
// Shopify token for that store) travel in a `ctx` object built per request —
// see src/pipeline.js. This is the key difference from the GitHub Actions
// version, where every value came from process.env at module load.

// ── Agent ── SDK reads ANTHROPIC_API_KEY from env.
const AGENT_MODEL = "claude-opus-4-8";
const MAX_AGENT_TURNS = 30; // runaway safeguard on the agent loop

// ── Figma ── file-read PAT; when set, the Figma MCP server is attached.
const FIGMA_TOKEN = process.env.FIGMA_TOKEN;

// ── Shopify ──
const SHOPIFY_API = "2024-01";
// themeDuplicate mutation only exists on newer API versions; keep REST on the
// pinned version above and use this one only for the GraphQL duplicate call.
const SHOPIFY_GRAPHQL_API = "2026-04";

// Per-store Admin tokens. Stores are NOT all in one Partner org, so we map
// store domain → token. The "Shopify Store" ClickUp field selects the token.
function parseShopifyTokens() {
  const raw = process.env.SHOPIFY_TOKENS;
  if (!raw) return {};
  try {
    const map = JSON.parse(raw);
    // Normalize keys the same way we normalize a store domain (strip scheme/slash).
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      out[normalizeStore(k)] = v;
    }
    return out;
  } catch (e) {
    console.error("⚠️ SHOPIFY_TOKENS is not valid JSON — no store tokens loaded.", e.message);
    return {};
  }
}

const normalizeStore = (s) =>
  (s || "").replace(/^https?:\/\//, "").replace(/\/$/, "").trim();

const SHOPIFY_TOKENS = parseShopifyTokens();

function shopifyTokenFor(store) {
  return SHOPIFY_TOKENS[normalizeStore(store)] || null;
}

const shopifyHeaders = (token) => ({
  "X-Shopify-Access-Token": token,
  "Content-Type": "application/json"
});

// ── ClickUp ──
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const CLICKUP_WEBHOOK_SECRET = process.env.CLICKUP_WEBHOOK_SECRET;
const FIELD_RUN_COUNT = "AI Run Count";
const FIELD_THEME_ID = "AI Theme ID";
// The "AI Ready" trigger checkbox field id (see clickup-ai-fields memory).
const FIELD_AI_READY_ID = "8db48fc3-1471-4c65-8790-0eae54ef7c4a";

// ── GitHub ── single PAT with access to ALL client repos.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ── Filesystem ── where persistent per-client clones live (Railway volume).
const VOLUME_DIR = process.env.VOLUME_DIR || "/data/repos";

const MAX_RUNS = 3; // max re-triggers of the "AI Ready" checkbox per task

// slugify drives both the branch name and staging theme name so they stay in sync.
const slugify = (name) =>
  (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

module.exports = {
  AGENT_MODEL,
  MAX_AGENT_TURNS,
  FIGMA_TOKEN,
  SHOPIFY_API,
  SHOPIFY_GRAPHQL_API,
  shopifyTokenFor,
  shopifyHeaders,
  normalizeStore,
  CLICKUP_API_KEY,
  CLICKUP_WEBHOOK_SECRET,
  FIELD_RUN_COUNT,
  FIELD_THEME_ID,
  FIELD_AI_READY_ID,
  GITHUB_TOKEN,
  VOLUME_DIR,
  MAX_RUNS,
  slugify
};
