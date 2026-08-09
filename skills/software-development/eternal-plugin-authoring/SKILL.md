---
name: eternal-plugin-authoring
description: "Write, install, enable, and verify Eternal plugins: manifest, register(ctx), tools, hooks, slash commands, providers."
version: 1.0.0
author: ETERNAL
license: MIT
platforms: [linux, macos, windows]
metadata:
  eternal:
    tags: [plugins, authoring, tools, hooks, extending, eternal]
    related_skills: [eternal-agent-skill-authoring, eternal-agent, plan]
---

# Authoring Eternal plugins

A plugin is Python code that extends Eternal itself — it adds tools, hooks,
slash commands, or whole providers (image gen, TTS, browser, search…).

Distinguish it from the neighbours before writing one:

| Want to… | Use |
|---|---|
| Give the agent *instructions* | a **skill** (`SKILL.md`) |
| Give the agent *new code-backed abilities* | a **plugin** (this document) |
| Connect an *external* MCP server | `eternal mcp add` |
| Ship all three as one install | a **pack** (`eternal pack create`) |

If the task is "teach the agent how to do X with tools it already has," write a
skill instead. Plugins are for capabilities that need real code.

## Folder layout

Four files. Nothing is auto-discovered by directory name — unlike Claude Code,
Eternal loads code and lets it register itself.

```
my-plugin/
├── plugin.yaml     # manifest — REQUIRED
├── __init__.py     # must define register(ctx) — REQUIRED
├── my_code.py      # your logic
└── README.md
```

Install location:

```
~/.eternal/plugins/my-plugin/     # user plugins
./.eternal/plugins/my-plugin/     # project-local plugins
```

## plugin.yaml

```yaml
name: my-plugin
version: 1.0.0
description: "One line. Shown in `eternal plugins list` and the dashboard."
author: you
kind: standalone

# Optional, for discovery/display. Declaring them does not register them —
# register() does the real work.
provides_tools: [my_tool]
hooks: [post_tool_call]

# Optional. Tools gate on these being present.
requires_env: [MY_API_KEY]
```

### `kind` — pick correctly, it changes loading behaviour

| kind | Meaning |
|---|---|
| `standalone` | Default. Own tools/hooks. **Opt-in via `plugins.enabled`.** |
| `backend` | Pluggable backend for a core tool (image_gen, browser). Bundled ones auto-load; user-installed still gated. |
| `exclusive` | Category with exactly one active provider (memory). Selected via `<category>.provider`. |
| `platform` | Gateway messaging adapter (IRC, etc.). Bundled auto-load. |
| `model-provider` | An inference provider. |

## `register(ctx)` — the entry point

The loader imports `__init__.py` and calls `register` once at startup. It is
the *only* required symbol.

```python
def register(ctx) -> None:
    ctx.register_tool(...)
    ctx.register_hook("post_tool_call", my_callback)
    ctx.register_command("mycmd", handler=..., description="...")
```

Keep `register()` cheap — it runs on every start. Do network calls, auth, and
heavy imports lazily inside handlers, not at registration time.

### Registering a tool

```python
MY_TOOL_SCHEMA = {
    "name": "my_tool",
    "description": "What it does, written for the model to read.",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["get", "set"]},
            "value":  {"type": "string", "description": "..."},
        },
        "required": ["action"],
    },
}

# SIGNATURE IS FIXED — do not write one parameter per schema field.
# tools/registry.py dispatch() calls: handler(args, **kwargs)
# `args` arrives as ONE positional dict; **kw absorbs runtime extras (task_id…).
def _handler(args: dict, **kw) -> str:
    action = str(args.get("action") or "").strip()
    value = args.get("value") or ""
    return f"did {action} to {value}"   # return a STRING — it becomes tool output

def _available() -> bool:
    import os
    return bool(os.getenv("MY_API_KEY"))

def register(ctx) -> None:
    ctx.register_tool(
        name="my_tool",
        toolset="my-plugin",        # groups it in the tool list
        schema=MY_TOOL_SCHEMA,
        handler=_handler,
        check_fn=_available,        # tool hides when this returns False
        emoji="🔧",
        is_async=False,
        # override=True replaces a built-in tool — additionally requires
        # plugins.entries.<id>.allow_tool_override: true in config.yaml
    )
```

The schema is standard JSON Schema under `parameters`. Every tool's schema is
sent on **every** request, so keep descriptions tight — verbose schemas cost
tokens on every turn.

