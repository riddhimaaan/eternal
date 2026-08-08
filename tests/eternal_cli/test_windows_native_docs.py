from pathlib import Path


def test_windows_native_install_path_docs_match_installer() -> None:
    doc = Path("website/docs/user-guide/windows-native.md").read_text()
    install = Path("scripts/install.ps1").read_text()

    assert "%LOCALAPPDATA%\\eternal\\eternal-agent\\venv\\Scripts" in doc
    assert "Get-Command eternal        # should print C:\\Users\\<you>\\AppData\\Local\\eternal\\eternal-agent\\venv\\Scripts\\eternal.exe" in doc
    assert '$eternalBin = "$InstallDir\\venv\\Scripts"' in install
