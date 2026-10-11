/**
 * In-process ExtensionAPI fake for banner and command tests.
 *
 * These tests exercise extensions through their real entry points (`pi.on` /
 * `pi.registerCommand`) without spawning a CLI. Hand-writing the fake per file
 * drifted — one copy omitted `registerCommand`, another passed `undefined` as
 * the TUI object — so the protocol lives here once and the call sites stay one
 * line long.
 */
export type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;
export type ExtensionCommandHandler = (args: string, ctx: never) => Promise<void>;
export interface ExtensionCommandSpec {
  description?: string;
  handler: ExtensionCommandHandler;
}

export interface FakeExtension {
  /** Pass to the extension factory. Deliberately `never`: the fake is partial. */
  api: never;
  handlers: Record<string, ExtensionHandler[]>;
  commands: Map<string, ExtensionCommandSpec>;
}

export function fakeExtensionApi(): FakeExtension {
  const handlers: Record<string, ExtensionHandler[]> = {};
  const commands = new Map<string, ExtensionCommandSpec>();
  const api = {
    on: (event: string, handler: ExtensionHandler) => { (handlers[event] ??= []).push(handler); },
    registerCommand: (name: string, spec: ExtensionCommandSpec) => { commands.set(name, spec); },
  };
  return { api: api as never, handlers, commands };
}

export interface TuiSessionOptions {
  /** Theme the header paints with; defaults to passthrough. */
  theme?: { fg: (color: string, text: string) => string };
  model?: string;
  /** Session-start reasons to replay; the default runs the handlers once. */
  reasons?: Array<"startup" | "reload" | "new" | "resume" | "fork">;
}

export interface TuiSession {
  /** Repaint count requested through the header's TUI object. */
  paints: () => number;
  /** Renders the header installed by `session_start`. */
  render: (width?: number) => string;
}

/** Runs the `session_start` handlers against a TUI context and captures the header. */
export function startTuiSession(handlers: Record<string, ExtensionHandler[]>, options: TuiSessionOptions = {}): TuiSession {
  const theme = options.theme ?? { fg: (_color: string, text: string) => text };
  let header: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  let paints = 0;
  const ui = { requestRender: () => { paints += 1; } };
  for (const reason of options.reasons ?? ["startup"]) {
    for (const handler of handlers.session_start ?? []) {
      handler({ reason }, { mode: "tui", model: { id: options.model ?? "fake-model" }, ui: { setHeader: (next: typeof header) => { header = next; } } });
    }
  }
  return {
    paints: () => paints,
    render: (width = 80) => {
      if (!header) throw new Error("session_start did not install a header");
      return header(ui, theme).render(width).join("\n");
    },
  };
}
