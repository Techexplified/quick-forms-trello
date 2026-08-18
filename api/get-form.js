// GET /api/get-form?boardId=...&formId=...
//
// Fetches the quickForms array stored in this board's Power-Up shared data
// (the same storage form-builder.html writes to via t.set("board","shared",...)),
// finds the requested form, and returns only what the public fill-out page
// needs to render inputs. Internal fields (targetListId, selectedLabelIds,
// selectedMemberIds, etc.) are intentionally withheld here — they're only
// used server-side in submit-form.js so they can't be tampered with by a
// client-side request.
//
// Required env vars:
//   TRELLO_API_KEY   - your Power-Up's API key
//   TRELLO_PLUGIN_ID - your Power-Up's Plugin ID, found on the Power-Up's
//                       admin page at trello.com/power-ups/admin (it's the
//                       id in the URL, NOT the API key)
//   KV_REST_API_URL / KV_REST_API_TOKEN

const { kv } = require("@vercel/kv");

async function fetchForms(boardId, apiKey, token) {
  const url =
    "https://api.trello.com/1/boards/" +
    encodeURIComponent(boardId) +
    "/pluginData?key=" +
    encodeURIComponent(apiKey) +
    "&token=" +
    encodeURIComponent(token);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error("Trello pluginData fetch failed: " + resp.status);
  }
  const entries = await resp.json();

  const pluginId = process.env.TRELLO_PLUGIN_ID;
  const entry = entries.find(function (e) {
    return e.idPlugin === pluginId && e.scope === "shared";
  });
  if (!entry) return [];

  let parsed;
  try {
    parsed = JSON.parse(entry.value);
  } catch (e) {
    return [];
  }
  // quickForms is stored as an object keyed by the shared-data key
  // ("quickForms") when written via t.set; pluginData returns the raw
  // value string for that key directly.
  return Array.isArray(parsed) ? parsed : [];
}

// Strip a field down to what the anonymous filler's browser needs.
function publicField(f) {
  var out = {
    id: f.id,
    kind: f.kind,
    label: f.label,
    required: !!f.required,
    placeholder: f.placeholder || "",
  };
  if (f.kind === "dropdown") out.options = f.options || [];
  if (f.kind === "customfield") out.subtype = f.subtype || "text";
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const boardId = req.query.boardId;
    const formId = req.query.formId;
    if (!boardId || !formId) {
      res.status(400).json({ error: "boardId and formId are required" });
      return;
    }

    const apiKey = process.env.TRELLO_API_KEY;
    if (!apiKey || !process.env.TRELLO_PLUGIN_ID) {
      res.status(500).json({ error: "Server misconfigured" });
      return;
    }

    const token = await kv.get("trello:token:" + boardId);
    if (!token) {
      res
        .status(404)
        .json({
          error: "This board hasn't been connected for public forms yet.",
        });
      return;
    }

    const forms = await fetchForms(boardId, apiKey, token);
    const form = forms.find(function (f) {
      return f.id === formId;
    });

    if (!form || form.status !== "complete") {
      res.status(404).json({ error: "Form not found." });
      return;
    }

    // Fields that are filler-facing on the public page. "labels" and
    // "members" are applied as fixed values at submission time server-side
    // (see submit-form.js) and aren't shown as inputs here.
    var visibleFields = form.fields.filter(function (f) {
      return f.kind !== "labels" && f.kind !== "members";
    });

    res.status(200).json({
      title: form.title,
      description: form.description,
      theme: form.theme,
      fields: visibleFields.map(publicField),
    });
  } catch (err) {
    console.error("get-form failed", err);
    res.status(500).json({ error: "Internal error" });
  }
};
