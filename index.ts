import { runBrainstorm } from "./brainstorm.js";
import { initRalpixHome, loadConfig, resolvePiAgentDir } from "./config.js";
import { createEventBus } from "./event-bus.js";
import { createLogWriterEmitter, LogWriter } from "./logger.js";
import { createTuiEmitter } from "./tui.js";

import type { RalpixConfig } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "success" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    const line = `[ralpix] ${message}\n`;
    if (level === "error") process.stderr.write(line);
    else process.stdout.write(line);
  }
}

function usage(): string {
  return "Usage: /ralpix init | /ralpix brainstorm <description>";
}

function loadRunConfig(ctx: ExtensionCommandContext): RalpixConfig {
  const loaded = loadConfig(ctx.cwd);
  return {
    ...loaded,
    piAgentDir: resolvePiAgentDir(ctx.cwd, loaded),
  };
}

function handleInit(ctx: ExtensionCommandContext): void {
  const result = initRalpixHome(false);
  const parts = [];
  if (result.created.length > 0) parts.push(`${String(result.created.length)} created`);
  if (result.overwritten.length > 0) parts.push(`${String(result.overwritten.length)} overwritten`);
  if (result.skipped.length > 0) parts.push(`${String(result.skipped.length)} skipped`);
  const suffix = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  notify(ctx, `ralpix initialized${suffix}`, "success");
}

async function handleBrainstorm(
  description: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("brainstorm requires an interactive UI");
  }

  const config = loadRunConfig(ctx);
  const writer = new LogWriter(ctx.cwd, "brainstorm", `smoke-${Date.now()}`);
  const session = createEventBus(ctx, "brainstorm", [
    createLogWriterEmitter(writer),
    createTuiEmitter(ctx),
  ]);

  try {
    const result = await runBrainstorm(ctx, {}, description, config, session);
    notify(ctx, `Brainstorm complete: ${result.sessionName}`, "success");
    notify(ctx, `Progress log: ${writer.filePath}`, "info");
  } finally {
    session.close();
  }
}

export default function ralpixExtension(pi: ExtensionAPI): void {
  pi.registerCommand("ralpix", {
    description: "Run ralpix brainstorm smoke-test commands",
    handler: async (args: unknown, ctx: ExtensionCommandContext) => {
      const trimmed = typeof args === "string" ? args.trim() : "";

      try {
        if (trimmed.length === 0) {
          notify(ctx, usage(), "error");
          return;
        }

        if (trimmed === "init") {
          handleInit(ctx);
          return;
        }

        if (trimmed === "brainstorm") {
          notify(ctx, "Usage: /ralpix brainstorm <description>", "error");
          return;
        }

        if (trimmed.startsWith("brainstorm ")) {
          const description = trimmed.slice("brainstorm ".length).trim();
          if (description.length === 0) {
            notify(ctx, "Usage: /ralpix brainstorm <description>", "error");
            return;
          }
          await handleBrainstorm(description, ctx);
          return;
        }

        notify(ctx, usage(), "error");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, message, "error");
      }
    },
  });
}
