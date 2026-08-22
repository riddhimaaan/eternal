"""Conversational AI helper for authoring full-control Base Prompts."""

from __future__ import annotations

import json
import re
from typing import Any


_SYSTEM_PROMPT = """You are Eternal's Agent Designer. Help a non-technical user
create a strong ten-section Base Prompt for a reusable AI agent.

Ask exactly one concise, high-leverage question at a time. Discover only what
is still missing: the agent's purpose, intended users, desired outcomes,
priorities, working method, evidence/quality standard, autonomy, communication
style, and meaningful boundaries. Do not interrogate the user or repeat
questions they already answered. When enough is known, say so and produce a
complete draft. You may produce an improved draft earlier when useful.

The editable draft contains sections 1-10. For a new agent, help the user shape
sections 1-3: identity, communication, and accuracy. Copy sections 4-10 from the
existing draft exactly as supplied. Do not rewrite, shorten, or omit them unless
the user explicitly asks to change those advanced instructions. If they do,
help them and briefly warn in `reply` that incorrect operational instructions
can make Eternal features unreliable.

Do not add the live skills catalog, actual memory contents, workspace details,
model/provider/date, or other generated runtime facts. Eternal appends those.

Return only JSON with this exact shape:
{
  "reply": "your conversational response or next question",
  "draft": "the complete current Base Prompt, or empty string",
  "suggested_name": "short profile name, or empty string",
  "description": "one sentence describing the agent, or empty string",
  "ready": false
}
Set ready=true when the draft is coherent enough to save. No markdown fences."""

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def _parse(raw: str) -> dict[str, Any]:
    text = _FENCE_RE.sub("", str(raw or "").strip())
    first, last = text.find("{"), text.rfind("}")
    if first >= 0 and last > first:
        try:
            value = json.loads(text[first : last + 1])
            if isinstance(value, dict):
                return value
        except (ValueError, json.JSONDecodeError):
            pass
    return {"reply": text or "Tell me what you want this agent to accomplish.", "draft": "", "ready": False}


def design_prompt(messages: list[dict[str, Any]], current_prompt: str = "") -> dict[str, Any]:
    from agent.auxiliary_client import call_llm

    safe_messages: list[dict[str, str]] = []
    for item in messages[-30:]:
        if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
            continue
        content = str(item.get("content") or "").strip()[:12_000]
        if content:
            safe_messages.append({"role": str(item["role"]), "content": content})
    prompt = str(current_prompt or "").strip()[:100_000]
    context = (
        "There is no existing draft. Start by understanding the use case."
        if not prompt
        else f"The user is improving this existing Base Prompt:\n\n{prompt}"
    )
    response = call_llm(
        task="prompt_designer",
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "system", "content": context},
            *safe_messages,
        ],
        temperature=0.4,
        max_tokens=6000,
        timeout=120,
    )
    try:
        raw = response.choices[0].message.content or ""
    except Exception:
        raw = ""
    parsed = _parse(raw)
    return {
        "reply": str(parsed.get("reply") or "Tell me more about the agent you want.").strip(),
        "draft": str(parsed.get("draft") or "").strip(),
        "suggested_name": str(parsed.get("suggested_name") or "").strip()[:120],
        "description": str(parsed.get("description") or "").strip()[:500],
        "ready": bool(parsed.get("ready")),
    }
