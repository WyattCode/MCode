Two things, both found by reading the code rather than the screen.

**The selected row was never drawn.** `SessionList` takes a `current` parameter - the open conversation's id - and never reads it, so the list had no mark for where you were. Claude does. The open row now carries the soft `#F0EFEC` pill.

**Six warnings, all worth clearing:**

- `AppTopBar` kept `wide`, `title` and `onTasks` after the portrait rewrite stopped using them. Narrowed to the three things it draws.
- `ConnectScreen` took an `onDismiss` it never called - the connect flow only closes on success.
- `MediaRecorder`'s no-arg constructor is deprecated from API 31. The context-bound one is used at 31+, the old one below with a scoped suppression.
- `Article` and `CallSplit` have AutoMirrored forms now (a back-facing arrow and a split both flip in RTL), so the deprecation notices go.
- The settings sheet shadowed the outer `currentRow` with a second lookup of the same expression.

`kotlinc` now reports nothing for this file.