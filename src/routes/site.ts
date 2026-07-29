// Public pages and the auth flow (signup, login, magic link, PIN).

import { Hono } from "hono";
import type { Env } from "../env";
import { adminEmails } from "../env";
import { layout, flash, esc } from "../html";
import { startChallenge, verifyMagicLink, verifyPin, currentPrincipal, isAdmin, logout } from "../auth";
import { isValidSlug } from "../address";
import { verifyTurnstile, turnstileWidget } from "../turnstile";
import { isEmail } from "../util";

export const site = new Hono<{ Bindings: Env }>();

site.get("/", async (c) => {
  const user = await currentPrincipal(c);
  if (user) return c.redirect("/dashboard");
  return c.html(
    layout(
      "Welcome",
      `<h2>A mail server for agents</h2>
<p>Postilion hosts <strong>IFP mailboxes</strong>: you sign up, mint addresses for your agents, and your agents send and receive <a href="https://github.com/Inter-Face-Protocol/ifp">Inter-Face</a> messages through this server — the way a mail host holds your email inboxes.</p>
<p>Addresses on this server look like:</p>
<p><code>https://${esc(c.env.SERVER_HOST)}/ifp/&lt;principal&gt;/&lt;agent&gt;</code><br>
<code>ifpmail:${esc(c.env.SERVER_HOST)}/&lt;principal&gt;.&lt;agent&gt;</code></p>
<p>Signup needs a passcode from this server's admin. Have one? <a href="/signup">Sign up</a>. Already aboard? <a href="/login">Sign in</a>.</p>`,
    ),
  );
});

site.get("/signup", (c) => {
  const e = c.req.query("e");
  return c.html(
    layout(
      "Sign up",
      `<h2>Sign up</h2>
${flash(e)}
<form class="stack" method="post" action="/signup">
  <label>Email address
    <input type="email" name="email" required autocomplete="email">
  </label>
  <label>Signup passcode <span class="note">(from the server admin)</span>
    <input type="text" name="passcode" autocomplete="off">
  </label>
  <label>Your principal name <span class="note">(lowercase letters, digits, hyphens — becomes part of your addresses)</span>
    <input type="text" name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="32">
  </label>
  ${turnstileWidget(c.env)}
  <button>Send me a sign-in link</button>
</form>`,
    ),
  );
});

site.post("/signup", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  const passcode = String(form.passcode ?? "").trim().toLowerCase();
  const slug = String(form.slug ?? "").trim().toLowerCase();
  const err = (m: string) => c.redirect(`/signup?e=${encodeURIComponent(m)}`);

  if (!isEmail(email)) return err("please enter a valid email address");
  if (!isValidSlug(slug)) return err("that principal name isn't available (format or reserved word)");
  if (!(await verifyTurnstile(c.env, String(form["cf-turnstile-response"] ?? ""), c.req.header("cf-connecting-ip")))) {
    return err("humanness check failed — please try again");
  }

  const existing = await c.env.DB.prepare("SELECT id FROM principals WHERE email = ? OR slug = ?")
    .bind(email, slug)
    .first();
  if (existing) return err("that email or principal name is already taken");

  // Admin emails may bootstrap without a passcode; everyone else needs one.
  let passcodeId: number | undefined;
  if (adminEmails(c.env).includes(email)) {
    passcodeId = undefined;
  } else {
    if (!passcode) return err("a signup passcode is required");
    const row = await c.env.DB.prepare(
      "SELECT id FROM passcodes WHERE code = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')",
    )
      .bind(passcode)
      .first<{ id: number }>();
    if (!row) return err("that passcode is invalid, used, or expired");
    passcodeId = row.id;
  }

  const started = await startChallenge(c, { email, purpose: "signup", passcodeId, principalSlug: slug });
  if (!started.ok) return err(started.error);
  return c.redirect("/auth/pending");
});

site.get("/login", (c) => {
  const e = c.req.query("e");
  return c.html(
    layout(
      "Sign in",
      `<h2>Sign in</h2>
${flash(e)}
<form class="stack" method="post" action="/login">
  <label>Email address
    <input type="email" name="email" required autocomplete="email">
  </label>
  <button>Send me a sign-in link</button>
</form>
<p class="note">New here? <a href="/signup">Sign up with a passcode</a>.</p>`,
    ),
  );
});

site.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) return c.redirect(`/login?e=${encodeURIComponent("please enter a valid email address")}`);

  const principal = await c.env.DB.prepare("SELECT id, status FROM principals WHERE email = ?")
    .bind(email)
    .first<{ id: number; status: string }>();
  // Same response whether or not the account exists — no enumeration oracle.
  if (principal && principal.status !== "trashed") {
    const started = await startChallenge(c, { email, purpose: "login" });
    if (!started.ok) return c.redirect(`/login?e=${encodeURIComponent(started.error)}`);
  }
  return c.redirect("/auth/pending");
});

site.get("/auth/pending", (c) => {
  const e = c.req.query("e");
  return c.html(
    layout(
      "Check your email",
      `<h2>Check your email</h2>
${flash(e)}
<p>If that address has (or can open) an account here, a sign-in email is on its way. Click the link in it on this device — or enter the PIN from the email below.</p>
<form class="stack" method="post" action="/auth/pin">
  <label>PIN from the email
    <input type="text" name="pin" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
  </label>
  <button>Sign in</button>
</form>`,
    ),
  );
});

site.post("/auth/pin", async (c) => {
  const form = await c.req.parseBody();
  const result = await verifyPin(c, String(form.pin ?? ""));
  if (!result.ok) return c.redirect(`/auth/pending?e=${encodeURIComponent(result.error)}`);
  return c.redirect("/dashboard");
});

site.get("/auth/verify", async (c) => {
  const token = c.req.query("t") ?? "";
  const result = await verifyMagicLink(c, token);
  if (!result.ok) {
    return c.html(layout("Sign-in problem", `<h2>Sign-in problem</h2>${flash(result.error)}<p><a href="/login">Try again</a></p>`), 400);
  }
  return c.redirect("/dashboard");
});

site.post("/auth/logout", async (c) => {
  await logout(c);
  return c.redirect("/");
});

// Convenience: check whether the signed-in principal sees admin nav.
export async function navUser(c: Parameters<typeof currentPrincipal>[0]) {
  const user = await currentPrincipal(c);
  return user ? { user, nav: { slug: user.slug, admin: isAdmin(c.env, user) } } : { user: null, nav: undefined };
}
