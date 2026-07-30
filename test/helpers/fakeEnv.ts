// A hand-rolled in-memory D1 stand-in for route tests. Not a SQL engine: it
// pattern-matches the small, fixed set of queries mailbox.ts/quota.ts/
// routes/inbox.ts actually issue and keeps state in plain arrays/maps. Add a
// branch here only when a route under test needs a query this doesn't
// already support.

import type { Env } from "../../src/env";

export interface SeedPrincipal {
  id: number;
  slug: string;
  email: string;
  status?: "active" | "paused" | "trashed";
}

export interface SeedAddress {
  id: number;
  principalId: number;
  agentSlug: string;
  tokenHash: string;
  status?: "active" | "paused" | "trashed";
}

interface MessageRow {
  id: number;
  addressId: number;
  direction: "in" | "out";
  peer: string;
  ifpMessageId: string | null;
  subject: string | null;
  size: number;
  status: string;
  body: string;
}

function makeFakeD1(seed: { principals: SeedPrincipal[]; addresses: SeedAddress[] }) {
  const principals = seed.principals.map((p) => ({ status: "active", ...p }));
  const addresses = seed.addresses.map((a) => ({ status: "active", ...a }));
  const messages: MessageRow[] = [];
  const quotaDays = new Map<string, number>(); // key: `${day}|${scope}`
  const settings = new Map<string, string>(); // unused by tests; queries return no rows
  let nextMessageId = 1;

  function mailboxRow(pred: (a: (typeof addresses)[number]) => boolean) {
    const a = addresses.find(pred);
    if (!a) return null;
    const p = principals.find((pp) => pp.id === a.principalId);
    if (!p) return null;
    return {
      addressId: a.id,
      principalId: p.id,
      principalSlug: p.slug,
      agentSlug: a.agentSlug,
      addressStatus: a.status,
      principalStatus: p.status,
    };
  }

  function exec(sql: string, bound: unknown[]): { row?: unknown; results?: unknown[] } {
    if (sql.includes("WHERE p.slug = ? AND a.agent_slug = ?")) {
      const [slug, agentSlug] = bound as [string, string];
      return { row: mailboxRow((a) => a.agentSlug === agentSlug && principals.find((p) => p.id === a.principalId)?.slug === slug) };
    }
    if (sql.includes("WHERE a.token_hash = ?")) {
      const [tokenHash] = bound as [string];
      return { row: mailboxRow((a) => a.tokenHash === tokenHash) };
    }
    if (sql.includes("SELECT COUNT(*) AS n FROM messages")) {
      const [addressId] = bound as [number];
      const n = messages.filter((m) => m.addressId === addressId && m.direction === "in").length;
      return { row: { n } };
    }
    if (sql.startsWith("INSERT INTO messages") && sql.includes("'in'")) {
      const [addressId, peer, ifpMessageId, subject, size, body] = bound as [number, string, string | null, string | null, number, string];
      messages.push({ id: nextMessageId++, addressId, direction: "in", peer, ifpMessageId, subject, size, status: "received", body });
      return {};
    }
    if (sql.includes("UPDATE addresses SET received_count")) {
      return {}; // counter not read by any query under test
    }
    if (sql.includes("SELECT id FROM messages WHERE address_id = ? AND direction = 'in' AND ifp_message_id = ?")) {
      const [addressId, ifpMessageId] = bound as [number, string];
      const m = messages.find((x) => x.addressId === addressId && x.direction === "in" && x.ifpMessageId === ifpMessageId);
      return { row: m ? { id: m.id } : null };
    }
    if (sql.includes("FROM settings WHERE key IN")) {
      return { results: [...settings.entries()].map(([key, value]) => ({ key, value })) };
    }
    if (sql.includes("FROM quota_days WHERE day = ? AND scope IN")) {
      const [day, scope] = bound as [string, string];
      const results: Array<{ scope: string; count: number }> = [];
      const serverCount = quotaDays.get(`${day}|server`);
      if (serverCount !== undefined) results.push({ scope: "server", count: serverCount });
      if (scope !== "server") {
        const principalCount = quotaDays.get(`${day}|${scope}`);
        if (principalCount !== undefined) results.push({ scope, count: principalCount });
      }
      return { results };
    }
    if (sql.includes("INSERT INTO quota_days")) {
      const [day, scope] = bound as [string, string];
      const key = `${day}|${scope}`;
      quotaDays.set(key, (quotaDays.get(key) ?? 0) + 1);
      return {};
    }
    throw new Error(`fakeEnv: unhandled SQL: ${sql}`);
  }

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        const r = exec(sql, bound);
        return (r.row ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const r = exec(sql, bound);
        return { results: (r.results ?? []) as T[] };
      },
      async run() {
        exec(sql, bound);
        return {} as unknown;
      },
    };
    return stmt;
  }

  async function batch(stmts: Array<{ run: () => Promise<unknown> }>) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }

  return { prepare, batch, _messages: messages };
}

export function createFakeEnv(opts: {
  principals: SeedPrincipal[];
  addresses: SeedAddress[];
  env?: Partial<Env>;
}): Env & { DB: ReturnType<typeof makeFakeD1> } {
  const db = makeFakeD1(opts);
  return {
    DB: db as unknown as Env["DB"] & { _messages: MessageRow[] },
    BASE_URL: "https://mail.example.com",
    SERVER_HOST: "mail.example.com",
    ADMIN_EMAILS: "",
    RETENTION_DAYS: "90",
    MAX_MESSAGE_BYTES: "65536",
    INBOX_MAX: "10000",
    SERVER_DAILY_QUOTA: "1000",
    PRINCIPAL_DAILY_QUOTA: "100",
    TURNSTILE_SITE_KEY: "",
    ...opts.env,
  } as Env & { DB: ReturnType<typeof makeFakeD1> };
}
