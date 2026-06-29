// ─── Dev AI — Claude Agent SDK driver ────────────────────────────────────────
// The agent runs in the checked-out theme repo with real tools (Read/Edit/Grep)
// plus two live MCP servers: figma (pulls a linked design) and shopify-dev
// (validates its own work). It edits files in place; lib/github.js reads them
// back from the working tree for the unchanged branch/theme/ClickUp deploy path.

const { query } = require("@anthropic-ai/claude-agent-sdk");
const {
  REPO_ROOT, AGENT_MODEL, MAX_AGENT_TURNS, FIGMA_TOKEN,
  TASK_NAME, TASK_DESCRIPTION
} = require("./config");

const FIGMA_URL_RE =
  /https?:\/\/(?:www\.)?figma\.com\/(?:file|design|proto)\/[A-Za-z0-9]+[^\s)]*/i;

function detectFigmaUrl(text) {
  const m = (text || "").match(FIGMA_URL_RE);
  return m ? m[0] : null;
}

// shopify-dev is always attached; figma only when a token exists.
function buildMcpServers() {
  const servers = {
    "shopify-dev": {
      type: "stdio",
      command: "npx",
      args: ["-y", "@shopify/dev-mcp@latest"]
    }
  };

  if (FIGMA_TOKEN) {
    servers.figma = {
      type: "stdio",
      command: "npx",
      args: ["-y", "figma-developer-mcp", "--stdio"],
      env: { FIGMA_API_KEY: FIGMA_TOKEN }
    };
  }

  return servers;
}

// The Figma section is only included when the task links a design.
const FIGMA_BRIEF = (url) => `
## Match the Figma design
This task references a design: ${url}
Before writing any code, read it with the available Figma MCP tools (inspect the
server's tool list and call whatever it exposes for layout, variables/tokens, and
images of the linked file/node). Then reproduce it faithfully: auto-layout →
flex/grid with gap + padding, exact typography, colors mapped to CSS custom
properties (never hard-coded hex), and the real copy.`;

// The agent's whole brief: workflow + Shopify rules + self-validation.
// There is no separate planner/QA step — this prompt is the entire spec.
function buildSystemPrompt(figmaUrl) {
  return `You are an expert Shopify theme developer. You are inside a checked-out theme repo (cwd = theme root). Implement the task by editing files in place with your tools. Touch only the files this task needs.

## Workflow
1. Explore with Glob/Grep/Read before editing — understand the existing section/template.
2. Route the change to the correct file type (below).
3. Make the edit, following the Shopify rules (below).
4. Validate with the shopify-dev MCP and fix until clean (below).

## Content vs structure — edit the RIGHT file
- CONTENT (text, label, link, image, color, toggling/reordering existing blocks): the value lives in JSON, NOT in .liquid markup. Edit templates/*.json (homepage = templates/index.json) or sections/*-group.json (header-group.json / footer-group.json). Change only what the task needs and keep the rest of the JSON byte-for-byte identical and valid. Example: announcement-bar TEXT lives in sections/header-group.json, NOT sections/announcement-bar.liquid.
- STRUCTURE / STYLING / LOGIC (new schema setting or block, layout/markup, CSS/JS, new feature): edit sections/<name>.liquid, snippets/<name>.liquid, and the matching assets/section-<name>.css|.js.
- MIXED: edit BOTH — the .liquid to add the setting, the JSON to set its value.

## Shopify rules
- Schema: every section needs a {% schema %} block with correct setting types, snake_case ids, and presets where appropriate.
- CSS: no hard-coded hex or pixel font sizes — use CSS custom properties. Scope to the section class; no global leakage.
- Images: {{ image | image_url: ... | image_tag: ... }} (CDN) with width/height, loading="lazy" (eager only above-the-fold), and alt text.
- Liquid: escape user content, provide sensible defaults, gate optional blocks with {% if %}.
- JS: vanilla only, deferred. Mobile-first, responsive at Dawn breakpoints (750 / 990 / 1200px).
${figmaUrl ? FIGMA_BRIEF(figmaUrl) : ""}
## Validate your own work (before finishing)
- Run the shopify-dev MCP on the files you created or changed: learn_shopify_api (api 'liquid') for a conversationId, then validate_theme. Fix every reported error and re-validate until clean.
- Unsure about a Liquid object, filter, or schema setting? Look it up with shopify-dev search_docs_chunks — do not guess.

## Finish
End with a ONE-paragraph summary of what you changed and which files. Do NOT run git or push anything — the pipeline handles branching and the staging theme.`;
}

// Returns { summary } — the agent's final text, used in the ClickUp comment.
// The file changes themselves are read from the working tree afterwards.
async function runAgent() {
  const figmaUrl = detectFigmaUrl(`${TASK_NAME}\n${TASK_DESCRIPTION}`);
  if (figmaUrl) {
    if (FIGMA_TOKEN) console.log(`    🎨 Figma design linked (${figmaUrl}) — Figma MCP attached.`);
    else console.warn(`    ⚠️ Figma URL in task but FIGMA_TOKEN not set — agent can't fetch the design.`);
  }

  const prompt = `TASK NAME: ${TASK_NAME}\nTASK DESCRIPTION: ${TASK_DESCRIPTION}\n\nImplement this task in the theme now.`;

  const q = query({
    prompt,
    options: {
      model: AGENT_MODEL,
      cwd: REPO_ROOT,
      systemPrompt: buildSystemPrompt(figmaUrl),
      // bypassPermissions auto-allows every tool, so we only NAME what to block:
      // Bash (and git/CLI through it) — branch/push/deploy stay with the pipeline.
      permissionMode: "bypassPermissions",
      disallowedTools: ["Bash"],
      mcpServers: buildMcpServers(),
      strictMcpConfig: true, // ignore any project .mcp.json — only ours
      settingSources: [],    // no user/project settings
      maxTurns: MAX_AGENT_TURNS,
      stderr: (d) => process.stderr.write(d)
    }
  });

  let summary = "";
  for await (const message of q) {
    if (message.type === "assistant") {
      const text = (message.message.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");
      if (text.trim()) console.log(`    [agent] ${text.trim().slice(0, 500)}`);
    } else if (message.type === "result") {
      summary = (message.result || "").trim();
      if (message.subtype === "success") {
        console.log(`    ✅ Agent done — ${message.num_turns} turns, $${(message.total_cost_usd || 0).toFixed(3)}`);
      } else {
        // Not a hard failure: partial edits may exist; the working-tree check decides.
        console.warn(`    ⚠️ Agent ended with: ${message.subtype}`);
        summary = summary || `Agent stopped: ${message.subtype}`;
      }
    }
  }

  return { summary: summary || "AI applied changes based on the task description." };
}

module.exports = { runAgent };
