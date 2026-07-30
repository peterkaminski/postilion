// A D1-shaped adapter over a real in-memory SQLite database (node:sqlite),
// with the actual migrations/*.sql applied in order.
//
// The sibling fakeEnv.ts pattern-matches a fixed set of queries, which is fine
// for routes that issue a small, known set. It can't help here: the agent API
// builds its WHERE clauses dynamically, and two of the things worth testing —
// the unique index that backstops send idempotency, and the migration's own
// backfill — are properties of the schema rather than of the route code. Those
// only mean something against a real engine.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url).href);

export function applyMigrations(db: DatabaseSync): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) db.exec(readFileSync(MIGRATIONS_DIR + f, "utf8"));
}

// D1 rejects undefined; normalise so a missing optional reads as SQL NULL
// rather than throwing somewhere less obvious.
const norm = (v: unknown): null | number | string | bigint | Uint8Array => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as number | string | bigint | Uint8Array;
};

function makeSqliteD1(db: DatabaseSync) {
  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (db.prepare(sql).get(...bound.map(norm)) as T) ?? null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: db.prepare(sql).all(...bound.map(norm)) as T[] };
      },
      async run() {
        const r = db.prepare(sql).run(...bound.map(norm));
        return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      _sql: sql,
      _bound: () => bound,
    };
    return stmt;
  }

  // D1 batches are transactional: all statements commit together, or none do.
  // The idempotency backstop depends on that, so the shim has to honour it.
  async function batch(stmts: Array<{ run: () => Promise<unknown> }>) {
    db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return { prepare, batch, _db: db };
}

export function createSqliteEnv(opts: {
  principals: SeedPrincipal[];
  addresses: SeedAddress[];
  env?: Partial<Env>;
}): Env & { DB: ReturnType<typeof makeSqliteD1> } {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);

  for (const p of opts.principals) {
    db.prepare("INSERT INTO principals (id, slug, email, status) VALUES (?, ?, ?, ?)").run(
      p.id,
      p.slug,
      p.email,
      p.status ?? "active",
    );
  }
  for (const a of opts.addresses) {
    db.prepare(
      "INSERT INTO addresses (id, principal_id, agent_slug, token_hash, status) VALUES (?, ?, ?, ?, ?)",
    ).run(a.id, a.principalId, a.agentSlug, a.tokenHash, a.status ?? "active");
  }

  return {
    DB: makeSqliteD1(db) as unknown as Env["DB"] & { _db: DatabaseSync },
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
  } as Env & { DB: ReturnType<typeof makeSqliteD1> };
}
