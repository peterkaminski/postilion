# mailroom-minimal

A minimal, self-contained reference implementation of Postilion's `MAILROOM` service binding, using [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) to actually send mail.

**This is a reference implementation, not a dependency.** It's unsupported and MPL-2.0 like the rest of the repo — copy it out, rename it, gut it, replace the mail provider, whatever fits your instance. Nothing else in Postilion imports or requires this code; it exists so an admin who wants real mail delivery has a working starting point instead of a blank page.

## Do you even need this?

**Maybe not.** Without any `MAILROOM` binding at all, Postilion falls back to logging sign-in links to the worker console (see `../../src/auth.ts`) instead of emailing them. For a tiny instance — you, and maybe a couple of friends you've handed a signup passcode to — that's a legitimate way to run indefinitely: you (the admin) can see the logs, so you can always get yourself signed back in. It stops being reasonable once you're inviting people who can't see your logs.

## The contract

Postilion calls the binding with one method, defined in `../../src/env.ts`:

```typescript
interface MailroomSendResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

interface MailroomBinding {
  send(req: {
    product: string;
    to: string;
    subject: string;
    text: string;
    category: "auth" | "notification" | "digest";
    knownHint?: boolean; // caller attests recipient is an existing account holder
  }): Promise<MailroomSendResult>;
}
```

This example restates that contract in `src/index.ts` rather than importing it — it's meant to run as its own standalone Worker, independent of the postilion repo it happens to ship inside.

`reason: "victim-cap"` is a code Postilion specifically understands: it maps that reason to a friendly "you've hit today's limit" message for the person waiting on the email, instead of a generic failure. Any other `reason` string is shown as-is (with `detail` appended when present), so pick short, informative ones.

## What this implementation does

- **Sends mail** through Cloudflare Email Service (a Workers binding — no API keys held in this Worker). The entire "talk to a provider" surface is one function, `deliverEmail()` in `src/index.ts`, marked as such — swap in another provider by replacing just that function.
- **Caps sends per recipient, per UTC day**, via a KV counter keyed on `cap:<day>:<sha256(to)>` (the hash just keeps raw addresses out of KV keys). Defaults: 3/day for a recipient Postilion hasn't vouched for, 10/day when the request carries `knownHint: true` (an existing, verified account). Both are overridable via `VICTIM_DAILY` / `VICTIM_DAILY_KNOWN` vars. The cap is a plain KV read-modify-write — best-effort, not a transaction — which is fine at these small numbers; its job is to blunt a runaway or abusive sender, not to be exact.

## Deploy steps

```bash
cd examples/mailroom-minimal
npm install

# Onboard the domain you'll send from (once, at the account level)
npx wrangler email sending enable yourdomain.example.com

# Create the KV namespace for the daily-cap counters, then put its id
# into wrangler.jsonc ("kv_namespaces")
npx wrangler kv namespace create CAP

# Set FROM_ADDRESS in wrangler.jsonc to an address on your onboarded domain

npx wrangler deploy
```

## Wire it into Postilion

In postilion's own `wrangler.jsonc`, add the service binding (this is already the shape the main repo documents):

```jsonc
"services": [
  { "binding": "MAILROOM", "service": "mailroom", "entrypoint": "Mailroom" }
]
```

`"service": "mailroom"` must match this Worker's `name` in its `wrangler.jsonc` — rename either side consistently if you deploy it under a different name.

## Using something other than Cloudflare Email Service

Cloudflare Email Service is the default here because it needs no separate account or API key — just a Workers binding. If you'd rather use something else, **[Resend](https://resend.com)** and **[Postmark](https://postmarkapp.com)** are both good fits: simple HTTP APIs, a single `fetch()` call each. Either way, the swap is the same: replace `deliverEmail()` in `src/index.ts` with a call to your provider's send endpoint (bearer token in a Worker secret, `wrangler secret put`), and leave the rest of the file — the contract, the cap logic — untouched.
