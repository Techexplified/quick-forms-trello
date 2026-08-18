// POST /api/submit-form?boardId=...&formId=...
// Body: { values: { [fieldId]: string | string[] } }
//
// Re-fetches the authoritative form definition server-side (never trusts
// field defs from the client), validates required fields, then creates the
// card in the form's targetListId using the board's stored token.
//
// Required env vars: same as get-form.js

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
  if (!resp.ok)
    throw new Error("Trello pluginData fetch failed: " + resp.status);
  const entries = await resp.json();
  const pluginId = process.env.TRELLO_PLUGIN_ID;
  const entry = entries.find(function (e) {
    return e.idPlugin === pluginId && e.scope === "shared";
  });
  if (!entry) return [];
  try {
    var parsed = JSON.parse(entry.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const boardId = req.query.boardId;
    const formId = req.query.formId;
    const values = (req.body && req.body.values) || {};

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
    if (!form.targetListId) {
      res
        .status(400)
        .json({ error: "This form has no destination list configured." });
      return;
    }

    // ---- Validate required fields ----
    var missing = [];
    form.fields.forEach(function (f) {
      if (f.kind === "labels" || f.kind === "members") return; // fixed, not filler input
      if (f.required) {
        var v = values[f.id];
        if (v === undefined || v === null || String(v).trim() === "") {
          missing.push(f.label);
        }
      }
    });
    if (missing.length) {
      res
        .status(400)
        .json({ error: "Missing required field(s): " + missing.join(", ") });
      return;
    }

    // ---- Build card payload ----
    var titleField = form.fields.find(function (f) {
      return f.kind === "title";
    });
    var descField = form.fields.find(function (f) {
      return f.kind === "description";
    });
    var name = titleField
      ? String(values[titleField.id] || "").trim()
      : "Untitled";
    var descLines = [];
    if (descField && values[descField.id])
      descLines.push(String(values[descField.id]));

    var params = new URLSearchParams();
    params.set("key", apiKey);
    params.set("token", token);
    params.set("idList", form.targetListId);
    params.set("name", name || "Untitled");

    form.fields.forEach(function (f) {
      var v = values[f.id];
      switch (f.kind) {
        case "startdate":
          if (v) params.set("start", new Date(v).toISOString());
          break;
        case "duedate":
          if (v) params.set("due", new Date(v).toISOString());
          break;
        case "labels": {
          var labelIds = f.selectedLabelIds || [];
          if (labelIds.length) params.set("idLabels", labelIds.join(","));
          break;
        }
        case "members": {
          var memberIds = f.selectedMemberIds || [];
          if (memberIds.length) params.set("idMembers", memberIds.join(","));
          break;
        }
        case "attachment":
          // handled after card creation below
          break;
        case "text":
        case "numbers":
        case "dropdown":
        case "customfield":
          // No first-class Trello card attribute for these (customfield
          // API integration is a documented v2 follow-up) — fold into the
          // description as labeled lines instead.
          if (v !== undefined && v !== null && String(v).trim() !== "") {
            descLines.push(f.label + ": " + v);
          }
          break;
        default:
          break;
      }
    });

    if (descLines.length) params.set("desc", descLines.join("\n\n"));

    var createResp = await fetch(
      "https://api.trello.com/1/cards?" + params.toString(),
      {
        method: "POST",
      },
    );
    if (!createResp.ok) {
      var errText = await createResp.text();
      console.error("Trello card create failed", createResp.status, errText);
      res
        .status(502)
        .json({ error: "Couldn't create the card. Please try again." });
      return;
    }
    var card = await createResp.json();

    // Optional pasted-URL attachment
    var attachmentField = form.fields.find(function (f) {
      return f.kind === "attachment";
    });
    if (attachmentField && values[attachmentField.id]) {
      var attachUrl =
        "https://api.trello.com/1/cards/" +
        card.id +
        "/attachments?key=" +
        encodeURIComponent(apiKey) +
        "&token=" +
        encodeURIComponent(token) +
        "&url=" +
        encodeURIComponent(values[attachmentField.id]);
      try {
        await fetch(attachUrl, { method: "POST" });
      } catch (e) {
        console.warn("Attachment add failed (card was still created)", e);
      }
    }

    res.status(200).json({ ok: true, cardId: card.id, cardUrl: card.shortUrl });
  } catch (err) {
    console.error("submit-form failed", err);
    res.status(500).json({ error: "Internal error" });
  }
};
