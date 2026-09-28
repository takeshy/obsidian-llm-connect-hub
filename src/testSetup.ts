import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { vi } from "vitest";

vi.stubGlobal("window", { clearInterval, clearTimeout, setInterval, setTimeout });
