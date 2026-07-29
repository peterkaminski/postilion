// IFP-6 endpoints: per-address inbox (POST) and address document (GET).
// Inbound is open to any IFP peer — receiving is what a mailbox is for.
// Paused mailboxes still accept (messages wait); trashed return 410.

import { Hono } from "hono";
import type { Env } from "../env";
import { intVar } from "../env";
import { canonicalUrl, nameForm } from "../address";
import { checkIfp4 } from "../ifp";
import { lookupMailbox, effectiveStatus, inboxCount, storeInbound } from "../mailbox";

export const inbox = new Hono<{ Bindings: Env }>();

inbox.get("/ifp/:principal/:agent", async (c) => {
  const box = await lookupMailbox(c.env, c.req.param("principal"), c.req.param("agent"));
  if (!box) return c.json({ error: "no such address" }, 404);
  const status = effectiveStatus(box);
  if (status === "trashed") return c.json({ error: "gone" }, 410);
  const address = canonicalUrl(c.env.SERVER_HOST, box.principalSlug, box.agentSlug);
  return c.json({
    address,
    name: nameForm(c.env.SERVER_HOST, box.principalSlug, box.agentSlug),
    principal: box.principalSlug,
    agent: box.agentSlug,
    server: c.env.BASE_URL,
    inbox: `${address}/inbox`,
    status,
  });
});

inbox.post("/ifp/:principal/:agent/inbox", async (c) => {
  const box = await lookupMailbox(c.env, c.req.param("principal"), c.req.param("agent"));
  if (!box) return c.json({ error: "no such address" }, 404);
  if (effectiveStatus(box) === "trashed") return c.json({ error: "gone" }, 410);

  const maxBytes = intVar(c.env.MAX_MESSAGE_BYTES, 65536);
  const raw = await c.req.text();
  if (raw.length > maxBytes) return c.json({ error: `message too large (max ${maxBytes} bytes)` }, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "body must be JSON (an IFP-4 structured message)" }, 400);
  }
  const check = checkIfp4(payload);
  if (!check.ok) return c.json({ error: `invalid IFP-4 message: ${check.error}` }, 400);
  const msg = check.msg;

  if ((await inboxCount(c.env, box.addressId)) >= intVar(c.env.INBOX_MAX, 10000)) {
    return c.json({ error: "inbox full" }, 429);
  }

  // Idempotency on message_id per mailbox: a redelivered message is accepted
  // but stored once (IFP-6 recommends Idempotency-Key = message_id).
  const dup = await c.env.DB.prepare(
    "SELECT id FROM messages WHERE address_id = ? AND direction = 'in' AND ifp_message_id = ?",
  )
    .bind(box.addressId, msg.headers.message_id)
    .first();
  if (!dup) {
    await c.env.DB.batch(
      storeInbound(c.env, box.addressId, msg.headers.from.agent, msg.headers.message_id, msg.headers.subject ?? null, JSON.stringify(msg)),
    );
  }

  return c.json({ status: "accepted", message_id: msg.headers.message_id }, 202);
});
