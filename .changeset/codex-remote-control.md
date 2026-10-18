---
"aicodeman": minor
---

Optional remote control for the CLIs that have one, all off by default, as a fallback for when the Codeman page can't be reached (a firewall, DNS, an external proxy). Settings gets a "Remote control" group: Claude Code, Antigravity and GitHub Copilot switches that start new local sessions with the CLI's own flag (`--remote-control`, or `--remote` for Copilot), so the vendor's phone or web client (GitHub web and mobile for Copilot) drives them through its relay over outbound connections, and a Codex switch with Start, Pair and Stop buttons for `codex remote-control`. Claude's flag is skipped on a claude older than 2.1.51; remote-SSH and Docker sessions never get it; Codex's Stop always works; the Codex controls are admin only in multi-user mode, and Codeman never starts any of it on its own.
