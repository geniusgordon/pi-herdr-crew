# Handoff: Add multiple skills to Crew roles

## Goal

Extend Crew role presets so one role can require multiple Pi skills.

A role should support this frontmatter:

```yaml
---
name: worker
description: Implement one bounded task
tools: read,bash,edit,write,grep,find,ls
skills: implement,tdd
---
```

When Crew dispatches a task, the child must receive each skill as a Pi skill command before the brief instruction.

## Current repository

- Repository: `/Users/gordon/Playground/pi-herdr-crew`
- Current branch has uncommitted Role preset work.
- Inspect it with `git diff` and `git status --short`.
- Do not discard or overwrite this work.

Changed and new files:

- `README.md`
- `src/index.ts`
- `src/registry.ts`
- `src/roles.ts`
- `src/roles.test.ts`

The current Role implementation already supports:

- Global roles from `~/.pi/agent/agents/*.md`
- Trusted project roles from `<cwd>/.pi/agents/*.md`
- Project override of a global role with the same name
- `name`, `description`, `kind: pi`, and comma-separated `tools`
- Role Markdown body as a Pi `--append-system-prompt` file
- `crew action=roles`
- `crew action=open role=<name>`

Role files already created globally:

- `~/.pi/agent/agents/scout.md`
- `~/.pi/agent/agents/reviewer.md`
- `~/.pi/agent/agents/worker.md`
- `~/.pi/agent/agents/planner.md`

## Required behavior

1. Parse `skills:` as a comma-separated ordered list.
2. Reject an empty declaration and invalid skill names.
3. Preserve declaration order.
4. Support more than one skill.
5. Keep Role tools as the child capability limit.
6. Keep the Role body in the child system prompt.
7. Keep the task and context in `brief.md`.
8. Force skill expansion for each dispatched task.

Use Pi skill commands, not a Role instruction that tells the model to load a skill.

For this role:

```yaml
skills: implement,tdd
```

The child task sequence should conceptually be:

```text
/skill:implement
/skill:tdd
Read /absolute/path/.pi/crew/<task>/brief.md and follow it exactly.
```

Confirm the correct delivery mechanism before editing. Pi expands `/skill:name` only when command expansion is enabled or the prompt enters the normal command path. The existing Crew dispatch uses:

```text
herdr agent prompt <member> <prompt>
```

Inspect the Herdr and Pi behavior rather than assuming that one combined string expands multiple commands.

## Important design constraint

Do not combine the skill commands and brief instruction into one line unless Pi documents that format.

A safe design can send ordered prompts separately:

1. Each `/skill:<name>` command.
2. The final `Read <brief> and follow it exactly.` instruction.

However, verify whether each prompt starts an unwanted agent turn. Prefer one supported Pi invocation path that loads all skills into the same task turn.

The reference implementation in `../pi-herdr-agents/pi-extension/subagents/index.ts:1654-1678` builds separate positional skill prompts. It adds `/skill:<name>` for each configured skill. Study that behavior and adapt only the minimum needed for Crew.

## Likely code changes

### `src/roles.ts`

- Add `skills?: string[]` to `CrewRole`.
- Parse and validate `skills:`.
- Keep the parser intentionally limited to comma-separated scalars.
- Do not add a YAML dependency.

### `src/index.ts`

- Apply the resolved Role skills during `askMember()`.
- Ensure `open` with a first task and later `ask` use the same path.
- Keep `brief.md` as the task source of truth.
- Show configured skills in the open result or `roles` output if useful.

### `src/roles.test.ts`

Add focused tests for:

- One skill
- Multiple ordered skills
- Invalid skill name
- Empty skills declaration
- No skills declaration

Add a focused dispatch-shape test if the current code allows extraction of a pure prompt builder.

### Global Role files

After implementation, update:

- `~/.pi/agent/agents/worker.md` with `skills: implement`
- `~/.pi/agent/agents/reviewer.md` with `skills: code-review`

Do not add skills to `scout` or `planner` unless their current task contract requires one.

## Existing skill facts

- `~/.pi/agent/skills/implement/SKILL.md` exists.
- `~/.pi/agent/skills/code-review/SKILL.md` exists.
- `implement` has `disable-model-invocation: true`, so explicit `/skill:implement` activation is required.
- `code-review` launches parallel subagents and expects a fixed comparison point.
- A Crew reviewer Role currently has only `read,grep,find,ls`. Check whether `code-review` requires capabilities outside that allowlist before assigning it.
- The `code-review` skill can conflict with the leaf reviewer Role because it orchestrates children. Resolve this explicitly. Do not silently give the reviewer extra tools.

## Verification state

Before this handoff, these commands passed:

```text
npm test          29 passed, 0 failed
npm run typecheck passed
git diff --check  passed
```

Run after implementation:

```bash
npm test
npm run typecheck
git diff --check
```

Also perform one live check if possible:

```text
crew action=roles
crew action=open member=<temporary-name> role=worker task=<small safe task>
```

Confirm the child session shows the expected Skill expansion and brief instruction. Close the temporary member after the check.

## Risks

- Multiple skill commands can create multiple turns instead of one task turn.
- A skill can require tools excluded by the Role allowlist.
- `code-review` is an orchestrator skill, while the current reviewer Role is a leaf Role.
- Project skills load only when the child starts with `trust=true`.
- Unknown global skill names can fail only inside the child unless Crew validates the resolved Pi skill catalog.

Keep the first version simple. Validate syntax locally, then let Pi report an unavailable skill at dispatch time unless a reliable public catalog interface already exists.

## Suggested skills

The next agent should call these skills:

1. `implement` - Implement this handoff and run the required checks.
2. `tdd` - Add the parser and prompt-shape tests before the implementation change.
3. `code-review` - Review the final diff against this handoff after implementation.
4. `ponytail` - Keep the change minimal and avoid a new workflow abstraction.

## Next action

Read `src/roles.ts`, `src/index.ts`, and `../pi-herdr-agents/pi-extension/subagents/index.ts:1654-1678`. Then choose the verified Pi skill delivery path.
