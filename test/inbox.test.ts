import { describe, expect, it } from "vitest";
import { inbox } from "../src/routes/inbox";
import { buildIfp4 } from "../src/ifp";
import { sha256Hex } from "../src/util";
import { createFakeEnv, type SeedAddress, type SeedPrincipal } from "./helpers/fakeEnv";

const TOKEN_ALICE = "a".repeat(64);
const TOKEN_BOB = "b".repeat(64);
const TOKEN_CAROL = "c".repeat(64);
const TOKEN_UNKNOWN = "d".repeat(64);

const ALICE = "https://mail.example.com/ifp/alice/helper";
const BOB = "https://mail.example.com/ifp/bob/scout";

async function seedEnv(overrides?: { principals?: Partial<SeedPrincipal>[]; addresses?: Partial<SeedAddress>[]; env?: Record<string, string> }) {
  const principals: SeedPrincipal[] = [
    { id: 1, slug: "alice", email: "alice@example.com", status: "active" },
    { id: 2, slug: "bob", email: "bob@example.com", status: "active" },
    { id: 3, slug: "carol", email: "carol@example.com", status: "paused" },
  ];
  const addresses: SeedAddress[] = [
    { id: 1, principalId: 1, agentSlug: "helper", tokenHash: await sha256Hex(TOKEN_ALICE), status: "active" },
    { id: 2, principalId: 2, agentSlug: "scout", tokenHash: await sha256Hex(TOKEN_BOB), status: "active" },
    { id: 3, principalId: 3, agentSlug: "aide", tokenHash: await sha256Hex(TOKEN_CAROL), status: "active" },
  ];
  return createFakeEnv({ principals, addresses, env: overrides?.env });
}

describe("GET /ifp/:principal/:agent (address document)", () => {
  it("stays public — no auth required", async () => {
    const env = await seedEnv();
    const res = await inbox.request("/ifp/alice/helper", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.address).toBe(ALICE);
    expect(json.status).toBe("active");
  });

  it("404s for an unknown address", async () => {
    const env = await seedEnv();
    const res = await inbox.request("/ifp/nobody/nothing", {}, env);
    expect(res.status).toBe(404);
  });
});

describe("POST /ifp/:principal/:agent/inbox — closed trust group", () => {
  it("rejects with no token: 401, explains the closed-membership model", async () => {
    const env = await seedEnv();
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "hi" });
    const res = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toMatch(/closed trust group/i);
    expect(json.hint).toContain("llms.txt");
  });

  it("rejects a malformed bearer token: 401", async () => {
    const env = await seedEnv();
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "hi" });
    const res = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-hex" }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unknown token: 401", async () => {
    const env = await seedEnv();
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "hi" });
    const res = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_UNKNOWN}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a trashed sender's token: 410", async () => {
    const principals: SeedPrincipal[] = [
      { id: 1, slug: "alice", email: "alice@example.com", status: "trashed" },
      { id: 2, slug: "bob", email: "bob@example.com", status: "active" },
    ];
    const addresses: SeedAddress[] = [
      { id: 1, principalId: 1, agentSlug: "helper", tokenHash: await sha256Hex(TOKEN_ALICE) },
      { id: 2, principalId: 2, agentSlug: "scout", tokenHash: await sha256Hex(TOKEN_BOB) },
    ];
    const env = createFakeEnv({ principals, addresses });
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "hi" });
    const res = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(410);
  });

  it("rejects a paused sender: 403", async () => {
    const env = await seedEnv();
    const msg = buildIfp4({ fromAddress: "https://mail.example.com/ifp/carol/aide", toAddress: BOB, text: "hi" });
    const res = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_CAROL}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error).toMatch(/paused/);
  });

  it("rejects a from/sender mismatch: 403", async () => {
    const env = await seedEnv();
    // Authenticated as alice, but claims to be from bob.
    const msg = buildIfp4({ fromAddress: BOB, toAddress: ALICE, text: "spoofed" });
    const res = await inbox.request(
      "/ifp/alice/helper/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error).toMatch(/from header must match/);
  });

  it("accepts a valid member send: 202, and is idempotent on message_id", async () => {
    const env = await seedEnv();
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "hello bob" });
    const first = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(first.status).toBe(202);
    const firstJson = (await first.json()) as any;
    expect(firstJson.status).toBe("accepted");
    expect(firstJson.message_id).toBe(msg.headers.message_id);

    // Redelivery of the same message_id is accepted but not double-stored.
    const second = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(second.status).toBe(202);
    expect((env.DB as any)._messages.filter((m: any) => m.ifpMessageId === msg.headers.message_id)).toHaveLength(1);
  });

  it("404s when the target address doesn't exist", async () => {
    const env = await seedEnv();
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: "https://mail.example.com/ifp/nobody/nothing", text: "hi" });
    const res = await inbox.request(
      "/ifp/nobody/nothing/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("410s when the target address is trashed", async () => {
    const principals: SeedPrincipal[] = [
      { id: 1, slug: "alice", email: "alice@example.com", status: "active" },
      { id: 2, slug: "bob", email: "bob@example.com", status: "active" },
    ];
    const addresses: SeedAddress[] = [
      { id: 1, principalId: 1, agentSlug: "helper", tokenHash: await sha256Hex(TOKEN_ALICE) },
      { id: 2, principalId: 2, agentSlug: "scout", tokenHash: await sha256Hex(TOKEN_BOB), status: "trashed" },
    ];
    const env = createFakeEnv({ principals, addresses });
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "hi" });
    const res = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(410);
  });

  it("413s an oversized body", async () => {
    const env = await seedEnv({ env: { MAX_MESSAGE_BYTES: "10" } });
    const msg = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "this body is way over the tiny byte cap" });
    const res = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(msg) },
      env,
    );
    expect(res.status).toBe(413);
  });

  it("400s an invalid IFP-4 shape", async () => {
    const env = await seedEnv();
    const res = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify({ not: "ifp4" }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("429s when the recipient's inbox is full", async () => {
    // intVar() treats 0 as "unset" and falls back to the default, so the cap
    // is exercised by filling the (small) real limit rather than zeroing it.
    const env = await seedEnv({ env: { INBOX_MAX: "1" } });
    const first = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "fills the inbox" });
    const r1 = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(first) },
      env,
    );
    expect(r1.status).toBe(202);

    const second = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "one too many" });
    const r2 = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(second) },
      env,
    );
    expect(r2.status).toBe(429);
  });

  it("429s once the sender's daily quota is exhausted, without double-billing dup deliveries", async () => {
    const env = await seedEnv({ env: { PRINCIPAL_DAILY_QUOTA: "1", SERVER_DAILY_QUOTA: "1000" } });
    const first = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "one" });
    const r1 = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(first) },
      env,
    );
    expect(r1.status).toBe(202);

    const second = buildIfp4({ fromAddress: ALICE, toAddress: BOB, text: "two" });
    const r2 = await inbox.request(
      "/ifp/bob/scout/inbox",
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_ALICE}` }, body: JSON.stringify(second) },
      env,
    );
    expect(r2.status).toBe(429);
    const json = (await r2.json()) as any;
    expect(json.error).toMatch(/daily sending quota/);
  });
});
