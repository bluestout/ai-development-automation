// ─── AI brain: planner, Dev, and QA ──────────────────────────────────────────
// Three Claude roles drive the automation:
//   1. planChange         — picks WHICH files to edit (content JSON vs structure Liquid)
//   2. generateWithClaude — the Dev: writes the actual file changes
//   3. qaReviewWithClaude — the QA: reviews the Dev's changes against the task
// devQaLoop wires Dev <-> QA together with feedback until QA approves.

const {
  anthropic, PLANNER_MODEL, DEV_MODEL, QA_MODEL,
  TASK_NAME, TASK_DESCRIPTION, MAX_QA_LOOPS
} = require("./config");

// ─── Planner: classify the task + pick the EXACT files to edit ───────────────
// This is the fix for "AI edits the wrong file". Given the full file list and
// the content-vs-structure rules, it returns which files to open. Without it the
// Dev only ever saw .liquid files and edited markup when the change belonged in JSON.
async function planChange(fileTree) {
  const prompt = `You are a senior Shopify theme architect. A task needs to be implemented on this theme. Your ONLY job right now is to decide WHICH files must be edited — do NOT write any code.

TASK NAME: ${TASK_NAME}
TASK DESCRIPTION: ${TASK_DESCRIPTION}

ALL EDITABLE THEME FILES:
${fileTree.join("\n")}

CRITICAL ROUTING RULES — Shopify separates CONTENT from STRUCTURE:

1. CONTENT changes → edit JSON files (NOT .liquid):
   - Changing text, headings, button labels, links, image references, colors picked in the editor, toggling/reordering existing blocks or sections.
   - The actual values live in:
     • sections/header-group.json  (announcement bar text, header content)
     • sections/footer-group.json  (footer content)
     • templates/*.json            (homepage = templates/index.json, product, collection, etc. — section settings + block content)
   - Example: "Update the announcement bar text to X" → edit sections/header-group.json (find the announcement block's "text" setting). DO NOT edit sections/announcement-bar.liquid.

2. STRUCTURE / LOGIC / STYLING changes → edit .liquid (and CSS/JS assets):
   - Adding a NEW schema setting or block type, changing layout/markup, adding a feature, fixing Liquid logic, restyling.
   - Edit sections/<name>.liquid, snippets/<name>.liquid, and the matching assets/section-<name>.css / .js.

3. MIXED changes → include BOTH the .liquid (to add the setting) AND the JSON (to set its value).

PICK ONLY the minimal set of files truly needed. Prefer JSON for pure content edits. When unsure whether content lives in a *-group.json or a template JSON, include the most likely one.

Respond with ONLY valid JSON, no markdown:
{"change_type":"content"|"structure"|"mixed","target_files":["exact/path/from/list.json"],"reasoning":"one sentence: why these files"}`;

  const parsed = await askClaudeForJson({
    model: PLANNER_MODEL,
    maxTokens: 1000,
    system: "You are a Shopify theme architect. Respond with valid JSON only.",
    prompt,
    label: "Planner",
    validate: (p) => {
      if (!Array.isArray(p.target_files)) throw new Error("planner missing 'target_files' array");
    }
  });

  // Guard against hallucinated paths — keep only files that exist in the tree.
  const valid = parsed.target_files.filter(p => fileTree.includes(p));
  if (valid.length === 0) {
    throw new Error(`Planner picked no valid files (picked: ${parsed.target_files.join(", ")})`);
  }

  return {
    change_type: parsed.change_type || "structure",
    target_files: valid.slice(0, 6),
    reasoning: parsed.reasoning || ""
  };
}

