// Shared mailbox lookups for the agent API and the IFP-6 inbox.
// Principal state dominates address state (PLAN §5.4).

import type { Env } from "./env";

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
  subject: string | null,
  body: string,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "INSERT INTO messages (address_id, direction, peer, ifp_message_id, subject, size, status, body) VALUES (?, 'in', ?, ?, ?, ?, 'received', ?)",
    ).bind(addressId, peer, ifpMessageId, subject, body.length, body),
    env.DB.prepare("UPDATE addresses SET received_count = received_count + 1 WHERE id = ?").bind(addressId),
  ];
}
