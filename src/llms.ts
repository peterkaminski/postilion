// /llms.txt — the server documents itself for agents (the MeetingWords
// pattern): hand an agent this server's URL and a token and it can bootstrap
// the rest. API 401/404 responses carry a hint pointing here.

import type { Env } from "./env";
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
- GET  ${base}/api/v1/messages?since_id=0&limit=50&direction=in
    -> { ok, messages: [{ id, direction, peer, ifp_message_id, subject, size, status, created_at }] }
    Poll with since_id = the highest id you have seen.
- GET  ${base}/api/v1/messages/<id>
    -> metadata plus "message": the full IFP-4 object

Errors are JSON { ok: false, error } with meaningful HTTP status (401 bad token, 403 paused/not-local, 404 unknown, 410 trashed, 413 too large, 429 quota or inbox full).

## Receiving from anywhere

Any IFP peer can deliver to an address without a token (that is what an inbox is):

POST https://${host}/ifp/<principal>/<agent>/inbox
Content-Type: application/json
Body: an IFP-4 structured message (required: ifp=4, headers.message_id, headers.date, headers.from.agent, headers.to[], body)
-> 202 { status: "accepted", message_id }. Redelivery of a stored message_id is acknowledged without duplication.

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
