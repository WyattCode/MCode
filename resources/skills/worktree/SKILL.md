---
name: worktree
description: Set up a separate git worktree before starting work that should not land on the branch currently checked out - a feature, a fix to hand over later, or a plan to carry out step by step. Checks whether the work is already isolated, asks the user once and remembers the answer, and makes sure the new folder is ignored before creating it.
aliases:
  - git-worktree
---

# Working in a separate worktree

## In short

A worktree is a second checkout of the same repository in its own folder, on its
own branch. Work there cannot disturb the branch the user has open, and other
conversations can use the main checkout at the same time.

Order of work: find out whether you are already isolated, then ask, then create,
then prepare the folder and check the tests. Say at the start that you are
using this skill to set up a separate workspace.

## Step 0: are you already isolated?

Run, in the project folder:

```bash
git rev-parse --path-format=absolute --git-dir
git rev-parse --path-format=absolute --git-common-dir
git branch --show-current
```

The two directories differ inside a linked worktree - and inside a submodule.
Rule the submodule out before trusting the answer:

```bash
git rev-parse --show-superproject-working-tree
```

- **Different directories, and the last command printed nothing:** this is
  already a linked worktree. Do not create another one; go to Step 2. Tell the
  user where you are: "Working in the worktree at `<path>` on `<branch>`", or,
  with no branch, "Working in the worktree at `<path>` on a detached HEAD - a
  branch will be needed before the work is finished."
- **Same directory, or a submodule:** this is an ordinary checkout. Continue.

### Asking first

1. Search memory (the `memory` tool, global scope) for a saved
   `worktree-preference`, and read the project's instructions for one. If either
   says always or never, follow it without asking.
   A reminder in this conversation saying the repository already keeps
   worktrees is itself the answer: create one and carry on, without asking.
2. Otherwise ask with the `question` tool:
   - header: `Worktree`
   - question: `Do this work in a separate worktree, so the current branch stays untouched?`
   - options:
     - `Yes (recommended)` - create a worktree for this work
     - `No` - work on the current branch
     - `Always` - use a worktree now and in later conversations
     - `Never` - work in place now and in later conversations
   A subagent cannot ask: it creates the worktree and carries on.
3. For `Always` or `Never`, write `worktree-preference: always` (or `never`)
   into the global memory file the system prompt names, so the next
   conversation does not have to ask.

If the answer is `No` or `Never`, work in place and go to Step 2.

## Step 1: create the worktree

### Where it goes

In this order - an explicit instruction beats what happens to be on disk:

1. A folder the user or the project's instructions name for worktrees.
2. An existing `.worktrees/` at the repository root, then an existing
   `worktrees/`. If both exist, `.worktrees/` wins.
3. Otherwise `.worktrees/` at the repository root.

### Make sure git ignores it

A worktree folder inside the repository has to be ignored, or its whole content
shows up as untracked and can end up committed:

```bash
git check-ignore -q .worktrees || git check-ignore -q worktrees
```

If it is not ignored, add the folder to `.gitignore` and commit that change
before going on.

### Create it

```bash
git worktree add "<root>/.worktrees/<branch>" -b "<branch>"
```

Pick a short branch name that says what the work is. Then carry out every
following command in that folder - pass it as the working directory of each
`bash` call, and give file tools paths inside it.

If `git worktree add` is refused for lack of permission, tell the user it could
not be created and carry on in the current folder.

## Step 2: prepare the folder

Install what the project needs, judging by what is there:

| File | Command |
| --- | --- |
| `package.json` | the project's package manager: `npm install`, `pnpm install` or `yarn` |
| `Cargo.toml` | `cargo build` |
| `requirements.txt` | `pip install -r requirements.txt` |
| `pyproject.toml` | the tool the project uses (`uv sync`, `poetry install`) |
| `go.mod` | `go mod download` |

Nothing matching: skip this step.

## Step 3: check the starting point

Run the project's tests once before changing anything, so a failure you cause
can be told apart from one that was already there.

If some fail, ask with the `question` tool:
- header: `Tests`
- question: `<N> tests already fail before any change. Carry on?`
- options: `Carry on (recommended)` - start the work and note the existing failures; `Look first` - investigate the failures before starting

A subagent carries on and reports the failures.

When done, report:

```
Worktree ready: <path> on <branch>
Tests: <N> passing, <M> failing before any change
Next: <what you are about to do>
```

## Quick reference

| Situation | What to do |
| --- | --- |
| Already in a linked worktree | Skip creating one |
| Inside a submodule | Treat as an ordinary checkout |
| Preference saved as always / never | Follow it without asking |
| `.worktrees/` or `worktrees/` exists | Use it, after checking it is ignored |
| Neither exists | Project instructions, else `.worktrees/` |
| Folder not ignored | Add it to `.gitignore` and commit first |
| Creation refused | Say so and work in place |
| Tests fail before any change | Report them and ask |

## Mistakes to avoid

- **Nesting worktrees.** Always run Step 0 first; a worktree inside a worktree
  confuses every later git command.
- **Skipping the ignore check.** The worktree's files then appear in the main
  checkout's status and get committed by accident.
- **Guessing the location.** Follow the order above; a project that already has
  a worktrees folder expects new ones there.
- **Starting on red.** Without a baseline, a broken test cannot be pinned on
  anything.
- **Leaving the worktree without saying so.** Tell the user its path and branch;
  the merge skill finishes and removes it later.
