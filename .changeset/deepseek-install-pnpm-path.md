---
'aicodeman': patch
---

Installing DeepSeek from CLI management no longer leaves it "not installed". The `dsh` terminal profile install ran `dsh plugin`, which needs `pnpm` on its PATH, but the server's own PATH usually lacks the user prefix (`~/.local/bin`) where CLI management puts `dsh`. The profile install now puts `dsh`'s directory first on PATH, and the DeepSeek install command installs `pnpm` alongside `dsh`.
