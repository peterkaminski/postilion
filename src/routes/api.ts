// Agent API v1 (PLAN §5.3). Bearer token per address. Sending is a closed
// domain: recipients must be addresses on this server (PLAN §2, decided).

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { intVar } from "../env";
import { parseAddress, isLocal, canonicalUrl, nameForm } from "../address";
import { checkIfp4, buildIfp4, type Ifp4Message } from "../ifp";
import { checkQuota, consumeQuota } from "../quota";
import { lookupMailbox, lookupMailboxByToken, effectiveStatus, inboxCount, storeInbound, type Mailbox } from "../mailbox";
import { sha256Hex } from "../util";

export const api = new Hono<{ Bindings: Env; Variables: { mailbox: Mailbox } }>();

type ApiContext = Context<{ Bindings: Env; Variables: { mailbox: Mailbox } }>;
const err = (c: ApiContext, status: 400 | 401 | 403 | 404 | 410 | 413 | 429, error: string) =>
  c.json({ ok: false, error }, status);

api.use("/api/v1/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(auth);
  if (!m) return err(c, 401, "missing or malformed bearer token");
  const box = await lookupMailboxByToken(c.env, await sha256Hex(m[1].toLowerCase()));
  if (!box) return err(c, 401, "unknown token");
  if (effectiveStatus(box) === "trashed") return err(c, 410, "this address is in the trash");
  c.set("mailbox", box);
  await next();
});

api.get("/api/v1/whoami", (c) => {
  const box = c.get("mailbox");
  return c.json({
    ok: true,
    address: canonicalUrl(c.env.SERVER_HOST, box.principalSlug, box.agentSlug),
    name: nameForm(c.env.SERVER_HOST, box.principalSlug, box.agentSlug),
    principal: box.principalSlug,
    agent: box.agentSlug,
    status: effectiveStatus(box),
    server: c.env.BASE_URL,
  });
});

api.post("/api/v1/send", async (c) => {
  const box = c.get("mailbox");
  if (effectiveStatus(box) !== "active") return err(c, 403, "sending is paused for this address or account");

  const maxBytes = intVar(c.env.MAX_MESSAGE_BYTES, 65536);
  const rawText = await c.req.text();
  if (rawText.length > maxBytes) return err(c, 413, `message too large (max ${maxBytes} bytes)`);
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return err(c, 400, "body must be JSON");
  }

  const p = payload as Record<string, unknown>;
  const senderCanonical = canonicalUrl(c.env.SERVER_HOST, box.principalSlug, box.agentSlug);

  // Two accepted forms: a full IFP-4 message, or {to, text, subject?, conversation_id?}.
  let msg: Ifp4Message;
  let toRaw: string;
  if (p.ifp === 4) {
    const check = checkIfp4(p);
    if (!check.ok) return err(c, 400, `invalid IFP-4 message: ${check.error}`);
    msg = check.msg;
    if (msg.headers.to.length !== 1) return err(c, 400, "exactly one recipient per send in v1");
    toRaw = msg.headers.to[0].agent;
    // The authenticated address is the sender; from is stamped server-side.
    msg.headers.from = { ...msg.headers.from, agent: senderCanonical };
  } else {
    const to = typeof p.to === "string" ? p.to : "";
    const text = typeof p.text === "string" ? p.text : "";
    if (!to || !text) return err(c, 400, 'expected {"to", "text"} or a full IFP-4 message');
    msg = buildIfp4({
      fromAddress: senderCanonical,
      toAddress: to,
      subject: typeof p.subject === "string" ? p.subject : undefined,
      text,
      conversationId: typeof p.conversation_id === "string" ? p.conversation_id : undefined,
    });
    toRaw = to;
  }

  const to = parseAddress(toRaw);
  if (!to) return err(c, 400, `unparseable recipient address: ${toRaw}`);
  if (!isLocal(to, c.env.SERVER_HOST)) {
    return err(c, 403, "this server delivers only to its own addresses (no inter-server delivery in v1)");
  }
  const target = await lookupMailbox(c.env, to.principal, to.agent);
  if (!target) return err(c, 404, "no such address on this server");
  if (effectiveStatus(target) === "trashed") return err(c, 410, "recipient address is gone");
  // Paused recipients still receive (PLAN §5.4).

  const inboxMax = intVar(c.env.INBOX_MAX, 10000);
  if ((await inboxCount(c.env, target.addressId)) >= inboxMax) return err(c, 429, "recipient inbox is full");

  const quota = await checkQuota(c.env, box.principalId);
  if (!quota.allowed) {
    return err(
      c,
      429,
      quota.reason === "server-quota"
        ? `server daily sending quota reached (${quota.serverUsed}/${quota.serverLimit})`
        : `your daily sending quota is reached (${quota.principalUsed}/${quota.principalLimit})`,
    );
  }

  msg.headers.to = [{ agent: canonicalUrl(c.env.SERVER_HOST, to.principal, to.agent) }];
  const body = JSON.stringify(msg);
  if (body.length > maxBytes) return err(c, 413, `message too large (max ${maxBytes} bytes)`);

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO messages (address_id, direction, peer, ifp_message_id, subject, size, status, body) VALUES (?, 'out', ?, ?, ?, ?, 'delivered', ?)",
    ).bind(box.addressId, msg.headers.to[0].agent, msg.headers.message_id, msg.headers.subject ?? null, body.length, body),
    c.env.DB.prepare("UPDATE addresses SET sent_count = sent_count + 1 WHERE id = ?").bind(box.addressId),
    ...storeInbound(c.env, target.addressId, msg.headers.from.agent, msg.headers.message_id, msg.headers.subject ?? null, body),
  ]);
  await consumeQuota(c.env, box.principalId);

  return c.json({ ok: true, message_id: msg.headers.message_id, delivered_to: msg.headers.to[0].agent });
});

api.get("/api/v1/messages", async (c) => {
  const box = c.get("mailbox");
  const sinceId = intVar(c.req.query("since_id"), 0);
  const limit = Math.min(intVar(c.req.query("limit"), 50), 200);
  const direction = c.req.query("direction") === "out" ? "out" : "in";
  const rows = (
    await c.env.DB.prepare(
      "SELECT id, direction, peer, ifp_message_id, subject, size, status, created_at FROM messages WHERE address_id = ? AND direction = ? AND id > ? ORDER BY id LIMIT ?",
    )
      .bind(box.addressId, direction, sinceId, limit)
      .all()
  ).results;
  return c.json({ ok: true, messages: rows });
});

api.get("/api/v1/messages/:id", async (c) => {
  const box = c.get("mailbox");
  const row = await c.env.DB.prepare(
    "SELECT id, direction, peer, ifp_message_id, subject, size, status, body, created_at FROM messages WHERE id = ? AND address_id = ?",
  )
    .bind(Number(c.req.param("id")), box.addressId)
    .first<{ id: number; direction: string; peer: string; ifp_message_id: string | null; subject: string | null; size: number; status: string; body: string; created_at: string }>();
  if (!row) return err(c, 404, "no such message");
  let message: unknown;
  try {
    message = JSON.parse(row.body);
  } catch {
    message = row.body;
  }
  const { body: _body, ...meta } = row;
  return c.json({ ok: true, ...meta, message });
});
