// Cloudflare Turnstile server-side verification. When TURNSTILE_SECRET is
// unset the check passes (local dev); production sets the secret, and the
// widget only renders when TURNSTILE_SITE_KEY is present.

import type { Env } from "./env";

export async function verifyTurnstile(env: Env, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

export function turnstileWidget(env: Env): string {
  if (!env.TURNSTILE_SITE_KEY) return "";
  return `<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
}
