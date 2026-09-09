/**
 * Read a pi child session from its JSONL file.
 *
 * This is the whole point of the extension. `herdr agent read` returns the raw
 * terminal, which carries the startup banner, the skill list, the extension
 * list, and the token bar. The JSONL holds the answer only.
 */

import { readFile } from "node:fs/promises";

export type Turn = {
  role: string;
  text: string;
  toolCalls: Array<{ name: string; args: string }>;
};

export type Transcript = {
  turns: Turn[];
  /** Last assistant text block, trimmed. Undefined when the child said nothing. */
  final?: string;
  /** Tool names in call order. */
  toolNames: string[];
  turnCount: number;
  /** True when an active background task can start an automatic follow-up turn. */
  followUpPending: boolean;
  /** Epoch time of the newest completed turn. */
  lastTurnAtMs?: number;
  lastDurationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

const MAX_TOOL_ARGS = 200;

export async function readTranscript(sessionPath: string): Promise<Transcript> {
  let raw: string;
  try {
    raw = await readFile(sessionPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read child session ${sessionPath}: ${(error as Error).message}`);
  }

  const turns: Turn[] = [];
  const toolNames: string[] = [];
  let turnCount = 0;
  const followUpTasks = new Set<string>();
  let followUpAwaitingTurn = false;
  let lastTurnAtMs: number | undefined;
  let lastDurationMs: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "custom" && entry.customType === "zentui-turn-summary") {
      turnCount += 1;
      followUpAwaitingTurn = false;
      const timestamp = Date.parse(String(entry.timestamp ?? ""));
      lastTurnAtMs = Number.isNaN(timestamp) ? undefined : timestamp;
      lastDurationMs = entry.data?.durationMs;
      inputTokens = entry.data?.input;
      outputTokens = entry.data?.output;
      continue;
    }

    if (entry.type === "custom_message" && entry.customType === "background-task-notification") {
      const taskId = String(entry.details?.id ?? "");
      if (taskId && followUpTasks.delete(taskId)) followUpAwaitingTurn = true;
      continue;
    }

    if (entry.type !== "message") continue;

    const message = entry.message ?? {};
    if (message.role === "toolResult" && message.toolName === "bg_run") {
      const task = message.details?.task;
      if (
        typeof task?.id === "string" &&
        task.status === "running" &&
        task.notifyOnCompletion === true &&
        task.triggerOnCompletion === true
      ) {
        followUpTasks.add(task.id);
      }
    }

    const content: any[] = Array.isArray(message.content) ? message.content : [];
    const turn: Turn = { role: String(message.role ?? "unknown"), text: "", toolCalls: [] };

    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        turn.text += block.text;
      } else if (block?.type === "toolCall") {
        const name = String(block.name ?? "?");
        toolNames.push(name);
        turn.toolCalls.push({ name, args: JSON.stringify(block.arguments ?? {}).slice(0, MAX_TOOL_ARGS) });
      }
    }

    turns.push(turn);
  }

  let final: string | undefined;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.role === "assistant" && turn.text.trim()) {
      final = turn.text.trim();
      break;
    }
  }

  return {
    turns,
    final,
    toolNames,
    turnCount,
    followUpPending: followUpAwaitingTurn || followUpTasks.size > 0,
    lastTurnAtMs,
    lastDurationMs,
    inputTokens,
    outputTokens,
  };
}

/** One line per step: what the child did, in order. No terminal noise. */
export function formatTrace(transcript: Transcript, maxLines = 40): string {
  const lines: string[] = [];

  for (const turn of transcript.turns) {
    for (const call of turn.toolCalls) {
      lines.push(`[tool] ${call.name} ${call.args}`);
    }
    const text = turn.text.trim();
    if (text) {
      lines.push(`[${turn.role}] ${text.length > 300 ? `${text.slice(0, 300)}...` : text}`);
    }
  }

  if (lines.length <= maxLines) return lines.join("\n");
  return [`... ${lines.length - maxLines} earlier lines omitted`, ...lines.slice(-maxLines)].join("\n");
}
