---
"aicodeman": minor
---

Optional remote control for the CLIs that have one, all off by default, as a fallback for when the Codeman page can't be reached (a firewall, DNS, an external proxy). Settings gets a "Remote control" group: Claude Code and Antigravity switches that start new local sessions with `--remote-control`, so the vendor's phone or web client drives them through its relay over outbound connections, and a Codex switch with Start, Pair and Stop buttons for `codex remote-control`. Claude's flag is skipped on a claude older than 2.1.51; remote-SSH and Docker sessions never get it; Codex's Stop always works; the Codex controls are admin only in multi-user mode, and Codeman never starts any of it on its own.
