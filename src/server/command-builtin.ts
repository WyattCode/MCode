import { existsSync } from "node:fs"
import path from "node:path"
import type { CommandDefinition } from "@shared/protocol"

/**
 * The commands MiMo's engine always offers after a slash, in its order:
 * /init, /review, /dream, /distill, /rebuild. (Its /goal is left out, as
 * MiMo's desktop hides it; its /deep-research and /loops sit behind
 * experiment switches the desktop leaves off.)
 *
 * Structured as MiMo's are - the same kinds of section, the same run modes -
 * and written in this app's own words:
 *
 * - /init runs in the conversation and writes AGENTS.md;
 * - /review is handed to a subagent;
 * - /dream and /distill run the turn as their own agent (session/prompts.ts),
 *   which may write only memory and the project's `.mcode` folder;
 * - /rebuild is taken by the composer, which compacts the conversation: MiMo
 *   rebuilds from a checkpoint, its desktop turns checkpoints off, and so it
 *   compacts instead - which is what this app does too.
 */

const INIT = `Set up or improve \`AGENTS.md\` for this repository.

The aim is a short file of instructions that saves later conversations from mistakes and lets them get going quickly. Test every line against one question: would an agent probably get this wrong without being told? If not, leave the line out.

What the user wants you to focus on or keep to (follow it):
$ARGUMENTS

## Where to look

Start with the sources that say the most:
- \`README*\`, the manifests at the root, workspace settings and lockfiles;
- the configuration for building, testing, linting, formatting, type checking and code generation;
- CI workflows, pre-commit hooks and task runners;
- instruction files that already exist (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`);
- this project's own MCode folder, \`.mcode/\` (commands, skills, \`rules.md\`).

If the structure is still unclear after that, read a few representative source files to find the real entry points, the package boundaries and how a request flows through. Prefer files that show how things are wired together over files that only implement one piece.

Trust what runs over what is written: where the docs and the configuration or scripts disagree, go with the configuration and keep only what you can confirm.

## What to pull out

The facts an agent working here most needs:
- the exact commands for the everyday jobs, above all the ones that are not obvious;
- how to run one test, one package, or one narrow check;
- the order commands must run in, when it matters (for example lint, then type check, then test);
- how a monorepo is split, who owns which top-level folders, and where the real entry points of each app or library are;
- quirks of the framework or toolchain: generated code, migrations, build output, special environment loading, dev servers, deployment;
- conventions of this repository that differ from the usual defaults;
- testing quirks: fixtures, services an integration test needs, snapshot workflows, slow or flaky suites;
- rules from the existing instruction files that should be kept.

The best content is the kind that took reading several files to work out.

## Asking

Ask the user only about what the repository cannot tell you, and then in one short batch with the question tool. Good things to ask: team conventions nobody wrote down; branch, pull request and release habits; setup steps or prerequisites that are known but not documented. Never ask what the repository already makes clear.

## How to write it

Put in only guidance specific to this repository:
- exact commands and shortcuts an agent would otherwise guess wrong;
- structure that the file names do not reveal;
- conventions that differ from what the language or framework would suggest;
- setup requirements, environment quirks and operational traps;
- pointers to other instruction files that matter.

Leave out generic programming advice, long tutorials, complete file trees, obvious language conventions, guesses, and anything you could not confirm. When in doubt, leave it out.

Use short sections and bullet points. A simple repository gets a simple file; for a large one, summarise the few structural facts that change how an agent should work.

If \`AGENTS.md\` already exists at \`\${path}\`, improve it where it is rather than starting over: keep what is useful and still true, remove padding and claims that no longer hold, and bring it in line with the code as it is now.
`

