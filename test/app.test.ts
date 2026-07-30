// Routing tests against the COMPOSED worker (src/index.ts), not a single
// router in isolation.
//
// api.test.ts calls api.request(...) directly, which proves each handler works
// but says nothing about how the handlers behave once site/dashboard/admin/api/
// inbox are all mounted on one app. That gap is real: a route can pass every
// handler test and still 404 in production because something mounted earlier
// claimed the path first.

import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/util";
import { createSqliteEnv, type SeedAddress, type SeedPrincipal } from "./helpers/sqliteEnv";
import type { Env } from "../src/env";

const TOKEN_ALICE = "a".repeat(64);
const TOKEN_BOB = "b".repeat(64);
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

const ctx = {} as ExecutionContext;

const call = (env: Env, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://mail.example.com${path}`, init), env, ctx);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("composed app — the agent API is reachable through the real worker", () => {
  it("GET /api/v1/whoami", async () => {
    const env = await seedEnv();
    const res = await call(env, "/api/v1/whoami", { headers: bearer(TOKEN_ALICE) });
    expect(res.status).toBe(200);
  });

  it("GET /api/v1/messages", async () => {
    const env = await seedEnv();
    const res = await call(env, "/api/v1/messages", { headers: bearer(TOKEN_ALICE) });
    expect(res.status).toBe(200);
  });

  it("GET /api/v1/conversations", async () => {
    const env = await seedEnv();
    const res = await call(env, "/api/v1/conversations", { headers: bearer(TOKEN_ALICE) });
    expect(res.status).toBe(200);
    expect((await res.json() as any).conversations).toEqual([]);
  });

  it("POST /api/v1/send honours Idempotency-Key end to end", async () => {
    const env = await seedEnv();
    const body = JSON.stringify({ to: BOB, text: "hi" });
    const headers = { ...bearer(TOKEN_ALICE), "content-type": "application/json", "idempotency-key": "app-key-001" };

    const first = (await (await call(env, "/api/v1/send", { method: "POST", headers, body })).json()) as any;
    expect(first.message_id).toBe("app-key-001");

    const second = (await (await call(env, "/api/v1/send", { method: "POST", headers, body })).json()) as any;
    expect(second.duplicate).toBe(true);
  });

  it("POST /api/v1/messages/:id/recall", async () => {
    const env = await seedEnv();
    await call(env, "/api/v1/send", {
      method: "POST",
      headers: { ...bearer(TOKEN_ALICE), "content-type": "application/json" },
      body: JSON.stringify({ to: BOB, text: "hi" }),
    });
    const mine = (await (await call(env, "/api/v1/messages?direction=out", { headers: bearer(TOKEN_ALICE) })).json()) as any;

    const res = await call(env, `/api/v1/messages/${mine.messages[0].id}/recall`, {
      method: "POST",
      headers: bearer(TOKEN_ALICE),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).recalled).toBe(true);
  });

  it("DELETE /api/v1/messages (range) keeps its required-param guards", async () => {
    const env = await seedEnv();
    const res = await call(env, "/api/v1/messages", { method: "DELETE", headers: bearer(TOKEN_ALICE) });
    expect(res.status).toBe(400);
  });
});
