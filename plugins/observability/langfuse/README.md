# Langfuse Observability Plugin

This plugin ships bundled with Eternal but is **opt-in** — it only loads when
you explicitly enable it.

## Enable

Pick one:

```bash
# Interactive: walks you through credentials + SDK install + enable
eternal tools  # → Langfuse Observability

# Manual
pip install langfuse
eternal plugins enable observability/langfuse
```

## Required credentials

Set these in `~/.eternal/.env` (or via `eternal tools`):

```bash
ETERNAL_LANGFUSE_PUBLIC_KEY=pk-lf-...
ETERNAL_LANGFUSE_SECRET_KEY=sk-lf-...
ETERNAL_LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or your self-hosted URL
```

Without the SDK or credentials the hooks no-op silently — the plugin fails
open.

## Verify

```bash
eternal plugins list                 # observability/langfuse should show "enabled"
eternal chat -q "hello"              # then check Langfuse for a "Eternal turn" trace
```

## Optional tuning

```bash
ETERNAL_LANGFUSE_ENV=production       # environment tag
ETERNAL_LANGFUSE_RELEASE=v1.0.0       # release tag
ETERNAL_LANGFUSE_SAMPLE_RATE=0.5      # sample 50% of traces
ETERNAL_LANGFUSE_MAX_CHARS=12000      # max chars per field (default: 12000)
ETERNAL_LANGFUSE_DEBUG=true           # verbose plugin logging
```

## Disable

```bash
eternal plugins disable observability/langfuse
```
