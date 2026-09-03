#!/usr/bin/env python3
"""Puts a working Upstox token into private.sync_config, and nothing else.

Driven by .github/workflows/upstox-token.yml every morning, because the OAuth
token expires at 3:30 AM IST and has no refresh token. Runnable by hand for the
same effect — it is idempotent, so a second run costs one HTTP request.

Nothing here knows how to log in. That is `upstox-totp`, pinned in the workflow,
which drives Upstox's undocumented login endpoints behind curl_cffi's Chrome TLS
impersonation. Keeping that out of this repo means an Upstox change to those
endpoints is a version bump rather than a reverse-engineering session.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# Reliance. Any liquid main-board instrument would do — the point is to probe
# the capability the app actually needs, not the one that is easiest to call.
#
# Deliberately NOT /v2/user/profile: an Analytics Token is refused there without
# a whitelisted static IP while working perfectly for market data, so a profile
# check would report a good token as dead and log in for no reason.
PROBE_URL = (
    "https://api.upstox.com/v2/market-quote/quotes"
    "?instrument_key=" + urllib.parse.quote("NSE_EQ|INE002A01018")
)


def require_env(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        sys.exit(f"{name} is not set")
    return value


def rpc(fn: str, payload: dict | None = None):
    """Calls a Postgres function through PostgREST as the service role.

    upstox_token_get / upstox_token_set are `security definer` wrappers over
    private.sync_config, which PostgREST cannot reach directly. See migration
    0011_upstox_token.sql.
    """
    url = f"{require_env('SUPABASE_URL').rstrip('/')}/rest/v1/rpc/{fn}"
    key = require_env("SUPABASE_SECRET_KEY")
    req = urllib.request.Request(
        url,
        data=json.dumps(payload or {}).encode(),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            body = res.read().decode().strip()
    except urllib.error.HTTPError as err:
        # PostgREST puts the Postgres error in the body; without it a failure
        # here reads as a bare "500" and tells you nothing.
        sys.exit(f"{fn} failed: {err.code} {err.read().decode()[:400]}")
    return json.loads(body) if body else None


def token_works(token: str) -> bool:
    if not token:
        return False
    req = urllib.request.Request(
        PROBE_URL,
        headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status == 200
    except urllib.error.HTTPError:
        return False
    except OSError as err:
        # A network fault is not evidence the token is dead. Logging in again
        # would be harmless but pointless, and it would hide a broken runner.
        sys.exit(f"could not reach Upstox to check the stored token: {err}")


def main() -> None:
    if token_works(rpc("upstox_token_get") or ""):
        print("stored token still works — nothing to do")
        return

    # Imported here so that the common case (token still valid) does not need
    # the dependency installed at all.
    from upstox_totp import UpstoxTOTP

    data = UpstoxTOTP().app_token.get_access_token().data

    # `extended_token` is Upstox's own long-lived read-only token. Where an app
    # is enabled for it, taking it here ends the daily refresh by itself — this
    # workflow then no-ops every morning instead of logging in.
    token = (getattr(data, "extended_token", None) or data.access_token or "").strip()
    if not token:
        sys.exit("Upstox returned no token")

    rpc("upstox_token_set", {"t": token})
    kind = "extended" if getattr(data, "extended_token", None) else "access"
    print(f"stored a fresh {kind} token for {data.user_id}")


if __name__ == "__main__":
    main()
