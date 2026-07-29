// Address shapes (PLAN §4, decided A + C):
//   A (canonical URL): https://<host>/ifp/<principal>/<agent>
//   C (name form):     ifpmail:<host>/<principal>.<agent>
// Slugs are lowercase alphanumeric + hyphen, 1–32 chars, no edge hyphens.
// The dot in form C is unambiguous because slugs cannot contain dots.

export interface ParsedAddress {
  host: string;
  principal: string;
  agent: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// Slugs that would collide with routes or read as authority.
export const RESERVED_SLUGS = new Set([
  "admin", "api", "auth", "ifp", "ifpmail", "postilion", "static", "www",
  "mail", "root", "system", "abuse", "postmaster", "inbox", "dashboard",
]);

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s) && !RESERVED_SLUGS.has(s);
}

export function parseAddress(input: string): ParsedAddress | null {
  const s = input.trim();

  let m = /^ifpmail:([a-z0-9.-]+(?::\d+)?)\/([a-z0-9-]+)\.([a-z0-9-]+)$/.exec(s);
  if (m) {
    const [, host, principal, agent] = m;
    if (SLUG_RE.test(principal) && SLUG_RE.test(agent)) return { host, principal, agent };
    return null;
  }

  m = /^https:\/\/([a-z0-9.-]+(?::\d+)?)\/ifp\/([a-z0-9-]+)\/([a-z0-9-]+)(?:\/inbox)?\/?$/.exec(s);
  if (m) {
    const [, host, principal, agent] = m;
    if (SLUG_RE.test(principal) && SLUG_RE.test(agent)) return { host, principal, agent };
    return null;
  }

  return null;
}

export function canonicalUrl(host: string, principal: string, agent: string): string {
  return `https://${host}/ifp/${principal}/${agent}`;
}

export function nameForm(host: string, principal: string, agent: string): string {
  return `ifpmail:${host}/${principal}.${agent}`;
}

export function isLocal(addr: ParsedAddress, serverHost: string): boolean {
  return addr.host.toLowerCase() === serverHost.toLowerCase();
}
