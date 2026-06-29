# ApexSight TURN minter — Cloudflare Worker (Option A1)

Public, authenticated `POST` endpoint that mints **short-lived** WebRTC ICE
credentials so ApexSight two-way talk works remotely through the existing
Cloudflare tunnel — **no new inbound LAN port forward on Unraid**, and Frigate /
go2rtc are never exposed directly.

> A TURN relay is a blind WebRTC media relay; it cannot browse Frigate, pull
> snapshots, or control the NVR. But this minting endpoint is public, so it must
> stay authenticated, rate-limited, logged (without secrets), and rotated if the
> shared secret leaks. The long-lived Cloudflare TURN API token never leaves the
> Worker.

## Files

| File | Purpose |
|------|---------|
| `worker.js` | The Worker. POST-only, Bearer-auth, strips `:53` URLs, returns `[IceServerConfig]`. |
| `wrangler.toml` | Worker config. No secrets in here. |
| `package.json` | `npm run deploy` convenience. |

## Deploy

```bash
# 1. Create a Cloudflare Realtime TURN key in the dashboard:
#    Realtime -> TURN -> create key. Copy TURN_KEY_ID and TURN_KEY_API_TOKEN.

npm i -g wrangler            # or: npx wrangler ...
cd apexsight-turn/worker

# 2. Store the three secrets (NEVER commit these):
wrangler secret put TURN_KEY_ID
wrangler secret put TURN_KEY_API_TOKEN
wrangler secret put APP_SHARED_SECRET   # a long random string you also put in the app Keychain

# 3. Deploy
wrangler deploy
```

The deployed URL (e.g. `https://apex-turn.<account>.workers.dev`) is what you
enter as **TURN Credentials URL** in the app's Settings → Remote Relay (TURN).

After deploy, add a **WAF / rate-limit rule** on the Worker route in the
Cloudflare dashboard.

## Smoke tests

```bash
# Success: 200 + JSON array, no ":53" URL, no long-term token.
curl -i -X POST "https://<worker-url>" \
  -H "Authorization: Bearer <APP_SHARED_SECRET>" \
  -H "Accept: application/json"

# Unauthorized -> 401
curl -i -X POST "https://<worker-url>"

# Wrong method -> 405
curl -i "https://<worker-url>"
```

Expected for the success case:
- HTTP `200`
- A JSON **array** of `{ "urls": [...], "username": "...", "credential": "..." }`
- At least one `stun:` or `turn:` URL
- **No** URL containing `:53`
- **No** Cloudflare long-term API token anywhere in the response

## Notes

- TTL is `86400` (verified against the live Cloudflare docs example; no documented
  max). Lower `TURN_TTL_SECONDS` in `worker.js` if you prefer per-session minting.
- Logs print only the **count** of returned servers — never usernames/credentials.
- Equivalent Flask route (Option A2, for reuse of the existing Python push
  companion behind your Cloudflare tunnel) is in `../flask/turn_credentials.py`.
