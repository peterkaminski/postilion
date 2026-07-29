import { describe, expect, it } from "vitest";
import { parseAddress, isValidSlug, canonicalUrl, nameForm, isLocal, RESERVED_SLUGS } from "../src/address";

describe("slug validation", () => {
  it("accepts plain slugs", () => {
    expect(isValidSlug("pete")).toBe(true);
    expect(isValidSlug("freya-2")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });
  it("rejects bad shapes", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("-pete")).toBe(false);
    expect(isValidSlug("pete-")).toBe(false);
    expect(isValidSlug("Pete")).toBe(false);
    expect(isValidSlug("pe.te")).toBe(false);
    expect(isValidSlug("x".repeat(33))).toBe(false);
  });
  it("rejects reserved words", () => {
    for (const r of ["admin", "api", "ifp", "postmaster"]) {
      expect(RESERVED_SLUGS.has(r)).toBe(true);
      expect(isValidSlug(r)).toBe(false);
    }
  });
});

describe("parseAddress", () => {
  it("parses the canonical URL form (A)", () => {
    expect(parseAddress("https://mail.example.com/ifp/pete/freya")).toEqual({
      host: "mail.example.com",
      principal: "pete",
      agent: "freya",
    });
  });
  it("parses A with a trailing /inbox or slash", () => {
    expect(parseAddress("https://mail.example.com/ifp/pete/freya/inbox")).toMatchObject({ principal: "pete", agent: "freya" });
    expect(parseAddress("https://mail.example.com/ifp/pete/freya/")).toMatchObject({ principal: "pete", agent: "freya" });
  });
  it("parses the name form (C)", () => {
    expect(parseAddress("ifpmail:mail.example.com/pete.freya")).toEqual({
      host: "mail.example.com",
      principal: "pete",
      agent: "freya",
    });
  });
  it("round-trips with the formatters", () => {
    const a = parseAddress(canonicalUrl("mail.example.com", "pete", "freya"))!;
    const c = parseAddress(nameForm("mail.example.com", "pete", "freya"))!;
    expect(a).toEqual(c);
  });
  it("rejects junk", () => {
    expect(parseAddress("pete.freya")).toBeNull();
    expect(parseAddress("mailto:pete@example.com")).toBeNull();
    expect(parseAddress("http://mail.example.com/ifp/pete/freya")).toBeNull(); // https only
    expect(parseAddress("ifpmail:mail.example.com/pete")).toBeNull();
    expect(parseAddress("ifpmail:mail.example.com/pete.fre.ya")).toBeNull();
  });
  it("is host-exact for locality", () => {
    const addr = parseAddress("ifpmail:mail.example.com/pete.freya")!;
    expect(isLocal(addr, "mail.example.com")).toBe(true);
    expect(isLocal(addr, "MAIL.example.com")).toBe(true);
    expect(isLocal(addr, "other.example.com")).toBe(false);
  });
});
