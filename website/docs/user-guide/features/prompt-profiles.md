---
sidebar_position: 8
title: "Agent Designer & Prompt Profiles"
description: "Create specialized Eternal agents and edit sections 1–10 of their runtime instructions"
---

# Agent Designer & Prompt Profiles

Eternal's **Create Your Agent** page turns agent design into a conversation.
Describe the job you want done, answer the Agent Designer's focused questions,
review the generated Base Prompt, and save it as a reusable Prompt Profile.

## Prompt Profiles versus Eternal profiles

An Eternal profile isolates a complete environment: configuration, API keys,
MCP servers, skills, memory and sessions. A Prompt Profile changes the
instructions sent to the model without changing those underlying resources.

Examples include Content Strategist, Research Analyst, Coding Partner and Sales
Assistant. Select one in the desktop sidebar, then start a new chat.

Every Eternal environment has an **Original Base Prompt** as its global
default. A Project Base Prompt overrides it for that Project; otherwise the
selected global Prompt Profile always applies. Eternal repairs an empty or
missing selection automatically, so `SOUL.md` is no longer a runtime identity
fallback.

## Files

Each Prompt Profile is intentionally stored as ordinary user-owned files:

```text
~/.eternal/prompt-profiles/content-strategist/
├── profile.json
└── BASE_PROMPT.md
```

Named Eternal profiles keep an independent library under
`~/.eternal/profiles/<name>/prompt-profiles/`. Profile cloning and export include
this directory.

## What users control

`BASE_PROMPT.md` exposes sections 1–10 of the assembled prompt. This includes
identity and communication as well as the instructions for task completion,
tools, memory, skills, mid-turn steering, profile boundaries and interface
behavior.

Every new Prompt Profile starts with Eternal's standard sections 4–10. The
user defines sections 1–3 first, then may edit any section later. Eternal also
restores missing sections 4–10 when an incomplete prompt is first created.

> Sections 4–10 control how the agent uses Eternal features. You can edit them,
> but incorrect instructions may make tools or other features unreliable.
> Restore the default text if something stops working.

Eternal still generates the changing parts of the prompt: installed skill
names, memory contents, workspace context, active model and provider, platform,
date and other runtime facts. Editing a prompt never bypasses the permissions
or safety checks enforced by Eternal's code.

Changes apply to new chats. Existing chats keep the prompt snapshot with which
they started.
