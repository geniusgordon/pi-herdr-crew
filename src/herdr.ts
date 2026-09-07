/**
 * Thin wrapper over the `herdr` CLI.
 *
 * Every control command returns JSON on stdout. A server error returns JSON on
 * stderr with exit status 1. A syntax error exits with status 2.
 */

export type Exec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number | null; killed?: boolean }>;

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly argv: string[],
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export function inHerdr(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
}

export function callerPane(): string {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) throw new HerdrError("not_in_herdr", "HERDR_PANE_ID is not set", []);
  return pane;
}

export function callerWorkspace(): string {
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (!workspace) throw new HerdrError("not_in_herdr", "HERDR_WORKSPACE_ID is not set", []);
  return workspace;
}

/** Run one herdr command and return `.result`. Throws HerdrError on failure. */
export async function herdr(
  exec: Exec,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<any> {
  if (!inHerdr()) {
    throw new HerdrError("not_in_herdr", "This pi session does not run inside a Herdr pane", args);
  }

  const res = await exec("herdr", args, {
    signal: options.signal,
    timeout: options.timeoutMs ?? 180_000,
  });

  const parse = (text: string): any => {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  };

  const payload = parse(res.stdout) ?? parse(res.stderr);

  if (payload?.error) {
    throw new HerdrError(String(payload.error.code ?? "herdr_error"), String(payload.error.message ?? "herdr failed"), args);
  }
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim().slice(0, 400);
    throw new HerdrError(res.code === 2 ? "cli_usage" : "herdr_failed", detail || `herdr exited ${res.code}`, args);
  }
  if (!payload || !("result" in payload)) {
    throw new HerdrError("bad_response", `herdr returned no result: ${res.stdout.slice(0, 200)}`, args);
  }
  return payload.result;
}

/**
 * Run one herdr command that returns plain text, not JSON.
 *
 * `pane read` and `agent read` write the terminal snapshot straight to stdout.
 * Only an error comes back as JSON, on stderr.
 */
export async function herdrText(
  exec: Exec,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  if (!inHerdr()) {
    throw new HerdrError("not_in_herdr", "This pi session does not run inside a Herdr pane", args);
  }

  const res = await exec("herdr", args, { signal: options.signal, timeout: options.timeoutMs ?? 30_000 });

  if (res.code !== 0) {
    let code = res.code === 2 ? "cli_usage" : "herdr_failed";
    let message = (res.stderr || res.stdout || "").trim().slice(0, 400);
    try {
      const payload = JSON.parse(res.stderr.trim());
      if (payload?.error) {
        code = String(payload.error.code ?? code);
        message = String(payload.error.message ?? message);
      }
    } catch {
      // Plain-text stderr. Keep the message as it is.
    }
    throw new HerdrError(code, message || `herdr exited ${res.code}`, args);
  }

  return res.stdout;
}

/** Pick the split direction that keeps both panes usable. */
export async function pickDirection(exec: Exec, paneId: string): Promise<"right" | "down"> {
  try {
    const result = await herdr(exec, ["pane", "layout", "--pane", paneId], { timeoutMs: 10_000 });
    const rect = result?.layout?.panes?.find((p: any) => p.pane_id === paneId)?.rect;
    const width = Number(rect?.width ?? 0);
    return width >= 150 ? "right" : "down";
  } catch {
    return "down";
  }
}
