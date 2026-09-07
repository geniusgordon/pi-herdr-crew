/**
 * The file protocol.
 *
 * A lane answer must not enter the parent context whole. Measured on one audit
 * of a 6-line file, the child produced 8256 bytes of markdown. Reading that
 * from the child session file is clean next to the terminal, but it is not
 * small.
 *
 * The protocol moves the payload to disk:
 *   1. The parent writes a brief file.
 *   2. The lane reads that brief and writes a result file.
 *   3. The lane replies with one summary line.
 *
 * The same audit then cost the parent 26 bytes, a 317x reduction.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Root that holds one directory per task, relative to the lane cwd. */
export const LANE_ROOT = ".pi/lanes";

export type Paths = {
  /** Absolute task directory. One directory per task holds every turn. */
  dir: string;
  /** Absolute brief path, for the parent to write. */
  brief: string;
  /** Absolute result path, for the lane to write. */
  result: string;
  /** Task directory as the lane sees it, relative to its own cwd. */
  dirRelative: string;
  /** Brief path as the lane sees it, relative to its own cwd. */
  briefRelative: string;
  /** Result path as the lane sees it, relative to its own cwd. */
  resultRelative: string;
};

/**
 * Lay out one task as a directory, not as flat files.
 *
 *   .pi/lanes/<task>/brief.md      turn 1
 *   .pi/lanes/<task>/result.md     turn 1
 *   .pi/lanes/<task>/brief-2.md    turn 2
 *   .pi/lanes/<task>/result-2.md   turn 2
 *
 * The lane can also write extra files beside them, such as a patch or a table,
 * and everything for that task stays in one place.
 */
export function lanePaths(laneCwd: string, task: string, turn: number): Paths {
  const dir = join(laneCwd, LANE_ROOT, task);
  const dirRelative = `${LANE_ROOT}/${task}`;
  const suffix = turn > 1 ? `-${turn}` : "";
  return {
    dir,
    dirRelative,
    brief: join(dir, `brief${suffix}.md`),
    result: join(dir, `result${suffix}.md`),
    briefRelative: `${dirRelative}/brief${suffix}.md`,
    resultRelative: `${dirRelative}/result${suffix}.md`,
  };
}

/**
 * Build the brief file body.
 *
 * The Deliverable and Reply sections are fixed, not advisory. A lane that
 * pastes its answer into the reply defeats the whole protocol.
 */
export function renderBrief(options: {
  lane: string;
  task: string;
  resultRelative: string;
  dirRelative: string;
  context?: string;
}): string {
  const lines = [
    `# Brief: ${options.lane}`,
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
    `Write your complete answer to \`${options.resultRelative}\`.`,
    "Create the parent directory first if it does not exist.",
    "Use markdown headings, one section per topic.",
    "Put every detail in that file, because it is the only durable output.",
    `Write any extra artifact, such as a patch or a table, into \`${options.dirRelative}/\` beside it.`,
    "",
    "## Reply",
    "",
    "Reply with one line only. Start it with DONE, then a count or a short verdict.",
    "Do not paste the answer into your reply. The orchestrator reads the file.",
    "",
    "## Rules",
    "",
    "1. You cannot see the orchestrator conversation. This brief holds every needed fact.",
    "2. Write files inside your own working directory only.",
    "3. Report a blocker in the result file, then reply with BLOCKED and the reason.",
    "",
  );

  return lines.join("\n");
}

/** The task text sent through `herdr agent prompt`. It stays one line and short. */
export function renderPrompt(briefRelative: string): string {
  return `Read ${briefRelative} in your current directory and follow it exactly.`;
}

export async function writeBrief(path: string, body: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
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
export async function inspectResult(path: string, laneCwd: string): Promise<ResultInfo> {
  const rel = isAbsolute(path) ? relative(laneCwd, path) : path;
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
 * Find the newest result file for a lane by scanning its directory.
 *
 * A lane outlives its parent, so a new parent adopts it with no memory of the
 * last result path. Disk holds that fact, so read it from there.
 */
export async function findLatestResult(laneCwd: string, task: string): Promise<string | undefined> {
  const dir = join(laneCwd, LANE_ROOT, task);
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
export async function listTaskFiles(laneCwd: string, task: string): Promise<Array<{ name: string; bytes: number }>> {
  const dir = join(laneCwd, LANE_ROOT, task);
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
