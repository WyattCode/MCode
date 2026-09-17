---
name: merge
description: Finish a branch once its work is done and its tests pass - offer to merge it locally, push it and open a pull request, keep it, or throw it away, then carry out the choice and tidy up the worktree it lived in. Use when implementation is complete and the user needs to decide how the work goes back into the main line.
aliases:
  - finish-branch
---

# Finishing a branch

## In short

Check the tests, find out where you are, offer a fixed set of choices, do the
one picked, and clean up only what this work created. Say at the start that you
are using this skill to finish the branch.

Nothing destructive happens without an explicit yes from the user.

## Step 1: the tests pass

Run the project's test suite (`npm test`, `cargo test`, `pytest`, `go test ./...`
- whatever the project uses).

If anything fails, stop and report:

```
<N> tests fail, so the branch is not ready to merge or publish:

<the failures>
```

Do not offer the choices below until they pass.

## Step 2: where the branch lives

```bash
git rev-parse --path-format=absolute --git-dir
git rev-parse --path-format=absolute --git-common-dir
git branch --show-current
```

| What you find | Choices to offer | Clean-up |
| --- | --- | --- |
| Same directories (ordinary checkout) | all four | none needed |
| Different directories, on a branch | all four | Step 5 |
| Different directories, detached HEAD | three: no local merge | none - someone else manages this folder |

## Step 3: the base branch

The system prompt names the repository's default branch; that is usually the
base. Confirm it with:

```bash
git merge-base HEAD <default branch>
```

If it is not clear which branch this one grew from, ask with the `question`
tool:
- header: `Base branch`
- question: `This branch seems to come from <base>. Is that right?`
- options: `Yes, <base>` - merge back into it; `Another branch` - the user names it

A subagent uses the branch it found.

## Step 4: offer the choices

With the `question` tool:
- header: `Finish`
- question: `The work is done and tested. What should happen to <branch>?`
- options:
  - `Merge here` - merge it into <base> in this repository
  - `Pull request` - push the branch and open a pull request
  - `Keep` - leave the branch as it is for now
  - `Discard` - delete the branch and its commits

On a detached HEAD, leave out `Merge here`, and say that the pull request would
be pushed as a new branch.

A subagent does not choose for the user: it keeps the branch and reports.

### Merge here

Work from the main checkout, never from inside the worktree being finished:

```bash
cd "$(git rev-parse --path-format=absolute --git-common-dir)/.."
git checkout <base>
git pull
git merge <branch>
```

Run the tests again on the merged result. Only when the merge and the tests both
succeed, clean up (Step 5) and then delete the branch:

```bash
git branch -d <branch>
```

If the merge stops on conflicts, the note in the command's result says what to
do; follow it rather than resolving the conflict yourself.

### Pull request

```bash
git push -u origin <branch>
```

Then open the pull request against <base> with the host's own tool if the user
has one set up (for example `gh pr create`), with a title and a body that list
what changed and how it was tested. Without such a tool, give the user the
branch name and the link the push printed.

Keep the worktree: review comments will need it.

### Keep

Report `Branch <branch> kept; its worktree stays at <path>.` and change nothing.

### Discard

Ask once more, with the `question` tool:
- header: `Discard`
- question: `This deletes <branch>, every commit on it and the worktree at <path>, and cannot be undone. Go ahead?`
- options: `Cancel` - keep everything; `Delete it` - discard for good

Only `Delete it` continues; `Cancel` goes back to Step 4. Then, from the main
checkout, clean up (Step 5) and remove the branch:

```bash
git branch -D <branch>
```

## Step 5: clean up the worktree

Only after `Merge here` or `Discard`.

```bash
git rev-parse --path-format=absolute --git-dir
git rev-parse --path-format=absolute --git-common-dir
git rev-parse --show-toplevel
```

- Same directories: an ordinary checkout, nothing to remove.
- The worktree is under `.worktrees/` or `worktrees/`: this work created it, so
  remove it from the main checkout:

  ```bash
  git worktree remove "<worktree path>"
  git worktree prune
  ```

- Anywhere else: something other than this workflow made it. Leave it in place
  and tell the user where it is.

`git worktree remove` refuses when the worktree has uncommitted changes. Do not
add `--force`; tell the user what is left there.

## Quick reference

| Choice | Merges | Pushes | Keeps the worktree | Deletes the branch |
| --- | --- | --- | --- | --- |
| Merge here | yes | - | - | yes |
| Pull request | - | yes | yes | - |
| Keep | - | - | yes | - |
| Discard | - | - | - | yes, forced |

## Mistakes to avoid

- **Offering choices on failing tests.** A merge or pull request of broken work
  costs more than the wait.
- **Asking an open question.** "What next?" gets a vague answer; give the four
  choices (three when detached).
- **Removing the worktree for a pull request.** The review is not over yet.
- **Deleting the branch before removing its worktree.** git refuses, and a half
  clean-up is left behind.
- **Discarding without the second question.** Deleting commits is the one step
  that cannot be taken back.
- **Removing a worktree this work did not create.** Only folders under
  `.worktrees/` or `worktrees/` are yours to remove.
