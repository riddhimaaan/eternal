"""Desktop API for reusable behavioral Prompt Profiles."""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from eternal_cli.web_deps import late
from eternal_cli.web_models import (
    ProjectAgentDesignerRequest,
    ProjectAgentUpdate,
    PromptDesignerRequest,
    PromptProfileActivate,
    PromptProfileCreate,
    PromptProfileUpdate,
)


router = APIRouter()
_log = logging.getLogger("eternal_cli.web_server")
_profile_scope = late("_profile_scope")


def _active_id() -> str:
    from eternal_cli.config import load_config_readonly

    cfg = load_config_readonly()
    agent = cfg.get("agent") if isinstance(cfg, dict) else {}
    return str((agent or {}).get("prompt_profile") or "").strip()


def _legacy_prompt() -> str:
    from eternal_cli.config import load_config_readonly

    cfg = load_config_readonly()
    agent = cfg.get("agent") if isinstance(cfg, dict) else {}
    return str((agent or {}).get("base_prompt") or "").strip()


def _set_active(profile_id: str) -> None:
    from eternal_cli.config import read_raw_config, save_config
    from eternal_cli.prompt_profiles import (
        create_prompt_profile,
        default_full_prompt,
        get_prompt_profile,
        list_prompt_profiles,
    )

    value = str(profile_id or "").strip()
    if value:
        get_prompt_profile(value)
    config = read_raw_config()
    if not isinstance(config, dict):
        config = {}
    agent = config.get("agent")
    if not isinstance(agent, dict):
        agent = {}
        config["agent"] = agent
    if value:
        legacy = str(agent.get("base_prompt") or "").strip()
        if legacy:
            # Converting from the legacy inline prompt must never make the
            # user's original agent disappear. Preserve it as a reusable
            # full-control profile before removing the inline field. If the
            # profile being activated is itself that conversion, its prompt
            # already matches and no duplicate is created.
            expanded = default_full_prompt(legacy).strip()
            already_saved = any(
                str(item.get("prompt") or "").strip() == expanded
                for item in list_prompt_profiles()
            )
            if not already_saved:
                create_prompt_profile(
                    "Original Base Prompt",
                    expanded,
                    description="The Base Prompt that existed before Prompt Profiles",
                )
        agent["prompt_profile"] = value
        # The original now has a durable profile, so the obsolete inline field
        # can be removed without losing anything or becoming a stale fallback.
        agent.pop("base_prompt", None)
    else:
        agent.pop("prompt_profile", None)
    save_config(config, merge_existing=False)


@router.get("/api/prompt-profiles")
async def list_prompt_profiles_endpoint(profile: Optional[str] = None):
    def _run():
        from eternal_cli.prompt_profiles import default_full_prompt, list_prompt_profiles

        with _profile_scope(profile):
            legacy = _legacy_prompt()
            return {
                "profiles": list_prompt_profiles(),
                "active_id": _active_id(),
                "legacy_prompt": legacy,
                "legacy_editable_prompt": default_full_prompt(legacy) if legacy else "",
                "default_prompt": default_full_prompt(),
            }

    return await asyncio.to_thread(_run)


@router.post("/api/prompt-profiles")
async def create_prompt_profile_endpoint(body: PromptProfileCreate, profile: Optional[str] = None):
    def _run():
        from eternal_cli.prompt_profiles import create_prompt_profile

        with _profile_scope(profile):
            created = create_prompt_profile(
                body.name,
                body.prompt,
                description=body.description,
                icon=body.icon,
            )
            if body.activate:
                _set_active(created["id"])
            return {"ok": True, "profile": created, "active_id": _active_id()}

    try:
        return await asyncio.to_thread(_run)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/api/prompt-profiles/{profile_id}")
async def get_prompt_profile_endpoint(profile_id: str, profile: Optional[str] = None):
    def _run():
        from eternal_cli.prompt_profiles import get_prompt_profile

        with _profile_scope(profile):
            return {"profile": get_prompt_profile(profile_id), "active_id": _active_id()}

    try:
        return await asyncio.to_thread(_run)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/api/prompt-profiles/{profile_id}")
