// Light IFP-4 validation and construction. v1 checks the envelope essentials
// rather than full schema validation; signatures are stored, not verified
// (PLAN §6). Body parts are untrusted input (IFP-4 §security) — Postilion
// never interprets them, it is storage and transport only.

import { mintMessageId } from "./util";

export interface Ifp4Message {
  ifp: number;
  headers: {
    message_id: string;
    date: string;
    from: { agent: string; display?: string };
    to: Array<{ agent: string; display?: string }>;
    conversation_id: string;
    sequence: number;
    phase: string;
    content_type: string;
    subject?: string;
    [k: string]: unknown;
  };
  body: unknown;
  trace?: unknown;
  security?: unknown;
  [k: string]: unknown;
}

export type IfpCheck = { ok: true; msg: Ifp4Message } | { ok: false; error: string };

export function checkIfp4(raw: unknown): IfpCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "message must be a JSON object" };
  }
  const m = raw as Record<string, unknown>;
  if (m.ifp !== 4) return { ok: false, error: 'missing or unsupported "ifp" version (expected 4)' };
  const h = m.headers as Record<string, unknown> | undefined;
  if (!h || typeof h !== "object") return { ok: false, error: 'missing "headers"' };
  if (typeof h.message_id !== "string" || !h.message_id) return { ok: false, error: "headers.message_id required" };
  if (typeof h.date !== "string") return { ok: false, error: "headers.date required (ISO 8601)" };
  const from = h.from as Record<string, unknown> | undefined;
  if (!from || typeof from.agent !== "string") return { ok: false, error: "headers.from.agent required" };
  const to = h.to;
  if (!Array.isArray(to) || to.length === 0 || to.some((t) => typeof (t as { agent?: unknown })?.agent !== "string")) {
    return { ok: false, error: "headers.to must be a non-empty array of { agent } objects" };
  }
  if (!("body" in m)) return { ok: false, error: 'missing "body"' };
  return { ok: true, msg: m as unknown as Ifp4Message };
}

// Build an IFP-4 message from the agent API's convenience form.
export function buildIfp4(opts: {
  fromAddress: string;
  fromDisplay?: string;
  toAddress: string;
  subject?: string;
  text: string;
  conversationId?: string;
}): Ifp4Message {
  const now = new Date();
  return {
    ifp: 4,
    headers: {
      message_id: mintMessageId(now),
      date: now.toISOString(),
      from: { agent: opts.fromAddress, ...(opts.fromDisplay ? { display: opts.fromDisplay } : {}) },
      to: [{ agent: opts.toAddress }],
      conversation_id: opts.conversationId ?? `conv-${mintMessageId(now)}`,
      sequence: 1,
      phase: "converse",
      content_type: "text/markdown; charset=utf-8",
      ...(opts.subject ? { subject: opts.subject } : {}),
    },
    body: { text: opts.text },
  };
}
