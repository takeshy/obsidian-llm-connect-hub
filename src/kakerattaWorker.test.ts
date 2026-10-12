import { describe, expect, it, vi } from "vitest";
import { pollKakeratta, type KakerattaGenerate } from "./kakerattaWorker";

function fixture(asks: unknown[] = [{ id: "ask-1", status: "pending", claimBy: new Date(Date.now() + 60_000).toISOString() }]) {
  const call = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name === "list_asks") return { asks };
    if (name === "claim_ask") return { ask: { planBy: new Date(Date.now() + 60_000).toISOString() }, context: { persona: { name: "Test" } } };
    if (name === "submit_answer") return { accepted: true };
    return {};
  });
  const generate = vi.fn<KakerattaGenerate>(async () => JSON.stringify({ type: "answer", answer: { text: "Hello", sources: [] } }));
  return { call, generate, controller: new AbortController() };
}

describe("Kakeratta external agent", () => {
  it("does not invoke inference or claim expired / already claimed asks", async () => {
    const f = fixture([{ id: "old", status: "pending", claimBy: new Date(0).toISOString() }, { id: "other", status: "claimed", claimBy: new Date(Date.now() + 60_000).toISOString() }]);
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks"]);
    expect(result).toEqual({ pending: 0, submitted: 0, unsubmitted: 0, errors: [] });
  });
  it("submits the answer with the same host-owned claim ID", async () => {
    const f = fixture();
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    const ids = f.call.mock.calls.find(c => c[0] === "claim_ask")![1];
    expect(f.call).toHaveBeenCalledWith("submit_answer", { ...ids, answer: { text: "Hello", sources: [] } });
    expect(f.call.mock.calls.some(c => c[0] === "release_ask")).toBe(false);
    expect(result).toEqual({ pending: 1, submitted: 1, unsubmitted: 0, errors: [] });
  });
  it("supports context reads and corrects a rejected answer", async () => {
    const f = fixture();
    f.generate.mockResolvedValueOnce(JSON.stringify({ type: "read", steps: [{ type: "notes_list" }] }));
    const original = f.call.getMockImplementation()!;
    let submissions = 0;
    f.call.mockImplementation(async (name, args) => name === "submit_answer" && submissions++ === 0 ? { accepted: false, problems: ["must answer"] } : original(name, args));
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks", "claim_ask", "read_for_ask", "submit_answer", "submit_answer"]);
    expect(result).toEqual({ pending: 1, submitted: 1, unsubmitted: 0, errors: [] });
  });
  it("releases when inference fails", async () => {
    const f = fixture();
    f.generate.mockRejectedValue(new Error("provider failed"));
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(result).toEqual({ pending: 1, submitted: 0, unsubmitted: 1, errors: [expect.any(Error)] });
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("release_ask");
  });
  it("releases an in-flight turn on disable without submitting", async () => {
    const f = fixture();
    f.generate.mockImplementation(async () => { f.controller.abort(); return '{"type":"answer","answer":{"text":"late","sources":[]}}'; });
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks", "claim_ask", "release_ask"]);
    expect(result).toEqual({ pending: 1, submitted: 0, unsubmitted: 1, errors: [] });
  });
  it("bounds malformed output retries and releases", async () => {
    const f = fixture();
    f.generate.mockResolvedValue("not JSON");
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).toHaveBeenCalledTimes(16);
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("release_ask");
    expect(result).toEqual({ pending: 1, submitted: 0, unsubmitted: 1, errors: [] });
  });
  it("records a submit error and releases without repeated submissions", async () => {
    const f = fixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => name === "submit_answer" ? Promise.reject(new Error("submit unavailable")) : original(name, args));
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(result).toEqual({ pending: 1, submitted: 0, unsubmitted: 1, errors: [expect.any(Error)] });
    expect(f.call.mock.calls.filter(c => c[0] === "submit_answer")).toHaveLength(1);
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("release_ask");
  });
  it("never generates after the claim deadline", async () => {
    const f = fixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => name === "claim_ask" ? { ask: { planBy: new Date(0).toISOString() } } : original(name, args));
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("release_ask");
    expect(result).toEqual({ pending: 1, submitted: 0, unsubmitted: 1, errors: [] });
  });
});

