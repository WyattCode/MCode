---
name: skill-creator
description: Create, review and improve skills for MCode - folders with a SKILL.md that teach the agent one kind of work. Use when the user wants to make a new skill, turn a workflow they keep repeating into one, fix a skill that is never picked up or picked up at the wrong times, or check a skill folder before sharing it.
aliases:
  - create-skill
---

# Making skills

A skill is a folder holding `SKILL.md` and, optionally, `scripts/`, `references/`
and `assets/`. MCode lists every skill's name and description in the system
prompt; the full file is only read when the skill is loaded. So the description
decides whether a skill is used, and the body decides whether it is used well.

## Where skills live

- A project's own: `.mcode/skills/<name>/SKILL.md` in the project (a `.mcode`
  folder higher up, to the repository root, is read too; the nearest wins).
- The user's, for every project: the `skills/<name>/` folder in MCode's data
  folder, beside its global AGENTS.md (Settings shows where that is).
- A skill with the same name as a built-in one replaces it.

## 1. Understand the workflow

Ask for one or two real examples of the task, what a good result looks like, and
what usually goes wrong. Use the question tool when choices are clear-cut.

## 2. Write the frontmatter

```
---
name: meeting-notes
description: Turn a meeting transcript into notes with decisions, owners and dates. Use when the user shares a transcript, recording notes or chat log and asks for minutes, a summary or action items.
aliases:
  - minutes
disable-model-invocation: false
---
```

- `name`: lowercase words joined by hyphens, the same as the folder.
- `description` (required): what it does and when to use it, with the words a
  user would actually say and the file types involved. Under 1024 characters,
  no angle brackets.
- `aliases` (optional): other names `skill_search` should match.
- `disable-model-invocation: true` (optional): the agent never sees or loads the
  skill; the user starts it by typing `/name`. Use it for long or disruptive
  workflows whose timing the user should decide.

## 3. Write the body

- Imperative steps in the order the work happens, with the checks that prove
  each step worked.
- Name the tools to use (bash, read, edit, present_files, task, actor ...).
- Move long reference material into `references/` and say when to read it.
- Put repeatable, fiddly work into a script in `scripts/` rather than asking the
  agent to rewrite it each time; say exactly how to run it. Paths in the body are
  relative to the skill's folder.
- Keep it under a few hundred lines. Cut anything the agent already knows.

## 4. Check it

```
python scripts/check_skill.py path/to/the-skill
```

Run this skill's checker with the bash tool (from this skill's folder). It flags
missing fields, a name that does not match its folder, a vague description, and
scripts or references the body mentions that do not exist. Then try the skill:
start a message with `/name` and watch whether the steps hold up, and ask a
question that should trigger it without naming it to see whether the description
is picked up.
