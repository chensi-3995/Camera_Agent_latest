from __future__ import annotations

import json
import subprocess
import threading
from collections import defaultdict
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any


class RemoteCaptureClient:
    def __init__(
        self,
        ssh_host: str,
        ssh_port: int,
        ssh_username: str,
        remote_manifest_path: str,
        local_cache_dir: str,
        processed_state_path: str,
        ssh_key_path: str = "",
        manifest_tail_lines: int = 500,
        max_clips_per_camera: int = 1,
        selection_mode: str = "latest",
    ) -> None:
        self.ssh_host = str(ssh_host or "").strip()
        self.ssh_port = int(ssh_port or 22)
        self.ssh_username = str(ssh_username or "").strip()
        self.ssh_key_path = str(ssh_key_path or "").strip()
        self.remote_manifest_path = str(remote_manifest_path or "").strip()
        self.local_cache_dir = Path(local_cache_dir)
        self.processed_state_path = Path(processed_state_path)
        self.manifest_tail_lines = max(10, int(manifest_tail_lines or 500))
        self.max_clips_per_camera = max(1, int(max_clips_per_camera or 1))
        self.selection_mode = str(selection_mode or "latest").strip().lower()
        self.lock = threading.Lock()

        self.local_cache_dir.mkdir(parents=True, exist_ok=True)
        self.processed_state_path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def enabled(self) -> bool:
        return bool(self.ssh_host and self.ssh_username and self.remote_manifest_path)

    def sync_clips(self, camera_ids: list[str] | None = None) -> list[dict[str, Any]]:
        if not self.enabled:
            return []

        manifest_records = self._read_manifest_records()
        processed = self._load_processed_state()
        candidates = [
            record
            for record in manifest_records
            if str(record.get("status", "")).lower() == "completed"
            and str(record.get("clip_id", "")).strip()
            and str(record.get("filepath", "")).strip()
            and str(record.get("clip_id")) not in processed
            and (not camera_ids or str(record.get("camera_id", "")) in set(camera_ids))
        ]
        selected = self._select_candidates(candidates)

        synced: list[dict[str, Any]] = []
        for record in selected:
            synced.append(self._download_record(record))
        return synced

    def mark_processed(self, clip_ids: list[str]) -> None:
        if not clip_ids:
            return
        with self.lock:
            state = self._load_processed_state()
            now = datetime.now().isoformat(timespec="seconds")
            for clip_id in clip_ids:
                state[str(clip_id)] = now
            # Keep the state file bounded.
            items = sorted(state.items(), key=lambda item: item[1], reverse=True)[:5000]
            self._save_processed_state(dict(items))

    def _read_manifest_records(self) -> list[dict[str, Any]]:
        target = f"{self.ssh_username}@{self.ssh_host}"
        remote_cmd = f"tail -n {self.manifest_tail_lines} '{self.remote_manifest_path}'"
        command = self._ssh_command(target, remote_cmd)
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "ssh_manifest_read_failed")

        records: list[dict[str, Any]] = []
        for line in result.stdout.splitlines():
            raw = line.strip()
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                records.append(payload)
        return records

    def _select_candidates(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in records:
            grouped[str(record.get("camera_id", ""))].append(record)

        selected: list[dict[str, Any]] = []
        reverse = self.selection_mode == "latest"
        for camera_id, items in grouped.items():
            items.sort(key=lambda item: (str(item.get("finished_at", "")), str(item.get("clip_id", ""))), reverse=reverse)
            selected.extend(items[: self.max_clips_per_camera])
        selected.sort(key=lambda item: (str(item.get("finished_at", "")), str(item.get("clip_id", ""))))
        return selected

    def _download_record(self, record: dict[str, Any]) -> dict[str, Any]:
        remote_path = str(record["filepath"])
        local_path = self._build_local_path(record)
        local_path.parent.mkdir(parents=True, exist_ok=True)
        if not local_path.exists():
            source = f"{self.ssh_username}@{self.ssh_host}:{remote_path}"
            command = self._scp_command(source, str(local_path))
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "scp_download_failed")

        payload = dict(record)
        payload["local_path"] = str(local_path)
        return payload

    def _build_local_path(self, record: dict[str, Any]) -> Path:
        remote_path = PurePosixPath(str(record["filepath"]))
        camera_id = str(record.get("camera_id", "unknown"))
        day_token = str(record.get("started_at", ""))[:10] or "unknown-date"
        return self.local_cache_dir / camera_id / day_token / remote_path.name

    def _load_processed_state(self) -> dict[str, str]:
        if not self.processed_state_path.exists():
            return {}
        try:
            payload = json.loads(self.processed_state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if isinstance(payload, dict):
            return {str(key): str(value) for key, value in payload.items()}
        return {}

    def _save_processed_state(self, state: dict[str, str]) -> None:
        self.processed_state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def _ssh_command(self, target: str, remote_cmd: str) -> list[str]:
        command = ["ssh", "-p", str(self.ssh_port)]
        if self.ssh_key_path:
            command.extend(["-i", self.ssh_key_path])
        command.extend([target, remote_cmd])
        return command

    def _scp_command(self, source: str, destination: str) -> list[str]:
        command = ["scp", "-P", str(self.ssh_port)]
        if self.ssh_key_path:
            command.extend(["-i", self.ssh_key_path])
        command.extend([source, destination])
        return command
