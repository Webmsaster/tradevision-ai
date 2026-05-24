"""Unit tests for phase_switch_supervisor.py."""

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "tools"))


def _import_supervisor_with_env(env_overrides: dict):
    """Re-import supervisor with given env-vars (module-level constants)."""
    import importlib
    if "phase_switch_supervisor" in sys.modules:
        del sys.modules["phase_switch_supervisor"]
    with mock.patch.dict(os.environ, env_overrides, clear=False):
        return importlib.import_module("phase_switch_supervisor")


def test_validate_env_rejects_missing_tf():
    """_validate_env must exit on missing FTMO_TF_P1 or FTMO_TF_P2."""
    sup = _import_supervisor_with_env({"FTMO_TF_P1": "", "FTMO_TF_P2": ""})
    try:
        sup._validate_env()
        raise AssertionError("expected SystemExit")
    except SystemExit as e:
        assert e.code == 1


def test_validate_env_rejects_invalid_p1_target():
    """_validate_env rejects out-of-range P1 target.

    Reload pattern: re-set os.environ then importlib.reload so module-
    level constants pick up the new value.
    """
    import importlib
    if "phase_switch_supervisor" in sys.modules:
        del sys.modules["phase_switch_supervisor"]
    os.environ["FTMO_TF_P1"] = "a"
    os.environ["FTMO_TF_P2"] = "b"
    os.environ["FTMO_P1_TARGET"] = "1.5"
    try:
        sup = importlib.import_module("phase_switch_supervisor")
        try:
            sup._validate_env()
            raise AssertionError("expected SystemExit for P1_TARGET=1.5")
        except SystemExit as e:
            assert e.code == 1
    finally:
        os.environ.pop("FTMO_P1_TARGET", None)


def test_latest_equity_reads_last_line():
    """latest_equity returns equity_usd from last line of jsonl."""
    sup = _import_supervisor_with_env({"FTMO_TF_P1": "a", "FTMO_TF_P2": "b"})
    with tempfile.TemporaryDirectory() as td:
        state = Path(td)
        eqh = state / "equity-history.jsonl"
        eqh.write_text(
            json.dumps({"ts": "2026-05-25T00:00:00Z", "equity_usd": 100000}) + "\n"
            + json.dumps({"ts": "2026-05-25T00:01:00Z", "equity_usd": 102000}) + "\n"
            + json.dumps({"ts": "2026-05-25T00:02:00Z", "equity_usd": 105000}) + "\n"
        )
        assert sup.latest_equity(state) == 105000.0


def test_latest_equity_returns_none_on_missing_file():
    sup = _import_supervisor_with_env({"FTMO_TF_P1": "a", "FTMO_TF_P2": "b"})
    with tempfile.TemporaryDirectory() as td:
        assert sup.latest_equity(Path(td)) is None


def test_latest_equity_skips_corrupt_last_line():
    """AUDIT FIX WARNUNG: corrupt last line is SKIPPED, previous valid
    equity is returned (handles file-rotation race)."""
    sup = _import_supervisor_with_env({"FTMO_TF_P1": "a", "FTMO_TF_P2": "b"})
    with tempfile.TemporaryDirectory() as td:
        state = Path(td)
        eqh = state / "equity-history.jsonl"
        eqh.write_text(
            json.dumps({"equity_usd": 100000}) + "\n"
            + "BROKEN_JSON\n"
        )
        result = sup.latest_equity(state)
        assert result == 100000.0  # skipped broken line, returned prior valid


def test_validate_env_rejects_symmetric_tf_by_default():
    """KRIT #3: symmetric P1==P2 must be rejected unless opted-in."""
    import importlib
    if "phase_switch_supervisor" in sys.modules:
        del sys.modules["phase_switch_supervisor"]
    os.environ["FTMO_TF_P1"] = "same-tf"
    os.environ["FTMO_TF_P2"] = "same-tf"
    os.environ.pop("FTMO_ALLOW_SYMMETRIC_TF", None)
    try:
        sup = importlib.import_module("phase_switch_supervisor")
        try:
            sup._validate_env()
            raise AssertionError("expected SystemExit for symmetric TF")
        except SystemExit as e:
            assert e.code == 1
    finally:
        os.environ.pop("FTMO_TF_P1", None)
        os.environ.pop("FTMO_TF_P2", None)


