import { describe, expect, it } from "vitest";
import { fingerprintOf, mask, normalizeMessage, parseEvent, type Event } from "./event.ts";

const now = () => Date.parse("2026-10-22T12:00:00Z");
const parse = (body: unknown) => parseEvent(body, now);
const frame = (filename: string, fn: string, in_app = true, lineno = 1) => ({ filename, function: fn, lineno, in_app });
const trace = (...frames: ReturnType<typeof frame>[]) => ({ type: "TypeError", value: "x is undefined", frames });
const fp = (body: object) => fingerprintOf(parse(body));

describe("parseEvent", () => {
  it("fills what an application leaves out", () => {
    expect(parse({ message: "boom" })).toMatchObject({ level: "error", environment: "production", release: null, userId: null, timestamp: "2026-10-22T12:00:00.000Z", tags: {}, request: null });
  });

  it("keeps only the page of a request, never bodies, cookies or headers", () => {
    expect(parse({ message: "m", request: { url: "https://shop.example.com/cart?token=abc#x", method: "post" } }).request).toEqual({ url: "https://shop.example.com/cart", method: "POST" });
    expect(() => parse({ message: "m", request: { url: "https://a.example.com", body: "{}" } })).toThrow(/bodies, headers and cookies/);
    expect(() => parse({ message: "m", request: { url: "https://a.example.com", headers: {} } })).toThrow();
    expect(() => parse({ message: "m", user: { id: "1", email: "a@b.c" } })).toThrow(/names, emails/);
  });

  it("masks passwords and tokens in messages, values and tags", () => {
    const e = parse({ message: "login failed password=hunter2 for Bearer abcdefghijklmnop", exception: { type: "E", value: "token=abc123 rejected" }, tags: { api_key: "k-123", plan: "secret=zzz" } });
    expect(e.message).not.toMatch(/hunter2|abcdefghijklmnop/);
    expect(e.exception!.value).toBe("token=*** rejected");
    expect(e.tags).toEqual({ api_key: "***", plan: "secret=***" });
    expect(mask("ghp_abcdefghijklmnopqrstu")).toBe("***");
  });

  it("refuses what does not fit the schema", () => {
    for (const body of [[], "x", {}, { message: "m", level: "loud" }, { message: "m", extra: 1 }, { message: "m", timestamp: "yesterday" }, { message: "m", timestamp: "2027-12-01T00:00:00Z" },
      { exception: { frames: [] } }, { exception: { type: "E", frames: "no" } }, { exception: { type: "E", frames: [{ function: "f" }] } }, { message: "m", tags: { "bad key": "1" } },
      { message: "m", fingerprint: [] }, { message: "m", fingerprint: [1] }]) {
      expect(() => parse(body), JSON.stringify(body)).toThrow();
    }
  });
});

describe("grouping", () => {
  const a = trace(frame("node_modules/lib/x.js", "run", false), frame("src/cart.js", "total"), frame("src/app.js", "handle"), frame("src/server.js", "listen"));

  it("groups by exception type and the last three frames of the application's own code", () => {
    const same = fp({ exception: a });
    // A deploy that moves code, other values and frames of libraries do not make a new issue.
    expect(fp({ exception: { ...a, value: "y is undefined", frames: a.frames.map((f) => ({ ...f, lineno: f.lineno + 40 })) } })).toBe(same);
    expect(fp({ exception: { ...a, frames: [frame("other/lib.js", "x", false), ...a.frames] } })).toBe(same);
    // A different place, or a different type, is another issue.
    expect(fp({ exception: { ...a, frames: [...a.frames, frame("src/new.js", "extra")] } })).not.toBe(same);
    expect(fp({ exception: { ...a, type: "RangeError" } })).not.toBe(same);
    // Only the last three count: an earlier frame changing is the same issue.
    expect(fp({ exception: { ...a, frames: [frame("src/start.js", "other"), ...a.frames.slice(1)] } })).toBe(same);
  });

  it("falls back to every frame when none is marked as the application's", () => {
    const t = trace(frame("a.js", "f", false), frame("b.js", "g", false));
    expect(fp({ exception: t })).toBe(fp({ exception: { ...t, value: "other" } }));
    expect(fp({ exception: t })).not.toBe(fp({ exception: trace(frame("a.js", "f", false), frame("c.js", "g", false)) }));
  });

  it("groups an exception without frames, and a message, by what stays the same in them", () => {
    const e = (value: string) => fp({ exception: { type: "DbError", value } });
    expect(e('connection 4412 to "db-1" refused at 0xdeadbeef')).toBe(e('connection 77 to "db-2" refused at 0x1234abcd'));
    expect(e("connection refused")).not.toBe(e("connection reset"));
    expect(fp({ message: "User 12 not found" })).toBe(fp({ message: "User 987 not found" }));
    expect(fp({ message: "User 12 not found" })).not.toBe(fp({ message: "Order 12 not found" }));
    expect(normalizeMessage("id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 took 15ms")).toBe("id <id> took <n>ms");
  });

  it("lets the application decide with its own fingerprint", () => {
    const base = { exception: a };
    expect(fp({ ...base, fingerprint: ["checkout", "cart"] })).toBe(fp({ message: "different", fingerprint: ["checkout", "cart"] }));
    expect(fp({ ...base, fingerprint: ["checkout", "cart"] })).not.toBe(fp(base));
    expect(fp({ ...base, fingerprint: ["a", "b"] })).not.toBe(fp({ ...base, fingerprint: ["a", "c"] }));
  });
});

describe("Event type", () => {
  it("is what fingerprintOf takes", () => {
    const e: Event = parse({ message: "m" });
    expect(fingerprintOf(e)).toMatch(/^[0-9a-f]{32}$/);
  });
});
