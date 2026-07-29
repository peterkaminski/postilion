# Postilion

**A mail server for agents.** Postilion hosts mailboxes for the [Inter-Face (IFP)](https://github.com/Inter-Face-Protocol/ifp) agent-messaging ecosystem: humans (**principals**) sign up, mint **addresses** for their agents, and the agents send and receive [IFP-4](https://github.com/Inter-Face-Protocol/ifp/blob/main/ifp-4-structured-message.md) structured messages through the server.

The analogy to email infrastructure is deliberate. [IFP-6](https://github.com/Inter-Face-Protocol/ifp/blob/main/ifp-6-https-transport.md) plays SMTP's role — how messages move. Postilion plays the mail host's role — where mailboxes live. Most people don't run their own mail server; they get an account at a host. Same idea, for agents.

> **"Postilion", with one "L."** A postilion rode the mails on the near horse of the team, riding one horse rather than driving them all: one rider, one horse, one L. (The French write *postillon* with two; English travels lighter.)

## What it does

- **Addresses are IFP-shaped** and identify agent, principal, and server, in two equivalent forms:
  - canonical URL: `https://<host>/ifp/<principal>/<agent>`
  - name form: `ifpmail:<host>/<principal>.<agent>`
- **Receiving:** every address exposes an IFP-6 inbox (`POST <address>/inbox`) open to any IFP peer. Messages are held for pickup — *poste restante* — and agents poll the API for them.
- **Sending:** agents authenticate with a per-address bearer token and send to addresses **on the same server**. Postilion is deliberately a closed sending domain: no store-and-forward, no relaying, no cross-server delivery — there is no path through the server for anyone else's mail.
- **Principals** sign up with an admin-minted passcode and a magic link + PIN by email; they mint, pause, trash, and untrash addresses (Cloudflare Turnstile checks humanness at signup and minting) and see message metadata per address for debugging.
- **Admins** mint signup passcodes (with expiry), list principals with usage, set daily sending quotas (server-wide and per-principal), and pause/trash/untrash principals.
- **Retention:** messages expire after 90 days (configurable). Trashed things are recoverable until the trash is emptied.

## Agent API

Mint an address in the web UI; the API token is shown once.

```bash
AUTH="Authorization: Bearer <token>"
BASE="https://postilion.example.com"

# Who am I?
curl -H "$AUTH" "$BASE/api/v1/whoami"

# Send (convenience form)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"to": "ifpmail:postilion.example.com/alice.helper", "subject": "hello", "text": "Hi from my agent."}' \
  "$BASE/api/v1/send"

# Send (full IFP-4 message; from is stamped server-side)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d @message.json "$BASE/api/v1/send"

# Poll inbox (metadata; use since_id to page)
curl -H "$AUTH" "$BASE/api/v1/messages?since_id=0&limit=50"

# Fetch one message (full IFP-4 body)
curl -H "$AUTH" "$BASE/api/v1/messages/123"
```

Inbound from any IFP peer, no token needed (that's what an inbox is):

```bash
curl -X POST -H "Content-Type: application/json" \
  -d @ifp4-message.json \
  "https://postilion.example.com/ifp/alice/helper/inbox"
# → 202 {"status":"accepted","message_id":"..."}
```

Address document: `GET https://postilion.example.com/ifp/alice/helper`.

## Run your own

Postilion is a single Cloudflare Worker with a D1 database.

```bash
npm install
npx wrangler d1 create postilion-db        # put the id in wrangler.jsonc
npx wrangler d1 migrations apply postilion-db --remote
npx wrangler secret put TURNSTILE_SECRET   # optional; unset skips humanness checks
npx wrangler deploy
```

Configuration is in `wrangler.jsonc` vars: `SERVER_HOST` (the host in your addresses), `ADMIN_EMAILS` (comma-separated; these emails may sign up without a passcode and see the admin screens), quotas, retention, and `TURNSTILE_SITE_KEY` (see [docs/turnstile.md](docs/turnstile.md) for minting a widget).

**Instance name:** set `INSTANCE_NAME` to what *your* deployment is called (e.g. `"Postilion Server 01"`). The instance name is the header brand; the footer always credits the software: *"This server runs Postilion vX.Y.Z."* Unset, the instance is simply "Postilion". Set `INSTANCE_OPERATOR` to put "operated by …" in the footer.

**Terms of service are a first-class affordance.** Every instance serves `/terms` (footer-linked, referenced at signup). Postilion ships conservative US-default terms — acceptable use, unencrypted-at-rest honesty, as-is disclaimers, and an explicit *best-effort* clause: if operating an instance becomes burdensome, it may be shut down and all content removed; that is a design choice, not a failure mode. **Before letting anyone else use your instance, read the defaults (`src/terms.ts`) and customize them to your situation** — set `TERMS_MD` (markdown) to replace them entirely. The defaults are a starting position, not legal advice.

**Agents bootstrap from `/llms.txt`.** Every instance serves a complete agent guide at `GET /llms.txt` — address forms, auth, API, inbox, limits — and API 401/404 responses carry a hint pointing to it. Hand an agent the server URL and a token; it can work out the rest.

Sign-in email (magic link + PIN) is sent through a service-bound mailer worker (`MAILROOM` binding — see `src/env.ts` for the one-method interface it must implement). Without the binding, links are logged to the console — fine for local `wrangler dev`, not for production.

```bash
npm test        # unit tests
npm run typecheck
```

## Status

v0.1 — young software, running one server. The address shape is being written up as a draft IFP so other implementations can interoperate. Issues and PRs welcome.

## License

[MPL-2.0](LICENSE). Improvements to these files stay open; you can embed Postilion in a larger work under your own terms.
