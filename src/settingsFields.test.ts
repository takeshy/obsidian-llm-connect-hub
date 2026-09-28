import { describe, expect, it } from "vitest";
import { parseHeaderRows } from "./settingsFields";

describe("header fields", () => {
  it("preserves string values, ignores unused rows, and supports deletion", () => {
    const rows = [{ name: " Authorization ", value: "Bearer secret" }, { name: "X-Number", value: "001" }, { name: "", value: "" }];
    expect(parseHeaderRows(rows)).toEqual({ Authorization: "Bearer secret", "X-Number": "001" });
    rows.shift();
    expect(parseHeaderRows(rows)).toEqual({ "X-Number": "001" });
    expect(parseHeaderRows([{ name: "X-Empty", value: "" }])).toEqual({ "X-Empty": "" });
  });
  it("rejects duplicate names regardless of case and malformed input", () => {
    expect(() => parseHeaderRows([{ name: "Authorization", value: "a" }, { name: "authorization", value: "b" }])).toThrow();
    for (const row of [{ name: "", value: "secret" }, { name: "Bad name", value: "a" }, { name: "X-Key", value: "a\r\nb" }]) {
      expect(() => parseHeaderRows([row])).toThrow();
    }
  });
  it("treats special object keys as plain header names", () => {
    const headers = parseHeaderRows([{ name: "__proto__", value: "literal" }]);
    expect(Object.hasOwn(headers, "__proto__")).toBe(true);
    expect(headers.__proto__).toBe("literal");
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
  });
});
