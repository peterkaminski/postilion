// Server-rendered HTML, no SPA (PLAN §7). One layout, small CSS, postal red.
// Header carries the instance name; the footer is the software's attribution
// slot (instance vs software: see src/instance.ts).

import type { Env } from "./env";
import { instanceInfo, SOFTWARE_DOCS_URL } from "./instance";
import { escapeHtml } from "./util";

export { escapeHtml as esc };

export function layout(env: Env, title: string, body: string, opts: { user?: { slug: string; admin: boolean } } = {}): string {
  const inst = instanceInfo(env);
  const nav = opts.user
    ? `<nav>
        <a href="/dashboard">Addresses</a>
        ${opts.user.admin ? '<a href="/admin">Admin</a>' : ""}
        <a href="${SOFTWARE_DOCS_URL}">Docs</a>
        <span class="who">${escapeHtml(opts.user.slug)}</span>
        <form method="post" action="/auth/logout" class="inline"><button class="linkish">Sign out</button></form>
      </nav>`
    : `<nav><a href="/login">Sign in</a> <a href="/signup">Sign up</a> <a href="${SOFTWARE_DOCS_URL}">Docs</a></nav>`;

  const tagline = inst.branded
    ? `runs on ${escapeHtml(inst.software.name)} — an agent-to-agent message server`
    : "an agent-to-agent message server, IFP-shaped";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(inst.name)}</title>
<style>
  :root { --red: #b3001b; --ink: #1a1a1a; --paper: #fbfaf8; --line: #e2ddd5; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
  header { border-bottom: 3px solid var(--red); padding: 0.8rem 1.2rem; display: flex; align-items: baseline; gap: 1.2rem; flex-wrap: wrap; }
  header h1 { font-size: 1.15rem; margin: 0; }
  header h1 a { color: var(--red); text-decoration: none; letter-spacing: 0.02em; }
  header .tag { color: #777; font-size: 0.85rem; }
  nav { margin-left: auto; display: flex; gap: 1rem; align-items: baseline; }
  nav a { color: var(--ink); }
  nav .who { color: #777; font-size: 0.9rem; }
  main { max-width: 60rem; margin: 1.5rem auto; padding: 0 1.2rem; }
  h2 { font-size: 1.25rem; border-bottom: 1px solid var(--line); padding-bottom: 0.3rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.8rem 0; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--line); font-size: 0.95rem; vertical-align: baseline; }
  th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
  code { background: #f1ece4; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.88em; word-break: break-all; }
  form.stack { display: grid; gap: 0.7rem; max-width: 26rem; }
  label { font-size: 0.85rem; color: #555; display: grid; gap: 0.25rem; }
  input[type=text], input[type=email] { padding: 0.45rem 0.6rem; border: 1px solid #bbb; border-radius: 4px; font-size: 1rem; width: 100%; }
  button { background: var(--red); color: white; border: 0; border-radius: 4px; padding: 0.45rem 0.9rem; font-size: 0.95rem; cursor: pointer; }
  button.quiet { background: #6b675f; }
  button.linkish { background: none; color: var(--ink); text-decoration: underline; padding: 0; font-size: inherit; }
  form.inline { display: inline; margin: 0 0.15rem 0 0; }
  .badge { font-size: 0.75rem; padding: 0.1rem 0.45rem; border-radius: 9px; border: 1px solid; }
  .badge.active { color: #1a6b2f; border-color: #1a6b2f; }
  .badge.paused { color: #a06400; border-color: #a06400; }
  .badge.trashed { color: #8a8a8a; border-color: #8a8a8a; }
  .flash { border: 1px solid var(--red); background: #fff3f4; color: var(--red); padding: 0.6rem 0.9rem; border-radius: 4px; margin-bottom: 1rem; }
  .flash.ok { border-color: #1a6b2f; background: #f2faf4; color: #1a6b2f; }
  .note { color: #666; font-size: 0.88rem; }
  .reveal { border: 1px dashed var(--red); background: #fff; padding: 0.8rem 1rem; border-radius: 4px; margin: 0.8rem 0; }
  footer { margin: 3rem 0 1.5rem; text-align: center; color: #999; font-size: 0.8rem; }
  footer a { color: #999; }
</style>
</head>
<body>
<header>
  <h1><a href="/">✉ ${escapeHtml(inst.name)}</a></h1>
  <span class="tag">${tagline}</span>
  ${nav}
</header>
<main>
${body}
</main>
<footer>${env.INSTANCE_OPERATOR ? `${escapeHtml(inst.name)} is operated by ${escapeHtml(env.INSTANCE_OPERATOR)} · ` : ""}<a href="/terms">Terms</a> · <a href="/llms.txt">llms.txt</a><br>This server runs <a href="${inst.software.url}">${escapeHtml(inst.software.name)}</a> v${escapeHtml(inst.software.version)} — open source under MPL-2.0. <span title='A postilion rides just one horse of the team: one rider, one horse, one L.'>&ldquo;${escapeHtml(inst.software.name)}&rdquo;, with one &ldquo;L&rdquo;.</span></footer>
</body>
</html>`;
}

export function flash(msg: string | undefined, kind: "err" | "ok" = "err"): string {
  if (!msg) return "";
  return `<div class="flash${kind === "ok" ? " ok" : ""}">${escapeHtml(msg)}</div>`;
}

export function statusBadge(status: string): string {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}
