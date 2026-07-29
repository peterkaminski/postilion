import { describe, expect, it } from "vitest";
import { randomPin, randomToken, randomPasscode, dayKeyUTC, isEmail, escapeHtml } from "../src/util";

describe("tokens and pins", () => {
  it("PIN is always 6 digits", () => {
    for (let i = 0; i < 200; i++) expect(randomPin()).toMatch(/^\d{6}$/);
  });
  it("token is 64 hex chars and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).not.toBe(a);
  });
  it("passcode is grouped and avoids ambiguous characters", () => {
    for (let i = 0; i < 50; i++) {
      const p = randomPasscode();
      expect(p).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
      expect(p).not.toMatch(/[01loi]/);
    }
  });
});

describe("dayKeyUTC", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(dayKeyUTC(new Date("2026-07-29T23:59:59Z"))).toBe("2026-07-29");
    expect(dayKeyUTC(new Date("2026-07-29T00:00:00Z"))).toBe("2026-07-29");
    // Just past UTC midnight is the next day regardless of local zone.
    expect(dayKeyUTC(new Date("2026-07-30T00:00:01Z"))).toBe("2026-07-30");
  });
});

describe("isEmail", () => {
  it("accepts normal addresses, rejects junk", () => {
    expect(isEmail("pete@example.com")).toBe(true);
    expect(isEmail("p+tag@sub.example.org")).toBe(true);
    expect(isEmail("nope")).toBe(false);
    expect(isEmail("a b@example.com")).toBe(false);
    expect(isEmail("@example.com")).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes the five specials", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
});
