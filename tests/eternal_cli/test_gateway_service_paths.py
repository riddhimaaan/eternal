from unittest.mock import patch


def test_service_path_skips_nonexistent_node_modules(tmp_path):
    """Service PATH should not include node_modules/.bin if it doesn't exist."""
    from eternal_cli.gateway import _build_service_path_dirs
    with patch("eternal_cli.gateway.get_eternal_home", return_value=tmp_path / ".eternal"):
        dirs = _build_service_path_dirs(project_root=tmp_path)
    node_modules_bin = str(tmp_path / "node_modules" / ".bin")
    assert node_modules_bin not in dirs


def test_service_path_includes_node_modules_when_present(tmp_path):
    """Service PATH should include node_modules/.bin when it exists."""
    nm_bin = tmp_path / "node_modules" / ".bin"
    nm_bin.mkdir(parents=True)
    from eternal_cli.gateway import _build_service_path_dirs
    with patch("eternal_cli.gateway.get_eternal_home", return_value=tmp_path / ".eternal"):
        dirs = _build_service_path_dirs(project_root=tmp_path)
    assert str(nm_bin) in dirs


def test_service_path_includes_eternal_home_node_modules(tmp_path):
    """Service PATH should include ~/.eternal/node_modules/.bin when it exists."""
    eternal_nm = tmp_path / ".eternal" / "node_modules" / ".bin"
    eternal_nm.mkdir(parents=True)
    from eternal_cli.gateway import _build_service_path_dirs
    with patch("eternal_cli.gateway.get_eternal_home", return_value=tmp_path / ".eternal"):
        dirs = _build_service_path_dirs(project_root=tmp_path)
    assert str(eternal_nm) in dirs
