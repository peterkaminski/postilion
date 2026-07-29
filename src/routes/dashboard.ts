// Principal screens: mint/list/lifecycle addresses, address detail with
// message metadata (PLAN §5.2). Session-gated; SameSite cookies + POST-only
// mutations are the CSRF stance for v1.

import { Hono } from "hono";
import type { Env } from "../env";
import { layout, flash, statusBadge, esc } from "../html";
import { navUser } from "./site";
import { isValidSlug, canonicalUrl, nameForm } from "../address";
import { verifyTurnstile, turnstileWidget } from "../turnstile";
import { randomToken, sha256Hex } from "../util";

export const dashboard = new Hono<{ Bindings: Env }>();

interface AddressRow {
  id: number;
  agent_slug: string;
  status: string;
  sent_count: number;
  received_count: number;
  created_at: string;
}

function lifecycleButtons(base: string, status: string): string {
  const btn = (action: string, label: string, quiet = true) =>
    `<form class="inline" method="post" action="${base}/${action}"><button${quiet ? ' class="quiet"' : ""}>${label}</button></form>`;
  if (status === "active") return btn("pause", "Pause") + btn("trash", "Trash");
  if (status === "paused") return btn("unpause", "Unpause") + btn("trash", "Trash");
  return btn("untrash", "Untrash");
}

dashboard.get("/dashboard", async (c) => {
  const { user, nav } = await navUser(c);
  if (!user) return c.redirect("/login");

  const rows = (
    await c.env.DB.prepare(
      "SELECT id, agent_slug, status, sent_count, received_count, created_at FROM addresses WHERE principal_id = ? ORDER BY agent_slug",
    )
      .bind(user.id)
      .all<AddressRow>()
  ).results;

  const live = rows.filter((r) => r.status !== "trashed");
  const trashed = rows.filter((r) => r.status === "trashed");
  const paused = user.status === "paused";

  const addressTable = (list: AddressRow[]) =>
    list.length === 0
      ? `<p class="note">None.</p>`
      : `<table><tr><th>Agent</th><th>Address</th><th>Status</th><th>Sent</th><th>Received</th><th></th></tr>${list
          .map(
            (r) => `<tr>
  <td><a href="/addresses/${r.id}">${esc(r.agent_slug)}</a></td>
  <td><code>${esc(nameForm(c.env.SERVER_HOST, user.slug, r.agent_slug))}</code></td>
  <td>${statusBadge(r.status)}</td>
  <td>${r.sent_count}</td><td>${r.received_count}</td>
  <td>${lifecycleButtons(`/addresses/${r.id}`, r.status)}</td>
</tr>`,
          )
          .join("")}</table>`;

  return c.html(
    layout(c.env,
      "Addresses",
      `${flash(c.req.query("e"))}${flash(c.req.query("m"), "ok")}
${paused ? flash("your account is paused by the server admin — addresses still receive, but sending and minting are off", "err") : ""}
<h2>Your addresses</h2>
${addressTable(live)}
<h2>Mint a new address</h2>
${
  paused
    ? `<p class="note">Minting is unavailable while your account is paused.</p>`
    : `<form class="stack" method="post" action="/addresses">
  <label>Agent name <span class="note">(lowercase letters, digits, hyphens — e.g. <code>freya</code>, <code>scout</code>)</span>
    <input type="text" name="agent" required pattern="[a-z0-9][a-z0-9-]*" maxlength="32">
  </label>
  ${turnstileWidget(c.env)}
  <button>Mint address</button>
</form>`
}
${
  trashed.length
    ? `<h2>Trash</h2>${addressTable(trashed)}
<form method="post" action="/addresses/trash/empty" onsubmit="return confirm('Permanently delete all trashed addresses and their messages?')"><button>Empty trash</button></form>`
    : ""
}`,
      { user: nav },
    ),
  );
});

dashboard.post("/addresses", async (c) => {
  const { user } = await navUser(c);
  if (!user) return c.redirect("/login");
  if (user.status !== "active") return c.redirect(`/dashboard?e=${encodeURIComponent("account is paused")}`);

  const form = await c.req.parseBody();
  const agent = String(form.agent ?? "").trim().toLowerCase();
  if (!isValidSlug(agent)) return c.redirect(`/dashboard?e=${encodeURIComponent("that agent name isn't available (format or reserved word)")}`);
  if (!(await verifyTurnstile(c.env, String(form["cf-turnstile-response"] ?? ""), c.req.header("cf-connecting-ip")))) {
    return c.redirect(`/dashboard?e=${encodeURIComponent("humanness check failed — please try again")}`);
  }

  const token = randomToken();
  const created = await c.env.DB.prepare(
    "INSERT INTO addresses (principal_id, agent_slug, token_hash) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
  )
    .bind(user.id, agent, await sha256Hex(token))
    .first<{ id: number }>();
  if (!created) return c.redirect(`/dashboard?e=${encodeURIComponent("you already have an address with that agent name")}`);

  const { nav } = await navUser(c);
  return c.html(
    layout(c.env,
      "Address minted",
      `<h2>Address minted</h2>
<p>New address for agent <strong>${esc(agent)}</strong>:</p>
<p><code>${esc(canonicalUrl(c.env.SERVER_HOST, user.slug, agent))}</code><br>
<code>${esc(nameForm(c.env.SERVER_HOST, user.slug, agent))}</code></p>
<div class="reveal">
  <p><strong>Agent API token — shown once, copy it now:</strong></p>
  <p><code>${esc(token)}</code></p>
  <p class="note">Your agent uses it as <code>Authorization: Bearer &lt;token&gt;</code>. If it's lost, regenerate from the address page.</p>
</div>
<p><a href="/addresses/${created.id}">Address details</a> · <a href="/dashboard">Back to addresses</a></p>`,
      { user: nav },
    ),
  );
});

