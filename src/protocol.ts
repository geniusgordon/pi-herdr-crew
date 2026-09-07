/**
 * The file protocol.
 *
 * A member answer must not enter the parent context whole. Measured on one audit
 * of this repository, the member produced 12283 bytes of markdown. Reading that
 * from the child session file is clean next to the terminal, but it is not
 * small.
 *
 * The protocol moves the payload to disk:
 *   1. The parent writes a brief file.
 *   2. The member reads that brief and writes a result file.
 *   3. The member replies with one summary line.
 *
 * The same audit then cost the parent a 124 byte reply line, a 99x reduction.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Root that holds one directory per task, relative to the orchestrator cwd. */
export const CREW_ROOT = ".pi/crew";

export type Paths = {
  /** Absolute task directory in the orchestrator cwd. One directory per task. */
  dir: string;
  /** Absolute brief path, written by the orchestrator, read by the member. */
  brief: string;
  /** Absolute result path, written by the member, read by the orchestrator. */
  result: string;
  /** Task directory relative to the orchestrator cwd, for display. */
  dirRelative: string;
  /** Brief path relative to the orchestrator cwd, for display. */
  briefRelative: string;
  /** Result path relative to the orchestrator cwd, for display. */
  resultRelative: string;
};

/**
 * Lay out one task as a directory in the orchestrator cwd.
 *
 *   <orchestrator cwd>/.pi/crew/<task>/brief.md      turn 1
 *   <orchestrator cwd>/.pi/crew/<task>/result.md     turn 1
 *   <orchestrator cwd>/.pi/crew/<task>/brief-2.md    turn 2
 *   <orchestrator cwd>/.pi/crew/<task>/result-2.md   turn 2
 *
 * The orchestrator cwd owns these files, not the member cwd. A worktree member
 * runs in a directory that `close` removes, and a result stored there dies with
 * it. Verified: every worktree result written during development was lost this
 * way.
 *
 * The member therefore receives absolute paths. A work product such as a patch
 * still belongs in the member's own directory, because it must be committed
 * with the code.
 */
export function taskPaths(orchestratorCwd: string, task: string, turn: number): Paths {
  const dir = join(orchestratorCwd, CREW_ROOT, task);
  const suffix = turn > 1 ? `-${turn}` : "";
  return {
    dir,
    dirRelative: `${CREW_ROOT}/${task}`,
    brief: join(dir, `brief${suffix}.md`),
    result: join(dir, `result${suffix}.md`),
    briefRelative: `${CREW_ROOT}/${task}/brief${suffix}.md`,
    resultRelative: `${CREW_ROOT}/${task}/result${suffix}.md`,
  };
}

/**
 * Build the brief file body.
 *
 * The Deliverable and Reply sections are fixed, not advisory. A member that
 * pastes its answer into the reply defeats the whole protocol.
 */
export function renderBrief(options: {
  member: string;
  task: string;
  /** Absolute result path. The member cwd may differ from the orchestrator cwd. */
  result: string;
  /** Absolute task directory, for an extra orchestration artifact. */
  dir: string;
  /** The member's own working directory, for a work product such as a patch. */
  memberCwd: string;
  context?: string;
}): string {
  const lines = [
    `# Brief: ${options.member}`,
    "",
    "## Task",
    "",
    options.task.trim(),
    "",
  ];

  if (options.context?.trim()) {
    lines.push("## Context", "", options.context.trim(), "");
  }

  lines.push(
    "## Deliverable",
    "",
    `Write your complete answer to this exact absolute path:`,
    "",
    `    ${options.result}`,
    "",
    "Create the parent directory first if it does not exist.",
    "That path is outside your working directory. Use it exactly as written.",
    "Use markdown headings, one section per topic.",
    "Put every detail in that file, because it is the only durable output.",
    "",
    "## Reply",
    "",
    "Reply with one line only. Start it with DONE, then a count or a short verdict.",
    "Do not paste the answer into your reply. The orchestrator reads the file.",
    "",
    "## Rules",
    "",
    "1. You cannot see the orchestrator conversation. This brief holds every needed fact.",
    `2. Write a work product, such as a patch or a source file, into \`${options.memberCwd}\`.`,
    `3. Write an extra orchestration artifact, such as a table, into \`${options.dir}\`.`,
    "4. Report a blocker in the result file, then reply with BLOCKED and the reason.",
    "",
  );

  return lines.join("\n");
}

/** The task text sent through `herdr agent prompt`. It stays one line and short. */
export function renderPrompt(brief: string): string {
  return `Read ${brief} and follow it exactly.`;
}

export async function writeBrief(path: string, body: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
}

/**
 * Keep crew files out of Git.
 *
 * These files are orchestration scratch data, never shared work. A user with
 * `.pi/` in a global ignore file never sees them, but a teammate without that
 * line does. Write the rule into the repository instead of relying on a machine
 * setting.
 */
