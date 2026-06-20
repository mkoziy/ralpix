declare let __dirname: string;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

interface PiTuiComponent {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput?: (data: string) => void;
  wantsKeyRelease?: boolean;
}

interface PiTuiHandle {
  requestRender: () => void;
  close: () => void;
}

interface PiTuiTheme {
  fg: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

interface PiTuiRuntime {
  requestRender: () => void;
}

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    appendEntry: (key: string, value: unknown) => void;
    readEntry: (key: string) => unknown;
    registerCommand: (
      name: string,
      handler: {
        description: string;
        parameters?: unknown;
        handler: (args: unknown, ctx: ExtensionCommandContext) => Promise<void> | void;
      },
    ) => void;
    registerTool: (tool: {
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
      ) => ToolResult | Promise<ToolResult>;
    }) => void;
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void,
    ) => void;
  }

  interface ExtensionCommandContext {
    cwd: string;
    sessionManager: SessionManager;
    hasUI: boolean;
    ui: {
      notify: (message: string, level?: "info" | "success" | "warning" | "error") => void;
      select: (question: string, options: string[]) => Promise<string | undefined>;
      input: (prompt: string, placeholder?: string) => Promise<string | undefined>;
      confirm: (title: string, message: string) => Promise<boolean | undefined>;
      custom: {
        <TResult>(
          factory: (
            tui: PiTuiRuntime,
            theme: PiTuiTheme,
            keybindings: unknown,
            done: (result: TResult) => void,
          ) => PiTuiComponent,
          options?: Record<string, unknown>,
        ): Promise<TResult>;
        (component: PiTuiComponent, options?: Record<string, unknown>): PiTuiHandle;
      };
      setStatus: (key: string, value: string | undefined) => void;
      setWidget: (
        key: string,
        value:
          | string[] |
          ((ui: PiTuiRuntime, theme: PiTuiTheme) => PiTuiComponent) |
          undefined,
      ) => void;
      theme: { fg: (color: string, text: string) => string; bold: (text: string) => string };
    };
    newSession: (options: {
      setup?: (sm: SessionManager) => Promise<void> | void;
      withSession: (ctx: SessionContext) => Promise<void>;
    }) => Promise<void>;
  }

  interface SessionManager {
    appendModelChange: (provider: string, model: string) => void;
    appendThinkingLevelChange: (level: string) => void;
    getEntries: () => Array<{ type: string; value: unknown }>;
  }

  interface SessionContext {
    registerTool: (tool: {
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
      ) => ToolResult | Promise<ToolResult>;
    }) => void;
    sendUserMessage: (prompt: string) => Promise<void>;
    waitForIdle: () => Promise<void>;
  }
}

declare module "typebox" {
  export namespace Type {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function String(options?: Record<string, any>): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function Number(options?: Record<string, any>): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function Boolean(options?: Record<string, any>): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function Object(properties: Record<string, any>, options?: Record<string, any>): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function Array(items: any, options?: Record<string, any>): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function Union(schemas: readonly any[]): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function Optional(schema: any): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function Any(): any;
  }
}