def test_validate_env_allows_symmetric_tf_when_opted_in():
    """Symmetric TF allowed with FTMO_ALLOW_SYMMETRIC_TF=1."""
    import importlib
    if "phase_switch_supervisor" in sys.modules:
        del sys.modules["phase_switch_supervisor"]
    os.environ["FTMO_TF_P1"] = "same-tf"
    os.environ["FTMO_TF_P2"] = "same-tf"
    os.environ["FTMO_ALLOW_SYMMETRIC_TF"] = "1"
    try:
        sup = importlib.import_module("phase_switch_supervisor")
        result = sup._validate_env()
        assert result == ("same-tf", "same-tf")
    finally:
        os.environ.pop("FTMO_TF_P1", None)
        os.environ.pop("FTMO_TF_P2", None)
        os.environ.pop("FTMO_ALLOW_SYMMETRIC_TF", None)


def test_phase_state_persistence():
    """KRIT #4: phase state survives restarts (atomic write + read)."""
    import importlib
    if "phase_switch_supervisor" in sys.modules:
        del sys.modules["phase_switch_supervisor"]
    with tempfile.TemporaryDirectory() as td:
        os.environ["FTMO_TF_P1"] = "a"
        os.environ["FTMO_TF_P2"] = "b"
        try:
            sup = importlib.import_module("phase_switch_supervisor")
            sup.SUPERVISOR_STATE_DIR = Path(td) / "sup-state"
            assert sup._read_phase_state() == {}  # empty before init
            sup._write_phase_state({"current_phase": "P2", "p1_passed_at_iso": "2026-05-25"})
            re_read = sup._read_phase_state()
            assert re_read == {"current_phase": "P2", "p1_passed_at_iso": "2026-05-25"}
            # Verify atomic: file exists, tmp does not
            assert (sup.SUPERVISOR_STATE_DIR / "phase.json").exists()
            assert not (sup.SUPERVISOR_STATE_DIR / "phase.tmp").exists()
        finally:
            os.environ.pop("FTMO_TF_P1", None)
            os.environ.pop("FTMO_TF_P2", None)


def test_spawn_executor_exports_start_balance():
    """KRIT #5: spawn_executor must export FTMO_START_BALANCE (not just
    FTMO_INITIAL_BALANCE) since executor reads START_BALANCE."""
    import importlib
    if "phase_switch_supervisor" in sys.modules:
        del sys.modules["phase_switch_supervisor"]
    os.environ["FTMO_TF_P1"] = "a"
    os.environ["FTMO_TF_P2"] = "b"
    os.environ["FTMO_INITIAL_BALANCE"] = "250000"
    try:
        sup = importlib.import_module("phase_switch_supervisor")
        captured_env = {}
        original_popen = sup.subprocess.Popen

        def fake_popen(*args, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            # Return a fake proc that exits immediately
            class FakeProc:
                pid = 999
                returncode = 0
                def poll(self): return 0
                def wait(self, timeout=None): return 0
            return FakeProc()

        sup.subprocess.Popen = fake_popen
        try:
            sup.spawn_executor("test-tf", 0.10, 30)
        finally:
            sup.subprocess.Popen = original_popen
        assert captured_env.get("FTMO_START_BALANCE") == "250000.0"
        assert captured_env.get("FTMO_TF") == "test-tf"
        assert captured_env.get("FTMO_PROFIT_TARGET") == "0.1"
    finally:
        os.environ.pop("FTMO_TF_P1", None)
        os.environ.pop("FTMO_TF_P2", None)
        os.environ.pop("FTMO_INITIAL_BALANCE", None)


def test_archive_state_copies_dir():
    """archive_state should copytree to BACKUP_DIR with timestamped name."""
    with tempfile.TemporaryDirectory() as repo_root:
        with mock.patch.dict(os.environ, {"FTMO_TF_P1": "a", "FTMO_TF_P2": "b", "FTMO_ACCOUNT_ID": "TEST"}):
            sup = _import_supervisor_with_env({"FTMO_TF_P1": "a", "FTMO_TF_P2": "b", "FTMO_ACCOUNT_ID": "TEST"})
            sup.REPO_ROOT = Path(repo_root)
            sup.BACKUP_DIR = Path(repo_root) / "state-backups"
            sup.SUPERVISOR_STATE_DIR = Path(repo_root) / "ftmo-state-supervisor-TEST"

            src = Path(repo_root) / "test-state"
            src.mkdir()
            (src / "file.txt").write_text("hello")

            dest = sup.archive_state(src, "P1")
            assert dest is not None
            assert dest.parent == sup.BACKUP_DIR
            assert dest.name.startswith("TEST-P1-")
            assert (dest / "file.txt").read_text() == "hello"


def test_archive_state_skips_missing_dir():
    sup = _import_supervisor_with_env({"FTMO_TF_P1": "a", "FTMO_TF_P2": "b"})
    with tempfile.TemporaryDirectory() as td:
        result = sup.archive_state(Path(td) / "does-not-exist", "P1")
        assert result is None
