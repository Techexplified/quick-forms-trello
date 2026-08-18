// POST /api/save-token
// Body: { boardId: string, token: string }
//
// Called by /public/connect-callback.html once an admin has granted a
// Trello token via the classic authorize flow. Validates the token can
// actually see the board, then stores it in Vercel KV keyed by boardId.
//
// Required env vars:
//   TRELLO_API_KEY   - your Power-Up's API key (same as used client-side)
//   KV_REST_API_URL / KV_REST_API_TOKEN - injected automatically if you
//     add the Vercel KV (or Upstash) integration to this project.

const { kv } = require("@vercel/kv");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { boardId, token } = req.body || {};

    if (!boardId || !token) {
      res.status(400).json({ error: "boardId and token are required" });
      return;
    }

    const apiKey = process.env.TRELLO_API_KEY;
    if (!apiKey) {
      res
        .status(500)
        .json({ error: "Server misconfigured: missing TRELLO_API_KEY" });
      return;
    }

    // Verify the token is real and actually has access to this board
    // before we trust and store it.
    const checkUrl =
      "https://api.trello.com/1/boards/" +
      encodeURIComponent(boardId) +
      "?fields=id,name&key=" +
      encodeURIComponent(apiKey) +
      "&token=" +
      encodeURIComponent(token);

    const checkResp = await fetch(checkUrl);
    if (!checkResp.ok) {
      res.status(400).json({
        error:
          "This token doesn't have access to that board. Re-authorize and try again.",
      });
      return;
    }

    await kv.set("trello:token:" + boardId, token);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("save-token failed", err);
    res.status(500).json({ error: "Internal error" });
  }
};
