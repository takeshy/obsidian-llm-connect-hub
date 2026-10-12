import type { ConnectMessage } from "./contract";

export interface RequestState {
  id: string;
  entryId: string;
  claimId: string;
  expiresAt: number;
  context?: unknown;
  deadline?: number;
  messages: ConnectMessage[];
  rounds: number;
  comments: number;
  attemptedComments: string[];
  pendingComment?: string;
  action?: Record<string, unknown>;
  reply?: string;
  replyAttempted?: boolean;
}

export interface RequestStore {
  list(): Promise<RequestState[]>;
  save(state: RequestState): Promise<void>;
  remove(id: string): Promise<void>;
}

export function memoryRequestStore(): RequestStore {
  const states = new Map<string, RequestState>();
  return {
    async list() { return structuredClone([...states.values()]); },
    async save(state) { states.set(state.id, structuredClone(state)); },
    async remove(id) { states.delete(id); },
  };
}

interface JournalAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}
interface Snapshot { version: 1; revision: number; states: RequestState[] }

/** Alternate snapshots so an interrupted write leaves the previous journal readable. */
export function persistentRequestStore(adapter: JournalAdapter, path: string): RequestStore {
  let snapshot: Snapshot | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }
  async function read(): Promise<Snapshot> {
    if (snapshot) return snapshot;
    const candidates: Snapshot[] = [];
    let existing = false;
    for (const slot of [0, 1]) {
      const file = `${path}.${slot}.json`;
      if (!await adapter.exists(file)) continue;
      existing = true;
      const text = await adapter.read(file);
      try {
        const value = JSON.parse(text) as Snapshot;
        if (value.version === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
            Array.isArray(value.states) && value.states.every(state => typeof state.id === "string" &&
              typeof state.claimId === "string" && Array.isArray(state.messages) && Array.isArray(state.attemptedComments))) candidates.push(value);
      } catch { /* A partial snapshot can be recovered from the other slot. */ }
    }
    if (existing && !candidates.length) throw new Error("Kakeratta request journal is unreadable");
    snapshot = candidates.sort((a, b) => b.revision - a.revision)[0] ?? { version: 1, revision: 0, states: [] };
    return snapshot;
  }
  async function update(change: (states: RequestState[]) => RequestState[]): Promise<void> {
    const previous = await read();
    const next: Snapshot = { version: 1, revision: previous.revision + 1, states: change(structuredClone(previous.states)) };
    await adapter.write(`${path}.${next.revision % 2}.json`, JSON.stringify(next));
    snapshot = next;
  }
  return {
    list: () => serial(async () => structuredClone((await read()).states)),
    save: state => {
      const saved = structuredClone(state);
      return serial(() => update(states => [...states.filter(item => item.id !== saved.id), saved]));
    },
    remove: id => serial(() => update(states => states.filter(state => state.id !== id))),
  };
}

/** Credentials identify a connection but are never written into the journal filename or contents. */
export async function requestScope(url: string, headers: Record<string, string>): Promise<string> {
  const identity = JSON.stringify([new URL(url).href, Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b))]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
