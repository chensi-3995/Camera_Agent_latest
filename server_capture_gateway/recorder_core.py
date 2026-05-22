from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import cv2


@dataclass
class CameraSource:
    camera_id: str
    name: str
    rtsp_url: str
    enabled: bool = True


@dataclass
class RecorderConfig:
    storage_dir: str
    manifest_path: str
    segment_seconds: int
    retention_days: int
    reconnect_backoff_seconds: float
    cleanup_interval_seconds: int
    cameras: list[CameraSource]


def load_config(config_path: str) -> RecorderConfig:
    payload = json.loads(Path(config_path).read_text(encoding="utf-8"))
    cameras = [
        CameraSource(
            camera_id=str(item["camera_id"]).strip(),
            name=str(item["name"]).strip(),
            rtsp_url=str(item["rtsp_url"]).strip(),
            enabled=bool(item.get("enabled", True)),
        )
        for item in payload.get("cameras", [])
        if str(item.get("camera_id", "")).strip()
    ]
    return RecorderConfig(
        storage_dir=str(payload["storage_dir"]),
        manifest_path=str(payload["manifest_path"]),
        segment_seconds=int(payload.get("segment_seconds", 120)),
        retention_days=int(payload.get("retention_days", 7)),
        reconnect_backoff_seconds=float(payload.get("reconnect_backoff_seconds", 2.0)),
        cleanup_interval_seconds=int(payload.get("cleanup_interval_seconds", 3600)),
        cameras=cameras,
    )


def _open_capture(rtsp_url: str) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(rtsp_url)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def _build_clip_path(storage_dir: str, camera: CameraSource, started_at: datetime) -> Path:
    day_dir = Path(storage_dir) / "raw_clips" / camera.camera_id / started_at.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{camera.camera_id}_{started_at.strftime('%Y-%m-%d_%H-%M-%S')}.mp4"
    return day_dir / filename


def append_manifest(manifest_path: str, record: dict[str, Any], manifest_lock: threading.Lock) -> None:
    target = Path(manifest_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with manifest_lock:
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def record_segment(camera: CameraSource, config: RecorderConfig) -> dict[str, Any]:
    started_at = datetime.now()
    clip_path = _build_clip_path(config.storage_dir, camera, started_at)
    clip_id = clip_path.stem

    cap = _open_capture(camera.rtsp_url)
    if not cap.isOpened():
        return {
            "clip_id": clip_id,
            "camera_id": camera.camera_id,
            "camera_name": camera.name,
            "started_at": started_at.isoformat(timespec="seconds"),
            "finished_at": datetime.now().isoformat(timespec="seconds"),
            "segment_seconds_requested": config.segment_seconds,
            "duration_seconds_actual": 0.0,
            "filepath": str(clip_path),
            "status": "failed",
            "error_message": f"unable_to_open_rtsp:{camera.rtsp_url}",
            "frames_written": 0,
            "fps": 0.0,
            "width": 0,
            "height": 0,
        }

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 1 or fps > 120:
        fps = 12.0

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720

    writer = cv2.VideoWriter(
        str(clip_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )
    if not writer.isOpened():
        cap.release()
        return {
            "clip_id": clip_id,
            "camera_id": camera.camera_id,
            "camera_name": camera.name,
            "started_at": started_at.isoformat(timespec="seconds"),
            "finished_at": datetime.now().isoformat(timespec="seconds"),
            "segment_seconds_requested": config.segment_seconds,
            "duration_seconds_actual": 0.0,
            "filepath": str(clip_path),
            "status": "failed",
            "error_message": "unable_to_open_writer",
            "frames_written": 0,
            "fps": float(fps),
            "width": width,
            "height": height,
        }

    frames_written = 0
    deadline = time.time() + config.segment_seconds
    last_success = time.time()
    error_message = ""

    try:
        while time.time() < deadline:
            ok, frame = cap.read()
            if not ok:
                if time.time() - last_success > max(5.0, config.reconnect_backoff_seconds * 2):
                    error_message = "stream_read_timeout"
                    break
                time.sleep(0.1)
                continue

            writer.write(frame)
            frames_written += 1
            last_success = time.time()
    finally:
        cap.release()
        writer.release()

    finished_at = datetime.now()
    actual_duration = frames_written / fps if fps > 0 else 0.0
    status = "completed" if frames_written > 0 else "failed"
    if status == "failed" and not error_message:
        error_message = "no_valid_frames"

    return {
        "clip_id": clip_id,
        "camera_id": camera.camera_id,
        "camera_name": camera.name,
        "started_at": started_at.isoformat(timespec="seconds"),
        "finished_at": finished_at.isoformat(timespec="seconds"),
        "segment_seconds_requested": config.segment_seconds,
        "duration_seconds_actual": round(actual_duration, 2),
        "filepath": str(clip_path),
        "status": status,
        "error_message": error_message,
        "frames_written": frames_written,
        "fps": round(float(fps), 2),
        "width": width,
        "height": height,
    }


def cleanup_old_segments(storage_dir: str, retention_days: int) -> int:
    if retention_days <= 0:
        return 0

    root = Path(storage_dir) / "raw_clips"
    if not root.exists():
        return 0

    cutoff = datetime.now() - timedelta(days=retention_days)
    removed = 0
    for file_path in root.rglob("*.mp4"):
        try:
            modified_at = datetime.fromtimestamp(file_path.stat().st_mtime)
        except OSError:
            continue
        if modified_at < cutoff:
            try:
                file_path.unlink()
                removed += 1
            except OSError:
                continue
    return removed


class RecorderService:
    def __init__(self, config: RecorderConfig) -> None:
        self.config = config
        self.stop_event = threading.Event()
        self.manifest_lock = threading.Lock()
        self.threads: list[threading.Thread] = []

    def start(self) -> None:
        for camera in self.config.cameras:
            if not camera.enabled:
                continue
            thread = threading.Thread(target=self._camera_loop, args=(camera,), daemon=True)
            thread.start()
            self.threads.append(thread)

        cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        cleanup_thread.start()
        self.threads.append(cleanup_thread)

    def stop(self) -> None:
        self.stop_event.set()
        for thread in self.threads:
            thread.join(timeout=3)

    def run_once(self, camera_id: str | None = None) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for camera in self.config.cameras:
            if not camera.enabled:
                continue
            if camera_id and camera.camera_id != camera_id:
                continue
            record = record_segment(camera, self.config)
            append_manifest(self.config.manifest_path, record, self.manifest_lock)
            results.append(record)
        return results

    def _camera_loop(self, camera: CameraSource) -> None:
        while not self.stop_event.is_set():
            record = record_segment(camera, self.config)
            append_manifest(self.config.manifest_path, record, self.manifest_lock)
            if record["status"] != "completed":
                time.sleep(self.config.reconnect_backoff_seconds)

    def _cleanup_loop(self) -> None:
        while not self.stop_event.is_set():
            cleanup_old_segments(self.config.storage_dir, self.config.retention_days)
            self.stop_event.wait(self.config.cleanup_interval_seconds)
