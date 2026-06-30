// ─── Shopify integration ─────────────────────────────────────────────────────
// Creates/updates the staging preview theme and applies the AI-changed files.
// Shopify is only touched here — purely to stage a preview for review.
//
// Ported from the GitHub Actions version: the store domain, its Admin token, and
// the task name now travel in `ctx` (the server serves many stores, each with
// its own token from SHOPIFY_TOKENS) instead of module-level constants.

const fetch = require("node-fetch");
const {
  SHOPIFY_API, SHOPIFY_GRAPHQL_API, shopifyHeaders, slugify
} = require("./config");

// ─── Find-or-create the staging theme, then apply the AI changes ─────────────
// Idempotent: if `existingThemeId` still exists, we update it in place (re-run);
// otherwise we duplicate the live theme. If Shopify rejects the create due to
// the theme limit, we return { limitReached: true }.
//   ctx: { store, shopifyToken, taskName }
async function upsertStagingThemeAndApplyChanges(ctx, changes, existingThemeId) {
  const s = sh(ctx);

  // Re-run path: if the stored theme still exists, update it in place.
  if (existingThemeId) {
    const theme = await getTheme(s, existingThemeId);
    if (theme) {
      console.log(`  Reusing staging theme: ${theme.name} (id: ${existingThemeId})`);
      await applyChangesToTheme(s, existingThemeId, changes);
      return {
        themeId: existingThemeId,
        name: theme.name,
        previewUrl: previewUrlFor(s, existingThemeId),
        limitReached: false
      };
    }
  }

  // Fresh-create path: duplicate the live theme (one server-side copy), then
  // push only the AI-changed files on top.
  const liveTheme = await getLiveTheme(s);
  const stagingName = `ai/${slugify(ctx.taskName)}`; // mirrors the branch name
  const dup = await duplicateTheme(s, liveTheme.id, stagingName);
  if (dup.limitReached) {
    return { themeId: "", name: "", previewUrl: "", limitReached: true };
  }
  console.log(`  Created staging theme: ${dup.name} (id: ${dup.themeId})`);

  await waitForThemeReady(s, dup.themeId);
  await applyChangesToTheme(s, dup.themeId, changes);

  return {
    themeId: String(dup.themeId),
    name: dup.name,
    previewUrl: previewUrlFor(s, dup.themeId),
    limitReached: false
  };
}

// Build a small per-task Shopify handle: { store, headers }.
function sh(ctx) {
  return { store: ctx.store, headers: shopifyHeaders(ctx.shopifyToken) };
}

const previewUrlFor = (s, themeId) => `https://${s.store}/?preview_theme_id=${themeId}`;

// ─── Live theme lookup ───────────────────────────────────────────────────────
async function getLiveTheme(s) {
  const res = await fetch(
    `https://${s.store}/admin/api/${SHOPIFY_API}/themes.json`,
    { headers: s.headers }
  );
  if (!res.ok) throw new Error(`Failed to fetch themes: ${res.status} - ${await res.text()}`);
  const { themes } = await res.json();
  const liveTheme = themes.find(t => t.role === "main") || themes[0];
  if (!liveTheme) throw new Error("No live theme found in Shopify store");
  return liveTheme;
}

async function getTheme(s, themeId) {
  const res = await fetch(
    `https://${s.store}/admin/api/${SHOPIFY_API}/themes/${themeId}.json`,
    { headers: s.headers }
  );
  if (!res.ok) return null;
  const { theme } = await res.json();
  return theme || null;
}

// ─── Duplicate a theme via the native themeDuplicate GraphQL mutation ─────────
// One call copies every file server-side. Returns { themeId, name } on success,
// or { limitReached: true } if the store is at its theme-count limit.
async function duplicateTheme(s, sourceThemeId, name) {
  const query = `mutation DuplicateTheme($id: ID!, $name: String) {
    themeDuplicate(id: $id, name: $name) {
      newTheme { id name role }
      userErrors { field message }
    }
  }`;

  const res = await fetch(
    `https://${s.store}/admin/api/${SHOPIFY_GRAPHQL_API}/graphql.json`,
    {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({
        query,
        variables: { id: `gid://shopify/OnlineStoreTheme/${sourceThemeId}`, name }
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    if (isThemeLimitError(res.status, errText)) {
      console.warn(`  ⚠️ Shopify theme limit reached: ${errText}`);
      return { limitReached: true };
    }
    throw new Error(`themeDuplicate request failed: ${res.status} - ${errText}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`themeDuplicate GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  const payload = json.data?.themeDuplicate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    const msg = userErrors.map(e => e.message).join("; ");
    if (isThemeLimitError(200, msg)) {
      console.warn(`  ⚠️ Shopify theme limit reached: ${msg}`);
      return { limitReached: true };
    }
    throw new Error(`themeDuplicate failed: ${msg}`);
  }

  const newTheme = payload?.newTheme;
  if (!newTheme?.id) throw new Error("themeDuplicate returned no new theme");
  // newTheme.id is a GID (gid://shopify/OnlineStoreTheme/123); REST needs the numeric id.
  return { themeId: String(newTheme.id).split("/").pop(), name: newTheme.name };
}

// ─── Wait for a freshly-duplicated theme to finish processing ─────────────────
// A duplicate is `processing: true` while Shopify copies files; pushing assets
// before it's ready can fail. Polls until done (or times out, then proceeds).
async function waitForThemeReady(s, themeId, maxWaitMs = 120000, intervalMs = 3000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const theme = await getTheme(s, themeId);
    if (theme && theme.processing === false) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.warn(`  ⚠️ Theme ${themeId} still processing after ${maxWaitMs}ms — applying changes anyway.`);
}

// ─── Apply the AI-changed files to a theme ───────────────────────────────────
async function applyChangesToTheme(s, themeId, changes) {
  for (const file of changes.files) {
    const ok = await putAssetWithRetry(s, themeId, { asset: { key: file.path, value: file.content } });
    if (!ok) console.warn(`  ⚠️  Failed to apply: ${file.path}`);
  }
}

// Asset PUT with retry on Shopify's 429 rate limit.
async function putAssetWithRetry(s, themeId, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(
      `https://${s.store}/admin/api/${SHOPIFY_API}/themes/${themeId}/assets.json`,
      { method: "PUT", headers: s.headers, body: JSON.stringify(body) }
    );
    if (res.ok) return true;
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return false;
  }
  return false;
}

// Detect Shopify's "you have reached the theme limit" condition.
function isThemeLimitError(status, text) {
  const t = (text || "").toLowerCase();
  return status === 403 || status === 406 ||
    (t.includes("theme") && (t.includes("limit") || t.includes("maximum") || t.includes("exceed")));
}

module.exports = { upsertStagingThemeAndApplyChanges };