export async function writeIgnore(orchestratorCwd: string): Promise<void> {
  const path = join(orchestratorCwd, CREW_ROOT, ".gitignore");
  try {
    await stat(path);
    return;
  } catch {
    // Absent, so write it once.
  }
  await mkdir(join(orchestratorCwd, CREW_ROOT), { recursive: true });
  await writeFile(path, "# Crew orchestration scratch data. Never shared work.\n*\n", "utf8");
}

export type ResultInfo = {
  path: string;
  relative: string;
  exists: boolean;
  bytes: number;
  lines: number;
  /** Every markdown heading, so the parent can pick one section to read. */
  headings: string[];
};

/**
 * Describe the result file without returning its body.
 *
 * This is the whole saving. The parent learns the shape and reads a section
 * only when it needs one.
 */
export async function inspectResult(path: string, orchestratorCwd: string): Promise<ResultInfo> {
  const rel = isAbsolute(path) ? relative(orchestratorCwd, path) : path;
  const info: ResultInfo = { path, relative: rel, exists: false, bytes: 0, lines: 0, headings: [] };

  try {
    const stats = await stat(path);
    info.exists = true;
    info.bytes = stats.size;
  } catch {
    return info;
  }

  const body = await readFile(path, "utf8").catch(() => "");
  info.lines = body ? body.split("\n").length : 0;
  info.headings = body
    .split("\n")
    .filter((line) => /^#{1,3} /.test(line))
    .map((line) => line.trim())
    .slice(0, 40);

  return info;
}

/**
 * The next free turn number for a task.
 *
 * Disk owns the turn count, not the member record. A member that runs task A,
 * then task B, then task A again would restart at turn 1 from its own counter
 * and overwrite the first pair of files. Scanning the directory cannot, and it
 * also survives a parent that adopted the member with no memory.
 */
export async function nextTurn(orchestratorCwd: string, task: string): Promise<number> {
  const dir = join(orchestratorCwd, CREW_ROOT, task);
  const names = await readdir(dir).catch(() => [] as string[]);

  let highest = 0;
  for (const name of names) {
    const match = name.match(/^(?:brief|result)(?:-(\d+))?\.md$/);
    if (!match) continue;
    highest = Math.max(highest, match[1] ? Number(match[1]) : 1);
  }

  return highest + 1;
}

/**
 * Find the newest result file for a member by scanning its directory.
 *
 * A member outlives its parent, so a new parent adopts it with no memory of the
 * last result path. Disk holds that fact, so read it from there.
 */
export async function findLatestResult(orchestratorCwd: string, task: string): Promise<string | undefined> {
  const dir = join(orchestratorCwd, CREW_ROOT, task);
  const names = await readdir(dir).catch(() => [] as string[]);

  const candidates = names.filter((name) => /^result(-\d+)?\.md$/.test(name));
  if (!candidates.length) return undefined;

  const stamped = await Promise.all(
    candidates.map(async (name) => {
      const path = join(dir, name);
      const stats = await stat(path).catch(() => undefined);
      return { path, mtime: stats?.mtimeMs ?? 0 };
    }),
  );

  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped[0]?.path;
}

/** Every file in the task directory, so the parent can see extra artifacts. */
export async function listTaskFiles(orchestratorCwd: string, task: string): Promise<Array<{ name: string; bytes: number }>> {
  const dir = join(orchestratorCwd, CREW_ROOT, task);
  const names = await readdir(dir).catch(() => [] as string[]);

  const files = await Promise.all(
    names.map(async (name) => {
      const stats = await stat(join(dir, name)).catch(() => undefined);
      return stats?.isFile() ? { name, bytes: stats.size } : undefined;
    }),
  );

  return files.filter((file): file is { name: string; bytes: number } => file !== undefined).sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one heading's section, or a byte window when no heading matches. */
export async function readSection(
  path: string,
  options: { section?: string; maxBytes?: number } = {},
): Promise<string> {
  const body = await readFile(path, "utf8");
  const limit = options.maxBytes ?? 8_000;

  if (!options.section) {
    return body.length <= limit ? body : `${body.slice(0, limit)}\n\n... ${body.length - limit} more bytes`;
  }

  const needle = options.section.toLowerCase();
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^#{1,6} /.test(line) && line.toLowerCase().includes(needle));
  if (start === -1) {
    throw new Error(`No heading matches "${options.section}". Call action "result" to list the headings.`);
  }

  const depth = (lines[start]!.match(/^#+/) ?? ["#"])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i]!.match(/^#+/);
    if (match && match[0].length <= depth) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start, end).join("\n");
  return section.length <= limit ? section : `${section.slice(0, limit)}\n\n... ${section.length - limit} more bytes`;
}
