// ─── Shared config: env vars, model, limits ──────────────────────────────────

// ── Agent (lib/agent.js) ── SDK reads ANTHROPIC_API_KEY from env.
const AGENT_MODEL = "claude-opus-4-8";
const MAX_AGENT_TURNS = 30; // runaway safeguard on the agent loop

// ── Figma ── file-read PAT; when set, the Figma MCP server is attached.
const FIGMA_TOKEN = process.env.FIGMA_TOKEN;

// ── Shopify ──
const SHOPIFY_STORE = (process.env.SHOPIFY_STORE || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_HEADERS = {
  "X-Shopify-Access-Token": SHOPIFY_TOKEN,
  "Content-Type": "application/json"
};
const SHOPIFY_API = "2024-01";
// themeDuplicate mutation only exists on newer API versions; keep REST on the
// pinned version above and use this one only for the GraphQL duplicate call.
const SHOPIFY_GRAPHQL_API = "2026-04";

// ── ClickUp ── run-state field names we create/manage on the list.
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const TASK_ID = process.env.TASK_ID;
const FIELD_RUN_COUNT = "AI Run Count";
const FIELD_THEME_ID = "AI Theme ID";

// ── GitHub ──
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_NAME = process.env.REPO_NAME;

// ── Task (from the ClickUp → dispatch payload) ──
const TASK_NAME = process.env.TASK_NAME;
const TASK_DESCRIPTION = process.env.TASK_DESCRIPTION;

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
  SHOPIFY_STORE,
  SHOPIFY_HEADERS,
  SHOPIFY_API,
  SHOPIFY_GRAPHQL_API,
  CLICKUP_API_KEY,
  TASK_ID,
  FIELD_RUN_COUNT,
  FIELD_THEME_ID,
  GITHUB_TOKEN,
  REPO_NAME,
  TASK_NAME,
  TASK_DESCRIPTION,
  MAX_RUNS,
  slugify
};
