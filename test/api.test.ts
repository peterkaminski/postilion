// Agent API v1 against a real SQLite database with the real migrations
// applied — see test/helpers/sqliteEnv.ts for why this one doesn't use the
// pattern-matching fake.

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api } from "../src/routes/api";
import { buildIfp4 } from "../src/ifp";
import { sha256Hex } from "../src/util";
import { applyMigrations, createSqliteEnv, type SeedAddress, type SeedPrincipal } from "./helpers/sqliteEnv";
import type { Env } from "../src/env";

const TOKEN_ALICE = "a".repeat(64);
const TOKEN_BOB = "b".repeat(64);

const ALICE = "https://mail.example.com/ifp/alice/helper";
const BOB = "https://mail.example.com/ifp/bob/scout";

async function seedEnv() {
  const principals: SeedPrincipal[] = [
    { id: 1, slug: "alice", email: "alice@example.com" },
    { id: 2, slug: "bob", email: "bob@example.com" },
  ];
  const addresses: SeedAddress[] = [
    { id: 1, principalId: 1, agentSlug: "helper", tokenHash: await sha256Hex(TOKEN_ALICE) },
    { id: 2, principalId: 2, agentSlug: "scout", tokenHash: await sha256Hex(TOKEN_BOB) },
  ];
  return createSqliteEnv({ principals, addresses });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

function send(env: Env, token: string, body: unknown, headers: Record<string, string> = {}) {
  return api.request(
    "/api/v1/send",
    { method: "POST", headers: { ...auth(token), ...headers }, body: JSON.stringify(body) },
    env,
  );
}

const get = (env: Env, token: string, path: string) =>
  api.request(path, { headers: { authorization: `Bearer ${token}` } }, env);

const del = (env: Env, token: string, path: string) =>
  api.request(path, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, env);

describe("POST /api/v1/send — idempotency", () => {
  it("without a key, a repeat send is a second delivery", async () => {
    const env = await seedEnv();
    await send(env, TOKEN_ALICE, { to: BOB, text: "hi" });
    await send(env, TOKEN_ALICE, { to: BOB, text: "hi" });

    const json = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(json.messages).toHaveLength(2);
  });

  it("Idempotency-Key makes a retried convenience send exactly-once", async () => {
    const env = await seedEnv();
    const key = "msg-retry-001";

    const first = (await (await send(env, TOKEN_ALICE, { to: BOB, text: "hi" }, { "idempotency-key": key })).json()) as any;
    const second = (await (await send(env, TOKEN_ALICE, { to: BOB, text: "hi" }, { "idempotency-key": key })).json()) as any;

    expect(first.ok).toBe(true);
    expect(first.message_id).toBe(key);
    expect(first.duplicate).toBeUndefined();

    expect(second.ok).toBe(true);
    expect(second.message_id).toBe(key);
    expect(second.duplicate).toBe(true);
    expect(second.delivered_to).toBe(first.delivered_to);

    const inbox = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(inbox.messages).toHaveLength(1);
    const sent = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?direction=out")).json()) as any;
    expect(sent.messages).toHaveLength(1);
  });

  it("does not charge quota twice for a replay", async () => {
    const env = await seedEnv();
    const key = "msg-quota-001";
    await send(env, TOKEN_ALICE, { to: BOB, text: "hi" }, { "idempotency-key": key });
    await send(env, TOKEN_ALICE, { to: BOB, text: "hi" }, { "idempotency-key": key });

    const row = env.DB._db
      .prepare("SELECT SUM(count) AS n FROM quota_days WHERE scope = 'p:1'")
      .get() as { n: number | null };
    expect(row.n).toBe(1);
  });

  it("a full IFP-4 message dedupes on its own headers.message_id", async () => {
    const env = await seedEnv();
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "hi", messageId: "ifp4-fixed-id" });

    await send(env, TOKEN_ALICE, msg);
    const second = (await (await send(env, TOKEN_ALICE, msg)).json()) as any;
    expect(second.duplicate).toBe(true);

    const inbox = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(inbox.messages).toHaveLength(1);
  });

  it("rejects an Idempotency-Key that contradicts headers.message_id", async () => {
    const env = await seedEnv();
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "hi", messageId: "one" });
    const res = await send(env, TOKEN_ALICE, msg, { "idempotency-key": "two" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/must equal headers.message_id/);
  });

  it("the same key to a different recipient is a different message", async () => {
    const env = await seedEnv();
    const key = "msg-fanout-001";
    await send(env, TOKEN_ALICE, { to: BOB, text: "hi" }, { "idempotency-key": key });
    const selfSend = (await (await send(env, TOKEN_ALICE, { to: ALICE, text: "note to self" }, { "idempotency-key": key })).json()) as any;
    expect(selfSend.duplicate).toBeUndefined();
  });
});

