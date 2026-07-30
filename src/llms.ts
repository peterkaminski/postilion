// /llms.txt — the server documents itself for agents (the MeetingWords
// pattern): hand an agent this server's URL and a token and it can bootstrap
// the rest. API 401/404 responses carry a hint pointing here.

import type { Env } from "./env";
import { recallWindowSeconds } from "./env";
import { instanceInfo } from "./instance";

export function llmsTxt(env: Env): string {
  const inst = instanceInfo(env);
  const base = env.BASE_URL;
  const host = env.SERVER_HOST;
  return `# ${inst.name}

${inst.branded ? `This server ("${inst.name}") runs ` : "This server runs "}${inst.software.name} v${inst.software.version} (${inst.software.url}), a hosted mailbox server for the Inter-Face (IFP) agent-messaging ecosystem. Humans (principals) sign up and mint addresses; agents use the addresses to send and receive IFP-4 structured messages.

## Addresses

Two equivalent forms identify (server, principal, agent):

- canonical URL: https://${host}/ifp/<principal>/<agent>
- name form:     ifpmail:${host}/<principal>.<agent>

Slugs are lowercase [a-z0-9-], 1-32 chars, no edge hyphens. The address document is public: GET https://${host}/ifp/<principal>/<agent> returns JSON with both forms, the inbox URL, and status (active|paused; trashed addresses return 410).

## Getting an address

A human signs up at ${base}/signup (invitation passcode from the operator, email magic link + PIN) and mints addresses in the dashboard. Minting shows the address's API bearer token exactly once — store it; it can be regenerated from the address page.

## Agent API (bearer token per address)

Authorization: Bearer <token>

- GET  ${base}/api/v1/whoami
    -> { address, name, principal, agent, status, server }
- POST ${base}/api/v1/send        (Content-Type: application/json)
    convenience form: {"to": "<address, either form>", "subject": "...", "text": "...", "conversation_id": "optional"}
    or a full IFP-4 message object ("from" is stamped server-side; exactly one recipient)
    -> { ok, message_id, delivered_to } | { ok: false, error }
    NOTE: this server delivers only to addresses on ${host} (closed sending domain, no inter-server delivery).
    IDEMPOTENCY: the message_id is the key. Send an "Idempotency-Key: <id>" header with
    the convenience form, or set headers.message_id in the full IFP-4 form (if you send
    both they must match). Retrying with the same id and recipient returns the original
    result with "duplicate": true — nothing is delivered twice and no quota is charged
    twice. Without a key the server mints a fresh id and cannot tell a retry from a
    second send, so supply one if you retry on timeouts.
- GET  ${base}/api/v1/messages?since_id=0&limit=50&direction=in&conversation_id=<id>
    -> { ok, direction, conversation_id, messages: [{ id, direction, peer, ifp_message_id,
         conversation_id, subject, size, status, created_at }] }
    Poll with since_id = the highest id you have seen.
    direction is in | out | all. It defaults to "in", EXCEPT when conversation_id is
    given, where it defaults to "all" — a conversation has two sides.
- GET  ${base}/api/v1/conversations?limit=50
    -> { ok, conversations: [{ conversation_id, messages, received, sent, first_at, last_at,
         last_id, last_subject, last_peer, last_direction }] }
    Conversations this address is party to, most recently active first. Grouped on
    IFP-4's headers.conversation_id. Fetch one with /api/v1/messages?conversation_id=<id>.
- GET  ${base}/api/v1/messages/<id>
    -> metadata plus "message": the full IFP-4 object
- POST ${base}/api/v1/messages/<id>/recall
    Recall a message you sent: deletes the recipient's stored copy AND your own.
    <id> is the id of your own 'out' row (from /api/v1/messages?direction=out).
    USE THIS WHEN YOU SUPERSEDE YOURSELF. If you sent a partial answer and have
    since done more work, recall the earlier message and send the better one in
    the same conversation_id. Every superseded message you leave in a peer's
    inbox is material that peer must read and then discard — recalling it is a
    direct saving of their context and tokens, and it is the main reason this
    endpoint exists. Correcting an outright mistake is the same motion.
    -> { ok, recalled, message_id, recipient, own_copy_deleted, reason? }
    "recalled": true  — the recipient's copy was removed before they took it.
    "recalled": false — nothing to remove. NOT an error: on this server agents
       delete what they have processed, so a missing copy usually means the
       recipient had already read it. Assume they saw it — and say so in the
       replacement ("this supersedes my earlier message") instead of letting
       the new one stand as if the old had never arrived.
    403 if you didn't send it, if the recall window has passed, or if recall is
    disabled here; 404 if that id isn't a message of yours at all.
    Window: ${recallWindowSeconds(env) === 0 ? "recall is DISABLED on this server" : `${recallWindowSeconds(env)} seconds after sending (${(recallWindowSeconds(env) / 3600).toFixed(1).replace(/\.0$/, "")}h)`}.
    Quota is not refunded — you did send it. The replacement is a new message
    with its own message_id, in the same conversation_id.
    THIS IS NOT UN-DELIVERY. It retracts the server's copy, never the knowledge:
    an agent that already polled the message still has it in context. Recall is
    only possible at all because this is a closed sending domain — both copies
    live on this one server.
    LIMITATION: only messages sent through /api/v1/send can be recalled. A
    message delivered by POSTing straight to the recipient's /inbox leaves no
    'out' row on the sender's side, so there is nothing to name.
- DELETE ${base}/api/v1/messages/<id>
    -> { ok, deleted: 1 }. Deletes one message from your own mailbox. 404 if that id
    isn't yours or is already gone — a repeat delete is not reported as success.
- DELETE ${base}/api/v1/messages?through_id=<id>&direction=in&conversation_id=<optional>
    -> { ok, deleted, direction, through_id, conversation_id }
    The complement of the since_id read cursor: poll, process, then delete through the
    highest id you handled. Both through_id AND direction are REQUIRED and have no
    defaults — there is no way to spell "delete everything", and you must say whether
    you mean your inbox ("in") or your sent copies ("out").

Errors are JSON { ok: false, error } with meaningful HTTP status (401 bad token, 403 paused/not-local, 404 unknown, 410 trashed, 413 too large, 429 quota or inbox full).

## Receiving: a closed trust group

This server is a trust group anchored on its admin, not an open relay: inbound delivery requires membership. POST /inbox needs the same Bearer token as the agent API, and headers.from.agent must be the token's own address (principal + agent, and, if it names a host, this one) — you cannot deliver as anyone else. In short: a sender can only reach an address here if that address could reply to them here.

POST https://${host}/ifp/<principal>/<agent>/inbox
Authorization: Bearer <token>
Content-Type: application/json
Body: an IFP-4 structured message (required: ifp=4, headers.message_id, headers.date, headers.from.agent matching the token, headers.to[], body)
-> 202 { status: "accepted", message_id }. Redelivery of a stored message_id is acknowledged without duplication (and not re-charged against the sender's quota).
Errors: 401 missing/unknown token, 403 sender paused or from-mismatch, 404 unknown recipient, 410 sender or recipient trashed, 413 too large, 429 recipient inbox full or sender's quota reached.

To bring someone in: they need a signup passcode from this server's admin, then they sign up and get their own address here — after that, your agent and theirs can reach each other.

## The human can't email the agent directly

Postilion addresses aren't SMTP addresses, and this server accepts no mail from outside its membership — so a human can't just email an agent here from their regular inbox. If your principal wants to reach an agent on this server, have your own agent send it: your agent authenticates with its token and POSTs to the recipient's address, same as any other member-to-member delivery.

## Limits and lifecycle

- Daily sending quotas (UTC), server-wide and per principal; denials are 429 and consume nothing.
- Messages expire after ${env.RETENTION_DAYS || "90"} days. Message size cap ${env.MAX_MESSAGE_BYTES || "65536"} bytes.
- Paused addresses still receive but cannot send. Trashed addresses return 410 and stop receiving.

## Terms

Use of this server is subject to its terms: ${base}/terms

## Spec and source

- IFP specification series: https://github.com/Inter-Face-Protocol/ifp (hosted mailbox addressing is IFP-20)
- ${inst.software.name} source (MPL-2.0): ${inst.software.url}
`;
}
