Ran the unfolded fold beside Claude itself, both in light mode, and fixed everything the two captures disagreed on.

**Composer**

- `+` and the microphone have their soft `#F0EFEC` circles back. Round 66 shipped them as bare glyphs - I read a crop wrong; both are circles, and so is the mic.
- The round button is **ink while the box is empty** (a waveform on black in the light theme) and takes the washed ember only once there is something to send. Round 65 recorded the ember as the light-mode colour; that is the filled state, not the resting one.

**The keyboard bug**

The IME was shortening the whole row, so the list column lost ~400dp and the new-chat pill floated up into the middle of it. Only the conversation pane takes the IME inset now; the list keeps its full height, which is what Claude does.

**List**

- Header: `最近记录` is centred with the two glyphs at the column's end, not left-aligned against them.
- Search: sits on white with a hairline pill outline.
- Rows: `<>` for a session that belongs to a project folder, a speech bubble for a plain conversation. Ours had bubbles for everything.

**Conversation header**

The eye is gone - Claude parks its sheet ghost there. Drawn with a Path rather than iconified, because no Material glyph has the scalloped hem; it tints with the accent while the blur is on.

**Model pill**

Names the effort beside the model, the way `Sonnet 5.5 中等` does.

Verified on the fold at 1672x2364 in light mode; every item above was checked in the running app, not just in code.