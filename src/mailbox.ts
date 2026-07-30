// Shared mailbox lookups for the agent API and the IFP-6 inbox.
// Principal state dominates address state (PLAN §5.4).

import type { Context } from "hono";
import type { Env } from "./env";
import { sha256Hex } from "./util";

export interface Mailbox {
  addressId: number;
  principalId: number;
  principalSlug: string;
  agentSlug: string;
  addressStatus: string;
  principalStatus: string;
}

export function effectiveStatus(m: Mailbox): "active" | "paused" | "trashed" {
  if (m.principalStatus === "trashed" || m.addressStatus === "trashed") return "trashed";
  if (m.principalStatus === "paused" || m.addressStatus === "paused") return "paused";
  return "active";
}

export async function lookupMailbox(env: Env, principalSlug: string, agentSlug: string): Promise<Mailbox | null> {
  const row = await env.DB.prepare(
    `SELECT a.id AS addressId, p.id AS principalId, p.slug AS principalSlug, a.agent_slug AS agentSlug,
            a.status AS addressStatus, p.status AS principalStatus
     FROM addresses a JOIN principals p ON p.id = a.principal_id
     WHERE p.slug = ? AND a.agent_slug = ?`,
  )
    .bind(principalSlug, agentSlug)
    .first<Mailbox>();
  return row ?? null;
}

export async function lookupMailboxByToken(env: Env, tokenHash: string): Promise<Mailbox | null> {
  const row = await env.DB.prepare(
    `SELECT a.id AS addressId, p.id AS principalId, p.slug AS principalSlug, a.agent_slug AS agentSlug,
            a.status AS addressStatus, p.status AS principalStatus
     FROM addresses a JOIN principals p ON p.id = a.principal_id
     WHERE a.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<Mailbox>();
  return row ?? null;
}

export type BearerAuthResult =
  | { ok: true; box: Mailbox }
  | { ok: false; status: 401; error: string; hint: string }
  | { ok: false; status: 410; error: string };

// Shared Bearer-token check for the agent API and the IFP-6 inbox: the
// closed trust group means both entry points authenticate the same way
// (an address on this server, by its token). Callers may override the
// missing/unknown-token message to fit their surface; the trashed-address
// message is fixed, matching the rest of the codebase.
export async function authenticateBearer<E extends { Bindings: Env }>(
  c: Context<E>,
  opts: { authError?: string } = {},
): Promise<BearerAuthResult> {
  const auth = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(auth);
  const hint = `agent guide: ${c.env.BASE_URL}/llms.txt`;
  if (!m) return { ok: false, status: 401, error: opts.authError ?? "missing or malformed bearer token", hint };
  const box = await lookupMailboxByToken(c.env, await sha256Hex(m[1].toLowerCase()));
  if (!box) return { ok: false, status: 401, error: opts.authError ?? "unknown token", hint };
  if (effectiveStatus(box) === "trashed") return { ok: false, status: 410, error: "this address is in the trash" };
  return { ok: true, box };
}

export async function inboxCount(env: Env, addressId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE address_id = ? AND direction = 'in'")
    .bind(addressId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Store a received message and bump the counter.
export function storeInbound(
  env: Env,
  addressId: number,
  peer: string,
  ifpMessageId: string | null,
  conversationId: string | null,
  subject: string | null,
  body: string,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "INSERT INTO messages (address_id, direction, peer, ifp_message_id, conversation_id, subject, size, status, body) VALUES (?, 'in', ?, ?, ?, ?, ?, 'received', ?)",
    ).bind(addressId, peer, ifpMessageId, conversationId, subject, body.length, body),
    env.DB.prepare("UPDATE addresses SET received_count = received_count + 1 WHERE id = ?").bind(addressId),
  ];
}