describe("the unique index backstops the pre-check", () => {
  it("refuses a duplicate (mailbox, direction, peer, message_id) row at the schema level", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    db.prepare("INSERT INTO principals (id, slug, email) VALUES (1, 'alice', 'alice@example.com')").run();
    db.prepare("INSERT INTO addresses (id, principal_id, agent_slug, token_hash) VALUES (1, 1, 'helper', 'x')").run();

    const ins = () =>
      db
        .prepare(
          "INSERT INTO messages (address_id, direction, peer, ifp_message_id, size, status, body) VALUES (1, 'out', 'peer-a', 'dup-id', 1, 'delivered', '{}')",
        )
        .run();

    ins();
    expect(ins).toThrow(/UNIQUE|constraint/i);

    // A different peer with the same message_id is not a duplicate — that was
    // the pre-existing flaw the index also fixes.
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (address_id, direction, peer, ifp_message_id, size, status, body) VALUES (1, 'out', 'peer-b', 'dup-id', 1, 'delivered', '{}')",
        )
        .run(),
    ).not.toThrow();
  });

  it("migration 0002 backfills conversation_id out of existing bodies", () => {
    // Apply 0001 only, insert a pre-migration row, then apply 0002.
    const db = new DatabaseSync(":memory:");
    const first = "migrations/0001_init.sql";
    db.exec(readMigration(first));
    db.prepare("INSERT INTO principals (id, slug, email) VALUES (1, 'alice', 'alice@example.com')").run();
    db.prepare("INSERT INTO addresses (id, principal_id, agent_slug, token_hash) VALUES (1, 1, 'helper', 'x')").run();
    const body = JSON.stringify({ ifp: 4, headers: { conversation_id: "conv-legacy" }, body: {} });
    db.prepare(
      "INSERT INTO messages (address_id, direction, peer, ifp_message_id, size, status, body) VALUES (1, 'in', 'p', 'm1', ?, 'received', ?)",
    ).run(body.length, body);

    db.exec(readMigration("migrations/0002_conversations_and_idempotency.sql"));

    const row = db.prepare("SELECT conversation_id FROM messages WHERE id = 1").get() as { conversation_id: string };
    expect(row.conversation_id).toBe("conv-legacy");
  });
});

const readMigration = (rel: string): string =>
  readFileSync(fileURLToPath(new URL("../" + rel, import.meta.url).href), "utf8");

