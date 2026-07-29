// Principal auth: signup passcode + email → magic link AND PIN (via mailroom)
// → session cookie. The principal row is created only after the email
// round-trip proves address ownership. Admin = principal whose email is in
// ADMIN_EMAILS (checked per request; PLAN §6, Pete: in-app admin).

import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./env";
import { adminEmails } from "./env";
import { randomToken, randomPin, sha256Hex } from "./util";

const CHALLENGE_TTL_MIN = 15;
const SESSION_TTL_DAYS = 30;
const MAX_PIN_ATTEMPTS = 5;
const SESSION_COOKIE = "postilion_session";
const PENDING_COOKIE = "postilion_pending";

export interface Principal {
  id: number;
  slug: string;
  email: string;
  status: string;
}

export interface StartChallengeOpts {
  email: string;
  purpose: "login" | "signup";
  passcodeId?: number;
  principalSlug?: string;
}

export async function startChallenge(
  c: Context<{ Bindings: Env }>,
  opts: StartChallengeOpts,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const env = c.env;
  const token = randomToken();
  const pin = randomPin();
  const expires = new Date(Date.now() + CHALLENGE_TTL_MIN * 60_000).toISOString();

  const res = await env.DB.prepare(
    `INSERT INTO logins (email, token_hash, pin_hash, purpose, passcode_id, principal_slug, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      opts.email,
      await sha256Hex(token),
      await sha256Hex(pin),
      opts.purpose,
      opts.passcodeId ?? null,
      opts.principalSlug ?? null,
      expires,
    )
    .first<{ id: number }>();
  if (!res) return { ok: false, error: "could not start sign-in" };

  const link = `${env.BASE_URL}/auth/verify?t=${token}`;
  const text = [
    opts.purpose === "signup" ? "Welcome to Postilion." : "Sign in to Postilion.",
    "",
    `Open this link on this device: ${link}`,
    "",
    `Or, if you're signing in on another device, enter this PIN there: ${pin}`,
    "",
    `The link and PIN expire in ${CHALLENGE_TTL_MIN} minutes. If you didn't request this, ignore this email.`,
  ].join("\n");

  if (env.MAILROOM) {
    const sent = await env.MAILROOM.send({
      product: "postilion",
      to: opts.email,
      subject: `Postilion sign-in — PIN ${pin}`,
      text,
      category: "auth",
    });
    if (!sent.ok) return { ok: false, error: `could not send sign-in email (${sent.reason ?? "unknown"})` };
  } else {
    // Local dev without the mailroom binding: surface the link in the log.
    console.log(`[dev] magic link for ${opts.email}: ${link} (PIN ${pin})`);
  }

  // Pending-login cookie ties the PIN form to this challenge.
  setCookie(c, PENDING_COOKIE, String(res.id), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: CHALLENGE_TTL_MIN * 60,
  });
  return { ok: true };
}

interface LoginRow {
  id: number;
  email: string;
  purpose: string;
  passcode_id: number | null;
  principal_slug: string | null;
  attempts: number;
}

async function completeChallenge(
  c: Context<{ Bindings: Env }>,
  row: LoginRow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const env = c.env;

  let principal = await env.DB.prepare("SELECT id, slug, email, status FROM principals WHERE email = ?")
    .bind(row.email)
    .first<Principal>();

  if (row.purpose === "signup") {
    if (principal) return { ok: false, error: "an account with this email already exists — sign in instead" };
    if (row.passcode_id !== null) {
      // Re-check at completion: the passcode must still be unused and unexpired.
      const claimed = await env.DB.prepare(
        `UPDATE passcodes SET used_at = datetime('now')
         WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')
         RETURNING id`,
      )
        .bind(row.passcode_id)
        .first<{ id: number }>();
      if (!claimed) return { ok: false, error: "that signup passcode is no longer valid" };
    }
    const created = await env.DB.prepare(
      "INSERT INTO principals (slug, email) VALUES (?, ?) RETURNING id, slug, email, status",
    )
      .bind(row.principal_slug, row.email)
      .first<Principal>();
    if (!created) return { ok: false, error: "could not create account (name may be taken)" };
    principal = created;
    if (row.passcode_id !== null) {
      await env.DB.prepare("UPDATE passcodes SET used_by = ? WHERE id = ?").bind(created.id, row.passcode_id).run();
    }
  } else {
    if (!principal) return { ok: false, error: "no account with this email" };
    if (principal.status === "trashed") return { ok: false, error: "this account is in the trash — contact the server admin" };
  }

  await env.DB.prepare("UPDATE logins SET used_at = datetime('now') WHERE id = ?").bind(row.id).run();

  const sessionToken = randomToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token_hash, principal_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(sessionToken), principal!.id, expires)
    .run();

  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
  deleteCookie(c, PENDING_COOKIE, { path: "/" });
  return { ok: true };
}

export async function verifyMagicLink(
  c: Context<{ Bindings: Env }>,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await c.env.DB.prepare(
    `SELECT id, email, purpose, passcode_id, principal_slug, attempts FROM logins
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(await sha256Hex(token))
    .first<LoginRow>();
  if (!row) return { ok: false, error: "this sign-in link is invalid or expired" };
  return completeChallenge(c, row);
}

export async function verifyPin(
  c: Context<{ Bindings: Env }>,
  pin: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pendingId = getCookie(c, PENDING_COOKIE);
  if (!pendingId) return { ok: false, error: "no sign-in in progress — request a new link" };
  const row = await c.env.DB.prepare(
    `SELECT id, email, purpose, passcode_id, principal_slug, attempts, pin_hash FROM logins
     WHERE id = ? AND used_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(Number(pendingId))
    .first<LoginRow & { pin_hash: string }>();
  if (!row) return { ok: false, error: "sign-in expired — request a new link" };
  if (row.attempts >= MAX_PIN_ATTEMPTS) return { ok: false, error: "too many PIN attempts — request a new link" };
  await c.env.DB.prepare("UPDATE logins SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
  if ((await sha256Hex(pin.trim())) !== row.pin_hash) return { ok: false, error: "wrong PIN" };
  return completeChallenge(c, row);
}

export async function currentPrincipal(c: Context<{ Bindings: Env }>): Promise<Principal | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.email, p.status FROM sessions s
     JOIN principals p ON p.id = s.principal_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(await sha256Hex(token))
    .first<Principal>();
  if (!row || row.status === "trashed") return null;
  return row;
}

export function isAdmin(env: Env, principal: Principal): boolean {
  return adminEmails(env).includes(principal.email.toLowerCase());
}

export async function logout(c: Context<{ Bindings: Env }>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
