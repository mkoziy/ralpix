import { vi } from "vitest";

import type { RunSession } from "../event-bus.js";

export function stubRunSession(): RunSession & {
  log: ReturnType<typeof vi.fn>;
  choose: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  milestone: ReturnType<typeof vi.fn>;
  statusChanged: ReturnType<typeof vi.fn>;
  usageCheckpoint: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn(),
    choose: vi.fn().mockResolvedValue(null),
    confirm: vi.fn().mockResolvedValue(false),
    input: vi.fn().mockResolvedValue(null),
    milestone: vi.fn(),
    statusChanged: vi.fn(),
    usageCheckpoint: vi.fn(),
    close: vi.fn(),
  };
}
