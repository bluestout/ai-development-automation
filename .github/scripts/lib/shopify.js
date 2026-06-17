// ─── Shopify integration ─────────────────────────────────────────────────────
// Creates/updates the staging preview theme and applies the AI-changed files.
// Shopify is only touched here — purely to stage a preview for review.

const fetch = require("node-fetch");
const {
  SHOPIFY_STORE, SHOPIFY_HEADERS, SHOPIFY_API, SHOPIFY_GRAPHQL_API,
  TASK_NAME, TASK_ID
} = require("./config");

// ─── Find-or-create the staging theme, then apply the AI changes ─────────────
// Idempotent: if `existingThemeId` still exists, we update it in place (re-run);
// otherwise we duplicate the live theme. If Shopify rejects the create due to
// the theme limit, we return { limitReached: true }.
async function upsertStagingThemeAndApplyChanges(changes, existingThemeId) {
  // Re-run path: stored theme still present → update it in place.
  if (existingThemeId) {
    const theme = await getTheme(existingThemeId);
    if (theme) {
      console.log(`  Reusing existing staging theme (id: ${existingThemeId})`);
      await applyChangesToTheme(existingThemeId, changes);
      return {
        themeId: existingThemeId,
        name: theme.name,
        previewUrl: previewUrlFor(existingThemeId),
        limitReached: false
      };
    }
    console.log(`  Stored theme ${existingThemeId} no longer exists — creating a fresh one.`);
  }

  // Fresh-create path: duplicate the live theme natively (Shopify copies every
  // file server-side in one call), then push ONLY the AI-changed files on top.
  const liveTheme = await getLiveTheme();
  console.log(`  Live theme: ${liveTheme.name} (id: ${liveTheme.id})`);

  const stagingName = `AI: ${TASK_NAME || TASK_ID}`.slice(0, 50);
  const dup = await duplicateTheme(liveTheme.id, stagingName);
  if (dup.limitReached) {
    return { themeId: "", name: "", previewUrl: "", limitReached: true };
  }
  console.log(`  Staging theme duplicated: ${dup.name} (id: ${dup.themeId})`);

  await waitForThemeReady(dup.themeId);
  await applyChangesToTheme(dup.themeId, changes);

  return {
    themeId: String(dup.themeId),
    name: dup.name,
    previewUrl: previewUrlFor(dup.themeId),
    limitReached: false
  };
}

const previewUrlFor = (themeId) => `https://${SHOPIFY_STORE}/?preview_theme_id=${themeId}`;

// ─── Live theme lookup ───────────────────────────────────────────────────────
async function getLiveTheme() {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API}/themes.json`,
    { headers: SHOPIFY_HEADERS }
  );
  if (!res.ok) throw new Error(`Failed to fetch themes: ${res.status} - ${await res.text()}`);
  const { themes } = await res.json();
  const liveTheme = themes.find(t => t.role === "main") || themes[0];
  if (!liveTheme) throw new Error("No live theme found in Shopify store");
  return liveTheme;
}

async function getTheme(themeId) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API}/themes/${themeId}.json`,
    { headers: SHOPIFY_HEADERS }
  );
  if (!res.ok) return null;
  const { theme } = await res.json();
  return theme || null;
}

// ─── Duplicate a theme via the native themeDuplicate GraphQL mutation ─────────
// One call copies every file server-side. Returns { themeId, name } on success,
// or { limitReached: true } if the store is at its theme-count limit.
async function duplicateTheme(sourceThemeId, name) {
  const query = `mutation DuplicateTheme($id: ID!, $name: String) {
    themeDuplicate(id: $id, name: $name) {
      newTheme { id name role }
      userErrors { field message }
    }
  }`;

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_GRAPHQL_API}/graphql.json`,
    {
      method: "POST",
      headers: SHOPIFY_HEADERS,
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
async function waitForThemeReady(themeId, maxWaitMs = 120000, intervalMs = 3000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const theme = await getTheme(themeId);
    if (theme && theme.processing === false) {
      console.log(`  Duplicate ready (processing complete).`);
      return;
    }
    console.log(`  ⏳ Waiting for duplicate to finish processing...`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.warn(`  ⚠️ Theme ${themeId} still processing after ${maxWaitMs}ms — applying changes anyway.`);
}

// ─── Apply the AI-changed files to a theme ───────────────────────────────────
async function applyChangesToTheme(themeId, changes) {
  console.log(`  Applying ${changes.files.length} AI-modified file(s) to theme ${themeId}...`);
  for (const file of changes.files) {
    const ok = await putAssetWithRetry(themeId, { asset: { key: file.path, value: file.content } });
    if (ok) console.log(`  ✅ Applied AI change: ${file.path}`);
    else console.warn(`  ⚠️  AI file upload failed: ${file.path}`);
  }
}

// Asset PUT with retry on Shopify's 429 rate limit.
async function putAssetWithRetry(themeId, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API}/themes/${themeId}/assets.json`,
      { method: "PUT", headers: SHOPIFY_HEADERS, body: JSON.stringify(body) }
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
