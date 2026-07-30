// Minimal reference implementation of Postilion's MAILROOM service binding.
//
// This is a *separate*, independently deployable Worker. An admin who wants
// real mail delivery (instead of the zero-config fallback — sign-in links
// logged to the console, see ../../src/auth.ts) deploys this Worker and
// binds it in postilion's wrangler.jsonc:
//
//   "services": [{ "binding": "MAILROOM", "service": "mailroom", "entrypoint": "Mailroom" }]
//
// Unsupported, replace freely: this file is MPL-2.0 like the rest of the
// repo and is meant to be copied out and modified, not depended on. See
// README.md for the interface contract, deploy steps, and how to swap in a
// different mail provider.

import { WorkerEntrypoint } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// The contract. This restates postilion's src/env.ts (`MailroomBinding`,
// `MailroomSendResult`) exactly. It's duplicated rather than imported
// because this example is meant to run as its own standalone Worker,
// independent of the postilion repo it ships inside — keep it in sync by
// hand if the contract in src/env.ts ever changes.
// ---------------------------------------------------------------------------

interface MailroomSendResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

interface MailroomSendRequest {
  product: string;
  to: string;
  subject: string;
  text: string;
  // Accepted for contract completeness; this reference implementation
  // doesn't branch on it (no differing per-category behavior below), but a
  // fancier mailer might use it to set precedence headers, choose a
  // template, etc.
  category: "auth" | "notification" | "digest";
  /** Caller attests the recipient is an existing account holder — apply the higher known-recipient cap. */
  knownHint?: boolean;
}

export interface Env {
  /** Cloudflare Email Service binding — see wrangler.jsonc "send_email". */
  EMAIL: SendEmail;
  /** Per-recipient daily cap counters (KV). */
  CAP: KVNamespace;
  /** The address mail goes out from; must be on a domain onboarded to Email Service. */
  FROM_ADDRESS: string;
  /** Daily cap for a recipient Postilion hasn't vouched for. Default 3. */
  VICTIM_DAILY?: string;
  /** Daily cap for a recipient Postilion attests is a known account holder (knownHint). Default 10. */
  VICTIM_DAILY_KNOWN?: string;
}

const intVar = (v: string | undefined, fallback: number): number => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ---------------------------------------------------------------------------
// Per-recipient daily cap (best-effort).
//
// KV reads and writes here are a plain read-modify-write, not a transaction
// — a burst of concurrent sends to the same address in the same instant
// could both read the same count and both slip through. That's fine for
// caps this small (single digits): the point is to blunt runaway or
// abusive sending (a bug hammering one address with mail, a signup flow
// being poked repeatedly), not to be an exact rate limiter.
// ---------------------------------------------------------------------------

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function underDailyCap(env: Env, to: string, known: boolean): Promise<boolean> {
  const cap = known ? intVar(env.VICTIM_DAILY_KNOWN, 10) : intVar(env.VICTIM_DAILY, 3);
  const utcDay = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `cap:${utcDay}:${await sha256Hex(to.trim().toLowerCase())}`;

  const current = parseInt((await env.CAP.get(key)) ?? "0", 10) || 0;
  if (current >= cap) return false;

  // A two-day TTL is comfortably past the UTC day the key names, so stale
  // counters just expire on their own — no housekeeping cron needed for
  // something this cheap.
  await env.CAP.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 * 2 });
  return true;
}

// ---------------------------------------------------------------------------
// Deliver one email. This is the ONLY function that talks to a mail
// provider — swap Cloudflare Email Service for Resend, Postmark, or
// anything else by replacing this function alone; nothing else in this file
// needs to change.
// ---------------------------------------------------------------------------

async function deliverEmail(
  env: Env,
  msg: { to: string; subject: string; text: string; fromName: string },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await env.EMAIL.send({
      to: msg.to,
      from: { email: env.FROM_ADDRESS, name: msg.fromName },
      subject: msg.subject,
      text: msg.text,
    });
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, detail };
  }
}

// ---------------------------------------------------------------------------
// The service entrypoint Postilion (or anything else speaking this
// contract) binds to.
// ---------------------------------------------------------------------------

export class Mailroom extends WorkerEntrypoint<Env> {
  async send(req: MailroomSendRequest): Promise<MailroomSendResult> {
    const known = req.knownHint === true;

    if (!(await underDailyCap(this.env, req.to, known))) {
      return { ok: false, reason: "victim-cap" };
    }

    const delivered = await deliverEmail(this.env, {
      to: req.to,
      subject: req.subject,
      text: req.text,
      // `product` names the caller (e.g. "postilion") — used as the visible
      // sender display name so a recipient can tell who the mail is from.
      fromName: req.product,
    });

    if (!delivered.ok) {
      return { ok: false, reason: "delivery-failed", detail: delivered.detail };
    }
    return { ok: true };
  }
}

// A service-bound Worker like this one is never fetched directly, but
// `main` still needs a default export — a stub response makes that obvious
// if someone hits its workers.dev URL by mistake.
export default {
  async fetch(): Promise<Response> {
    return new Response(
      "mailroom-minimal is a service-binding Worker (see wrangler.jsonc). It has no HTTP surface of its own.",
      { status: 404 },
    );
  },
};
