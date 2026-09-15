---
name: mcode-guide
description: Answer questions about MCode itself and change its display settings - where instructions, skills and commands go, how subagents, tasks, permissions, models and MCP servers work, and how to switch theme, font sizes, diff style or language. Use when the user asks how to do something in MCode, why it behaves a certain way, or asks it to change one of its own settings.
aliases:
  - mcode-help
---

# MCode, for its own users

Answer from what is below. If a question goes past it, say what you are unsure
of and point to the Settings page most likely to hold the answer instead of
guessing.

## Settings you can change directly

`get_desktop_settings` reads, and `set_desktop_setting` changes, these keys:
`theme`, `ui_font_size`, `code_font_size`, `diff_style` and `language`. Read
first to see the allowed values, change what was asked, and say what changed.
Everything else - models and providers, MCP servers, permissions, shortcuts,
voice, sounds - is changed by the user in Settings; tell them which page.

## Instructions

- A project's `AGENTS.md` (also `CLAUDE.md` and `.mcode/rules.md`) is read into
  every conversation in that project.
- The global AGENTS.md, kept in MCode's data folder and opened from Settings,
  applies to every project; the project's own file wins where they disagree.

## Skills

- Folders with a `SKILL.md`. MCode ships built-in ones (this is one); users add
  their own under `.mcode/skills/<name>/` in a project or `skills/<name>/` in
  MCode's data folder. A user skill replaces a built-in one of the same name.
- Typing `/name` in a message loads that skill into it (up to three per
  message). The slash menu lists every skill, and the composer's plus menu
  offers them as chips. The skill-creator skill explains how to write one.

## Commands

Markdown files under `.mcode/commands/` become slash commands; the text after
the command name fills `$ARGUMENTS`, `$1`, `$2`. MCP servers' prompts appear in
the same menu.

## Subagents and tasks

- The agent can hand work to subagents with the actor tool: `spawn` runs one in
  the background, `run` waits for it. They appear as pills in the conversation
  and in the 子智能体 (Subagents) tab of the side panel, with their own
  transcripts.
- The task tool keeps the conversation's task list (T1, T1.1 ...), shown in the
  information card's task list.

## Permissions

The access level in the composer decides what runs without asking: ask for
changes, approve-for-me (routine edits and commands run, risky ones are checked),
or full access. Settings can set any tool to always allow, ask or deny. A
refusal stops the turn, and the reason is passed to the agent with the next
message.

## Modes

Plan mode (from the composer) reads and describes a plan without changing files.
`/compact` summarises a long conversation to free context.

## Side panel

Files the agent produces or presents open in the side panel: Word, Excel,
PowerPoint and PDF previews, HTML pages, images and video, diffs and review, a
terminal and a browser.
