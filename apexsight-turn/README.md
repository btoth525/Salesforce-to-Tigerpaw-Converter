# ApexSight — No-Open-Ports Remote Two-Way Talk (TURN)

This directory implements **TURN Option A: Cloudflare Realtime TURN credential
minting** so ApexSight two-way talk works remotely through the existing
Cloudflare tunnel — **without opening any inbound LAN port on Unraid** and
without exposing Frigate / go2rtc directly.

> **Heads up about placement.** This work belongs in the **ApexSight iOS repo**
> (the one with `native-ios/ApexSightNative.xcodeproj` and the two handoff `.md`
> files). It was committed here, in the Salesforce→Tigerpaw repo, only because
> that's the repository this session was scoped to and you asked to scaffold the
> files anyway. **Move `apexsight-turn/ios/*` into your real Xcode target and the
> `worker/` (or `flask/`) piece into your infra repo on your Mac.** Nothing here
> is wired into the Python app, and there is no Xcode project here to build
> against — so it was intentionally **not** built (`xcodebuild` was not run, per
> your instruction and because there's no Xcode in this sandbox).

## What's here

| File | Goes where | What it is |
|------|------------|------------|
| `worker/worker.js` | Cloudflare Worker project | POST-only, Bearer-auth minting endpoint. Strips `:53` URLs, returns `[IceServerConfig]`. **Primary minting option (A1).** |
| `worker/wrangler.toml`, `worker/package.json`, `worker/README.md` | Cloudflare Worker project | Deploy config + instructions. |
| `flask/turn_credentials.py` | Existing Python push companion (behind your Cloudflare tunnel) | Equivalent `/turn-credentials` Flask route. **Alternative (A2)** — use only if you'd rather reuse the companion. |
| `ios/TurnSettings.swift` | ApexSight Xcode target | URL in UserDefaults, secret in Keychain, POST fetch + decode. |
| `ios/TurnSettingsView.swift` | ApexSight Xcode target | "Remote Relay (TURN)" Settings section + **Test Relay** button. |
| `ios/TurnConnectionWatchdog.swift` | ApexSight Xcode target | Self-contained **6-second ICE watchdog**. |
| `ios/TwoWayTalkController+RemoteTURN.swift` | ApexSight Xcode target | Extension + numbered steps to merge TURN servers and arm the watchdog in your real controller. |
| `ios/TurnSupportingTypes.swift` | ApexSight Xcode target | Scaffold stubs for `IceServerConfig` / `FrigateError` / `KeychainStore`. **Delete any that already exist** in ApexSight. |

## Security model (do not weaken)

- The long-lived Cloudflare `TURN_KEY_API_TOKEN` stays **server-side only** (Worker
  secret or companion env). It is **never** compiled into the app.
- The app-side shared secret lives in the **iOS Keychain** — never UserDefaults,
  App Group defaults, plist, source, or logs.
- Minting endpoint is **POST-only**, **authenticated** (`Bearer APP_SHARED_SECRET`),
  **un-cached** (`Cache-Control: no-store`), and should have a **WAF/rate-limit**
  rule. Rotate `APP_SHARED_SECRET` if it leaks.
- `:53` ICE URLs are stripped server-side (ApexSight uses non-trickle ICE, which
  can stall on port 53 — confirmed: Cloudflare's own STUN list includes a `:53`
  entry).
- Logs print the **count** of ICE servers only — never usernames/credentials.

This adds **no new inbound LAN port forwards** and does not expose Frigate or
go2rtc directly. But the public minting endpoint still has attack surface, which
is why it's authenticated, rate-limited, logged, and rotatable.

## Cloudflare endpoint (verified 2026-06)

`POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers`
→ `201` with `{ "iceServers": [ { urls, username?, credential? } ] }`. TTL `86400`
is the documented example with no stated max.

---

## What you need to verify on your Mac

Do these in your **real ApexSight repo** after moving the files.

### A. Cloudflare Worker (or Flask)
1. Create a Realtime TURN key; copy `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`.
2. `cd worker && wrangler secret put TURN_KEY_ID / TURN_KEY_API_TOKEN / APP_SHARED_SECRET`, then `wrangler deploy`.
3. Smoke-test (see `worker/README.md`):
   - `POST` with correct Bearer → **200**, JSON array, **no** `:53` URL, no API token.
   - `POST` with no auth → **401**.
   - `GET` → **405**.
4. Add a WAF / rate-limit rule on the Worker route.

### B. iOS integration
1. Add `ios/*.swift` to the `ApexSightNative` target. **Delete duplicate types**
   from `TurnSupportingTypes.swift` if ApexSight already defines
   `IceServerConfig` / `FrigateError` / `KeychainStore` (and confirm the existing
   `KeychainStore` exposes `readString(account:)` / `writeString(_:account:)` —
   if not, add them; never fall back to UserDefaults for the secret).
2. Apply the **numbered STEPS** in `TwoWayTalkController+RemoteTURN.swift`:
   add the `iceWatchdog` property, merge `remoteTurnIceServers()` into the
   `RTCConfiguration`, arm the watchdog when a session starts, drive it from the
   ICE-state delegate, and cancel it in teardown. Uncomment the watchdog-wiring
   block once the property exists.
3. Confirm `TwoWayTalkController` is still **non-trickle** (Step 2 of the handoff);
   if it has changed, the `:53` strip is still harmless but note it.
4. Build (this was NOT run here — no Xcode in the sandbox):
   ```bash
   cd native-ios
   xcodegen generate
   xcodebuild -list -project ApexSightNative.xcodeproj
   xcodebuild -project ApexSightNative.xcodeproj -scheme ApexSightNative \
     -configuration Debug -destination 'generic/platform=iOS' \
     CODE_SIGNING_ALLOWED=NO clean build
   ```

### C. Settings UI
1. Embed `TurnSettingsSection()` in your Settings form (or push `TurnSettingsScreen`).
2. Enter the Worker URL + shared secret, tap **Test Relay** → should show
   *"Relay OK — N usable ICE servers."* (count only, no credentials).
3. Validation: non-HTTPS URL and empty secret are rejected with friendly errors.

### D. go2rtc (Path 1 first — handoff Step 4)
1. Configure go2rtc with LAN candidate + STUN only (no static TURN creds).
2. **Cellular test (Wi-Fi off):** open via the remote tunnel, start two-way talk on
   a `_twoway` camera, verify ICE connects, audio reaches the camera, and ending
   talk **fully releases mic / audio session / WebRTC**. Repeat after force-quit
   and after a fresh credential mint.
3. Only if Path 1 is flaky remotely, implement the Path 2 server-side go2rtc
   credential refresher (sketch in the handoff) — it was **not** built here.

### E. Watchdog behavior
- Confirm a deliberately-broken relay (wrong secret / unreachable URL) makes talk
  fail within ~6s with a clean error, not a silent hang.

### F. Secret hygiene
- Grep your logs / crash logs: no `Authorization`, TURN username, or credential
  should ever appear. Confirm `.env`, `.p8`, APNs/Frigate/TURN tokens, and the
  shared secret are **not** committed.

---

## Not done here (by design)
- `xcodebuild` / `xcodegen` — no Xcode in this sandbox; verify on your Mac.
- go2rtc YAML + Path 2 refresher — environment-specific; do Path 1 first.
- Real `TwoWayTalkController` diff — original file wasn't provided; delivered as an
  extension + numbered steps instead.
