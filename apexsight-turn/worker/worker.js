/**
 * ApexSight — Cloudflare Worker: TURN credential minting (Option A1)
 *
 * Implements the public `/turn-credentials` minting endpoint described in
 * ApexSight-TURN-Minting-and-Security. It lets the iOS app obtain short-lived
 * WebRTC ICE credentials so remote two-way talk works through the existing
 * Cloudflare tunnel WITHOUT opening any inbound LAN port on Unraid.
 *
 * Security model (do not weaken):
 *   - The long-lived Cloudflare `TURN_KEY_API_TOKEN` NEVER leaves the server.
 *     It lives only in Worker secrets; the app only ever receives short-lived
 *     ICE credentials.
 *   - This endpoint is public, so it MUST stay authenticated, POST-only, and
 *     un-cached. Add a Cloudflare WAF / rate-limit rule on the route.
 *   - Never log Authorization headers, TURN usernames, or TURN credentials.
 *
 * Upstream verified against the live Cloudflare docs (2026-06):
 *   POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers
 *   -> 201 Created, body { "iceServers": [ { urls, username?, credential? } ] }
 *   Cloudflare's own STUN list includes a ":53" URL, which is why we strip
 *   ":53" below — non-trickle ICE clients (ApexSight) can stall on port 53.
 *
 * Required Worker secrets (set via `wrangler secret put ...`):
 *   TURN_KEY_ID          Cloudflare Realtime TURN key id
 *   TURN_KEY_API_TOKEN   Cloudflare Realtime TURN API token  (server-side only)
 *   APP_SHARED_SECRET    long random string the app sends as a Bearer token
 *
 * The response body is a RAW JSON ARRAY of ICE server objects: [IceServerConfig].
 * This matches `JSONDecoder().decode([IceServerConfig].self, ...)` on iOS.
 */

// Credentials live ~24h. The doc's own example uses 86400 and Cloudflare states
// no fixed maximum, so 86400 is safe. Lower it if you mint per short session.
const TURN_TTL_SECONDS = 86400;

export default {
  async fetch(req, env) {
    // POST-only. A plain GET (or anything else) is rejected before auth so the
    // method check is observable in the curl smoke tests.
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    // Constant-shape auth check. Bearer <APP_SHARED_SECRET>.
    const auth = req.headers.get("authorization") || "";
    if (!env.APP_SHARED_SECRET || auth !== `Bearer ${env.APP_SHARED_SECRET}`) {
      // Do NOT echo the received header — that would leak attempted secrets.
      return new Response("Unauthorized", { status: 401 });
    }

    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      console.log("TURN mint misconfigured: missing TURN_KEY_ID/API_TOKEN");
      return new Response("Server misconfigured", { status: 500 });
    }

    let upstream;
    try {
      upstream = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        }
      );
    } catch (err) {
      // Network/DNS failure reaching Cloudflare Realtime. Log status only.
      console.log("TURN mint upstream error (network)");
      return new Response("TURN mint failed", { status: 502 });
    }

    if (!upstream.ok) {
      // Cloudflare returns 201 on success; .ok covers 200-299.
      console.log("TURN mint upstream failed", upstream.status);
      return new Response("TURN mint failed", { status: 502 });
    }

    let body;
    try {
      body = await upstream.json();
    } catch (err) {
      console.log("TURN mint upstream returned non-JSON");
      return new Response("TURN mint failed", { status: 502 });
    }

    const iceServers = Array.isArray(body.iceServers) ? body.iceServers : [];

    // Strip every ":53" URL (non-trickle ICE stalls on port 53) and drop any
    // server left with no usable URL. Keep username/credential intact.
    const cleaned = iceServers
      .map((server) => {
        const rawUrls = Array.isArray(server.urls)
          ? server.urls
          : [server.urls].filter(Boolean);
        const urls = rawUrls.filter(
          (url) => typeof url === "string" && !url.includes(":53")
        );
        return { urls, username: server.username, credential: server.credential };
      })
      .filter((server) => server.urls.length > 0);

    if (cleaned.length === 0) {
      console.log("TURN mint produced no usable ICE servers after :53 strip");
      return new Response("No usable ICE servers", { status: 502 });
    }

    // Count only — never log usernames/credentials.
    console.log("TURN mint ok, ice servers returned:", cleaned.length);

    return Response.json(cleaned, {
      headers: { "Cache-Control": "no-store" },
    });
  },
};
