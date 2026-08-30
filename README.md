# DiffOps

**DiffOps** is an installable PWA that lets you view and review local git diffs
with a GitHub-style viewer. Register a repository folder, open it in its own
window, and review it with comments, keyboard navigation, and AI-assisted
narration. Reading a folder needs the File System Access API, so it runs in a
desktop Chromium browser.

DiffOps is forked from [difit](https://yoshiko-pg.github.io/difit/), a similar
local code review review tool that's CLI-based. Go check it out.

## Quick Start

This project uses [Bun](https://bun.com).

```bash
bun install
bun run build
bun run serve
```

The built app is fully static — the server only hands out files. Explain and
Narrated review call [Vercel's AI Gateway](https://vercel.com/docs/ai-gateway)
from the browser; add your API key under **Settings → AI** to turn them on.
