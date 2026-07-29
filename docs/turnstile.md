# Turnstile setup

Postilion uses [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) to check that a human is present at the two actions that create things: **signup** and **address minting**. Turnstile needs a **widget**, which gives you a key pair: a public *site key* (rendered into the page) and a *secret key* (used server-side to verify tokens).

## Mint a widget (Cloudflare dashboard)

Widget creation lives in the dashboard. (It can also be done with the API, but only with a token carrying the `Turnstile:Edit` permission — a typical Workers deploy token doesn't have it, and adding widgets is a once-per-deployment task, so the dashboard is the practical path.)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → your account → **Turnstile** (left sidebar).
2. **Add widget.**
3. **Widget name:** `postilion` (or your instance name — the name is only for your dashboard).
4. **Hostnames:** add every hostname the screens are served from. For the first Postilion server that's:
   - `postilion-server-01.peterkaminski.ai`
   - `postilion.kaminski.workers.dev`
5. **Widget mode:** *Managed* (recommended — Cloudflare decides when to challenge). *Non-interactive* is fine if you never want users to see a checkbox.
6. Create, then copy the **Site Key** and **Secret Key**.

## Wire the keys into Postilion

```bash
# 1. Site key (public) — edit wrangler.jsonc:
#      "TURNSTILE_SITE_KEY": "<your site key>"

# 2. Secret key (secret):
npx wrangler secret put TURNSTILE_SECRET
# paste the secret key at the prompt

# 3. Ship:
npx wrangler deploy
```

## Verify

- `/signup` and the dashboard's mint form show the Turnstile widget.
- A form POST **without** a Turnstile token is refused ("humanness check failed") — e.g. `curl -X POST .../signup -d "email=a@example.com&slug=x"` should bounce back to the form with that error.

## Behavior without keys

- `TURNSTILE_SECRET` unset → verification is **skipped** (local dev convenience; don't run production this way).
- Cloudflare publishes test keys that keep the full flow wired while always passing or always failing:

| Purpose | Site key | Secret key |
| --- | --- | --- |
| Always passes | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
| Always blocks | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` |

⚠️ The first Postilion deployment (2026-07-29) shipped with the **always-passes test keys** so the flow could be exercised end to end — swap in a real widget's keys before opening signups beyond trusted testers. (Signup is still passcode-gated either way; Turnstile is the second layer.)

## Why this isn't the mailer's job

The mailer service behind the `MAILROOM` binding deliberately carries **no** Turnstile: humanness checks are request-shaped and belong in the app whose form is being submitted, while the mailer owns sending budgets and suppression. Each Postilion instance brings its own widget.
