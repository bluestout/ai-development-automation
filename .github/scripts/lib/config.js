// ─── Shared config ───────────────────────────────────────────────────────────
// Central place for env vars, API clients, model names, and tunable limits.
// Every other module imports what it needs from here.

const Anthropic = require("@anthropic-ai/sdk");

// ── Anthropic ──
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PLANNER_MODEL = "claude-sonnet-4-6"; // decides WHICH files to touch
const DEV_MODEL = "claude-sonnet-4-6";     // writes the theme changes
const QA_MODEL = "claude-sonnet-4-6";      // reviews the changes

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

// ── ClickUp ──
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const TASK_ID = process.env.TASK_ID;
// Custom field names we manage on the ClickUp list.
const FIELD_RUN_COUNT = "AI Run Count";
const FIELD_THEME_ID = "AI Theme ID";

// ── GitHub ──
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_NAME = process.env.REPO_NAME;

// ── Task (from the ClickUp → dispatch payload) ──
const TASK_NAME = process.env.TASK_NAME;
const TASK_DESCRIPTION = process.env.TASK_DESCRIPTION;

// ── Tunable limits ──
const MAX_RUNS = 3;      // user may re-trigger the checkbox at most 3 times
const MAX_QA_LOOPS = 3;  // Dev <-> QA iterations before giving up

module.exports = {
  anthropic,
  PLANNER_MODEL,
  DEV_MODEL,
  QA_MODEL,
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
  MAX_QA_LOOPS
};
