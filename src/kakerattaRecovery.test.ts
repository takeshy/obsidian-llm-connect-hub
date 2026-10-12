import { describe, expect, it, vi } from "vitest";
import { KakerattaRejectedError, pollKakeratta, type KakerattaCall, type KakerattaGenerate } from "./kakerattaWorker";
import { persistentRequestStore, requestScope, type RequestStore } from "./kakerattaRequestStore";

function disk() {
  const files = new Map<string, string>();
  const adapter = {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => files.get(path)!,
    write: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
  };
  return { files, adapter, reopen: () => persistentRequestStore(adapter, "requests") };
}

function server() {
  let status = "pending";
  let claimId = "";
  let loseClaim = false;
  let replyFailure: "before" | "after" | undefined;
  const entries: Record<string, unknown>[] = [];
  const context = { trigger: { id: "entry-1", text: "@agent help" }, thread: [{ id: "old-reply", speaker: "agent", text: "Done" }] };
  const call = vi.fn<KakerattaCall>(async (name, args) => {
    if (name === "list_asks") return { asks: [], requests: status === "gone" ? [] : [{ id: "request-1", entryId: "entry-1", status, ...(claimId ? { claimId } : {}), claimBy: new Date(Date.now() + 60_000).toISOString() }] };
    if (name === "claim_request") {
      if (claimId && claimId !== args.claimId) throw new Error("Wrong owner");
      claimId = args.claimId as string;
      status = "claimed";
      if (loseClaim) { loseClaim = false; throw new Error("Claim response lost"); }
      return { request: { replyBy: new Date(Date.now() + 60_000).toISOString() }, context };
    }
    if (name === "reply_request") {
      if (replyFailure === "before") { replyFailure = undefined; throw new Error("Transport unavailable"); }
      entries.push({ id: "new-reply", speaker: "agent", replyTo: "entry-1", text: args.text });
      status = "gone";
      if (replyFailure === "after") { replyFailure = undefined; throw new Error("Reply response lost"); }
      return { replied: true };
    }
    if (name === "get_thread") return { entries: [{ id: "old-reply", speaker: "agent", replyTo: "entry-1", text: "Done" }, ...entries] };
    if (name === "list_notes") return { notes: ["remembered.md"] };
    if (name === "comment_on_entry") return { posted: true };
    return {};
  });
  return { call, loseClaim: () => { loseClaim = true; }, loseReply: (when: "before" | "after") => { replyFailure = when; }, revoke: () => { status = "gone"; } };
}

const reply = vi.fn<KakerattaGenerate>(async () => '{"type":"reply","text":"Done"}');
function poll(call: KakerattaCall, generate: KakerattaGenerate, store: RequestStore, signal = new AbortController().signal) {
  return pollKakeratta(call, generate, signal, store);
}

