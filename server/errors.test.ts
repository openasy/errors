import { describe, expect, it } from "vitest";
import { lastDays } from "./errors.ts";

describe("lastDays", () => {
  it("names the last days in UTC, today last", () => {
    expect(lastDays(3, Date.parse("2026-11-01T23:59:59.000Z"))).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});
