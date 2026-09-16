---
name: session-chat
description: Treat the other conversations open in MCode as contacts - consult one that holds context this work needs, hand a piece of work to one, keep a long-running conversation's purpose and task up to date, or open a new conversation for a separate strand of work. Use when the user asks to ask, tell, consult or coordinate with another conversation, or when what you need is known to a conversation that is not this one.
aliases:
  - talk-to-session
---

# Talking to other conversations

Every conversation open in MCode is a contact with its own history, its own
folder and its own turn. Messaging one runs a real turn there, which the user
can watch; the reply is that turn's final message.

This is not delegation. A helper that does one piece of work and disappears is
the `task` tool's job - a subagent shares this conversation's turn and cannot
use these tools at all. Reach for a session only when the work belongs to a
conversation that outlives this turn: one that already holds the context, or one
the user keeps for that strand of work.

## Finding who to talk to

`contacts` lists the others, most recently active first. Each line gives the
title, the contact id, whether it is busy, and the purpose, workspace, task and
task status recorded for it.

Call it when you cannot name the target exactly, when you want to read what a
conversation is for, or after `talk_to_session` came back with candidates. When
you already know the exact title or the id, skip it and send the message.

## Sending a message

`talk_to_session` takes either `contact` (the target's exact title) or
`contact_id`, and a `message`.

- The other conversation cannot see this one. Write the message so it stands on
  its own: what you need, what it is for, and any detail from here it would
  otherwise have to ask for.
- `mode: "sync"` is the default and waits up to 120 seconds. If the target is
  busy, or the reply does not come in time, the call returns at once and says it
  switched to async - **do not send the message again**; the reply arrives in
  this conversation later as a marked message.
- `mode: "async"` always returns immediately, for when you have other work to
  get on with.

A session cannot message itself, and a chain of sessions messaging each other
stops after five hops. When a call is refused, say so plainly to the user rather
than working around it.

## Opening a new conversation

`create_session` takes a `name`, a `purpose` and a `workspace`, and optionally a
first `task`. It creates a real conversation the user sees in the side column.

- Only create one when the user asks for it, or when work genuinely has to
  continue in a conversation of its own and none of the existing ones fits.
- `workspace` must be an absolute path to a folder that already exists. Check it
  rather than guessing, and do not quietly reuse this conversation's folder.
- A new conversation does nothing until you send it a message.

## Keeping the record straight

`update_session` changes a conversation's title, or the purpose, task and task
status recorded for it, by `contact_id`. `task_status` is one of `idle`,
`working`, `blocked` or `done`.

Update the task and its status when you hand work over and when it lands - that
record is what `contacts` shows, so a stale one sends the next question to the
wrong place. An empty `purpose` or `task` clears it.

## Reporting back

Tell the user which conversation you asked and what it said, in a line or two.
When a reply is coming later, say that instead of waiting in silence, and carry
on with what you can do meanwhile.