describe("conversations", () => {
  async function seedConversation() {
    const env = await seedEnv();
    await send(env, TOKEN_ALICE, { to: BOB, text: "one", conversation_id: "conv-1", subject: "First" });
    await send(env, TOKEN_BOB, { to: ALICE, text: "two", conversation_id: "conv-1", subject: "Re: First" });
    await send(env, TOKEN_ALICE, { to: BOB, text: "three", conversation_id: "conv-1", subject: "Re: First" });
    await send(env, TOKEN_ALICE, { to: BOB, text: "elsewhere", conversation_id: "conv-2", subject: "Other" });
    return env;
  }

  it("stores conversation_id as a queryable column", async () => {
    const env = await seedConversation();
    const json = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?direction=out")).json()) as any;
    expect(json.messages.map((m: any) => m.conversation_id)).toEqual(["conv-1", "conv-1", "conv-2"]);
  });

  it("filtering by conversation_id returns both sides by default", async () => {
    const env = await seedConversation();
    const json = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?conversation_id=conv-1")).json()) as any;
    expect(json.direction).toBe("all");
    expect(json.messages).toHaveLength(3);
    expect(json.messages.map((m: any) => m.direction)).toEqual(["out", "in", "out"]);
  });

  it("an explicit direction still wins inside a conversation", async () => {
    const env = await seedConversation();
    const json = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?conversation_id=conv-1&direction=in")).json()) as any;
    expect(json.messages).toHaveLength(1);
    expect(json.messages[0].direction).toBe("in");
  });

  it("the plain listing still defaults to 'in'", async () => {
    const env = await seedConversation();
    const json = (await (await get(env, TOKEN_ALICE, "/api/v1/messages")).json()) as any;
    expect(json.direction).toBe("in");
    expect(json.messages.every((m: any) => m.direction === "in")).toBe(true);
  });

  it("GET /api/v1/conversations groups and orders by most recent", async () => {
    const env = await seedConversation();
    const json = (await (await get(env, TOKEN_ALICE, "/api/v1/conversations")).json()) as any;
    expect(json.conversations).toHaveLength(2);

    const [newest, older] = json.conversations;
    expect(newest.conversation_id).toBe("conv-2");
    expect(older.conversation_id).toBe("conv-1");
    expect(older.messages).toBe(3);
    expect(older.sent).toBe(2);
    expect(older.received).toBe(1);
    expect(older.last_subject).toBe("Re: First");
  });
});

