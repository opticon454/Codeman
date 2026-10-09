---
'aicodeman': patch
---

The mouse wheel scrolls a Codex session again. Codex 0.160 draws on the alternate screen, so Codeman's own scrollback for it is empty and the wheel scrolled nothing (PageUp/PageDown, which Codex handles itself, still worked). Codex sessions with no local scrollback now page Codex's own transcript with those keys, exactly as Claude sessions already did; Shift+wheel and sessions with real scrollback are unchanged.
