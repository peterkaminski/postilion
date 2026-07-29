// Admin screens: passcodes, principals, quotas, trash (PLAN §5.1). Admin =
// signed-in principal whose email is in ADMIN_EMAILS.

import { Hono } from "hono";
import type { Env } from "../env";
import { intVar } from "../env";
import { layout, flash, statusBadge, esc } from "../html";
import { navUser } from "./site";
import { isAdmin } from "../auth";
import { getQuotaLimits } from "../quota";
import { randomPasscode, dayKeyUTC } from "../util";

export const admin = new Hono<{ Bindings: Env }>();

admin.use("/admin/*", async (c, next) => {
  const { user } = await navUser(c);
  if (!user) return c.redirect("/login");
  if (!isAdmin(c.env, user)) return c.text("forbidden", 403);
  await next();
});
// The list above matches /admin/* but not /admin itself:
admin.use("/admin", async (c, next) => {
  const { user } = await navUser(c);
  if (!user) return c.redirect("/login");
  if (!isAdmin(c.env, user)) return c.text("forbidden", 403);
  await next();
});

interface PrincipalRow {
  id: number;
  slug: string;
  email: string;
  status: string;
  created_at: string;
  addr_count: number;
  sent_total: number;
}

admin.get("/admin", async (c) => {
  const { nav } = await navUser(c);
  const db = c.env.DB;

  const principals = (
    await db
      .prepare(
        `SELECT p.id, p.slug, p.email, p.status, p.created_at,
                (SELECT COUNT(*) FROM addresses a WHERE a.principal_id = p.id AND a.status != 'trashed') AS addr_count,
                (SELECT COALESCE(SUM(a.sent_count), 0) FROM addresses a WHERE a.principal_id = p.id) AS sent_total
         FROM principals p ORDER BY p.slug`,
      )
      .all<PrincipalRow>()
  ).results;

  const passcodes = (
    await db
      .prepare(
        `SELECT pc.id, pc.code, pc.expires_at, pc.created_at, pc.used_at, pc.revoked_at, p.slug AS used_by_slug
         FROM passcodes pc LEFT JOIN principals p ON p.id = pc.used_by
         ORDER BY pc.id DESC LIMIT 100`,
      )
      .all<{ id: number; code: string; expires_at: string; created_at: string; used_at: string | null; revoked_at: string | null; used_by_slug: string | null }>()
  ).results;

  const limits = await getQuotaLimits(c.env);
  const today = (
    await db
      .prepare("SELECT scope, count FROM quota_days WHERE day = ? AND scope = 'server'")
      .bind(dayKeyUTC())
      .all<{ scope: string; count: number }>()
  ).results;
  const sentToday = today[0]?.count ?? 0;

  const live = principals.filter((p) => p.status !== "trashed");
  const trashed = principals.filter((p) => p.status === "trashed");

  const lifecycle = (p: PrincipalRow) => {
    const btn = (action: string, label: string, confirm?: string) =>
      `<form class="inline" method="post" action="/admin/principals/${p.id}/${action}"${confirm ? ` onsubmit="return confirm('${confirm}')"` : ""}><button class="quiet">${label}</button></form>`;
    if (p.status === "active") return btn("pause", "Pause") + btn("trash", "Trash", `Trash principal ${p.slug}?`);
    if (p.status === "paused") return btn("unpause", "Unpause") + btn("trash", "Trash", `Trash principal ${p.slug}?`);
    return btn("untrash", "Untrash");
  };

  const principalTable = (list: PrincipalRow[]) =>
    list.length === 0
      ? `<p class="note">None.</p>`
      : `<table><tr><th>Principal</th><th>Email</th><th>Status</th><th>Addresses</th><th>Sent</th><th></th></tr>${list
          .map(
            (p) =>
              `<tr><td>${esc(p.slug)}</td><td>${esc(p.email)}</td><td>${statusBadge(p.status)}</td><td>${p.addr_count}</td><td>${p.sent_total}</td><td>${lifecycle(p)}</td></tr>`,
          )
          .join("")}</table>`;

  const passcodeStatus = (r: (typeof passcodes)[number]) => {
    if (r.revoked_at) return "revoked";
    if (r.used_at) return `used by ${r.used_by_slug ?? "?"}`;
    if (r.expires_at <= new Date().toISOString()) return "expired";
    return "open";
  };

  return c.html(
    layout(
      "Admin",
      `${flash(c.req.query("e"))}${flash(c.req.query("m"), "ok")}
<h2>Server</h2>
<p>Sent today (UTC): <strong>${sentToday}</strong> of ${limits.server} · per-principal cap ${limits.principal}/day · ${live.length} principals</p>
<form class="stack" method="post" action="/admin/quotas">
  <label>Server sending quota (messages/day)
    <input type="text" name="server" inputmode="numeric" value="${limits.server}">
  </label>
  <label>Per-principal sending quota (messages/day, same for all principals)
    <input type="text" name="principal" inputmode="numeric" value="${limits.principal}">
  </label>
  <button>Set quotas</button>
</form>

<h2>Signup passcodes</h2>
<form class="stack" method="post" action="/admin/passcodes">
  <label>Expires in (days)
    <input type="text" name="days" inputmode="numeric" value="7">
  </label>
  <button>Mint passcode</button>
</form>
${
  passcodes.length === 0
    ? `<p class="note">No passcodes yet.</p>`
    : `<table><tr><th>Passcode</th><th>Status</th><th>Expires</th><th></th></tr>${passcodes
        .map(
          (r) =>
            `<tr><td><code>${esc(r.code)}</code></td><td>${esc(passcodeStatus(r))}</td><td>${esc(r.expires_at)}</td><td>${
              !r.used_at && !r.revoked_at
                ? `<form class="inline" method="post" action="/admin/passcodes/${r.id}/revoke"><button class="quiet">Revoke</button></form>`
                : ""
            }</td></tr>`,
        )
        .join("")}</table>`
}

<h2>Principals</h2>
${principalTable(live)}
${
  trashed.length
    ? `<h2>Trash</h2>${principalTable(trashed)}
<form method="post" action="/admin/trash/empty" onsubmit="return confirm('Permanently delete all trashed principals, their addresses, and their messages?')"><button>Empty trash</button></form>`
    : ""
}`,
      { user: nav },
    ),
  );
});