async def update_prompt_profile_endpoint(
    profile_id: str, body: PromptProfileUpdate, profile: Optional[str] = None
):
    def _run():
        from eternal_cli.prompt_profiles import update_prompt_profile

        with _profile_scope(profile):
            updated = update_prompt_profile(
                profile_id,
                name=body.name,
                prompt=body.prompt,
                description=body.description,
                icon=body.icon,
            )
            return {"ok": True, "profile": updated, "active_id": _active_id()}

    try:
        return await asyncio.to_thread(_run)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/api/prompt-profiles/{profile_id}")
async def delete_prompt_profile_endpoint(profile_id: str, profile: Optional[str] = None):
    def _run():
        from eternal_cli.prompt_profiles import delete_prompt_profile

        with _profile_scope(profile):
            if _active_id() == profile_id:
                _set_active("")
            path = delete_prompt_profile(profile_id)
            return {"ok": True, "path": str(path), "active_id": _active_id()}

    try:
        return await asyncio.to_thread(_run)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/prompt-profiles/active/select")
async def activate_prompt_profile_endpoint(
    body: PromptProfileActivate, profile: Optional[str] = None
):
    def _run():
        with _profile_scope(profile):
            _set_active(body.profile_id)
            return {"ok": True, "active_id": _active_id()}

    try:
        return await asyncio.to_thread(_run)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/prompt-profiles/designer/message")
async def prompt_designer_message_endpoint(
    body: PromptDesignerRequest, profile: Optional[str] = None
):
    def _run():
        from eternal_cli.prompt_designer import design_prompt

        with _profile_scope(profile):
            return design_prompt(
                [message.model_dump() for message in body.messages],
                current_prompt=body.current_prompt,
            )

    try:
        return await asyncio.to_thread(_run)
    except Exception as exc:
        _log.exception("POST /api/prompt-profiles/designer/message failed")
        raise HTTPException(status_code=502, detail=f"Agent Designer could not reach the model: {exc}")


@router.get("/api/project-agents/{project_id}")
async def get_project_agent_endpoint(project_id: str, profile: Optional[str] = None):
    def _run():
        from eternal_cli.project_prompt import get_project_prompt

        with _profile_scope(profile):
            return {"agent": get_project_prompt(project_id)}

    try:
        return await asyncio.to_thread(_run)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/api/project-agents/{project_id}")
async def update_project_agent_endpoint(
    project_id: str, body: ProjectAgentUpdate, profile: Optional[str] = None
):
    def _run():
        from eternal_cli.project_prompt import save_project_prompt

        with _profile_scope(profile):
            return {
                "ok": True,
                "agent": save_project_prompt(project_id, body.prompt, source=body.source),
            }

    try:
        return await asyncio.to_thread(_run)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/project-agents/{project_id}/designer/message")
async def project_agent_designer_endpoint(
    project_id: str,
    body: ProjectAgentDesignerRequest,
    profile: Optional[str] = None,
):
    def _run():
        from eternal_cli.project_prompt import get_project_prompt
        from eternal_cli.prompt_designer import design_project_prompt

        with _profile_scope(profile):
            agent = get_project_prompt(project_id)
            current = body.current_prompt or agent["prompt"] or agent["default_prompt"]
            return design_project_prompt(
                [message.model_dump() for message in body.messages],
                current_prompt=current,
                project_name=agent["project_name"],
            )

    try:
        return await asyncio.to_thread(_run)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        _log.exception("POST project Agent Designer failed")
        raise HTTPException(status_code=502, detail=f"Project Agent Designer could not reach the model: {exc}")


@router.post("/api/project-agents/{project_id}/scan")
async def scan_project_agent_endpoint(project_id: str, profile: Optional[str] = None):
    def _run():
        from eternal_cli.project_prompt import get_project_prompt, scan_project_workspace
        from eternal_cli.prompt_designer import design_project_prompt

        with _profile_scope(profile):
            agent = get_project_prompt(project_id)
            scan = scan_project_workspace(project_id)
            designed = design_project_prompt(
                [],
                current_prompt=agent["prompt"] or agent["default_prompt"],
                project_name=agent["project_name"],
                scan_context=scan["context"],
            )
            return {
                **designed,
                "files_discovered": scan["files_discovered"],
                "files_read": scan["files_read"],
                "warnings": scan["warnings"],
            }

    try:
        return await asyncio.to_thread(_run)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        _log.exception("POST project workspace scan failed")
        raise HTTPException(status_code=502, detail=f"Project scan could not reach the model: {exc}")
