// Daily sending quotas, UTC day scope (PLAN §5.5). Server-wide total and a
// uniform per-principal cap; admin overrides live in settings, env vars are
// the defaults. Denials consume no quota. D1 is a single database and these
// are two UPSERTs in a batch — a rare lost race costs at most a message or
// two over quota, which is why v1 needs no Durable Object (PLAN §7).

import type { Env } from "./env";
import { intVar } from "./env";
import { dayKeyUTC } from "./util";

export interface QuotaVerdict {
  allowed: boolean;
  reason?: "server-quota" | "principal-quota";
  serverUsed: number;
  serverLimit: number;
  principalUsed: number;
  principalLimit: number;
}

export async function getQuotaLimits(env: Env): Promise<{ server: number; principal: number }> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('server_daily_quota','principal_daily_quota')",
  ).all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  return {
    server: intVar(map.get("server_daily_quota"), intVar(env.SERVER_DAILY_QUOTA, 1000)),
    principal: intVar(map.get("principal_daily_quota"), intVar(env.PRINCIPAL_DAILY_QUOTA, 100)),
  };
}

export async function checkQuota(env: Env, principalId: number): Promise<QuotaVerdict> {
  const day = dayKeyUTC();
  const limits = await getQuotaLimits(env);
  const rows = await env.DB.prepare(
    "SELECT scope, count FROM quota_days WHERE day = ? AND scope IN ('server', ?)",
  )
    .bind(day, `p:${principalId}`)
    .all<{ scope: string; count: number }>();
  const serverUsed = rows.results.find((r) => r.scope === "server")?.count ?? 0;
  const principalUsed = rows.results.find((r) => r.scope !== "server")?.count ?? 0;

  const base = { serverUsed, serverLimit: limits.server, principalUsed, principalLimit: limits.principal };
  if (serverUsed >= limits.server) return { allowed: false, reason: "server-quota", ...base };
  if (principalUsed >= limits.principal) return { allowed: false, reason: "principal-quota", ...base };
  return { allowed: true, ...base };
}

export async function consumeQuota(env: Env, principalId: number): Promise<void> {
  const day = dayKeyUTC();
  const upsert =
    "INSERT INTO quota_days (day, scope, count) VALUES (?, ?, 1) ON CONFLICT (day, scope) DO UPDATE SET count = count + 1";
  await env.DB.batch([
    env.DB.prepare(upsert).bind(day, "server"),
    env.DB.prepare(upsert).bind(day, `p:${principalId}`),
  ]);
}
