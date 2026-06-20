import { vi } from "vitest";

import type { RunSession } from "../event-bus.js";
import type { Mock } from "vitest";


type SessionMock<T extends keyof RunSession> = Mock<RunSession[T]>;

export type StubRunSession = RunSession & {
  log: SessionMock<"log">;
  choose: SessionMock<"choose">;
  confirm: SessionMock<"confirm">;
  input: SessionMock<"input">;
  milestone: SessionMock<"milestone">;
  statusChanged: SessionMock<"statusChanged">;
  usageCheckpoint: SessionMock<"usageCheckpoint">;
  close: SessionMock<"close">;
};

export function stubRunSession(): StubRunSession {
  return {
    log: vi.fn<RunSession["log"]>(),
    choose: vi.fn<RunSession["choose"]>().mockResolvedValue(null),
    confirm: vi.fn<RunSession["confirm"]>().mockResolvedValue(false),
    input: vi.fn<RunSession["input"]>().mockResolvedValue(null),
    milestone: vi.fn<RunSession["milestone"]>(),
    statusChanged: vi.fn<RunSession["statusChanged"]>(),
    usageCheckpoint: vi.fn<RunSession["usageCheckpoint"]>(),
    close: vi.fn<RunSession["close"]>(),
  };
}
