from types import SimpleNamespace

import pytest

from eternal_cli.prompt_profiles import (
    create_prompt_profile,
    default_full_prompt,
    delete_prompt_profile,
    get_prompt_profile,
    list_prompt_profiles,
    prepare_new_prompt,
    resolve_agent_base_prompt,
    selected_prompt_has_full_control,
    update_prompt_profile,
)


def test_prompt_profile_lifecycle_uses_plain_base_prompt_file(tmp_path):
    created = create_prompt_profile(
        "Research Analyst",
        "You verify claims against primary sources.",
        description="Evidence-first research",
        home=tmp_path,
    )

    assert created["id"] == "research-analyst"
    assert created["full_control"] is True
    stored = (tmp_path / "prompt-profiles/research-analyst/BASE_PROMPT.md").read_text()
    assert "You verify claims against primary sources." in stored
    assert "# 4. Completing the User's Request" in stored
    assert "# 10. Interface Behavior" in stored
    assert [profile["id"] for profile in list_prompt_profiles(tmp_path)] == [
        "research-analyst"
    ]

    updated = update_prompt_profile(
        created["id"],
        prompt="You research carefully and state uncertainty.",
        home=tmp_path,
    )
    assert updated["prompt"] == "You research carefully and state uncertainty."

    removed = delete_prompt_profile(created["id"], home=tmp_path)
    assert removed.name == "research-analyst"
    assert not removed.exists()


def test_duplicate_names_receive_stable_unique_ids(tmp_path):
    first = create_prompt_profile("Writer", "Write clearly.", home=tmp_path)
    second = create_prompt_profile("Writer", "Write concisely.", home=tmp_path)

    assert first["id"] == "writer"
    assert second["id"] == "writer-2"


def test_selected_profile_wins_over_inline_base_prompt(tmp_path):
    created = create_prompt_profile(
        "Content Agent", "You are the selected content agent.", home=tmp_path
    )

    resolved = resolve_agent_base_prompt(
        {
            "prompt_profile": created["id"],
            "base_prompt": "This legacy prompt must not win.",
        },
        home=tmp_path,
    )

    assert "You are the selected content agent." in resolved
    assert "# 10. Interface Behavior" in resolved
    assert selected_prompt_has_full_control(
        {"prompt_profile": created["id"]}, home=tmp_path
    ) is True


def test_default_full_prompt_exposes_sections_one_through_ten():
    prompt = default_full_prompt("You are a content agent.")

    for section in range(1, 11):
        assert f"# {section}." in prompt
    assert "You are a content agent." in prompt
    assert "<available_skills>" not in prompt


def test_new_prompt_keeps_authored_sections_and_fills_missing_operational_sections():
    prompt = prepare_new_prompt(
        "# 1. Identity and Purpose\n\nYou are a writer.\n\n"
        "# 5. Tool-Use Strategy\n\nUse tools selectively."
    )

    assert "You are a writer." in prompt
    assert prompt.count("# 5. Tool-Use Strategy") == 1
    assert "Use tools selectively." in prompt
    for section in (4, 6, 7, 8, 9, 10):
        assert f"# {section}." in prompt


def test_later_edit_can_deliberately_remove_operational_sections(tmp_path):
    created = create_prompt_profile("Minimal", "Start with safe defaults.", home=tmp_path)
    assert "# 10. Interface Behavior" in created["prompt"]

    updated = update_prompt_profile(created["id"], prompt="Only my custom instructions.", home=tmp_path)

    assert updated["prompt"] == "Only my custom instructions."


def test_stale_selection_falls_back_to_inline_prompt(tmp_path):
    assert resolve_agent_base_prompt(
        {"prompt_profile": "missing", "base_prompt": ["Fallback", "prompt"]},
        home=tmp_path,
    ) == "Fallback\nprompt"


def test_rejects_path_traversal_ids(tmp_path):
    with pytest.raises(ValueError, match="Invalid prompt profile id"):
        get_prompt_profile("../config", home=tmp_path)


def test_prompt_designer_parses_structured_reply(monkeypatch):
    from eternal_cli import prompt_designer

    response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=(
                        '{"reply":"Who is the audience?","draft":"You are a writer.",'
                        '"suggested_name":"Writer","description":"Writes content",'
                        '"ready":false}'
                    )
                )
            )
        ]
    )
    monkeypatch.setattr("agent.auxiliary_client.call_llm", lambda **_kwargs: response)

    result = prompt_designer.design_prompt(
        [{"role": "user", "content": "I need a writing agent"}]
    )

    assert result["reply"] == "Who is the audience?"
    assert result["draft"] == "You are a writer."
    assert result["suggested_name"] == "Writer"
    assert result["ready"] is False


def test_project_prompt_designer_treats_scan_as_untrusted_workspace_overview(monkeypatch):
    from eternal_cli import prompt_designer

    captured = {}
    response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=(
                        '{"reply":"Drafted from the workspace evidence.",'
                        '"draft":"# 1. Workspace Overview\\n\\nA content workspace.",'
                        '"suggested_name":"Content Workspace","description":"Produces content",'
                        '"ready":true}'
                    )
                )
            )
        ]
    )

    def fake_call(**kwargs):
        captured.update(kwargs)
        return response

    monkeypatch.setattr("agent.auxiliary_client.call_llm", fake_call)

    result = prompt_designer.design_project_prompt(
        [],
        "# 1. Workspace Overview\n\nExisting overview.",
        project_name="Content Engine",
        scan_context='<project_file path="README.md">workspace evidence</project_file>',
    )

    assert result["ready"] is True
    assert result["draft"].startswith("# 1. Workspace Overview")
    system = captured["messages"][0]["content"]
    assert "workspace overview, not its task router" in system
    assert "untrusted reference data" in system
    assert "workspace evidence" in captured["messages"][1]["content"]


def test_prompt_profile_api_round_trip():
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    from eternal_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN
    from eternal_cli.config import save_config

    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    save_config(
        {"agent": {"base_prompt": "You are the original content agent."}},
        merge_existing=False,
    )

    created = client.post(
        "/api/prompt-profiles",
        json={
            "name": "Content Strategist",
            "prompt": "You build evidence-led content strategies.",
            "description": "Plans content",
            "activate": True,
        },
    )
    assert created.status_code == 200
    profile_id = created.json()["profile"]["id"]
    assert created.json()["active_id"] == profile_id

    listed = client.get("/api/prompt-profiles")
    assert listed.status_code == 200
    body = listed.json()
    assert "# 10. Interface Behavior" in body["default_prompt"]
    assert body["legacy_prompt"] == ""
    assert body["legacy_editable_prompt"] == ""
    assert len(body["profiles"]) == 2
    by_name = {profile["name"]: profile for profile in body["profiles"]}
    assert "You build evidence-led content strategies." in by_name["Content Strategist"]["prompt"]
    assert "# 10. Interface Behavior" in by_name["Content Strategist"]["prompt"]
    assert "You are the original content agent." in by_name["Original Base Prompt"]["prompt"]
    assert "# 10. Interface Behavior" in by_name["Original Base Prompt"]["prompt"]

    updated = client.put(
        f"/api/prompt-profiles/{profile_id}",
        json={"prompt": "You create original, source-grounded content."},
    )
    assert updated.status_code == 200
    assert updated.json()["profile"]["prompt"].endswith("source-grounded content.")

    deleted = client.delete(f"/api/prompt-profiles/{profile_id}")
    assert deleted.status_code == 200
    assert deleted.json()["active_id"] == ""