const REVIEW = `Review a set of code changes and give feedback the author can act on.

What to review: $ARGUMENTS

## Working out what to review

1. Nothing given: every change not yet committed.
   - \`git diff\` for what is not staged, \`git diff --cached\` for what is;
   - \`git status --short\` for files that are new and untracked.
2. A commit hash, full or short: that commit - \`git show <hash>\`.
3. A branch name: this branch against it - \`git diff <branch>...HEAD\`.
4. A pull request, as a link or a number: \`gh pr view <it>\` for its context and \`gh pr diff <it>\` for the change, when the GitHub CLI is available.

Use judgement where the input could be read more than one way.

## Reading around the change

A diff on its own is not enough. Once you know which files changed, read each of them whole: code that looks wrong in isolation can be right in context, and the other way round.
- Read untracked files in full.
- Follow the control flow and error handling around each change.
- Look for the project's own conventions: AGENTS.md, CONVENTIONS.md, .editorconfig, linters' settings.

## What to look for

**Bugs** - the main thing.
- Wrong logic, off-by-one errors, conditions the wrong way round.
- Missing guards, wrong branches, code that can never run.
- Edge cases: empty, missing or null input, error paths, races.
- Security: injection, bypassed authorisation, data exposed.
- Error handling that swallows failures, throws where nothing catches it, or returns errors callers do not check.

**Fit** - does the change belong in this codebase?
- Does it follow the patterns around it, and use the abstractions that already exist?
- Could deep nesting be flattened with early returns or a helper?

**Performance** - only where it is plainly a problem: quadratic work on unbounded input, a query per item, blocking I/O on a hot path.

**Changed behaviour** - point out anything that now behaves differently, especially if it may not have been intended.

## Before calling something a problem

Be sure. Review only what changed, not code that was already there. Do not report a bug you are unsure of - look further first - and do not invent unlikely failures; if an edge case matters, describe the real situation in which it breaks. If you still cannot tell, say that you are not sure rather than stating it as a fault.

Do not police style. Check that a convention is really broken before saying so, accept the simplest option when it is reasonable, and raise style only where it clearly goes against this project's own rules. Deep nesting is worth raising regardless.

## Tools

Read the surrounding code, search the project for how similar problems are handled, and check the documentation of a library before calling its use wrong.

## The report

1. For each bug, say plainly why it is one.
2. Give each finding an honest severity; do not inflate it.
3. Say under which inputs, environments or conditions the problem appears, so its severity can be judged at a glance.
4. Keep the tone factual and helpful - neither accusing nor flattering.
5. Write so the point is clear on a quick read.
6. Leave out anything that does not help: no praise, no thanks.
`

const DREAM = [
  "Tidy this project's memory once, now.",
  "",
  "What the user wants you to focus on or keep to:",
  "$ARGUMENTS",
  "",
  "Treat the memory files as the index and the raw record of past conversations as the truth.",
  "Use shell commands only to read: query the SQLite index read-only and look around the files. Do not change the database or the conversation files.",
  "Put into project memory only what will stay true and what you have checked.",
].join("\n")

const DISTILL = [
  "Look for repeated work in this project once, now.",
  "",
  "What the user wants you to focus on or keep to:",
  "$ARGUMENTS",
  "",
  "Go back over recent work and find the procedures done by hand again and again that are worth packaging.",
  "Treat the raw record of past conversations as the truth, and use the memory files to spot what recurs across conversations.",
  "List the skills and commands that already exist first, so you reuse or extend them instead of making copies.",
  "Use shell commands only to read: query the SQLite index read-only and look around the files. Do not change the database or the conversation files.",
  "Draw up a short list, then create only the missing pieces you are sure of.",
].join("\n")

/** The folder a repository's AGENTS.md belongs in: its top, or the folder itself outside a repository. */
function repositoryTop(directory: string): string {
  let at = path.resolve(directory)
  for (;;) {
    if (existsSync(path.join(at, ".git"))) return at
    const parent = path.dirname(at)
    if (parent === at) return path.resolve(directory)
    at = parent
  }
}

/** MiMo's engine commands for one folder, in the order the slash menu lists them. */
export function builtinCommands(directory: string): Record<string, CommandDefinition> {
  return {
    init: {
      description: "set up or improve AGENTS.md for this project",
      template: INIT.replace("${path}", () => repositoryTop(directory)),
    },
    review: {
      description: "review changes - uncommitted by default, or a [commit|branch|pr]",
      template: REVIEW,
      subtask: true,
    },
    dream: {
      description: "tidy this project's memory by hand from its memory files and past conversations",
      template: DREAM,
      agent: "dream",
      subtask: false,
    },
    distill: {
      description: "turn work that keeps repeating into skills or commands",
      template: DISTILL,
      agent: "distill",
      subtask: false,
    },
    rebuild: {
      description: "make room in the context now by condensing the conversation so far",
      template: "$ARGUMENTS",
      subtask: false,
    },
  }
}
