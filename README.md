# MCode

A keyboard-first, command-palette-driven AI coding agent, built as an Electron desktop app.

This is a ground-up reimplementation of [opencode](https://github.com/anomalyco/opencode)'s core runtime on a
different stack — **Electron + Vue 3 + Node + WebSocket** — following opencode's own design system. opencode
is MIT-licensed; this is new code, not a port of theirs.

## Design

The token vocabulary is opencode's, and two details carry most of the look:

- **Text is a four-step scale** — `strong` / `base` / `weak` / `weaker` — where **`base` (#A0A0A0) is the
  default body colour** and `strong` is reserved for emphasis and for conversation content. Chrome sits a
  step or two down.
- **Two accents with separate jobs.** `--interactive` (blue) owns selection, focus, and input state.
  `--primary` (apricot, #FAB283) is the brand mark and is used sparingly — the streaming indicator, and
  little else. It is deliberately *not* a button fill: primary buttons are a light neutral on dark, which is
  what gives opencode its characteristic look instead of a saturated call-to-action colour.

Surfaces step `base` → `raised` → `raised-hover`; borders come in `weaker` / `weak` / `strong`. The status
hues get separate on-surface text variants (`--text-warning` and friends) because the raw hues are surface
colours and fall below readable contrast as text on a light ground.

## Architecture

```
Electron main process
├─ window / menu / IPC bridge          src/main
├─ preload (contextBridge, 3 methods)  src/preload
└─ Node backend                        src/server
   ├─ WebSocket server (127.0.0.1:0)   index.ts        request/response + event broadcast
   ├─ event bus                        bus.ts          runtime never touches a socket directly
   ├─ session store                    session/store.ts one JSON file per message
   ├─ agent loop                       session/runner.ts hand-written streaming loop
   ├─ provider adapter                 provider/       Anthropic Messages API
   ├─ tools                            tool/           read write edit list glob grep bash todowrite webfetch
   ├─ permission gate                  permission.ts   parks a tool until the user answers
   └─ shell                            shell.ts        pipe-backed, no native modules

Renderer (Vue 3 + Pinia)               src/renderer
├─ typed WS client                     lib/client.ts
├─ store                               stores/app.ts
└─ components                          components/
```

**Why WebSocket rather than Electron IPC for data.** The backend is a plain Node module with no Electron
imports. That keeps the agent runtime testable headlessly — `npm run smoke` drives the real socket with no
window on screen — and leaves the privileged preload bridge small enough to audit at a glance (bootstrap,
directory picker, window controls; nothing else).

**Why a hand-written agent loop** instead of the SDK's tool runner: every step has to be observable. Each
text delta, tool state transition, and permission prompt is published as it happens so the UI can render a
turn while it is still running, and so an abort can land mid-tool.

## Running it

```bash
npm install
npm run dev
```

Add an Anthropic API key in **Settings** (`Ctrl+,`), or export `ANTHROPIC_API_KEY` before launching. Keys are
stored with owner-only permissions in the app data directory and only ever cross the wire as a
`configured: true` flag — the renderer never receives the key itself.

```bash
npm run smoke       # 209 backend checks over a real socket, no API key needed
npm run typecheck   # renderer + node
npm run build
npm run package     # electron-builder
```

Ten narrower checks guard the things a type error cannot see. Each is meant to be able to fail: the way to
trust one is to break the code it covers on purpose and watch it go red.

```bash
npm run themecheck    # every theme resolves; scrims exist; logical properties only
npm run wiringcheck   # menu channels, component events and command ids all reach something
npm run i18ncheck     # 18 tables agree, and match the reference's own strings
npm run mcpcheck      # MCP server lifecycle
npm run mdcheck       # the markdown renderer
npm run sandboxcheck  # path traversal refusals
npm run toolcheck     # the tools, driven the way a turn drives them
npm run sessioncheck  # the runner, permissions, undo and revert
npm run shellcheck    # the terminal opens onto a real pty, prompts and echoes
```

## Keys

| Key | |
|---|---|
| `Ctrl+K` | command palette — everything is reachable from here |
| `Ctrl+N` / `Ctrl+O` | new session / open a project directory |
| `Ctrl+M` | switch model |
| `` Ctrl+` `` | terminal drawer |
| `Ctrl+B` | sidebar |
| `Ctrl+.` / `Esc` | stop the current turn |
| `Enter` / `Shift+Enter` | send / newline |
| `Y` `A` `N` | in a permission prompt: allow once, always, reject |

## Permissions

Read-only tools (`read`, `glob`, `grep`, `list`, `todowrite`) run without asking. Anything that writes a
file, runs a command, or reaches the network prompts first, showing the exact command or a unified diff of
the change. "Always allow" is remembered per session for the life of the process and is deliberately never
persisted, so a blanket approval cannot silently outlive the app.

A few command shapes — recursive force deletes, disk writes, fork bombs, host power control — are refused
outright rather than prompted. An approval dialog trains people to click through, and the agent has no
reason to reach for those on its own.

## What is not here

opencode is a large monorepo; this rewrite covers its core runtime, not its surface area. Not implemented:

- **LSP, plugins, and skills.** No subsystem for any of the three, so the panes that would list them are
  deliberately absent rather than empty.
- **Custom agents.** The two presets, Build and Plan, are the whole set.
- **Sub-agents.** No `task` tool, so a turn cannot hand work to a child session.
- **Session sharing, cloud sync, and the web/TUI clients.**

## Verification

`npm run smoke` boots the backend over a real WebSocket and checks the session lifecycle, persistence
across a restart, every tool, path-traversal refusal, the permission round-trip (allow / reject / always),
the diff renderer, glob semantics, and provider history conversion — in particular that every `tool_use`
block is answered by a matching `tool_result`, which is where replayed-history bugs tend to live.

The one path it cannot reach without an API key is the provider call itself.
