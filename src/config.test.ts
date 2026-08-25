import { describe, expect, it } from "vitest";
import { isValidApiKey } from "./config.js";

describe("isValidApiKey", () => {
  it("accepts current and historical key formats", () => {
    expect(isValidApiKey("bf_live_1234567890abcdef")).toBe(true);
    expect(isValidApiKey("bf_test_1234567890abcdef")).toBe(true);
    expect(isValidApiKey("bf_1234567890abcdef")).toBe(true);
  });

  it("rejects malformed and oversized keys", () => {
    expect(isValidApiKey("bf_live_short")).toBe(false);
    expect(isValidApiKey(`bf_live_${"a".repeat(129)}`)).toBe(false);
    expect(isValidApiKey("not-a-key")).toBe(false);
  });
});
