# Onboarding a New Client to AI Development Automation

This automation turns a ClickUp task into a Shopify staging theme via an AI agent.

**Distribution model: self-contained copy.** Each client repo gets its own full
copy of the automation (`.github/workflows/` + `.github/scripts/`). There is no
GitHub org / reusable-workflow dependency. The files are written to work for any
client unchanged — the per-client store comes from the dispatch payload, the
Shopify token is a per-repo secret, and the base branch is auto-detected.

> Trade-off: when the automation logic changes, the updated files must be
> re-copied into each client repo (this repo stays the source of truth — copy
> `.github/workflows/ai-development-automation.yml` and `.github/scripts/` from
> here).

## How it works

```
ClickUp "AI Ready" checkbox
      │  (Zapier — one dynamic flow for all clients)
      ▼
repository_dispatch → CLIENT repo (runs in that repo's Actions tab)
      │
      ▼
.github/scripts/ai-development-automation.js
   • auto-detects the repo's default branch (main/master/custom)
   • Dev AI agent edits the theme → pushes branch → creates staging theme
   • comments the result on the ClickUp task
```

---

## Per-client setup (repeat for each new client repo)

### 1. Copy the automation files into the client repo
From this repo, copy as-is:
- `.github/workflows/ai-development-automation.yml`
- `.github/scripts/` (the whole folder: `ai-development-automation.js` + `lib/`)

No edits needed — everything is env/payload driven.

### 2. Add the repo secrets
Client repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | (same across clients) |
| `SHOPIFY_TOKEN` | That store/app's Admin API token (per-client) |
| `CLICKUP_API_KEY` | (same across clients) |
| `FIGMA_TOKEN` | (same, optional — enables Figma design fetch) |

Via CLI:
```bash
gh secret set ANTHROPIC_API_KEY --repo bluestout/CLIENT-REPO --body "sk-ant-..."
gh secret set SHOPIFY_TOKEN     --repo bluestout/CLIENT-REPO --body "shpat_..."
gh secret set CLICKUP_API_KEY   --repo bluestout/CLIENT-REPO --body "pk_..."
gh secret set FIGMA_TOKEN       --repo bluestout/CLIENT-REPO --body "figd_..."
```

> Without a GitHub Teams plan there are no org-level secrets, so each secret is
> set per repo. `ANTHROPIC_API_KEY` / `CLICKUP_API_KEY` / `FIGMA_TOKEN` are the
> same value everywhere; only `SHOPIFY_TOKEN` differs per client.

### 3. Create the ClickUp custom fields (in the client's space)

| Field | Type | Purpose |
|---|---|---|
| `AI Ready` | Checkbox | Trigger |
| `AI Run Count` | Number | State (auto-managed — exact name required) |
| `AI Theme ID` | Text | State (auto-managed — exact name required) |
| `Shopify Store` | Text | e.g. `client.myshopify.com` |
| `GitHub Repo` | Text | `bluestout/client-repo` (no `https://`, no `.git`) |

### 4. Install the Shopify custom app on the store
Develop apps → install → scopes `read_themes, write_themes`. This is what makes
that store's `SHOPIFY_TOKEN` work.

### 5. Test
1. On a task, fill `Shopify Store` + `GitHub Repo`, then check `AI Ready`.
2. Client repo → Actions: the workflow runs.
3. ClickUp task gets a comment with the branch + staging theme preview link.

---

## Zapier — one dynamic flow for all clients (set once)
1. Trigger: ClickUp "Custom Field Updated" → `AI Ready` = checked (workspace-wide).
2. Action: POST `https://api.github.com/repos/{{GitHub Repo field}}/dispatches`
   - Header `Authorization: Bearer <PAT with repo scope>`, `Accept: application/vnd.github+json`
   - Body:
     ```json
     {
       "event_type": "ai-development-automation",
       "client_payload": {
         "task_id": "{{task id}}",
         "task_name": "{{task name}}",
         "task_description": "{{task description}}",
         "shopify_store": "{{Shopify Store field}}",
         "github_repo": "{{GitHub Repo field}}"
       }
     }
     ```

---

## Common mistakes
- **`GitHub Repo` field wrong** → dispatch 404. Must be exactly `owner/repo`.
- **Custom app not installed on store** → Shopify 401. Install per store.
- **Field name mismatch** → `AI Run Count` / `AI Theme ID` must match exactly.
- **Zapier PAT scope** → needs `repo` to reach client repos.
