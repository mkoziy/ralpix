import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("stage3 spike document", () => {
  const content = readFileSync(join(process.cwd(), "docs/plans/stage3-spike.md"), "utf8");

  it("captures the required reliability topics", () => {
    expect(content).toContain("### Ordering");
    expect(content).toContain("### Failure Handling");
    expect(content).toContain("### Durability");
    expect(content).toContain("### TUI Attachment");
  });

  it("records the redesign decision for Stage 3", () => {
    expect(content).toContain("Do not implement Stage 3 exactly as currently sketched.");
    expect(content).toContain("sender-side spool");
    expect(content).toContain("ack");
    expect(content).toContain("TUI stays local");
  });
});