describe("POST /api/v1/messages/:id/recall", () => {
  const recall = (env: Env, token: string, id: number) =>
    api.request(`/api/v1/messages/${id}/recall`, { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);

  async function sendAndFindIds(env: Env) {
    await send(env, TOKEN_ALICE, { to: BOB, text: "oops, wrong number" });
    const mine = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?direction=out")).json()) as any;
    const theirs = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    return { outId: mine.messages[0].id, inId: theirs.messages[0].id };
  }

  it("removes the recipient's copy and the sender's own", async () => {
    const env = await seedEnv();
    const { outId } = await sendAndFindIds(env);

    const res = await recall(env, TOKEN_ALICE, outId);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.recalled).toBe(true);
    expect(json.own_copy_deleted).toBe(true);
    expect(json.recipient).toBe(BOB);

    const bobs = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(bobs.messages).toHaveLength(0);
    const alices = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?direction=out")).json()) as any;
    expect(alices.messages).toHaveLength(0);
  });

  it("reports recalled:false — not an error — when the recipient already deleted it", async () => {
    const env = await seedEnv();
    const { outId, inId } = await sendAndFindIds(env);

    // Bob processes and deletes it before Alice thinks better of it.
    await del(env, TOKEN_BOB, `/api/v1/messages/${inId}`);

    const res = await recall(env, TOKEN_ALICE, outId);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.recalled).toBe(false);
    expect(json.reason).toMatch(/already gone/);
  });

  it("404s for a message you never sent — a real error, distinct from 'too late'", async () => {
    const env = await seedEnv();
    const { outId } = await sendAndFindIds(env);
    const res = await recall(env, TOKEN_BOB, outId);
    expect(res.status).toBe(404);
  });

  it("refuses to recall a message you received", async () => {
    const env = await seedEnv();
    const { inId } = await sendAndFindIds(env);
    const res = await recall(env, TOKEN_BOB, inId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/only the sender/);
  });

  it("refuses once the window has passed", async () => {
    const env = createSqliteEnv({
      principals: [
        { id: 1, slug: "alice", email: "alice@example.com" },
        { id: 2, slug: "bob", email: "bob@example.com" },
      ],
      addresses: [
        { id: 1, principalId: 1, agentSlug: "helper", tokenHash: await sha256Hex(TOKEN_ALICE) },
        { id: 2, principalId: 2, agentSlug: "scout", tokenHash: await sha256Hex(TOKEN_BOB) },
      ],
      env: { RECALL_WINDOW_SECONDS: "900" },
    });
    const { outId } = await sendAndFindIds(env);
    // Backdate the send past the window.
    env.DB._db.prepare("UPDATE messages SET created_at = datetime('now', '-1 hour')").run();

    const res = await recall(env, TOKEN_ALICE, outId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/recall window has passed/);

    const bobs = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(bobs.messages).toHaveLength(1);
  });

  it("the default window is hours, not minutes — a 6h-old message is still recallable", async () => {
    const env = await seedEnv(); // no RECALL_WINDOW_SECONDS set
    const { outId } = await sendAndFindIds(env);
    env.DB._db.prepare("UPDATE messages SET created_at = datetime('now', '-6 hours')").run();

    const res = await recall(env, TOKEN_ALICE, outId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).recalled).toBe(true);
  });

  it("the default window still ends — a 13h-old message is not recallable", async () => {
    const env = await seedEnv();
    const { outId } = await sendAndFindIds(env);
    env.DB._db.prepare("UPDATE messages SET created_at = datetime('now', '-13 hours')").run();

    const res = await recall(env, TOKEN_ALICE, outId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/recall window has passed/);
  });

  it("RECALL_WINDOW_SECONDS=0 disables recall entirely", async () => {
    const env = createSqliteEnv({
      principals: [
        { id: 1, slug: "alice", email: "alice@example.com" },
        { id: 2, slug: "bob", email: "bob@example.com" },
      ],
      addresses: [
        { id: 1, principalId: 1, agentSlug: "helper", tokenHash: await sha256Hex(TOKEN_ALICE) },
        { id: 2, principalId: 2, agentSlug: "scout", tokenHash: await sha256Hex(TOKEN_BOB) },
      ],
      env: { RECALL_WINDOW_SECONDS: "0" },
    });
    const { outId } = await sendAndFindIds(env);

    const res = await recall(env, TOKEN_ALICE, outId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/recall is disabled/);

    const bobs = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(bobs.messages).toHaveLength(1);
  });

  // A message_id names one message, so it should not be re-used for different
  // content — a replacement is a new message. What this pins is only that
  // recall leaves no residue: the rows are gone, not tombstoned, so nothing
  // lingering in the unique index blocks a later legitimate send of the same
  // message (here, re-sending the identical thing after recalling it).
  it("leaves no residue — the rows are gone, not tombstoned", async () => {
    const env = await seedEnv();
    const key = "msg-identical-001";
    await send(env, TOKEN_ALICE, { to: BOB, text: "same message" }, { "idempotency-key": key });
    const mine = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?direction=out")).json()) as any;

    await recall(env, TOKEN_ALICE, mine.messages[0].id);

    const again = (await (await send(env, TOKEN_ALICE, { to: BOB, text: "same message" }, { "idempotency-key": key })).json()) as any;
    expect(again.duplicate).toBeUndefined();

    const bobs = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(bobs.messages).toHaveLength(1);
  });
});

