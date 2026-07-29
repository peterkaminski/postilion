import { describe, expect, it } from "vitest";
import { checkIfp4, buildIfp4 } from "../src/ifp";

const valid = {
  ifp: 4,
  headers: {
    message_id: "msg-1",
    date: "2026-07-29T00:00:00Z",
    from: { agent: "https://a.example.com/ifp/alice/helper" },
    to: [{ agent: "https://b.example.com/ifp/bob/scout" }],
    conversation_id: "conv-1",
    sequence: 1,
    phase: "converse",
    content_type: "text/markdown; charset=utf-8",
  },
  body: { text: "hello" },
};

describe("checkIfp4", () => {
  it("accepts a valid message", () => {
    expect(checkIfp4(valid).ok).toBe(true);
  });
  it("rejects non-objects and wrong versions", () => {
    expect(checkIfp4("nope").ok).toBe(false);
    expect(checkIfp4(null).ok).toBe(false);
    expect(checkIfp4([]).ok).toBe(false);
    expect(checkIfp4({ ...valid, ifp: 3 }).ok).toBe(false);
  });
  it("requires envelope essentials", () => {
    const noId = structuredClone(valid) as Record<string, any>;
    delete noId.headers.message_id;
    expect(checkIfp4(noId).ok).toBe(false);

    const noFrom = structuredClone(valid) as Record<string, any>;
    delete noFrom.headers.from;
    expect(checkIfp4(noFrom).ok).toBe(false);

    const emptyTo = structuredClone(valid) as Record<string, any>;
    emptyTo.headers.to = [];
    expect(checkIfp4(emptyTo).ok).toBe(false);

    const noBody = structuredClone(valid) as Record<string, any>;
    delete noBody.body;
    expect(checkIfp4(noBody).ok).toBe(false);
  });
});

describe("buildIfp4", () => {
  it("builds a message that passes checkIfp4", () => {
    const msg = buildIfp4({
      fromAddress: "https://mail.example.com/ifp/pete/freya",
      toAddress: "https://mail.example.com/ifp/pete/saga",
      subject: "hi",
      text: "hello there",
    });
    const check = checkIfp4(msg);
    expect(check.ok).toBe(true);
    expect(msg.headers.subject).toBe("hi");
    expect(msg.headers.content_type).toContain("markdown");
    expect(msg.headers.message_id).toMatch(/^msg-/);
  });
});
