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
  SERVER_DAILY_QUOTA: string;
  PRINCIPAL_DAILY_QUOTA: string;
  TURNSTILE_SITE_KEY: string;
  /** Optional display name for this deployment (instance chrome); the software name is the fallback. */
  INSTANCE_NAME?: string;
  // Secrets
  TURNSTILE_SECRET?: string;
}

export const intVar = (v: string | undefined, fallback: number): number => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const adminEmails = (env: Env): string[] =>
  env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