describe("DELETE /api/v1/messages/:id", () => {
  it("deletes one message from your own mailbox", async () => {
    const env = await seedEnv();
    await send(env, TOKEN_ALICE, { to: BOB, text: "hi" });
    const list = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    const id = list.messages[0].id;

    const res = await del(env, TOKEN_BOB, `/api/v1/messages/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).deleted).toBe(1);

    const after = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(after.messages).toHaveLength(0);
  });

  it("fails closed: a repeat delete is a 404, not a silent success", async () => {
    const env = await seedEnv();
    await send(env, TOKEN_ALICE, { to: BOB, text: "hi" });
    const list = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    const id = list.messages[0].id;

    await del(env, TOKEN_BOB, `/api/v1/messages/${id}`);
    const again = await del(env, TOKEN_BOB, `/api/v1/messages/${id}`);
    expect(again.status).toBe(404);
  });

  it("fails closed: cannot delete another mailbox's message", async () => {
    const env = await seedEnv();
    await send(env, TOKEN_ALICE, { to: BOB, text: "hi" });
    const bobs = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    const bobsId = bobs.messages[0].id;

    // Alice holds the 'out' copy, Bob the 'in' copy; Alice must not reach Bob's row.
    const res = await del(env, TOKEN_ALICE, `/api/v1/messages/${bobsId}`);
    expect(res.status).toBe(404);

    const still = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(still.messages).toHaveLength(1);
  });

  it("rejects a non-numeric id", async () => {
    const env = await seedEnv();
    const res = await del(env, TOKEN_ALICE, "/api/v1/messages/not-a-number");
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/v1/messages (range) — fail-closed guards", () => {
  async function seedFive() {
    const env = await seedEnv();
    for (let i = 1; i <= 5; i++) await send(env, TOKEN_ALICE, { to: BOB, text: `m${i}` });
    return env;
  }

  it("refuses a bare collection delete — there is no 'delete everything'", async () => {
    const env = await seedFive();
    const res = await del(env, TOKEN_BOB, "/api/v1/messages");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/through_id is required/);

    const after = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(after.messages).toHaveLength(5);
  });

  it("refuses a range delete with no direction", async () => {
    const env = await seedFive();
    const res = await del(env, TOKEN_BOB, "/api/v1/messages?through_id=3");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/direction is required/);

    const after = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(after.messages).toHaveLength(5);
  });

  it("rejects a non-positive through_id", async () => {
    const env = await seedFive();
    expect((await del(env, TOKEN_BOB, "/api/v1/messages?through_id=0&direction=in")).status).toBe(400);
    expect((await del(env, TOKEN_BOB, "/api/v1/messages?through_id=abc&direction=in")).status).toBe(400);
  });

  it("deletes through the cursor and leaves later messages alone", async () => {
    const env = await seedFive();
    const before = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    const third = before.messages[2].id;

    const res = await del(env, TOKEN_BOB, `/api/v1/messages?through_id=${third}&direction=in`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.deleted).toBe(3);
    expect(json.through_id).toBe(third);

    const after = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(after.messages).toHaveLength(2);
  });

  it("direction scopes the delete — clearing the inbox spares the sent copies", async () => {
    const env = await seedFive();
    const alicesSent = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?direction=out")).json()) as any;
    const highest = alicesSent.messages[alicesSent.messages.length - 1].id;

    await del(env, TOKEN_ALICE, `/api/v1/messages?through_id=${highest}&direction=in`);

    const stillSent = (await (await get(env, TOKEN_ALICE, "/api/v1/messages?direction=out")).json()) as any;
    expect(stillSent.messages).toHaveLength(5);
  });

  it("can be scoped to one conversation", async () => {
    const env = await seedEnv();
    await send(env, TOKEN_ALICE, { to: BOB, text: "a", conversation_id: "keep" });
    await send(env, TOKEN_ALICE, { to: BOB, text: "b", conversation_id: "drop" });
    await send(env, TOKEN_ALICE, { to: BOB, text: "c", conversation_id: "keep" });

    const list = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    const highest = list.messages[list.messages.length - 1].id;

    const res = await del(env, TOKEN_BOB, `/api/v1/messages?through_id=${highest}&direction=in&conversation_id=drop`);
    expect(((await res.json()) as any).deleted).toBe(1);

    const after = (await (await get(env, TOKEN_BOB, "/api/v1/messages")).json()) as any;
    expect(after.messages).toHaveLength(2);
    expect(after.messages.every((m: any) => m.conversation_id === "keep")).toBe(true);
  });
});