admin.post("/admin/passcodes", async (c) => {
  const form = await c.req.parseBody();
  const days = intVar(String(form.days ?? ""), 7);
  const code = randomPasscode();
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();
  await c.env.DB.prepare("INSERT INTO passcodes (code, expires_at) VALUES (?, ?)").bind(code, expires).run();
  return c.redirect(`/admin?m=${encodeURIComponent(`minted passcode ${code} (expires in ${days} days)`)}`);
});

admin.post("/admin/passcodes/:id/revoke", async (c) => {
  await c.env.DB.prepare("UPDATE passcodes SET revoked_at = datetime('now') WHERE id = ? AND used_at IS NULL")
    .bind(Number(c.req.param("id")))
    .run();
  return c.redirect(`/admin?m=passcode+revoked`);
});

admin.post("/admin/quotas", async (c) => {
  const form = await c.req.parseBody();
  const server = intVar(String(form.server ?? ""), 0);
  const principal = intVar(String(form.principal ?? ""), 0);
  if (!server || !principal) return c.redirect(`/admin?e=${encodeURIComponent("quotas must be positive integers")}`);
  const upsert = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
  await c.env.DB.batch([
    c.env.DB.prepare(upsert).bind("server_daily_quota", String(server)),
    c.env.DB.prepare(upsert).bind("principal_daily_quota", String(principal)),
  ]);
  return c.redirect(`/admin?m=quotas+updated`);
});

for (const [action, sql] of [
  ["pause", "UPDATE principals SET status = 'paused' WHERE id = ? AND status = 'active'"],
  ["unpause", "UPDATE principals SET status = 'active' WHERE id = ? AND status = 'paused'"],
  ["trash", "UPDATE principals SET status = 'trashed', trashed_at = datetime('now') WHERE id = ? AND status != 'trashed'"],
  ["untrash", "UPDATE principals SET status = 'active', trashed_at = NULL WHERE id = ? AND status = 'trashed'"],
] as const) {
  admin.post(`/admin/principals/:id/${action}`, async (c) => {
    await c.env.DB.prepare(sql).bind(Number(c.req.param("id"))).run();
    return c.redirect("/admin");
  });
}

admin.post("/admin/trash/empty", async (c) => {
  const db = c.env.DB;
  await db.batch([
    db.prepare(
      "DELETE FROM messages WHERE address_id IN (SELECT a.id FROM addresses a JOIN principals p ON p.id = a.principal_id WHERE p.status = 'trashed')",
    ),
    db.prepare("DELETE FROM addresses WHERE principal_id IN (SELECT id FROM principals WHERE status = 'trashed')"),
    db.prepare("DELETE FROM sessions WHERE principal_id IN (SELECT id FROM principals WHERE status = 'trashed')"),
    db.prepare("DELETE FROM principals WHERE status = 'trashed'"),
  ]);
  return c.redirect(`/admin?m=${encodeURIComponent("trash emptied")}`);
});