async function ownAddress(c: Parameters<typeof navUser>[0], id: string) {
  const { user, nav } = await navUser(c);
  if (!user) return { user: null, nav: undefined, addr: null };
  const addr = await c.env.DB.prepare(
    "SELECT id, agent_slug, status, sent_count, received_count, created_at FROM addresses WHERE id = ? AND principal_id = ?",
  )
    .bind(Number(id), user.id)
    .first<AddressRow>();
  return { user, nav, addr };
}

dashboard.get("/addresses/:id", async (c) => {
  const { user, nav, addr } = await ownAddress(c, c.req.param("id"));
  if (!user) return c.redirect("/login");
  if (!addr) return c.notFound();

  const messages = (
    await c.env.DB.prepare(
      "SELECT id, direction, peer, ifp_message_id, subject, size, status, created_at FROM messages WHERE address_id = ? ORDER BY id DESC LIMIT 200",
    )
      .bind(addr.id)
      .all<{ id: number; direction: string; peer: string; ifp_message_id: string | null; subject: string | null; size: number; status: string; created_at: string }>()
  ).results;

  const inboxUrl = `${canonicalUrl(c.env.SERVER_HOST, user.slug, addr.agent_slug)}/inbox`;
  return c.html(
    layout(c.env,
      `Address ${addr.agent_slug}`,
      `${flash(c.req.query("e"))}${flash(c.req.query("m"), "ok")}
<h2>${esc(user.slug)}.${esc(addr.agent_slug)} ${statusBadge(addr.status)}</h2>
<p><code>${esc(canonicalUrl(c.env.SERVER_HOST, user.slug, addr.agent_slug))}</code><br>
<code>${esc(nameForm(c.env.SERVER_HOST, user.slug, addr.agent_slug))}</code></p>
<p class="note">Inbox (IFP-6): <code>POST ${esc(inboxUrl)}</code> · Agent API: <code>${esc(c.env.BASE_URL)}/api/v1</code> with this address's bearer token.</p>
<p>${lifecycleButtons(`/addresses/${addr.id}`, addr.status)}
<form class="inline" method="post" action="/addresses/${addr.id}/regen-token" onsubmit="return confirm('Regenerate the API token? The old token stops working immediately.')"><button class="quiet">Regenerate token</button></form></p>
<h2>Messages <span class="note">(${addr.sent_count} sent · ${addr.received_count} received · metadata of last 200)</span></h2>
${
  messages.length === 0
    ? `<p class="note">No messages yet.</p>`
    : `<table><tr><th>Dir</th><th>Peer</th><th>Message id</th><th>Subject</th><th>Bytes</th><th>Status</th><th>At (UTC)</th></tr>${messages
        .map(
          (m) => `<tr><td>${m.direction === "in" ? "→ in" : "out →"}</td><td><code>${esc(m.peer)}</code></td><td><code>${esc(m.ifp_message_id ?? "")}</code></td><td>${esc(m.subject ?? "")}</td><td>${m.size}</td><td>${esc(m.status)}</td><td>${esc(m.created_at)}</td></tr>`,
        )
        .join("")}</table>`
}`,
      { user: nav },
    ),
  );
});

for (const [action, sql] of [
  ["pause", "UPDATE addresses SET status = 'paused' WHERE id = ? AND principal_id = ? AND status = 'active'"],
  ["unpause", "UPDATE addresses SET status = 'active' WHERE id = ? AND principal_id = ? AND status = 'paused'"],
  ["trash", "UPDATE addresses SET status = 'trashed', trashed_at = datetime('now') WHERE id = ? AND principal_id = ? AND status != 'trashed'"],
  ["untrash", "UPDATE addresses SET status = 'active', trashed_at = NULL WHERE id = ? AND principal_id = ? AND status = 'trashed'"],
] as const) {
  dashboard.post(`/addresses/:id/${action}`, async (c) => {
    const { user } = await navUser(c);
    if (!user) return c.redirect("/login");
    await c.env.DB.prepare(sql).bind(Number(c.req.param("id")), user.id).run();
    return c.redirect(c.req.header("referer")?.includes("/addresses/") ? `/addresses/${c.req.param("id")}` : "/dashboard");
  });
}

dashboard.post("/addresses/:id/regen-token", async (c) => {
  const { user, nav, addr } = await ownAddress(c, c.req.param("id"));
  if (!user) return c.redirect("/login");
  if (!addr || addr.status === "trashed") return c.redirect("/dashboard?e=address+unavailable");
  const token = randomToken();
  await c.env.DB.prepare("UPDATE addresses SET token_hash = ? WHERE id = ?").bind(await sha256Hex(token), addr.id).run();
  return c.html(
    layout(c.env,
      "Token regenerated",
      `<h2>Token regenerated</h2>
<div class="reveal">
  <p><strong>New agent API token for ${esc(user.slug)}.${esc(addr.agent_slug)} — shown once:</strong></p>
  <p><code>${esc(token)}</code></p>
</div>
<p><a href="/addresses/${addr.id}">Back to address</a></p>`,
      { user: nav },
    ),
  );
});

dashboard.post("/addresses/trash/empty", async (c) => {
  const { user } = await navUser(c);
  if (!user) return c.redirect("/login");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM messages WHERE address_id IN (SELECT id FROM addresses WHERE principal_id = ? AND status = 'trashed')",
    ).bind(user.id),
    c.env.DB.prepare("DELETE FROM addresses WHERE principal_id = ? AND status = 'trashed'").bind(user.id),
  ]);
  return c.redirect(`/dashboard?m=${encodeURIComponent("trash emptied")}`);
});