describe("Kakeratta direct requests", () => {
  function directFixture(requests: unknown[] = [{ id: "request-1", status: "pending", claimBy: new Date(Date.now() + 60_000).toISOString() }]) {
    const f = fixture([]);
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => {
      if (name === "list_asks") return { asks: [], requests };
      if (name === "claim_request") return { request: { replyBy: new Date(Date.now() + 60_000).toISOString() }, context: { trigger: { text: "@agent help" }, thread: [] } };
      if (name === "reply_request") return { replied: true };
      return original(name, args);
    });
    f.generate.mockResolvedValue('{"type":"reply","text":"Done"}');
    return f;
  }
  it("claims and replies without a persona using host-owned IDs", async () => {
    const f = directFixture();
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    const ids = f.call.mock.calls.find(c => c[0] === "claim_request")![1];
    expect(f.call).toHaveBeenCalledWith("reply_request", { ...ids, text: "Done" });
    expect(f.generate).toHaveBeenCalledWith(expect.any(Array), expect.stringContaining("outside kakeratta's personas"), expect.any(AbortSignal), expect.objectContaining({ trigger: { text: "@agent help" } }));
    expect(result).toEqual({ pending: 1, submitted: 1, unsubmitted: 0, errors: [] });
  });
  it("ignores expired and already claimed direct requests", async () => {
    const f = directFixture([{ id: "old", status: "pending", claimBy: new Date(0).toISOString() }, { id: "claimed", status: "claimed", claimBy: new Date(Date.now() + 60_000).toISOString() }]);
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks"]);
  });
  it("reads and comments using the claim's IDs, blocking unsupported tools", async () => {
    const f = directFixture();
    f.generate.mockResolvedValueOnce('{"type":"read","tool":"reply_request","args":{"text":"unsafe"}}')
      .mockResolvedValueOnce('{"type":"read","tool":"get_thread","args":{"entryId":"entry-1"}}')
      .mockResolvedValueOnce('{"type":"comment","entryId":"entry-1","text":"Correction","claimId":"model-id"}');
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    const ids = f.call.mock.calls.find(c => c[0] === "claim_request")![1];
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks", "claim_request", "get_thread", "comment_on_entry", "reply_request"]);
    expect(f.call).toHaveBeenCalledWith("comment_on_entry", { ...ids, entryId: "entry-1", text: "Correction" });
  });
  it("posts a failure reply when generation fails and never releases a direct request", async () => {
    const f = directFixture();
    f.generate.mockRejectedValue(new Error("provider failed"));
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(result.errors).toHaveLength(1);
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks", "claim_request", "reply_request"]);
  });
  it("does not submit after disable or reprocess a claimed execution", async () => {
    const f = directFixture();
    f.generate.mockImplementation(async () => { f.controller.abort(); return '{"type":"reply","text":"late"}'; });
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(result).toEqual({ pending: 1, submitted: 0, unsubmitted: 1, errors: [] });
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["list_asks", "claim_request"]);
  });
  it("does not replace an ambiguous reply submission with another reply", async () => {
    const f = directFixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => name === "reply_request" ? Promise.reject(new Error("response lost")) : original(name, args));
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.call.mock.calls.filter(c => c[0] === "reply_request")).toHaveLength(1);
    expect(result.unsubmitted).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
  it("bounds malformed output and reports failure to the user", async () => {
    const f = directFixture();
    f.generate.mockResolvedValue("null");
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).toHaveBeenCalledTimes(32);
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("reply_request");
  });
  it("processes persona asks and direct requests in the same poll", async () => {
    const f = directFixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => name === "list_asks" ? {
      asks: [{ id: "ask-1", status: "pending", claimBy: new Date(Date.now() + 60_000).toISOString() }],
      requests: [{ id: "request-1", status: "pending", claimBy: new Date(Date.now() + 60_000).toISOString() }],
    } : original(name, args));
    f.generate.mockImplementation(async (_messages, _system, _signal, context) => JSON.stringify(
      (context as { persona?: unknown }).persona ? { type: "answer", answer: { text: "Persona", sources: [] } } : { type: "reply", text: "Direct" }));
    const result = await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(result).toEqual({ pending: 2, submitted: 2, unsubmitted: 0, errors: [] });
    expect(f.call.mock.calls.filter(c => c[0] === "submit_answer")).toHaveLength(1);
    expect(f.call.mock.calls.filter(c => c[0] === "reply_request")).toHaveLength(1);
  });
  it("does not generate past replyBy and closes the claimed request with a failure reply", async () => {
    const f = directFixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => name === "claim_request" ? { request: { replyBy: new Date(0).toISOString() }, context: {} } : original(name, args));
    await pollKakeratta(f.call, f.generate, f.controller.signal);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("reply_request");
  });
});
