# Setting up Eternal on a new computer

This is the short version of "I have a fresh Linux machine and want Eternal back".
It has three parts. Do part 1 to just use the app. Part 2 brings back your chats
and settings. Part 3 is only for changing the code.

Everything here was tested on Bazzite (Fedora-based) on 2026-10-22.

---

## 1. Install the app (about 5 minutes)

The ready-to-run app is stored as a private download on this repository's
**Releases** page (tag `eternal-desktop-0.17.0-20261022`). It contains its own
Python and everything else it needs, including the MCP library.

1. Install GitHub's command-line tool and sign in (opens your browser):

   ```bash
   brew install gh
   ```

   ```bash
   gh auth login --hostname github.com --git-protocol https --web
   ```

   On a machine without Homebrew, install `gh` from your distro's software
   store or from https://cli.github.com instead.

2. Download and unpack the app:

   ```bash
   mkdir -p ~/eternal-download && cd ~/eternal-download && gh release download eternal-desktop-0.17.0-20261022 --repo riddhimaaan/eternal
   ```

   ```bash
   tar --zstd -xf Eternal-0.17.0-linux-x86_64.tar.zst
   ```

3. Install it into your app menu:

   ```bash
   ./install.sh
   ```

Eternal now appears in the app menu under **Utility**. The app lives in
`~/.local/opt/Eternal`; the download folder can be deleted afterwards.

On first launch it sets up its engine in `~/.eternal/eternal-agent` (takes a few
seconds) and then asks for your licence key and AI provider key, unless you do
part 2 first.

---

## 2. Bring back your chats, memory, skills and settings (optional)

These are **not** on GitHub on purpose: they contain API keys, MCP sign-ins and
your licence. They live on the backup drive
(`CachyOS-backup-2026-10-09/eternal/`).

1. Close Eternal.
2. Copy the two folders from the backup into your home folder:

   - `.eternal` → `~/.eternal`
   - `.config/Eternal` → `~/.config/Eternal`

3. **Important:** delete or rename `~/.eternal/eternal-agent` after copying.

   ```bash
   mv ~/.eternal/eternal-agent ~/.eternal/eternal-agent.old
   ```

   That folder is the engine built for the *old* computer. It does not work on a
   new one, and if it is there the app shows "Eternal couldn't start". Removing
   it makes the app build a fresh engine on next launch. Your chats and settings
   are not inside it.

4. Open Eternal. Your MCP servers (Composio, Exa, Fathom, Miro) should connect on
   their own; any that say "Sign in" need re-authorising once.

---

## 3. Working on the code

```bash
gh repo clone riddhimaaan/eternal ~/work/eternal
```

- `ETERNAL-CONTEXT.md` explains the whole project in plain language. Read it
  first; section 9 is the build-and-release runbook, section 10 the open items.
- The newest work at the time of writing is on the branch
  `fix/mcp-oauth-flow-safety` (four MCP sign-in fixes not yet merged into
  `main`).
- Building the desktop app needs Node.js, Python 3.11, `uv`, and podman or
  docker. On Bazzite, podman is already installed and the rest come from
  Homebrew (`brew install node uv`).

---

## What is deliberately NOT on GitHub

| Item | Where it is | Why |
| --- | --- | --- |
| Chats, memory, skills, settings (`~/.eternal`) | Backup drive | Contains API keys and sign-in tokens |
| Licence + app window state (`~/.config/Eternal`) | Backup drive | Contains your licence |
| Licence **signing** key (`~/.eternal-license-signing-key.pem`) | Not found in the 2026-10-09 backup | Must never be uploaded. If it is lost, new licence keys can't be issued without an app update. Check whether a copy exists anywhere. |

---

## Known issue the download already works around

Packaged builds made from the source do not include the MCP library (it is
listed as an optional, install-on-demand extra in
`apps/desktop/scripts/stage-agent-runtime.mjs`), so every MCP server fails with
an "HTTP transport" import error. The release download above has the library
added to its bundled packages. A fresh build from source will have the problem
again until the staging script bundles `mcp`.
