export type SessionAgent = {
  agent_session?: { value?: unknown };
  [key: string]: unknown;
};

type Options = {
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
  now?: () => number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function hasAgentSession(agent: SessionAgent | undefined): boolean {
  const value = agent?.agent_session?.value;
  return typeof value === "string" && value.startsWith("/");
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function waitForAgentSession(
  initial: SessionAgent | undefined,
  observe: (remainingMs: number) => Promise<SessionAgent | undefined>,
  options: Options,
): Promise<SessionAgent | undefined> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? abortableDelay;
  const deadline = now() + options.timeoutMs;
  let agent = initial;

  while (!hasAgentSession(agent) && now() < deadline) {
    await delay(Math.min(options.pollMs, deadline - now()), options.signal);
    if (now() >= deadline) break;

    const previous = agent;
    try {
      agent = await observe(deadline - now());
    } catch (error) {
      if (!options.shouldRetry?.(error)) throw error;
      agent = previous;
    }
    if (now() > deadline) agent = previous;
  }

  return agent;
}