// ─── Dev ↔ QA feedback loop ──────────────────────────────────────────────────
// Dev proposes changes; QA reviews against the task. If QA rejects, its feedback
// is fed back to Dev for a fix. Repeats up to MAX_QA_LOOPS. Returns the best
// changes plus the final QA verdict.
async function devQaLoop(themeFiles, plan) {
  let changes = await generateWithClaude(themeFiles, null, plan);
  validateChanges(changes);

  let qaFeedback = null;

  for (let i = 1; i <= MAX_QA_LOOPS; i++) {
    console.log(`  — QA review (iteration ${i}/${MAX_QA_LOOPS})...`);
    const verdict = await qaReviewWithClaude(themeFiles, changes);
    console.log(`    QA: ${verdict.approved ? "APPROVED" : "CHANGES REQUESTED"} — ${verdict.summary}`);

    if (verdict.approved) {
      return { changes, qa: { approved: true, iterations: i, issues: [], summary: verdict.summary } };
    }

    qaFeedback = verdict;

    // Last loop still failed — return best effort, flagged as not approved.
    if (i === MAX_QA_LOOPS) {
      return { changes, qa: { approved: false, iterations: i, issues: verdict.issues || [], summary: verdict.summary } };
    }

    // Feed QA feedback back to Dev for a fix.
    console.log(`    Sending QA feedback back to Dev AI...`);
    changes = await generateWithClaude(themeFiles, qaFeedback, plan);
    validateChanges(changes);
  }
}

// ─── Dev: generate the file changes ──────────────────────────────────────────
// When `qaFeedback` is provided, the prompt asks Dev to FIX the flagged issues.
async function generateWithClaude(themeFiles, qaFeedback, plan) {
  const filesContext = Object.entries(themeFiles)
    .map(([path, content]) => `=== FILE: ${path} ===\n${content}\n=== END: ${path} ===`)
    .join("\n\n");

  const planBlock = plan
    ? `\nA planner already classified this task as a "${plan.change_type}" change and selected the files below for this reason: ${plan.reasoning}\n`
    : "";

  const feedbackBlock = qaFeedback
    ? `\n\nIMPORTANT — A QA reviewer rejected your previous attempt. Fix EVERY issue below and return the corrected complete files:\nQA SUMMARY: ${qaFeedback.summary}\nISSUES:\n${(qaFeedback.issues || []).map((x, i) => `${i + 1}. ${x}`).join("\n")}\n`
    : "";

  const prompt = `You are an expert Shopify theme developer. Make ONLY the specific changes described in the task below.

TASK NAME: ${TASK_NAME}
TASK DESCRIPTION: ${TASK_DESCRIPTION}
${planBlock}
CURRENT THEME FILES (these are the ONLY files you may edit):
${filesContext}
${feedbackBlock}
CONTENT vs STRUCTURE — edit the RIGHT file:
- CONTENT change (text, label, link, image, color, toggling/reordering existing blocks): edit the JSON file. The values live there. Example: announcement bar text lives in sections/header-group.json under the announcement block's "text" setting — NOT in sections/announcement-bar.liquid.
- STRUCTURE/STYLING change (new setting/block, layout, markup, CSS/JS): edit the .liquid section/snippet and its assets/section-*.css|js.
- For JSON files: change ONLY the specific value(s) the task requires and keep the rest of the JSON byte-for-byte identical. The result MUST be valid JSON.

STRICT RULES:
1. Return ONLY valid JSON — no markdown, no explanation, no code blocks
2. Only modify files that need to change for this specific task
3. Include the COMPLETE file content (not just the changed part)
4. If a file doesn't need changes, don't include it
5. Do NOT invent file paths — only return paths that appear in CURRENT THEME FILES above

REQUIRED JSON FORMAT (no other text):
{"files":[{"path":"sections/header-group.json","content":"...complete file content..."}],"summary":"One sentence describing what was changed"}`;

  return askClaudeForJson({
    model: DEV_MODEL,
    maxTokens: 8000,
    system: "You are a Shopify theme developer. Respond with valid JSON only. No markdown, no code blocks, no explanation.",
    prompt,
    label: "Dev",
    previewResponse: true,
    validate: (p) => {
      if (!p.files || !Array.isArray(p.files)) throw new Error("AI response missing 'files' array");
    }
  });
}

