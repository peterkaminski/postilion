// Agent API v1 (PLAN §5.3). Bearer token per address. Sending is a closed
// domain: recipients must be addresses on this server (PLAN §2, decided).

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { intVar, recallWindowSeconds } from "../env";
import { parseAddress, isLocal, canonicalUrl, nameForm } from "../address";
import { checkIfp4, buildIfp4, type Ifp4Message } from "../ifp";
import { checkQuota, consumeQuota } from "../quota";
import { lookupMailbox, effectiveStatus, inboxCount, storeInbound, authenticateBearer, type Mailbox } from "../mailbox";

export const api = new Hono<{ Bindings: Env; Variables: { mailbox: Mailbox } }>();

type ApiContext = Context<{ Bindings: Env; Variables: { mailbox: Mailbox } }>;
const err = (c: ApiContext, status: 400 | 401 | 403 | 404 | 410 | 413 | 429, error: string) =>
  c.json({ ok: false, error }, status);

api.use("/api/v1/*", async (c, next) => {
  const auth = await authenticateBearer(c);
  if (!auth.ok) {
    return c.json(
      auth.status === 401 ? { ok: false, error: auth.error, hint: auth.hint } : { ok: false, error: auth.error },
      auth.status,
    );
  }
  c.set("mailbox", auth.box);
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

  // Idempotency key == message_id (IFP-6's recommendation, and what the inbound
  // path already keys on). A full IFP-4 message brings its own; the convenience
  // form can set one with the Idempotency-Key header. With neither, the server
  // mints a fresh id and a retry is indistinguishable from a second send — so
  // an agent that cares about exactly-once must supply one.
  const idemKey = (c.req.header("idempotency-key") ?? "").trim();
  if (idemKey.length > 200) return err(c, 400, "Idempotency-Key must be at most 200 characters");

  // Two accepted forms: a full IFP-4 message, or {to, text, subject?, conversation_id?}.
  let msg: Ifp4Message;
  let toRaw: string;
  if (p.ifp === 4) {
    const check = checkIfp4(p);
    if (!check.ok) return err(c, 400, `invalid IFP-4 message: ${check.error}`);
    msg = check.msg;
    if (msg.headers.to.length !== 1) return err(c, 400, "exactly one recipient per send in v1");
    if (idemKey && idemKey !== msg.headers.message_id) {
      return err(c, 400, "Idempotency-Key must equal headers.message_id when sending a full IFP-4 message");
    }
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
      messageId: idemKey || undefined,
    });
    toRaw = to;
  }
  // True when the id came from the caller, so a replay is recognisable.
  const clientKeyed = p.ifp === 4 || Boolean(idemKey);

  const to = parseAddress(toRaw);
  if (!to) return err(c, 400, `unparseable recipient address: ${toRaw}`);
  if (!isLocal(to, c.env.SERVER_HOST)) {
    return err(c, 403, "this server delivers only to its own addresses (no inter-server delivery in v1)");
  }
  const target = await lookupMailbox(c.env, to.principal, to.agent);
  if (!target) return err(c, 404, "no such address on this server");
  if (effectiveStatus(target) === "trashed") return err(c, 410, "recipient address is gone");
  // Paused recipients still receive (PLAN §5.4).

  const toCanonical = canonicalUrl(c.env.SERVER_HOST, to.principal, to.agent);

  // Replay: same message_id, same recipient, already sent. Acknowledge with the
  // original outcome — don't deliver again, don't charge quota again. Mirrors
  // the inbound path's 202-on-redelivery.
  if (clientKeyed) {
    const prior = await c.env.DB.prepare(
      "SELECT id FROM messages WHERE address_id = ? AND direction = 'out' AND peer = ? AND ifp_message_id = ?",
    )
      .bind(box.addressId, toCanonical, msg.headers.message_id)
      .first<{ id: number }>();
    if (prior) {
      return c.json({ ok: true, message_id: msg.headers.message_id, delivered_to: toCanonical, duplicate: true });
    }
  }

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

  msg.headers.to = [{ agent: toCanonical }];
  const body = JSON.stringify(msg);
  if (body.length > maxBytes) return err(c, 413, `message too large (max ${maxBytes} bytes)`);
  const conversationId = typeof msg.headers.conversation_id === "string" ? msg.headers.conversation_id : null;

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO messages (address_id, direction, peer, ifp_message_id, conversation_id, subject, size, status, body) VALUES (?, 'out', ?, ?, ?, ?, ?, 'delivered', ?)",
      ).bind(
        box.addressId,
        toCanonical,
        msg.headers.message_id,
        conversationId,
        msg.headers.subject ?? null,
        body.length,
        body,
      ),
      c.env.DB.prepare("UPDATE addresses SET sent_count = sent_count + 1 WHERE id = ?").bind(box.addressId),
      ...storeInbound(
        c.env,
        target.addressId,
        msg.headers.from.agent,
        msg.headers.message_id,
        conversationId,
        msg.headers.subject ?? null,
        body,
      ),
    ]);
  } catch (e) {
    // Backstop for two concurrent identical sends that both cleared the
    // pre-check: the unique index rejects the second, and the batch is a
    // transaction, so nothing partial was written. Treat it as the replay it is.
    if (clientKeyed && /UNIQUE|constraint/i.test(String(e))) {
      return c.json({ ok: true, message_id: msg.headers.message_id, delivered_to: toCanonical, duplicate: true });
    }
    throw e;
  }
  await consumeQuota(c.env, box.principalId);

  return c.json({ ok: true, message_id: msg.headers.message_id, delivered_to: toCanonical });
});

