import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { AgentEvent, AgentEventEmitter } from "./events.js";
import type { Phase } from "./types.js";

export function progressDirForPhase(cwd: string, phase: Phase): string {
  return resolve(cwd, ".ralpix", "progress", phase);
}

export class LogWriter {
  readonly filePath: string;

  constructor(cwd: string, phase: Phase, sessionName: string) {
    const dir = progressDirForPhase(cwd, phase);
    this.filePath = join(dir, `${sessionName}.jsonl`);
  }

  write(event: AgentEvent): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        process.stderr.write(`[ralpix] failed to write progress log ${this.filePath}: ${message}\n`);
      } catch {
        // Logging failures must never throw.
      }
    }
  }
}

export function createLogWriterEmitter(writer: LogWriter): AgentEventEmitter {
  return {
    emit(event) {
      writer.write(event);
    },
  };
}
