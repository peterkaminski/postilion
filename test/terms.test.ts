import { describe, expect, it } from "vitest";
import { renderMarkdown, DEFAULT_TERMS_MD } from "../src/terms";

describe("renderMarkdown", () => {
  it("renders headings, lists, paragraphs, inline marks", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and *em* text.\n\n- one\n- two [link](https://example.com/x)");
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain('<li>one</li><li>two <a href="https://example.com/x">link</a></li>');
  });
  it("escapes HTML in source", () => {
    const html = renderMarkdown("hello <script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("only links https URLs", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a ");
  });
});

describe("DEFAULT_TERMS_MD", () => {
  it("carries the essential sections", () => {
    for (const marker of [
      "best-effort basis",
      "not a failure mode; it is an explicit design choice",
      "Acceptable use",
      "unencrypted at rest",
      "not** routinely monitor or inspect",
      "as is",
      "Governing law",
      "ask the operator",
    ]) {
      expect(DEFAULT_TERMS_MD).toContain(marker);
    }
  });
  it("renders without empty blocks", () => {
    const html = renderMarkdown(DEFAULT_TERMS_MD);
    expect(html).toContain("<h2>Terms of Service</h2>");
    expect(html).toContain("<h3>Best effort</h3>");
    expect(html).not.toContain("<p></p>");
  });
});