// direction accepts in | out | all. The plain listing keeps its 'in' default,
// but scoping to a conversation defaults to 'all': a conversation is inherently
// two-sided, and returning half of one is the wrong answer to that question.
function readDirection(c: ApiContext, hasConversation: boolean): "in" | "out" | "all" {
  const d = c.req.query("direction");
  if (d === "in" || d === "out" || d === "all") return d;
  return hasConversation ? "all" : "in";
}

api.get("/api/v1/messages", async (c) => {
  const box = c.get("mailbox");
  const sinceId = intVar(c.req.query("since_id"), 0);
  const limit = Math.min(intVar(c.req.query("limit"), 50), 200);
  const conversationId = c.req.query("conversation_id") || null;
  const direction = readDirection(c, Boolean(conversationId));

  const where = ["address_id = ?", "id > ?"];
  const binds: unknown[] = [box.addressId, sinceId];
  if (direction !== "all") {
    where.push("direction = ?");
    binds.push(direction);
  }
  if (conversationId) {
    where.push("conversation_id = ?");
    binds.push(conversationId);
  }
  binds.push(limit);

  const rows = (
    await c.env.DB.prepare(
      `SELECT id, direction, peer, ifp_message_id, conversation_id, subject, size, status, created_at
         FROM messages WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
    )
      .bind(...binds)
      .all()
  ).results;
  return c.json({ ok: true, direction, conversation_id: conversationId, messages: rows });
});

// Conversations this address is party to, most recently active first. The
// grouping key is IFP-4's headers.conversation_id, which the envelope always
// carried — this endpoint just makes it queryable.
api.get("/api/v1/conversations", async (c) => {
  const box = c.get("mailbox");
  const limit = Math.min(intVar(c.req.query("limit"), 50), 200);
  const rows = (
    await c.env.DB.prepare(
      `SELECT g.conversation_id, g.messages, g.received, g.sent, g.first_at, g.last_at, g.last_id,
              m.subject AS last_subject, m.peer AS last_peer, m.direction AS last_direction
         FROM (SELECT conversation_id,
                      COUNT(*) AS messages,
                      SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS received,
                      SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent,
                      MIN(created_at) AS first_at,
                      MAX(created_at) AS last_at,
                      MAX(id) AS last_id
                 FROM messages
                WHERE address_id = ? AND conversation_id IS NOT NULL
                GROUP BY conversation_id) g
         JOIN messages m ON m.id = g.last_id
        ORDER BY g.last_id DESC LIMIT ?`,
    )
      .bind(box.addressId, limit)
      .all()
  ).results;
  return c.json({ ok: true, conversations: rows });
});

api.get("/api/v1/messages/:id", async (c) => {
  const box = c.get("mailbox");
  const row = await c.env.DB.prepare(
    "SELECT id, direction, peer, ifp_message_id, conversation_id, subject, size, status, body, created_at FROM messages WHERE id = ? AND address_id = ?",
  )
    .bind(Number(c.req.param("id")), box.addressId)
    .first<{ id: number; direction: string; peer: string; ifp_message_id: string | null; conversation_id: string | null; subject: string | null; size: number; status: string; body: string; created_at: string }>();
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

// Recall a sent message: remove the recipient's copy, and your own with it.
//
// The case this is really for is supersession, not typos. An agent that sent a
// partial answer and has since done more work wants the earlier message gone
// before the recipient reads it, because every superseded message left in a
// peer's inbox is material that peer must load and then discard. That is a
// direct cost in someone else's context window. Hence a window measured in
// hours (RECALL_WINDOW_SECONDS, 12h default) rather than the minutes an
// "undo send" button would want — agent work cycles are long.
//
// This is only possible because the sending domain is closed — both copies of
// a message live in this one database, so retraction is a real operation
// rather than the theatre "recall this message" is on SMTP. It is still NOT
// un-delivery. If the recipient's agent already polled the message, it is in
// that agent's context and nothing here reaches it. Recall retracts the
// server's copy, never the knowledge.
//
// Its own path rather than a flag on DELETE: this reaches into someone else's
// mailbox, and the more dangerous action should be the more explicit one.
//
// Both copies go, so "retracted" is a clean state rather than a half-one.
// Quota is not refunded — you did send it.
api.post("/api/v1/messages/:id/recall", async (c) => {
  const box = c.get("mailbox");
  if (effectiveStatus(box) !== "active") return err(c, 403, "recall is paused for this address or account");

  const windowSeconds = recallWindowSeconds(c.env);
  if (windowSeconds === 0) return err(c, 403, "recall is disabled on this server");

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, 400, "message id must be a positive integer");

  // The window is evaluated in SQL so it reads the same clock and the same
  // datetime format the row was written with.
  const row = await c.env.DB.prepare(
    `SELECT id, direction, peer, ifp_message_id, created_at,
            (created_at >= datetime('now', ?)) AS in_window
       FROM messages WHERE id = ? AND address_id = ?`,
  )
    .bind(`-${windowSeconds} seconds`, id, box.addressId)
    .first<{ id: number; direction: string; peer: string; ifp_message_id: string | null; created_at: string; in_window: number }>();

  // A message you never sent is a genuine error, and distinct from a recall
  // that arrived too late.
  if (!row) return err(c, 404, "no such message");
  if (row.direction !== "out") return err(c, 403, "only the sender can recall a message; this one you received");
  if (!row.ifp_message_id) return err(c, 403, "this message has no message_id and cannot be matched to recall");
  if (!row.in_window) {
    return err(c, 403, `the recall window has passed (${windowSeconds}s after sending on this server)`);
  }

  const recipient = parseAddress(row.peer);
  const target = recipient && isLocal(recipient, c.env.SERVER_HOST)
    ? await lookupMailbox(c.env, recipient.principal, recipient.agent)
    : null;

  // Delete the recipient's copy and your own together, so a failure leaves
  // neither half-applied.
  const statements = [c.env.DB.prepare("DELETE FROM messages WHERE id = ? AND address_id = ?").bind(id, box.addressId)];
  if (target) {
    statements.unshift(
      c.env.DB.prepare(
        "DELETE FROM messages WHERE address_id = ? AND direction = 'in' AND peer = ? AND ifp_message_id = ?",
      ).bind(target.addressId, canonicalUrl(c.env.SERVER_HOST, box.principalSlug, box.agentSlug), row.ifp_message_id),
    );
  }
  const results = await c.env.DB.batch(statements);
  const recalled = target ? ((results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0 : false;

  // Deliberately not a 404 and not a silent success: "too late" is a normal,
  // expected outcome that the sender needs to learn. And on a server where
  // agents delete what they have processed, the recipient's copy being gone
  // is itself evidence they read it — the most useful thing this call can say.
  return c.json({
    ok: true,
    recalled,
    message_id: row.ifp_message_id,
    recipient: row.peer,
    own_copy_deleted: true,
    ...(recalled
      ? {}
      : {
          reason: target
            ? "already gone — the recipient's copy was deleted before the recall, which on this server usually means their agent had processed it"
            : "the recipient address no longer exists on this server",
        }),
  });
});

// Delete one message from this mailbox. Fail-closed: the id must name a row
// this address actually holds, or nothing happens and you get a 404 — a repeat
// delete is not quietly reported as success, because "it's gone" and "it was
// never yours" are different answers and an agent should be able to tell them
// apart. Lifetime sent/received counters are deliberately not decremented;
// they record what passed through, not what is still held. Freeing rows does
// free INBOX_MAX headroom.
api.delete("/api/v1/messages/:id", async (c) => {
  const box = c.get("mailbox");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, 400, "message id must be a positive integer");
  const res = await c.env.DB.prepare("DELETE FROM messages WHERE id = ? AND address_id = ?")
    .bind(id, box.addressId)
    .run();
  const deleted = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (!deleted) return err(c, 404, "no such message");
  return c.json({ ok: true, deleted });
});

// Range delete, shaped as the exact complement of the since_id read cursor:
// poll with since_id, process, then delete through the highest id you handled.
//
// Fail-closed throughout. through_id is REQUIRED — a bare DELETE on the
// collection is a 400, never "delete everything". direction is REQUIRED too,
// with no default, because the one mistake this endpoint could make that you
// cannot undo is eating your sent copies when you meant your inbox. Both must
// be said out loud.
api.delete("/api/v1/messages", async (c) => {
  const box = c.get("mailbox");

  const throughRaw = c.req.query("through_id");
  if (throughRaw === undefined) {
    return err(c, 400, "through_id is required (delete through the highest id you have processed)");
  }
  const throughId = Number(throughRaw);
  if (!Number.isInteger(throughId) || throughId <= 0) {
    return err(c, 400, "through_id must be a positive integer");
  }

  const direction = c.req.query("direction");
  if (direction !== "in" && direction !== "out") {
    return err(c, 400, 'direction is required for a range delete and must be "in" or "out"');
  }

  const conversationId = c.req.query("conversation_id") || null;
  const where = ["address_id = ?", "direction = ?", "id <= ?"];
  const binds: unknown[] = [box.addressId, direction, throughId];
  if (conversationId) {
    where.push("conversation_id = ?");
    binds.push(conversationId);
  }

  const res = await c.env.DB.prepare(`DELETE FROM messages WHERE ${where.join(" AND ")}`)
    .bind(...binds)
    .run();
  const deleted = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return c.json({ ok: true, deleted, direction, through_id: throughId, conversation_id: conversationId });
});
