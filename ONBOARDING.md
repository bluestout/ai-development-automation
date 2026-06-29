# Onboarding a New Client to AI Development Automation

This automation turns a ClickUp task into a Shopify staging theme via an AI agent.
All the logic lives **once** in this central repo (`bluestout/ai-development-automation`).
Each client repo only needs a tiny caller workflow that `uses:` it — so when the
script changes, every client gets the update automatically and client repos are
never touched again.

## How it works

```
ClickUp "AI Ready" checkbox
      │  (Zapier — one dynamic flow for all clients)
      ▼
repository_dispatch → CLIENT repo
      │  (caller workflow: .github/workflows/ai-development-automation.yml)
      ▼
uses: bluestout/ai-development-automation/.github/workflows/ai-development-automation.yml@main
      │  • checks out the CLIENT theme (working tree the agent edits)
      │  • checks out the CENTRAL scripts into _automation/
      ▼
Dev AI agent edits theme → pushes branch → creates staging theme → comments on ClickUp
```

The Action **runs in the client repo** (its Actions tab shows the runs); the logic
is pulled from this central repo.

---

## One-time setup (whole org — do once)

### Org-level GitHub secrets
`bluestout` org → Settings → Secrets and variables → Actions. Set visibility to the
relevant repos (or "All repositories"):

| Secret | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Shared |
| `CLICKUP_API_KEY` | Shared |
| `FIGMA_TOKEN` | Shared, optional (file-read PAT — enables design fetch) |
| `GH_DISPATCH_PAT` | PAT with `repo` scope — checks out the client theme cross-repo |

> `SHOPIFY_TOKEN` is **NOT** org-level — each store/app has its own Admin API
> token, so it's set per client repo (below).

### Zapier — one dynamic flow for all clients
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

## Per-client setup (repeat for each new client)

### 1. Add the caller workflow to the client repo
Copy [`templates/client-caller.yml`](templates/client-caller.yml) into the client repo as:
```
.github/workflows/ai-development-automation.yml
```
That's the only automation file the client repo needs — no `.github/scripts/`.

### 2. Add the per-repo Shopify token
Client repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `SHOPIFY_TOKEN` | That store/app's Admin API access token |

Via CLI:
```bash
gh secret set SHOPIFY_TOKEN --repo bluestout/CLIENT-REPO --body "shpat_..."
```

### 3. Create the ClickUp custom fields (in the client's space)

| Field | Type | Purpose |
|---|---|---|
| `AI Ready` | Checkbox | Trigger |
| `AI Run Count` | Number | State (auto-managed — exact name required) |
| `AI Theme ID` | Text | State (auto-managed — exact name required) |
| `Shopify Store` | Text | e.g. `client.myshopify.com` |
| `GitHub Repo` | Text | `bluestout/client-repo` (no `https://`, no `.git`) |

### 4. Install the Shopify custom app on the store
Develop apps → install → scopes `read_themes, write_themes`. This is what makes that
store's `SHOPIFY_TOKEN` work.

### 5. Test
1. On a task, fill `Shopify Store` + `GitHub Repo`, then check `AI Ready`.
2. Client repo → Actions: the caller job runs, resolves the central reusable workflow.
3. ClickUp task gets a comment with the branch + staging theme preview link.

---

## Changing the automation later
Edit this central repo only. Every client picks up the change on the next run —
no client repos to re-touch. (Caller files pin `@main`; for stricter control you
can pin a tag/SHA instead.)

## Common mistakes
- **`GitHub Repo` field wrong** → dispatch 404. Must be exactly `owner/repo`.
- **Custom app not installed on store** → Shopify 401. Install per store.
- **Field name mismatch** → `AI Run Count` / `AI Theme ID` must match exactly.
- **`GH_DISPATCH_PAT` / Zapier PAT scope** → needs `repo` to reach client repos.