### Registering a slash command

```python
def _handle(raw_args: str) -> str | None:
    return f"you said: {raw_args}"

ctx.register_command(
    "mycmd",                        # invoked as /mycmd
    handler=_handle,
    description="Shown in /help.",
    args_hint="<file>",             # surfaces an arg field in Discord etc.
)
```

`register_cli_command()` is different — that creates `eternal <subcommand>`
terminal commands, not in-chat slash commands.

### Registering a hook

```python
ctx.register_hook("post_tool_call", my_callback)
```

Valid hooks:

```
pre_tool_call          post_tool_call         transform_tool_result
transform_terminal_output                     transform_llm_output
pre_llm_call           post_llm_call          pre_verify
pre_api_request        post_api_request       api_request_error
on_session_start       on_session_end         on_session_finalize
on_session_reset       subagent_start         subagent_stop
```

### Other things `ctx` can register

Beyond tools/hooks/commands, a plugin can supply whole subsystems:

```
register_image_gen_provider     register_video_gen_provider
register_tts_provider           register_transcription_provider
register_web_search_provider    register_browser_provider
register_context_engine         register_secret_source
register_dashboard_auth_provider
register_platform               register_slack_action_handler
register_auxiliary_task         register_middleware
register_skill                  inject_message   dispatch_tool
```

`ctx.llm` gives access to the model; `ctx.profile_name` the active profile.

**`register_skill()` caveat:** a plugin skill resolves only as
`<plugin>:<name>` via an explicit `skill_view()`. It does **not** land in
`~/.eternal/skills/` and is **not** listed in the system prompt's
`<available_skills>` index — so the agent will never discover it on its own.
For a skill the agent should find by itself, ship a real skill or a pack.

## Install → enable → verify

**User plugins do not load automatically.** This is the single most common
reason a new plugin appears to do nothing: it loaded fine, but it is untrusted
code, so it is gated behind `plugins.enabled`.

```bash
cp -r my-plugin ~/.eternal/plugins/       # 1. place it
eternal plugins list                      # 2. confirm the manifest parsed
eternal plugins enable my-plugin          # 3. REQUIRED — it is off by default
eternal plugins list                      # 4. should now read: enabled
```

Then restart Eternal and confirm the tool is actually live:

```bash
eternal prompt-size          # your tool's schema should appear in the toolset table
eternal -z "list your tools" # or ask the agent directly
```

`eternal plugins install <git-url>` installs from GitHub. Only plugins under
`~/.eternal/plugins` can be removed — bundled ones cannot.

## Checklist

- [ ] `plugin.yaml` has `name`, `version`, `description`, `kind`
- [ ] `__init__.py` defines `register(ctx)` at module level
- [ ] Handlers return **strings**
- [ ] `check_fn` provided if the tool needs credentials, so it hides cleanly
- [ ] `register()` does no network/auth work
- [ ] Installed to `~/.eternal/plugins/<name>/`
- [ ] **Enabled** via `eternal plugins enable <name>`
- [ ] Verified with `eternal plugins list` and `eternal prompt-size`

## Pitfalls

- **Nothing happens after install** — you skipped `plugins enable`. It is off
  by default for user plugins, by design.
- **Manifest not found** — `plugin.yaml` must sit at the plugin directory
  root, not in a subfolder.
- **Tool name collision** — registering a name another toolset owns is
  rejected unless `override=True` *and* the operator opted in via
  `plugins.entries.<id>.allow_tool_override`.
- **Handler gets a dict, not named fields** — the most common authoring bug,
  and a silent one. `dispatch()` calls `handler(args, **kwargs)`, passing the
  whole argument dict as a **single positional parameter**. Writing
  `def handler(name: str, **kw)` does not crash — `name` is silently bound to
  the entire dict, so the tool returns `Hello, {'name': 'World'}!` instead of
  `Hello, World!`. Adding `**kwargs` to a wrong signature hides the
  `TypeError` without fixing the cause. Always use
  `def handler(args: dict, **kw) -> str` and read fields with `args.get(...)`.
  Verify by calling the handler directly:
  `handler({"name": "World"}, task_id="t")` — check the output text, not just
  that it ran.
- **Slow startup** — heavy work in `register()` runs on every launch.
- **Token bloat** — every tool schema ships on every request. A plugin with
  ten verbose tools is a permanent tax on the context window.
- **Editing a loaded plugin** — changes need a restart, or
  `eternal plugins` rescan from the dashboard.
