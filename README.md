# AI Development Automation — Railway app

Replaces the old **Zapier + GitHub Actions** flow with one long-running Node app.
ClickUp posts a webhook when the **"AI Ready"** checkbox is checked; the app runs
the Dev AI agent on the client's theme, pushes an `ai/<task>` branch, creates a
Shopify staging theme, and comments the result back on the ClickUp task.

```
ClickUp "AI Ready" checked
   │  (ClickUp webhook → POST /webhook, X-Signature HMAC-SHA256)
   ▼
Railway app  ──verify sig──▶ enqueue (per-client lane) ──▶ 200 OK (fast)
   ▼ (background)
read task → ensure clone + worktree → Dev AI agent → push branch
        → create/update Shopify staging theme → comment on ClickUp
```

## Why these design choices

- **No checkout like Actions had.** The app keeps ONE persistent `git clone` per
  client repo on a Railway **volume** (`/data/repos`), `git fetch`es it, and runs
  each task in a throwaway **`git worktree`** — fast (clone once per client) and
  safe (tasks never stomp each other's files). See `src/lib/repo.js`.
- **Per-client serial queue.** Tasks for the same repo run one at a time so the
  shared clone is never fetched/branched concurrently; different clients run in
  parallel. See `src/queue.js`. **This requires a single instance** — keep
  `numReplicas: 1`.
- **Fast webhook ack.** The agent run takes minutes, so `/webhook` enqueues and
  returns 200 immediately (ClickUp disables slow webhooks).

## Layout

```
src/
  server.js                 Express: GET /health, POST /webhook (verify + enqueue)
  queue.js                  per-client serial lanes (p-queue)
  pipeline.js               processTask(): the orchestration (was main())
  lib/
    config.js               server-level env + constants (model, API versions, slugify)
    repo.js                 persistent clone + worktree lifecycle  [NEW]
    agent.js                Dev AI (Claude Agent SDK + figma/shopify-dev MCP)
    github.js               read worktree diff + branch/push via Contents API
    shopify.js              create/update staging theme + apply files
    clickup.js              read task, run-state fields, result comment
  scripts/register-webhook.js   one-off webhook registration
Dockerfile  railway.json  .env.example
```

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Dev AI agent. |
| `SHOPIFY_TOKENS` | yes | JSON map `{"store.myshopify.com":"shpat_..."}`. Stores aren't all in one Partner org, so token is looked up per task by the "Shopify Store" field. |
| `CLICKUP_API_KEY` | yes | Read tasks + post comments. |
| `CLICKUP_WEBHOOK_SECRET` | yes | From `register-webhook`. Verifies `X-Signature`. Without it, webhooks are rejected. |
| `GITHUB_TOKEN` | yes | One PAT with repo access to **all** client repos (clone + push). |
| `FIGMA_TOKEN` | no | File-read PAT. Enables Figma design fetch when a task links a design. |
| `VOLUME_DIR` | no | Defaults to `/data/repos`. Point at the Railway volume mount. |
| `PORT` | no | Provided by Railway. |

## Deploy on Railway

1. **New project → Deploy from repo** — point it at this repo. The app lives at
   the repo root, so no Root Directory setting is needed; Railway uses the `Dockerfile`.
2. **Add a Volume**, mount path `/data`. (The app writes clones under
   `/data/repos`.)
3. **Set the env vars** above (Service → Variables).
4. **Keep replicas at 1** (the queue + shared clone are in-process).
5. Deploy. Hit `https://<app>.up.railway.app/health` → `{ "ok": true }`.

## Register the ClickUp webhook (once)

```bash
CLICKUP_API_KEY=pk_... \
TEAM_ID=<your-workspace-id> \
ENDPOINT=https://<app>.up.railway.app/webhook \
node src/scripts/register-webhook.js <SPACE_ID>   # SPACE_ID optional (scope to one space)
```

Copy the printed **secret** into the `CLICKUP_WEBHOOK_SECRET` Railway var and
redeploy. The webhook listens for `taskUpdated`; the app only acts when the
**AI Ready** custom field flips to checked (field id is in `src/lib/config.js`).

## Per-task ClickUp fields (unchanged from before)

- **AI Ready** (checkbox) — the trigger.
- **Shopify Store** (short text) — `store.myshopify.com` (must match a key in `SHOPIFY_TOKENS`).
- **GitHub Repository** (short text) — `owner/repo` or a GitHub URL.
- **AI Run Count** / **AI Theme ID** — created lazily by the app; hold re-run state (max 3 runs/task).

## Local dev

```bash
cp .env.example .env   # fill in tokens
npm install
npm start              # http://localhost:3000/health
```

To exercise the webhook locally, POST a `taskUpdated` payload with a valid
`X-Signature` (HMAC-SHA256 of the raw body using `CLICKUP_WEBHOOK_SECRET`).
