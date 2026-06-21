import { describe, expect, it, vi } from "vitest";

import { createTuiEmitter } from "../adapters/tui.js";

function makeCtx() {
  return {
    cwd: "/tmp",
    hasUI: true,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn(),
      custom: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    },
    sessionManager: {
      appendModelChange: vi.fn(),
      appendThinkingLevelChange: vi.fn(),
      getEntries: vi.fn().mockReturnValue([]),
    },
    newSession: vi.fn(),
  };
}

describe("createTuiEmitter", () => {
  it("renders task lifecycle events through the local UI adapter", () => {
    const ctx = makeCtx();
    const emitter = createTuiEmitter(ctx);

    emitter.emit({
      type: "phase_start",
      phase: "execute",
      createdAt: "2026-06-21T12:00:00.000Z",
      label: "execute",
    });
    emitter.emit({
      type: "task_start",
      phase: "execute",
      createdAt: "2026-06-21T12:00:01.000Z",
      taskId: "task-1",
      taskNumber: 1,
      taskTitle: "Bootstrap logger",
      itemCount: 3,
    });
    emitter.emit({
      type: "phase_end",
      phase: "execute",
      createdAt: "2026-06-21T12:00:02.000Z",
      label: "complete",
    });

    expect(ctx.ui.setWidget).toHaveBeenCalledWith("ralpix-summary", expect.any(Function));
    expect(ctx.ui.notify).toHaveBeenCalledWith("[execute] started", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Task 1: Bootstrap logger", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("[execute] complete", "success");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ralpix", undefined);
  });
});