describe("persistent direct request recovery", () => {
  it("persists rejected-read feedback and resumes the model without repeating the invalid read", async () => {
    const d = disk(); const s = server(); const controller = new AbortController();
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (name, args) => {
      if (name === "read_note") throw new KakerattaRejectedError("Missing path");
      return original(name, args);
    });
    const generate = vi.fn<KakerattaGenerate>()
      .mockResolvedValueOnce('{"type":"read","tool":"read_note","args":{"persona":"one","path":"missing.md"}}')
      .mockImplementationOnce(async messages => {
        expect(messages.at(-1)?.content).toContain("Kakeratta rejected this read");
        controller.abort();
        return '{"type":"reply","text":"ignored"}';
      });
    await poll(s.call, generate, d.reopen(), controller.signal);
    const saved = (await d.reopen().list())[0];
    expect(saved.action).toBeUndefined();
    expect(saved.messages.at(-1)?.content).toContain("Kakeratta rejected this read");
    const resumed = vi.fn<KakerattaGenerate>()
      .mockResolvedValueOnce('{"type":"read","tool":"list_notes","args":{"persona":"one"}}')
      .mockResolvedValueOnce('{"type":"reply","text":"Done"}');
    const result = await poll(s.call, resumed, d.reopen());
    expect(result.submitted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(s.call.mock.calls.filter(([name]) => name === "read_note")).toHaveLength(1);
    expect(s.call.mock.calls.filter(([name]) => name === "list_notes")).toHaveLength(1);
  });

  it("retains a read after a transient transport failure and retries it on restart", async () => {
    const d = disk(); const s = server(); const original = s.call.getMockImplementation()!;
    let reads = 0;
    s.call.mockImplementation(async (name, args) => {
      if (name === "read_note") {
        if (++reads === 1) throw new Error("Transport unavailable");
        return { text: "Recovered note" };
      }
      return original(name, args);
    });
    const generate = vi.fn<KakerattaGenerate>()
      .mockResolvedValueOnce('{"type":"read","tool":"read_note","args":{"persona":"one","path":"valid.md"}}')
      .mockImplementationOnce(async messages => {
        expect(messages.at(-1)?.content).toContain("Recovered note");
        return '{"type":"reply","text":"Done"}';
      });
    const first = await poll(s.call, generate, d.reopen());
    expect(first.errors).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await d.reopen().list())[0].action?.tool).toBe("read_note");
    const second = await poll(s.call, generate, d.reopen());
    expect(second.submitted).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(reads).toBe(2);
  });

  it.each([false, true])("awaits persona completion or release after journal loading fails (abort=%s)", async abort => {
    const s = server(); const original = s.call.getMockImplementation()!;
    const journalError = new Error("Journal unavailable");
    const store: RequestStore = { list: async () => { throw journalError; }, save: vi.fn(), remove: vi.fn() };
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    let finish!: (text: string) => void;
    const generation = new Promise<string>(resolve => { finish = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    s.call.mockImplementation(async (name, args) => {
      if (name === "list_asks") return { asks: [{ id: "ask", status: "pending", claimBy: new Date(Date.now() + 60_000).toISOString() }] };
      if (name === "claim_ask") return { ask: { planBy: new Date(Date.now() + 60_000).toISOString() }, context: { persona: { id: "one" } } };
      if (name === "submit_answer") return { accepted: true };
      if (name === "release_ask") { await released; return { released: true }; }
      return original(name, args);
    });
    const generate = vi.fn<KakerattaGenerate>(async () => { start(); return generation; });
    let settled = false;
    const resultPromise = poll(s.call, generate, store, controller.signal);
    void resultPromise.then(() => { settled = true; }, () => { settled = true; });
    await started;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    if (abort) {
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(s.call.mock.calls.some(([name]) => name === "release_ask")).toBe(true);
      expect(settled).toBe(false); // Cleanup must finish before stop() can complete.
      release();
    } else finish('{"type":"answer","answer":{"text":"Done","sources":[]}}');
    const result = await resultPromise;
    expect(result.errors).toEqual([journalError]);
    expect(result.submitted).toBe(abort ? 0 : 1);
    expect(result.unsubmitted).toBe(abort ? 1 : 0);
  });

  it("recovers a lost claim response after restart with exactly the saved claim ID", async () => {
    const d = disk(); const s = server(); s.loseClaim();
    const generate = vi.fn<KakerattaGenerate>(async () => '{"type":"reply","text":"Done"}');
    const first = await poll(s.call, generate, d.reopen());
    expect(first.unsubmitted).toBe(1);
    expect(generate).not.toHaveBeenCalled();
    const saved = (await d.reopen().list())[0];
    const second = await poll(s.call, generate, d.reopen());
    const claims = s.call.mock.calls.filter(([name]) => name === "claim_request");
    expect(claims).toHaveLength(2);
    expect(claims[0][1]).toEqual(claims[1][1]);
    expect(claims[1][1].claimId).toBe(saved.claimId);
    expect(second.submitted).toBe(1);
    expect(await d.reopen().list()).toEqual([]);
  });

  it("does not claim if durable storage fails", async () => {
    const d = disk(); const s = server();
    d.adapter.write.mockRejectedValue(new Error("Disk full"));
    const result = await poll(s.call, reply, d.reopen());
    expect(result.errors).toHaveLength(1);
    expect(s.call.mock.calls.map(([name]) => name)).toEqual(["list_asks"]);
  });

  it("resumes generation with saved read results after stopping and restarting", async () => {
    const d = disk(); const s = server(); const controller = new AbortController();
    const generate = vi.fn<KakerattaGenerate>()
      .mockResolvedValueOnce('{"type":"read","tool":"list_notes","args":{"persona":"one"}}')
      .mockImplementationOnce(async () => { controller.abort(); return '{"type":"reply","text":"late"}'; });
    await poll(s.call, generate, d.reopen(), controller.signal);
    const resumed = vi.fn<KakerattaGenerate>(async messages => {
      expect(messages.some(message => message.content.includes("remembered.md"))).toBe(true);
      return '{"type":"reply","text":"Done"}';
    });
    const result = await poll(s.call, resumed, d.reopen());
    expect(result.submitted).toBe(1);
    expect(s.call.mock.calls.filter(([name]) => name === "list_notes")).toHaveLength(1);
    expect(s.call.mock.calls.filter(([name]) => name === "claim_request")).toHaveLength(2);
  });

  it("resends the saved reply after a transport failure without another model call", async () => {
    const d = disk(); const s = server(); s.loseReply("before");
    const generate = vi.fn<KakerattaGenerate>(async () => '{"type":"reply","text":"Done"}');
    await poll(s.call, generate, d.reopen());
    const result = await poll(s.call, generate, d.reopen());
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.submitted).toBe(1);
    const replies = s.call.mock.calls.filter(([name]) => name === "reply_request");
    expect(replies).toHaveLength(2);
    expect(replies[0][1]).toEqual(replies[1][1]);
    expect(await d.reopen().list()).toEqual([]);
  });

  it("confirms a posted reply after losing its response and clears the journal", async () => {
    const d = disk(); const s = server(); s.loseReply("after");
    const generate = vi.fn<KakerattaGenerate>(async () => '{"type":"reply","text":"Done"}');
    await poll(s.call, generate, d.reopen());
    const result = await poll(s.call, generate, d.reopen());
    expect(result.submitted).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(s.call.mock.calls.filter(([name]) => name === "reply_request")).toHaveLength(1);
    expect(await d.reopen().list()).toEqual([]);
  });

  it("does not resume actions for a withdrawn request", async () => {
    const d = disk(); const s = server(); s.loseClaim();
    await poll(s.call, reply, d.reopen());
    s.revoke(); s.call.mockClear();
    const generate = vi.fn<KakerattaGenerate>();
    await poll(s.call, generate, d.reopen());
    expect(generate).not.toHaveBeenCalled();
    expect(s.call.mock.calls.map(([name]) => name)).toEqual(["list_asks"]);
    expect(await d.reopen().list()).toEqual([]);
  });

  it("does not repeat a comment after a crash while saving its result", async () => {
    const d = disk(); const s = server();
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (name === "comment_on_entry") d.adapter.write.mockRejectedValueOnce(new Error("Interrupted write"));
      return result;
    });
    const first = vi.fn<KakerattaGenerate>(async () => '{"type":"comment","entryId":"elsewhere","text":"Correction"}');
    await poll(s.call, first, d.reopen());
    expect((await d.reopen().list())[0].pendingComment).toBeTruthy();
    const resumed = vi.fn<KakerattaGenerate>()
      .mockResolvedValueOnce('{"text":"Correction","type":"comment","extra":"ignored","entryId":"elsewhere"}')
      .mockResolvedValueOnce('{"type":"reply","text":"Done"}');
    const result = await poll(s.call, resumed, d.reopen());
    expect(result.submitted).toBe(1);
    expect(s.call.mock.calls.filter(([name]) => name === "comment_on_entry")).toHaveLength(1);
    expect(resumed.mock.calls[0][0].some(message => message.content.includes("unknown result"))).toBe(true);
  });
});

describe("request journal", () => {
  it("recovers the previous snapshot when the newest write is incomplete", async () => {
    const d = disk(); const store = d.reopen();
    const state = { id: "q", entryId: "e", claimId: "stable", expiresAt: Date.now() + 60_000, messages: [], rounds: 0, comments: 0, attemptedComments: [] };
    await store.save(state);
    await store.save({ ...state, rounds: 1 });
    d.files.set("requests.0.json", '{"version":1,');
    expect((await d.reopen().list())[0].claimId).toBe("stable");
    expect((await d.reopen().list())[0].rounds).toBe(0);
  });
  it("separates changed credentials and normalizes header order and case", async () => {
    const a = await requestScope("https://example.test/mcp", { Authorization: "Bearer a", "X-Test": "value" });
    expect(await requestScope("https://example.test/mcp", { "x-test": "value", authorization: "Bearer a" })).toBe(a);
    expect(await requestScope("https://example.test/mcp", { Authorization: "Bearer b", "X-Test": "value" })).not.toBe(a);
    expect(a).not.toContain("Bearer");
  });
});
