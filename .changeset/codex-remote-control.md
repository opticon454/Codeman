---
"aicodeman": minor
---

Codex remote control: Settings gets an opt-in switch (off by default) and Start, Pair and Stop buttons for the Codex CLI's own `codex remote-control` command, so another device can drive Codex on this machine without a shell. Stop always works, even with the switch off; in multi-user mode it is admin only, and Codeman never starts it on its own.
