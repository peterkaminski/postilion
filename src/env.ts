export interface MailroomSendResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

export interface MailroomBinding {
  send(req: {
    product: string;
    to: string;
    subject: string;
    text: string;
    category: "auth" | "notification" | "digest";
    /** Caller attests the recipient is an existing account holder — mailroom applies its higher known-recipient victim cap. */
    knownHint?: boolean;
  }): Promise<MailroomSendResult>;
}

export interface Env {
  DB: D1Database;
  MAILROOM?: MailroomBinding;
  BASE_URL: string;
  SERVER_HOST: string;
  ADMIN_EMAILS: string;
  RETENTION_DAYS: string;
  MAX_MESSAGE_BYTES: string;
  INBOX_MAX: string;
  /** How long after sending an agent may recall a message, in seconds. "0" disables recall. */
  RECALL_WINDOW_SECONDS?: string;
  SERVER_DAILY_QUOTA: string;
  PRINCIPAL_DAILY_QUOTA: string;
  TURNSTILE_SITE_KEY: string;
  /** Optional display name for this deployment (instance chrome); the software name is the fallback. */
  INSTANCE_NAME?: string;
  /** Optional operator name shown in the footer ("Operated by …") and implied throughout the terms. */
  INSTANCE_OPERATOR?: string;
  /** Optional markdown that fully replaces the shipped default terms at /terms. */
  TERMS_MD?: string;
  // Secrets
  TURNSTILE_SECRET?: string;
}

export const intVar = (v: string | undefined, fallback: number): number => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Recall window in seconds, default 12 hours.
 *
 * Sized for supersession rather than for typos: an agent that has kept working
 * and now has a better answer wants to replace the earlier one before the
 * recipient spends tokens reading material it will have to discard. Agent work
 * cycles run for hours, so a minutes-long window would miss the case the
 * feature exists for. Twelve hours covers an overnight background run and a
 * full working day, and is still a small slice of the 90-day retention, which
 * bounds how far back a peer can rewrite someone's inbox.
 *
 * Unlike the other numeric vars this one has a meaningful zero — "0" turns
 * recall off entirely — so it can't go through intVar, which treats 0 as
 * absent and falls back to the default.
 */
export const recallWindowSeconds = (env: Env): number => {
  const n = parseInt(env.RECALL_WINDOW_SECONDS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 43200;
};

export const adminEmails = (env: Env): string[] =>
  env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
