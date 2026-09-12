import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type CrewRole = {
  name: string;
  description?: string;
  kind?: string;
  tools?: string[];
  skills?: string[];
  prompt: string;
  path: string;
  source: "global" | "project";
};

export type RoleCatalog = {
  roles: CrewRole[];
  diagnostics: string[];
};

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const TOOL_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const SKILL_RE = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

function scalar(frontmatter: string, key: string): string | undefined {
  const prefix = `${key}:`;
  const lines = frontmatter.split("\n").filter((line) => line.startsWith(prefix));
  if (lines.length > 1) throw new Error(`duplicate ${key}`);
  const value = lines[0]?.slice(prefix.length).trim();
  if (!value) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseRole(content: string, path: string, source: CrewRole["source"]): CrewRole {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("missing frontmatter");

  const frontmatter = match[1]!;
  const name = scalar(frontmatter, "name") ?? basename(path, ".md");
  if (!NAME_RE.test(name)) throw new Error(`invalid name ${JSON.stringify(name)}`);

  const kind = scalar(frontmatter, "kind");
  if (kind && kind !== "pi") throw new Error(`unsupported kind ${JSON.stringify(kind)}; roles currently support pi only`);

  const rawTools = scalar(frontmatter, "tools");
  if (frontmatter.split("\n").some((line) => line === "tools:")) {
    throw new Error("tools must contain at least one comma-separated name");
  }
  const tools = rawTools?.split(",").map((tool) => tool.trim()).filter(Boolean);
  if (tools?.some((tool) => !TOOL_RE.test(tool))) throw new Error("tools must be comma-separated names");

  const rawSkills = scalar(frontmatter, "skills");
  const hasSkills = frontmatter.split("\n").some((line) => line.startsWith("skills:"));
  if (hasSkills && !rawSkills) {
    throw new Error("skills must contain at least one comma-separated name");
  }
  const skills = rawSkills?.split(",").map((skill) => skill.trim());
  if (skills?.some((skill) => !SKILL_RE.test(skill))) throw new Error("skills must be comma-separated names");

  const prompt = normalized.slice(match[0].length).trim();
  if (!prompt) throw new Error("missing prompt body");

  return {
    name,
    description: scalar(frontmatter, "description"),
    kind,
    tools: tools?.length ? tools : undefined,
    ...(skills?.length ? { skills } : {}),
    prompt,
    path,
    source,
  };
}

function loadDirectory(path: string, source: CrewRole["source"], catalog: Map<string, CrewRole>, diagnostics: string[]): void {
  if (!existsSync(path)) return;
  for (const file of readdirSync(path).filter((name) => name.endsWith(".md")).sort()) {
    const rolePath = join(path, file);
    try {
      const role = parseRole(readFileSync(rolePath, "utf8"), rolePath, source);
      catalog.set(role.name, role);
    } catch (error) {
      diagnostics.push(`${rolePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function discoverRoles(cwd: string, includeProject: boolean): RoleCatalog {
  const catalog = new Map<string, CrewRole>();
  const diagnostics: string[] = [];
  loadDirectory(join(homedir(), ".pi", "agent", "agents"), "global", catalog, diagnostics);
  if (includeProject) loadDirectory(join(cwd, ".pi", "agents"), "project", catalog, diagnostics);
  return { roles: [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

export function buildPiRoleArgs(
  role: CrewRole | undefined,
  directory = join(homedir(), ".pi", "agent", "crew", "role-prompts"),
): string[] {
  if (!role) return [];

  const hash = createHash("sha256").update(role.prompt).digest("hex").slice(0, 16);
  const promptPath = join(directory, `${role.name}-${hash}.md`);
  if (!existsSync(promptPath)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${promptPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${role.prompt}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, promptPath);
  }

  return [
    ...(role.tools ? ["--tools", [...role.tools, "crew_submit_result"].join(",")] : []),
    "--append-system-prompt",
    promptPath,
  ];
}

export function buildRoleTaskPrompts(role: Pick<CrewRole, "skills"> | undefined, taskPrompt: string): string[] {
  return [...(role?.skills ?? []).map((skill) => `/skill:${skill}`), taskPrompt];
}

export function findRole(cwd: string, name: string, includeProject: boolean): CrewRole {
  const catalog = discoverRoles(cwd, includeProject);
  const role = catalog.roles.find((candidate) => candidate.name === name);
  if (role) return role;

  const available = catalog.roles.map((candidate) => candidate.name);
  const hint = available.length ? ` Available roles: ${available.join(", ")}.` : " No roles are available.";
  const diagnostics = catalog.diagnostics.length ? ` Invalid roles: ${catalog.diagnostics.join("; ")}.` : "";
  throw new Error(`Unknown crew role ${JSON.stringify(name)}.${hint}${diagnostics}`);
}
