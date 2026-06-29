"""ApexSight — TURN credential minting (Option A2, Flask).

Alternative to the Cloudflare Worker for reuse of the existing ApexSight Python
push companion. Publish this route through your existing Cloudflare tunnel so it
is reachable away from home — this still requires NO new inbound port forward on
Unraid.

Same contract as the Worker:
  - POST only, at `/turn-credentials`
  - `Authorization: Bearer <APP_SHARED_SECRET>` required
  - Cloudflare TURN key/token are server-side only
  - `:53` ICE URLs are stripped (non-trickle ICE stalls on port 53)
  - Response body is a RAW JSON array: [IceServerConfig]
  - `Cache-Control: no-store`, no secrets in logs

Env (NEVER commit these):
  export TURN_KEY_ID="..."
  export TURN_KEY_API_TOKEN="..."
  export APP_SHARED_SECRET="long-random-string"

cloudflared ingress concept (adapt host/port to the real companion):
  ingress:
    - hostname: apex-turn.yourdomain.com
      service: http://127.0.0.1:5055
    - service: http_status:404
"""

import os

import requests
from flask import Blueprint, abort, jsonify, request

# Use a Blueprint so this drops into the existing companion app:
#   from turn_credentials import turn_bp
#   app.register_blueprint(turn_bp)
turn_bp = Blueprint("turn", __name__)

TURN_KEY_ID = os.environ["TURN_KEY_ID"]
TURN_KEY_API_TOKEN = os.environ["TURN_KEY_API_TOKEN"]
APP_SHARED_SECRET = os.environ["APP_SHARED_SECRET"]

# Verified against the live Cloudflare docs (2026-06): example TTL is 86400 and
# no fixed maximum is documented. Lower this for per-session minting.
TURN_TTL_SECONDS = 86400

_MINT_URL = (
    "https://rtc.live.cloudflare.com/v1/turn/keys/"
    f"{TURN_KEY_ID}/credentials/generate-ice-servers"
)


@turn_bp.post("/turn-credentials")
def turn_credentials():
    # Bearer auth. Never echo the received header back.
    if request.headers.get("Authorization") != f"Bearer {APP_SHARED_SECRET}":
        abort(401)

    try:
        resp = requests.post(
            _MINT_URL,
            headers={
                "Authorization": f"Bearer {TURN_KEY_API_TOKEN}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={"ttl": TURN_TTL_SECONDS},
            timeout=10,
        )
    except requests.RequestException:
        # Log without secrets.
        from flask import current_app

        current_app.logger.warning("TURN mint upstream network error")
        abort(502)

    if not resp.ok:  # Cloudflare returns 201 on success.
        from flask import current_app

        current_app.logger.warning(
            "TURN mint upstream failed with status %s", resp.status_code
        )
        abort(502)

    cleaned = []
    for server in resp.json().get("iceServers", []):
        urls = server.get("urls", [])
        if isinstance(urls, str):
            urls = [urls]

        # ApexSight uses non-trickle ICE. Strip ":53" URLs to avoid stalls/timeouts.
        urls = [u for u in urls if isinstance(u, str) and ":53" not in u]

        if urls:
            cleaned.append(
                {
                    "urls": urls,
                    "username": server.get("username"),
                    "credential": server.get("credential"),
                }
            )

    if not cleaned:
        abort(502)

    response = jsonify(cleaned)  # raw array
    response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":  # Standalone run for local testing only.
    from flask import Flask

    app = Flask(__name__)
    app.register_blueprint(turn_bp)
    # Bind to localhost; expose only via the Cloudflare tunnel.
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5055")))
