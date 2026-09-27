import { describe, expect, it, vi } from "vitest";
import { pollKakeratta } from "./kakerattaWorker";

function fixture(asks: unknown[] = [{ id: "ask-1", status: "pending", claimBy: new Date(Date.now() + 60_000).toISOString() }]) {
  const call = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name === "list_asks") return { asks };
    if (name === "claim_ask") return { ask: { planBy: new Date(Date.now() + 60_000).toISOString() }, context: { persona: { name: "Test" } } };
    if (name === "submit_answer") return { accepted: true };
    return {};
  });
  const generate = vi.fn(async () => JSON.stringify({ type: "answer", answer: { text: "Hello", sources: [] } }));
  return { call, generate, controller: new AbortController() };
}

describe("Kakeratta external agent", () => {
  it("does not invoke inference or claim expired / already claimed asks", async () => {
    const f = fixture([{ id: "old", status: "pending", claimBy: new Date(0).toISOString() }, { id: "other", status: "claimed", claimBy: new Date(Date.now() + 60_000).toISOString() }]);
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks"]);
  });
  it("submits the answer with the same host-owned claim ID", async () => {
    const f = fixture();
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    const ids = f.call.mock.calls.find(c => c[0] === "claim_ask")![1];
    expect(f.call).toHaveBeenCalledWith("submit_answer", { ...ids, answer: { text: "Hello", sources: [] } });
    expect(f.call.mock.calls.some(c => c[0] === "release_ask")).toBe(false);
  });
  it("supports context reads and corrects a rejected answer", async () => {
    const f = fixture();
    f.generate.mockResolvedValueOnce(JSON.stringify({ type: "read", steps: [{ type: "notes_list" }] }));
    const original = f.call.getMockImplementation()!;
    let submissions = 0;
    f.call.mockImplementation(async (name, args) => name === "submit_answer" && submissions++ === 0 ? { accepted: false, problems: ["must answer"] } : original(name, args));
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks", "claim_ask", "read_for_ask", "submit_answer", "submit_answer"]);
  });
  it("releases when inference fails", async () => {
    const f = fixture();
    f.generate.mockRejectedValue(new Error("provider failed"));
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("release_ask");
  });
  it("releases an in-flight turn on disable without submitting", async () => {
    const f = fixture();
    f.generate.mockImplementation(async () => { f.controller.abort(); return '{"type":"answer","answer":{"text":"late","sources":[]}}'; });
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks", "claim_ask", "release_ask"]);
  });
  it("bounds malformed output retries and releases", async () => {
    const f = fixture();
    f.generate.mockResolvedValue("not JSON");
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).toHaveBeenCalledTimes(16);
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("release_ask");
  });
  it("never generates after the claim deadline", async () => {
    const f = fixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => name === "claim_ask" ? { ask: { planBy: new Date(0).toISOString() } } : original(name, args));
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("release_ask");
  });
});
