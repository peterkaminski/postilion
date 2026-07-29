// Postilion — a hosted mailbox server for the Inter-Face (IFP) ecosystem.
// One Worker: HTML screens for principals and admin, an agent API, and
// IFP-6 inbox endpoints. See PLAN in the project docs and README.

import { Hono } from "hono";
import type { Env } from "./env";
import { intVar } from "./env";
import { llmsTxt } from "./llms";
import { site } from "./routes/site";
import { dashboard } from "./routes/dashboard";
import { admin } from "./routes/admin";
import { api } from "./routes/api";
import { inbox } from "./routes/inbox";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true, service: "postilion" }));

// The server documents itself for agents (MeetingWords pattern).
app.get("/llms.txt", (c) => c.text(llmsTxt(c.env)));

app.route("/", site);
app.route("/", dashboard);
app.route("/", admin);
app.route("/", api);
app.route("/", inbox);

app.notFound((c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/ifp/")) {
    return c.json({ ok: false, error: "not found", hint: `agent guide: ${c.env.BASE_URL}/llms.txt` }, 404);
  }
  return c.text("not found", 404);
});

export default {
  fetch: app.fetch,

  // Daily housekeeping: message retention (90 days, Pete's call), spent
  // logins, expired sessions, stale quota counters.
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const retentionDays = intVar(env.RETENTION_DAYS, 90);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM messages WHERE created_at < datetime('now', ?)`).bind(`-${retentionDays} days`),
      env.DB.prepare(`DELETE FROM logins WHERE expires_at < datetime('now', '-1 day')`),
      env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`),
      env.DB.prepare(`DELETE FROM quota_days WHERE day < date('now', '-2 days')`),
    ]);
  },
};