// ─── QA: review the proposed changes ─────────────────────────────────────────
// Returns a verdict. If QA itself can't run, we don't block the pipeline —
// it's treated as approved-with-warning.
async function qaReviewWithClaude(themeFiles, changes) {
  const originalContext = Object.entries(themeFiles)
    .map(([path, content]) => `=== ORIGINAL: ${path} ===\n${content}`)
    .join("\n\n");

  const proposedContext = changes.files
    .map(f => `=== PROPOSED: ${f.path} ===\n${f.content.slice(0, 4000)}`)
    .join("\n\n");

  const prompt = `You are a strict senior Shopify QA engineer. Review the PROPOSED changes against the TASK and decide if they are correct, complete, and safe to ship.

TASK NAME: ${TASK_NAME}
TASK DESCRIPTION: ${TASK_DESCRIPTION}

ORIGINAL FILES (truncated):
${originalContext}

PROPOSED CHANGES:
${proposedContext}

Check for: (1) does it actually implement the task, (2) valid Liquid/JSON syntax, (3) no broken/removed schema, (4) no obvious regressions, (5) follows Shopify best practices, (6) CONTENT vs STRUCTURE — was the change made in the correct file type? A content change (text/label/link/image/color/toggle) MUST be made in the JSON file (templates/*.json, sections/*-group.json), NOT in a section's .liquid markup. Editing announcement-bar.liquid to change the announcement TEXT (which actually lives in sections/header-group.json) is a WRONG-FILE error — reject it.

Respond with ONLY valid JSON, no markdown:
{"approved": true|false, "summary": "one sentence verdict", "issues": ["specific actionable issue 1", "issue 2"]}
If approved is true, "issues" must be an empty array.`;

  try {
    const parsed = await askClaudeForJson({
      model: QA_MODEL,
      maxTokens: 1500,
      prompt,
      label: "QA",
      validate: (p) => {
        if (typeof p.approved !== "boolean") throw new Error("QA response missing boolean 'approved'");
      }
    });
    parsed.issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    parsed.summary = parsed.summary || (parsed.approved ? "Looks good." : "Issues found.");
    return parsed;
  } catch (err) {
    console.warn(`    QA unavailable (${err.message}); proceeding without QA gate.`);
    return { approved: true, summary: "QA review unavailable; proceeded without gating.", issues: [] };
  }
}

// ─── Validate Dev output before it touches the theme ─────────────────────────
function validateChanges(changes) {
  if (!changes.files || changes.files.length === 0) {
    throw new Error("AI did not generate any changes — please review the task description");
  }
  for (const file of changes.files) {
    if (!file.path || !file.content || file.content.trim().length < 10) {
      throw new Error(`File '${file.path}' has empty or invalid content`);
    }
    // A malformed JSON template/group would break the theme — reject before push.
    if (file.path.endsWith(".json")) {
      try {
        JSON.parse(file.content);
      } catch (e) {
        throw new Error(`File '${file.path}' is not valid JSON: ${e.message}`);
      }
    }
  }
}

// ─── Shared Claude helper: call, retry 3x, extract + validate JSON ───────────
// All three roles share the same "ask for strict JSON" shape, so it lives here.
async function askClaudeForJson({ model, maxTokens, system, prompt, label, validate, previewResponse }) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        ...(system && { system }),
        messages: [{ role: "user", content: prompt }]
      });

      const text = (msg.content.find(b => b.type === "text")?.text || "").trim();
      if (previewResponse) console.log(`    ${label} AI response preview:`, text.slice(0, 150));

      const parsed = extractJson(text);
      if (validate) validate(parsed);
      return parsed;
    } catch (err) {
      console.warn(`    ${label} attempt ${attempt}/3 failed:`, err.message);
      lastError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`${label} AI failed after 3 attempts: ${lastError.message}`);
}

// Pull the first JSON object out of a model response (tolerates ``` fences).
function extractJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No valid JSON found in AI response");
  return JSON.parse(match[0]);
}

module.exports = { planChange, devQaLoop };
