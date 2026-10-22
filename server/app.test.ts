import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
let shop: { id: string; key: string };
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
  shop = await app.project("shop");
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
const frames = (...f: Array<[string, string, boolean?]>) => f.map(([filename, fn, in_app = true]) => ({ filename, function: fn, lineno: 10, in_app }));
const cartError = (over: object = {}) => ({ exception: { type: "TypeError", value: "x is undefined", frames: frames(["lib/x.js", "run", false], ["src/cart.js", "total"], ["src/app.js", "handle"]) }, release: "1.0.0", environment: "production", user: { id: "u1" }, ...over });
const at = (minutes: number) => new Date(app.clock() + minutes * 60_000).toISOString();

describe("projects and keys", () => {
  it("shows a key once, keeps only its hash, and tells projects apart", async () => {
    expect(shop.key).toMatch(/^ek_[0-9a-f]{48}$/);
    const listed = await json(await app.admin("/api/v1/projects"));
    expect(listed.projects).toMatchObject([{ name: "shop", keyPrefix: shop.key.slice(0, 11), unresolved: 0, lastEventAt: null, rateLimit: 600 }]);
    expect(JSON.stringify(listed)).not.toContain(shop.key);
    expect(JSON.stringify(app.db.prepare("SELECT * FROM projects").all())).not.toContain(shop.key);
    expect((await app.admin("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "shop" }) })).status).toBe(409);
    for (const body of [{ name: "bad name" }, { name: "x", rateLimit: 0 }, { name: "x", rateLimit: 1.5 }, { name: "x", extra: 1 }, {}]) {
      expect((await app.admin("/api/v1/projects", { method: "POST", body: JSON.stringify(body) })).status, JSON.stringify(body)).toBe(422);
    }
  });

  it("takes the key as a header or a bearer token, and refuses anything else", async () => {
    expect((await app.send(shop.key, { message: "a" })).status).toBe(201);
    const bearer = await fetch(`${app.base}/api/v1/events`, { method: "POST", body: JSON.stringify({ message: "b" }), headers: { authorization: `Bearer ${shop.key}` } });
    expect(bearer.status).toBe(201);
    for (const key of ["", "ek_wrong", "nope", `${shop.key}0`]) expect((await app.send(key, { message: "c" })).status, key).toBe(401);
    // An admin's token is not a project key: people cannot send events as a project by accident.
    expect((await app.send("test-admin-token", { message: "c" })).status).toBe(401);
    expect((await fetch(`${app.base}/api/v1/events`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("rotates a key and stops the old one at once", async () => {
    const p = await app.project("old-key");
    const rotated = await json(await app.admin(`/api/v1/projects/${p.id}/key`, { method: "POST" }));
    expect(rotated.key).not.toBe(p.key);
    expect((await app.send(p.key, { message: "x" })).status).toBe(401);
    expect((await app.send(rotated.key, { message: "x" })).status).toBe(201);
    expect((await app.admin(`/api/v1/projects/${p.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.send(rotated.key, { message: "x" })).status).toBe(401);
  });
});

describe("events become issues", () => {
  it("groups events, counts them and the people they hit, and keeps the first and last time", async () => {
    const first = await json(await app.send(shop.key, cartError({ timestamp: at(0), user: { id: "u1" } })));
    expect(first).toMatchObject({ issue: { new: true, regression: false } });
    const again = await json(await app.send(shop.key, cartError({ timestamp: at(5), user: { id: "u2" }, exception: { type: "TypeError", value: "y is undefined", frames: frames(["src/cart.js", "total"], ["src/app.js", "handle"]) } })));
    expect(again.issue).toMatchObject({ id: first.issue.id, new: false });
    await app.send(shop.key, cartError({ timestamp: at(9), user: { id: "u2" } }));
    const issues = (await json(await app.admin(`/api/v1/issues?project=${shop.id}&status=unresolved&sort=events`))).issues;
    const cart = issues.find((i: { id: string }) => i.id === first.issue.id);
    expect(cart).toMatchObject({ title: expect.stringContaining("TypeError"), culprit: "handle (src/app.js:10)", events: 3, users: 2, status: "unresolved", firstSeen: at(0), lastSeen: at(9), regression: null, project: { name: "shop" } });
    // The same type somewhere else is another issue.
    const other = await json(await app.send(shop.key, { exception: { type: "TypeError", value: "x", frames: frames(["src/other.js", "go"]) } }));
    expect(other.issue).toMatchObject({ new: true });
  });

  it("keeps the latest 20 events of an issue with their stack traces", async () => {
    const p = await app.project("noisy", 1000);
    let id = "";
    for (let i = 0; i < 25; i++) id = (await json(await app.send(p.key, { message: `Job ${i} failed`, timestamp: at(i), tags: { n: i } }))).issue.id;
    const issue = await json(await app.admin(`/api/v1/issues/${id}`));
    expect(issue.events).toBe(25);
    expect(issue.latestEvents).toHaveLength(20);
    expect(issue.latestEvents[0].timestamp).toBe(at(24));
    expect(issue.latestEvents.at(-1).timestamp).toBe(at(5));
  });

  it("tracks releases, environments and where an issue appeared", async () => {
    const p = await app.project("api");
    const send = (release: string, env: string, over: object = {}) => app.send(p.key, { exception: { type: "Error", value: "boom", frames: frames(["src/a.js", "f"]) }, release, environment: env, ...over });
    const first = await json(await send("1.0.0", "staging"));
    await send("1.1.0", "production");
    await send("1.1.0", "production", { exception: { type: "Other", value: "x", frames: frames(["src/b.js", "g"]) } });
    const issue = await json(await app.admin(`/api/v1/issues/${first.issue.id}`));
    expect(issue.environments).toEqual(["production", "staging"]);
    expect(issue.releases.map((r: { release: string; events: number }) => [r.release, r.events])).toEqual([["1.0.0", 1], ["1.1.0", 1]]);
    expect((await json(await app.admin(`/api/v1/issues?project=${p.id}&release=1.1.0`))).issues).toHaveLength(2);
    expect((await json(await app.admin(`/api/v1/issues?project=${p.id}&release=1.0.0`))).issues).toHaveLength(1);
    expect((await json(await app.admin(`/api/v1/issues?project=${p.id}&environment=staging`))).issues).toHaveLength(1);
    const releases = (await json(await app.admin(`/api/v1/releases?project=${p.id}`))).releases;
    expect(releases.map((r: { release: string; newIssues: number; issues: number }) => [r.release, r.newIssues, r.issues]).sort()).toEqual([["1.0.0", 1, 1], ["1.1.0", 1, 2]]);
  });

  it("never stores request bodies, cookies or the secrets in a message", async () => {
    const p = await app.project("private");
    const sent = await json(await app.send(p.key, { message: "login password=hunter2 failed", request: { url: "https://shop.example.com/login?token=abc", method: "post" }, tags: { session_id: "s-1" } }));
    const dump = JSON.stringify(app.db.prepare("SELECT * FROM events").all()) + JSON.stringify(await json(await app.admin(`/api/v1/issues/${sent.issue.id}`)));
    expect(dump).not.toMatch(/hunter2|token=abc|s-1/);
    expect((await app.send(p.key, { message: "m", request: { url: "https://a.example.com", body: "{}" } })).status).toBe(422);
    expect(await json(await app.send(p.key, { message: "m", cookie: "a=b" }))).toMatchObject({ code: "invalid-event" });
  });

  it("takes gzip, and refuses what is not an event", async () => {
    expect((await app.send(shop.key, gzipSync(JSON.stringify({ message: "zipped" })) as unknown as string, { "content-encoding": "gzip" })).status).toBe(201);
    expect(await json(await app.send(shop.key, "{nope"))).toMatchObject({ code: "invalid-json" });
    expect(await json(await app.send(shop.key, "[]"))).toMatchObject({ code: "invalid-event" });
    expect((await app.send(shop.key, { message: "m" }, { "content-encoding": "br" })).status).toBe(400);
    const big = await app.send(shop.key, JSON.stringify({ message: "x".repeat(1_100_000) }));
    expect([400, 413]).toContain(big.status);
  });
});

describe("resolving and regressions", () => {
  const issueOf = async (key: string, over: object = {}) => (await json(await app.send(key, { exception: { type: "Error", value: "pay", frames: frames(["src/pay.js", "charge"]) }, release: "2.0.0", ...over }))).issue.id as string;
  const patch = (id: string, body: unknown) => app.admin(`/api/v1/issues/${id}`, { method: "PATCH", body: JSON.stringify(body) });

  it("reopens a resolved issue when it happens again, as a regression in the release it came back in", async () => {
    const p = await app.project("pay");
    const id = await issueOf(p.key);
    expect(await json(await patch(id, { status: "resolved", release: "2.1.0" }))).toMatchObject({ status: "resolved", resolvedIn: "2.1.0", regression: null });
    // A resolved issue stays quiet in the list of open ones.
    expect((await json(await app.admin(`/api/v1/issues?project=${p.id}&status=unresolved`))).issues).toEqual([]);
    const back = await json(await app.send(p.key, { exception: { type: "Error", value: "pay", frames: frames(["src/pay.js", "charge"]) }, release: "2.2.0" }));
    expect(back.issue).toMatchObject({ id, new: false, regression: true });
    expect(await json(await app.admin(`/api/v1/issues/${id}`))).toMatchObject({ status: "unresolved", regression: { in: "2.2.0" }, resolvedIn: "2.1.0", resolvedAt: null });
    // The release the fix was meant for stays on the issue, so it reads: fixed in 2.1.0, back in 2.2.0.
    expect((await json(await app.admin("/api/v1/summary"))).regressions).toBeGreaterThanOrEqual(1);
  });

  it("counts it as a regression in the same release too: the fix did not hold", async () => {
    const p = await app.project("pay2");
    const id = await issueOf(p.key);
    await patch(id, { status: "resolved", release: "2.0.0" });
    expect((await json(await app.send(p.key, { exception: { type: "Error", value: "pay", frames: frames(["src/pay.js", "charge"]) }, release: "2.0.0" }))).issue.regression).toBe(true);
    // Resolving again clears the mark.
    expect(await json(await patch(id, { status: "resolved" }))).toMatchObject({ regression: null, resolvedIn: null });
  });

  it("keeps an ignored issue ignored, however often it happens", async () => {
    const p = await app.project("pay3");
    const id = await issueOf(p.key);
    await patch(id, { status: "ignored" });
    expect((await json(await app.send(p.key, { exception: { type: "Error", value: "pay", frames: frames(["src/pay.js", "charge"]) } }))).issue).toMatchObject({ regression: false });
    expect(await json(await app.admin(`/api/v1/issues/${id}`))).toMatchObject({ status: "ignored", events: 2 });
    expect(await json(await patch(id, { status: "unresolved" }))).toMatchObject({ status: "unresolved" });
  });

  it("refuses what is not a status", async () => {
    const p = await app.project("pay4");
    const id = await issueOf(p.key);
    for (const body of [{}, { status: "fixed" }, { status: "ignored", release: "1" }, { status: "resolved", release: "" }, { status: "resolved", extra: 1 }]) expect((await patch(id, body)).status, JSON.stringify(body)).toBe(422);
    expect((await patch("missing", { status: "resolved" })).status).toBe(404);
  });
});

describe("rate limit", () => {
  it("stops a project at its events a minute, says when to try again, and starts a new minute", async () => {
    const p = await app.project("flood", 3);
    for (let i = 0; i < 3; i++) expect((await app.send(p.key, { message: `m${i}` })).status).toBe(201);
    const refused = await app.send(p.key, { message: "one too many" });
    expect(refused.status).toBe(429);
    expect(await json(refused)).toMatchObject({ code: "rate-limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Another project is not slowed down by it.
    expect((await app.send(shop.key, { message: "fine" })).status).toBe(201);
    app.clock.advance(30_000);
    expect(Number((await app.send(p.key, { message: "still" })).headers.get("retry-after"))).toBeLessThanOrEqual(30);
    app.clock.advance(31_000);
    expect((await app.send(p.key, { message: "again" })).status).toBe(201);
    // The limit can change.
    await app.admin(`/api/v1/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ rateLimit: 100 }) });
    for (let i = 0; i < 10; i++) expect((await app.send(p.key, { message: `n${i}` })).status).toBe(201);
    // An event that is refused is not stored.
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM events e JOIN issues i ON i.id = e.issue_id WHERE i.title = 'one too many'").get()).toEqual({ n: 0 });
  });
});

describe("access", () => {
  it("lets viewers read, editors decide and admins manage", async () => {
    const anon = (path: string, init: RequestInit = {}) => fetch(app.base + path, init);
    for (const [m, p] of [["GET", "/api/v1/issues"], ["GET", "/api/v1/projects"], ["POST", "/api/v1/projects"], ["PATCH", "/api/v1/issues/x"], ["GET", "/api/v1/summary"]] as const) {
      expect((await anon(p, { method: m })).status, `${m} ${p}`).toBe(401);
    }
    expect(await json(await anon("/api/v1/version"))).toEqual({ product: "errors", version: "0.1.0" });
    expect((await anon("/healthz")).status).toBe(200);
    const metrics = await (await anon("/metrics")).text();
    expect(metrics).toContain('openasy_build_info{product="errors",version="0.1.0"} 1');
    expect(metrics).toContain('openasy_errors_issues{status="unresolved"}');
  });

  it("deletes an issue and a project with everything under it", async () => {
    const p = await app.project("gone");
    const id = (await json(await app.send(p.key, { message: "bye" }))).issue.id;
    expect((await app.admin(`/api/v1/issues/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.admin(`/api/v1/issues/${id}`)).status).toBe(404);
    await app.send(p.key, { message: "again" });
    expect((await app.admin(`/api/v1/projects/${p.id}`, { method: "DELETE" })).status).toBe(204);
    expect(app.db.prepare("SELECT (SELECT COUNT(*) FROM issues WHERE project_id = ?) + (SELECT COUNT(*) FROM releases WHERE project_id = ?) AS n").get(p.id, p.id)).toEqual({ n: 0 });
  });

  it("purges what is older than the retention", async () => {
    const quiet = await startApp({ version: "0.1.0", errorsOptions: { retentionDays: 30 } });
    const p = await quiet.project("old");
    await quiet.send(p.key, { message: "ancient", timestamp: new Date(quiet.clock() - 40 * 86_400_000).toISOString() });
    await quiet.send(p.key, { message: "recent" });
    quiet.errors.purge();
    expect((await json(await quiet.admin("/api/v1/issues"))).issues.map((i: { title: string }) => i.title)).toEqual(["recent"]);
    await quiet.close();
  });
});
