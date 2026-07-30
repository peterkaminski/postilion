// IFP-6 endpoints: per-address inbox (POST) and address document (GET).
// Postilion is a closed trust group: a server accepts inbound mail only
// from a sender it could reply to — i.e. another address on this same
// server. POST /inbox therefore requires the same Bearer auth as the agent
// API, and the authenticated sender's address must match the message's
// From header (no delivering-as-someone-else). Paused mailboxes still
// accept (messages wait); trashed return 410.

import { Hono } from "hono";
import type { Env } from "../env";
import { intVar } from "../env";
import { canonicalUrl, nameForm, parseAddress, isLocal } from "../address";
import { checkIfp4 } from "../ifp";
import { checkQuota, consumeQuota } from "../quota";
import { lookupMailbox, effectiveStatus, inboxCount, storeInbound, authenticateBearer } from "../mailbox";

export const inbox = new Hono<{ Bindings: Env }>();

// Public and unauthenticated by design: this is a discovery surface, not a
// membership check. It reveals only that an address exists and its status
// (active|paused|trashed), nothing a stranger couldn't already infer.
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
  const auth = await authenticateBearer(c, {
    authError:
      "this server accepts mail only from its own members (closed trust group) — authenticate with a Bearer token for an address on this server",
  });
  if (!auth.ok) {
    return c.json(auth.status === 401 ? { error: auth.error, hint: auth.hint } : { error: auth.error }, auth.status);
  }
  const sender = auth.box;
  if (effectiveStatus(sender) !== "active") {
    return c.json({ error: "sending is paused for this address or account" }, 403);
  }

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

  // Membership only proves you're some address on this server; the From
  // header must name the address the token actually authenticated as.
  const senderCanonical = canonicalUrl(c.env.SERVER_HOST, sender.principalSlug, sender.agentSlug);
  const from = parseAddress(msg.headers.from.agent);
  if (
    !from ||
    !isLocal(from, c.env.SERVER_HOST) ||
    from.principal !== sender.principalSlug ||
    from.agent !== sender.agentSlug
  ) {
    return c.json({ error: "from header must match the authenticated sender" }, 403);
  }

  if ((await inboxCount(c.env, box.addressId)) >= intVar(c.env.INBOX_MAX, 10000)) {
    return c.json({ error: "inbox full" }, 429);
  }

  // Idempotency on message_id per (mailbox, sender): a redelivered message is
  // accepted but stored (and quota-charged) once (IFP-6 recommends
  // Idempotency-Key = message_id). Keyed on the sender as well as the mailbox,
  // so two peers that happen to choose the same message_id don't collide and
  // get one another's mail swallowed as a phantom "redelivery".
  const dup = await c.env.DB.prepare(
    "SELECT id FROM messages WHERE address_id = ? AND direction = 'in' AND peer = ? AND ifp_message_id = ?",
  )
    .bind(box.addressId, senderCanonical, msg.headers.message_id)
    .first();
  if (dup) return c.json({ status: "accepted", message_id: msg.headers.message_id }, 202);

  // Same daily quota as /api/v1/send: inbound delivery must not be a
  // back-door around a sender's cap.
  const quota = await checkQuota(c.env, sender.principalId);
  if (!quota.allowed) {
    return c.json(
      {
        error:
          quota.reason === "server-quota"
            ? `server daily sending quota reached (${quota.serverUsed}/${quota.serverLimit})`
            : `your daily sending quota is reached (${quota.principalUsed}/${quota.principalLimit})`,
      },
      429,
    );
  }

  await c.env.DB.batch(
    storeInbound(
      c.env,
      box.addressId,
      senderCanonical,
      msg.headers.message_id,
      typeof msg.headers.conversation_id === "string" ? msg.headers.conversation_id : null,
      msg.headers.subject ?? null,
      JSON.stringify(msg),
    ),
  );
  await consumeQuota(c.env, sender.principalId);

  return c.json({ status: "accepted", message_id: msg.headers.message_id }, 202);
});
