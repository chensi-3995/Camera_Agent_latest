from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from camera_recorder import CameraService, record_clip
from embedding_client import EmbeddingClient
from event_store import EventStore
from feishu_agent import FeishuAgent
from llm_client import LLMClient
from monitoring_analysis import MonitoringAnalysisMixin
from monitoring_dashboard import MonitoringDashboardMixin
from monitoring_prompts import DEFAULT_PROMPT, SUMMARY_PERIODS
from monitoring_query import MonitoringQueryMixin
from monitoring_summary import MonitoringSummaryMixin
from monitoring_types import FrameJob
from ollama_client import OllamaClient
from remote_capture_client import RemoteCaptureClient
from schemas import CameraConfig, SystemConfig
from smart_extractor import SmartKeyframeExtractor
from vector_store import QdrantVectorStore
from xiaoan_assistant import XiaoAnAssistantMixin


class MonitoringOrchestrator(
    XiaoAnAssistantMixin,
    MonitoringDashboardMixin,
    MonitoringQueryMixin,
    MonitoringAnalysisMixin,
    MonitoringSummaryMixin,
):
    def __init__(self, config_path: str = "camera_config.json", prompt_path: str = "prompt.txt") -> None:
        self.config_path = Path(config_path)
        self.prompt_path = Path(prompt_path)
        self.config = self._load_config()

        self.base_dir = Path(self.config.storage.base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

        self.prompt_template = self._load_prompt()
        self.summary_periods = SUMMARY_PERIODS
        self.logs: list[dict[str, str]] = []
        self.capture_mode = str(self.config.capture.mode or "local_direct").strip().lower()
        self.pending_remote_clips: dict[str, list[dict[str, Any]]] = {}

        self.store = EventStore(self.config.storage.database_path)
        self.llm_client = LLMClient(
            base_url=self.config.server.base_url,
            provider=self.config.server.provider,
            model=self.config.server.model,
            api_key=self.config.server.api_key,
            photo_endpoint=self.config.server.photo_endpoint,
            chat_endpoint=self.config.server.chat_endpoint,
            chat_completions_endpoint=self.config.server.chat_completions_endpoint,
            timeout_seconds=self.config.server.timeout_seconds,
            max_tokens=self.config.server.max_tokens,
            temperature=self.config.server.temperature,
            top_p=self.config.server.top_p,
            presence_penalty=self.config.server.presence_penalty,
            top_k=self.config.server.top_k,
        )
        self.text_llm_client = OllamaClient(
            base_url=self.config.text_llm.base_url,
            model=self.config.text_llm.model,
            generate_endpoint=self.config.text_llm.generate_endpoint,
            timeout_seconds=self.config.text_llm.timeout_seconds,
            keep_alive=self.config.text_llm.keep_alive,
            temperature=self.config.text_llm.temperature,
            enabled=self.config.text_llm.enabled and self.config.text_llm.provider.lower() == "ollama",
        )
        self.embedding_client = EmbeddingClient(
            base_url=self.config.embedding.base_url,
            endpoint=self.config.embedding.endpoint,
            timeout_seconds=self.config.embedding.timeout_seconds,
            enabled=self.config.embedding.enabled,
        )
        self.vector_store = QdrantVectorStore(
            base_url=self.config.vector_store.base_url,
            collection_name=self.config.vector_store.collection_name,
            vector_size=self.config.vector_store.vector_size,
            distance=self.config.vector_store.distance,
            enabled=self.config.vector_store.enabled and self.config.vector_store.provider.lower() == "qdrant",
            create_payload_indexes=self.config.vector_store.create_payload_indexes,
        )

        self.text_llm_ready = self.text_llm_client.test_connection(timeout=2) if self.text_llm_client.enabled else False
        if self.text_llm_client.enabled:
            if self.text_llm_ready:
                self.add_log("文本模型", f"本地文本模型已就绪：{self.config.text_llm.model}")
            else:
                self.add_log("文本模型", f"本地文本模型不可用：{self.text_llm_client.last_error or 'unknown'}")

        feishu_runtime = self._resolve_feishu_runtime_config()
        self.feishu_agent = FeishuAgent(
            app_id=feishu_runtime["app_id"],
            app_secret=feishu_runtime["app_secret"],
            chat_id=feishu_runtime["chat_id"],
            webhook_url=feishu_runtime["webhook_url"],
        )
        self.remote_capture_client = RemoteCaptureClient(
            ssh_host=self.config.capture.ssh_host,
            ssh_port=self.config.capture.ssh_port,
            ssh_username=self.config.capture.ssh_username,
            ssh_key_path=self.config.capture.ssh_key_path,
            remote_manifest_path=self.config.capture.remote_manifest_path,
            local_cache_dir=self.config.capture.local_cache_dir,
            processed_state_path=self.config.capture.processed_state_path,
            manifest_tail_lines=self.config.capture.manifest_tail_lines,
            max_clips_per_camera=self.config.capture.max_clips_per_camera,
            selection_mode=self.config.capture.selection_mode,
        )

        self.camera_lookup = {camera.camera_id: camera for camera in self.config.cameras if camera.enabled}
        self.camera_services = self._build_camera_services()

        self.analysis_graph = self._build_analysis_graph()
        self.summary_graph = self._build_summary_graph()
        self.chat_graph = self._build_chat_graph()

        self.latest_report: list[dict[str, Any]] = self.get_events_for_date(self._today())
        self.latest_summary = self._deserialize_summary_record(self.store.get_latest_summary())
        self.task_status: dict[str, Any] = {
            "task_id": "",
            "status": "idle",
            "started_at": "",
            "finished_at": "",
            "duration_seconds": self.config.storage.clip_duration_seconds,
            "camera_ids": list(self.camera_lookup.keys()),
            "message": "系统空闲，等待新的采集任务。",
            "event_count": len(self.latest_report),
        }

        self.task_thread: threading.Thread | None = None
        self.task_lock = threading.Lock()
        self.scheduler_thread: threading.Thread | None = None
        self.last_scheduler_run_date = ""

        if self.config.storage.enable_daily_summary_scheduler:
            self.scheduler_thread = threading.Thread(target=self._daily_summary_scheduler, daemon=True)
            self.scheduler_thread.start()

        self.vector_search_enabled = self._init_vector_services()
        if self.capture_mode == "remote_manifest":
            self.add_log("系统", "当前运行在远程录制模式：服务器录制视频，本地下载片段后继续分析。")
        else:
            self.add_log("系统", "当前运行在内网直连模式：本地直接连接摄像头并完成录制与分析。")

    def _load_config(self) -> SystemConfig:
        if not self.config_path.exists():
            raise FileNotFoundError(f"Config file not found: {self.config_path}")
        data = json.loads(self.config_path.read_text(encoding="utf-8"))
        return SystemConfig.model_validate(data)

    def _load_prompt(self) -> str:
        if self.prompt_path.exists():
            content = self.prompt_path.read_text(encoding="utf-8").strip()
            if content:
                return content
        return DEFAULT_PROMPT

    def _run_text_llm(self, prompt: str, timeout: int | None = None, temperature: float | None = None) -> str:
        if not prompt.strip() or not self.text_llm_client.enabled:
            return ""

        response = self.text_llm_client.generate(prompt, timeout=timeout, temperature=temperature)
        if not response:
            return ""

        cleaned = response.replace("</s>", "").strip()
        cleaned = re.sub(r"<think>.*?</think>", "", cleaned, flags=re.IGNORECASE | re.DOTALL).strip()
        cleaned = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        return cleaned.strip()

    def _resolve_feishu_runtime_config(self) -> dict[str, str]:
        runtime = {
            "app_id": str(self.config.feishu.app_id or "").strip(),
            "app_secret": str(self.config.feishu.app_secret or "").strip(),
            "chat_id": str(self.config.feishu.chat_id or "").strip(),
            "webhook_url": str(self.config.feishu.webhook_url or "").strip(),
        }

        configured = bool(runtime["webhook_url"] or (runtime["app_id"] and runtime["app_secret"] and runtime["chat_id"]))
        if configured:
            return runtime

        fallback = self._load_feishu_config_from_test_alert()
        if fallback:
            runtime.update(fallback)
            self.config.feishu.app_id = runtime["app_id"]
            self.config.feishu.app_secret = runtime["app_secret"]
            self.config.feishu.chat_id = runtime["chat_id"]
            self.config.feishu.webhook_url = runtime["webhook_url"]
            self.add_log("飞书", "已从 test_alert.py 载入飞书配置。")
        else:
            self.add_log("飞书", "未找到可用的飞书配置，告警和日报推送将被跳过。")
        return runtime

    def _load_feishu_config_from_test_alert(self) -> dict[str, str]:
        candidate = self.config_path.parent / "test_alert.py"
        if not candidate.exists():
            return {}

        content = ""
        for encoding in ("utf-8", "gbk"):
            try:
                content = candidate.read_text(encoding=encoding)
                break
            except UnicodeDecodeError:
                continue
            except OSError:
                return {}

        if not content:
            return {}

        def extract(name: str) -> str:
            matched = re.search(rf"{name}\s*=\s*['\"]([^'\"]+)['\"]", content)
            return matched.group(1).strip() if matched else ""

        app_id = extract("FEISHU_APP_ID")
        app_secret = extract("FEISHU_APP_SECRET")
        chat_id = extract("FEISHU_CHAT_ID")
        webhook_url = extract("FEISHU_WEBHOOK_URL")

        if webhook_url:
            return {"app_id": "", "app_secret": "", "chat_id": "", "webhook_url": webhook_url}
        if app_id and app_secret and chat_id:
            return {"app_id": app_id, "app_secret": app_secret, "chat_id": chat_id, "webhook_url": ""}
        return {}

    def _init_vector_services(self) -> bool:
        if not self.embedding_client.enabled or not self.vector_store.enabled:
            self.add_log("向量库", "Embedding 或向量库未启用，将回退为 TF-IDF 检索。")
            return False

        if not self.embedding_client.test_connection():
            self.add_log("向量库", "Embedding 服务不可用，将回退为 TF-IDF 检索。")
            return False

        if not self.vector_store.test_connection():
            self.add_log("向量库", "Qdrant 服务不可用，将回退为 TF-IDF 检索。")
            return False

        try:
            self.vector_store.ensure_collection()
        except Exception as exc:
            self.add_log("向量库", f"Qdrant 集合初始化失败：{exc}")
            return False

        self.add_log("向量库", f"Qdrant 已就绪：{self.config.vector_store.base_url} / {self.config.vector_store.collection_name}")

        try:
            self._backfill_recent_events_to_vector_store(limit=300)
        except Exception as exc:
            self.add_log("向量库", f"历史事件回填 Qdrant 失败：{exc}")

        return True

    def _backfill_recent_events_to_vector_store(self, limit: int = 300) -> None:
        rows = self.store.list_recent_events(limit=limit)
        if not rows:
            return
        report_items = [self._build_report_item_from_row(row) for row in rows]
        self._index_report_items(report_items, source="backfill", force=True)

    def _build_camera_services(self) -> dict[str, CameraService]:
        if self.capture_mode != "local_direct":
            return {}
        return {
            camera.camera_id: CameraService(
                camera_id=camera.camera_id,
                name=camera.name,
                source_type=camera.source_type,
                source=camera.effective_source,
            )
            for camera in self.config.cameras
            if camera.enabled and camera.preview_enabled
        }

    def _sync_remote_clips(self, task_id: str, cameras: list[CameraConfig]) -> list[dict[str, Any]]:
        if not self.remote_capture_client.enabled:
            raise RuntimeError("remote_capture_not_configured")

        self.add_log("远程采集", f"任务 {task_id} 开始同步服务器视频片段。")
        records = self.remote_capture_client.sync_clips([camera.camera_id for camera in cameras])
        self.pending_remote_clips[task_id] = list(records)
        self.add_log("远程采集", f"任务 {task_id} 已同步 {len(records)} 个片段。")
        return records

    def _mark_remote_clips_processed(self, task_id: str) -> None:
        records = self.pending_remote_clips.pop(task_id, [])
        clip_ids = [str(record.get("clip_id", "")).strip() for record in records if str(record.get("clip_id", "")).strip()]
        if clip_ids:
            self.remote_capture_client.mark_processed(clip_ids)
            self.add_log("远程采集", f"任务 {task_id} 已标记 {len(clip_ids)} 个片段为已处理。")

    def _extract_frame_jobs_from_clip(
        self,
        task_id: str,
        camera: CameraConfig,
        clip_path: str,
        clip_started_at: str,
        frames_written: int = 0,
        fps: float = 0.0,
    ) -> list[FrameJob]:
        analysis_dir = self.base_dir / task_id / "analysis" / camera.camera_id
        analysis_dir.mkdir(parents=True, exist_ok=True)

        extractor = SmartKeyframeExtractor(
            input_video=str(clip_path),
            output_path=str(analysis_dir),
            base_threshold=self.config.storage.similarity_threshold,
            frame_rate=self.config.storage.frame_sample_rate,
            scale_factor=self.config.storage.extractor_scale_factor,
            min_time_gap=self.config.storage.min_frame_gap_seconds,
            event_time_gap=self.config.storage.event_merge_time_gap_seconds,
            event_similarity_threshold=self.config.storage.event_merge_similarity_threshold,
            max_event_duration=self.config.storage.event_max_duration_seconds,
            max_representative_frames=self.config.storage.max_representative_frames,
            motion_threshold=self.config.storage.motion_score_threshold,
        )
        extraction_result = extractor.run()
        if extraction_result is None:
            self.add_log("关键帧", f"{camera.name} 关键帧提取失败。")
            return []

        frames = extraction_result.get("frames", [])
        frame_jobs: list[FrameJob] = []
        for frame in frames:
            frame_jobs.append(
                {
                    "task_id": task_id,
                    "camera_id": camera.camera_id,
                    "camera_name": camera.name,
                    "clip_path": str(clip_path),
                    "clip_started_at": clip_started_at,
                    "frame_path": str(frame["filepath"]),
                    "frame_second": float(frame["second"]),
                    "event_group_id": str(frame.get("event_group_id", "")),
                    "event_frame_count": int(frame.get("event_frame_count", 1)),
                    "representative_count": int(frame.get("representative_count", 1)),
                    "event_start_second": float(frame.get("event_start_second", frame["second"])),
                    "event_end_second": float(frame.get("event_end_second", frame["second"])),
                    "event_duration_seconds": float(frame.get("event_duration_seconds", 0.0)),
                    "representative_rank": int(frame.get("representative_rank", 1)),
                    "is_primary": int(frame.get("is_primary", 1)),
                    "person_count_hint": int(frame.get("person_count_hint", 0)),
                    "person_score_hint": float(frame.get("person_score_hint", 0.0)),
                    "low_pose_hint": int(frame.get("low_pose_hint", 0)),
                    "foreground_area_ratio_hint": float(frame.get("foreground_area_ratio_hint", 0.0)),
                    "analysis_order": 0,
                }
            )

        self.add_log(
            "关键帧",
            f"{camera.name} 已提取 {int(extraction_result.get('event_count', 0))} 个事件窗口、{len(frame_jobs)} 张关键帧。"
            f" 片段帧数 {frames_written}，帧率 {fps:.2f}。",
        )
        return frame_jobs

    def _today(self) -> str:
        return datetime.now().strftime("%Y-%m-%d")

    def add_log(self, category: str, message: str) -> None:
        self.logs.append(
            {
                "time": datetime.now().strftime("%H:%M:%S"),
                "category": category,
                "message": message,
            }
        )
        if len(self.logs) > 250:
            self.logs = self.logs[-250:]

    def get_logs(self) -> list[dict[str, str]]:
        return list(self.logs)

    def get_task_status(self) -> dict[str, Any]:
        return dict(self.task_status)

    def get_latest_report(self) -> list[dict[str, Any]]:
        if self.latest_report:
            return list(self.latest_report)
        return self.get_events_for_date(self._today())

    def get_latest_summary(self) -> dict[str, Any] | None:
        if self.latest_summary is not None:
            return dict(self.latest_summary)
        latest = self._deserialize_summary_record(self.store.get_latest_summary())
        if latest is not None:
            self.latest_summary = latest
            return dict(latest)
        return None

    def get_camera_service(self, camera_id: str) -> CameraService | None:
        return self.camera_services.get(camera_id)

    def get_cameras_overview(self) -> list[dict[str, Any]]:
        overview: list[dict[str, Any]] = []
        for camera in self.config.cameras:
            if not camera.enabled:
                continue

            service = self.camera_services.get(camera.camera_id)
            if service is not None:
                status = service.status_snapshot()
            else:
                status = {
                    "camera_id": camera.camera_id,
                    "name": camera.name,
                    "source_type": camera.source_type,
                    "configured": bool(camera.effective_source),
                    "available": False,
                    "last_error": (
                        "远程录制模式下不提供实时预览"
                        if self.capture_mode == "remote_manifest"
                        else "预览未启用"
                    ),
                    "last_success_at": "",
                }

            status.update(
                {
                    "description": camera.description,
                    "source_preview": self._sanitize_source(camera.effective_source, camera.source_type),
                    "video_feed_url": f"/video_feed/{camera.camera_id}",
                }
            )
            overview.append(status)
        return overview

    def get_overview(self) -> dict[str, Any]:
        return {
            "cameras": self.get_cameras_overview(),
            "task": self.get_task_status(),
            "logs": self.get_logs(),
            "report": self.get_latest_report(),
            "summary": self.get_latest_summary(),
        }

    def get_events_for_date(self, target_date: str | None = None) -> list[dict[str, Any]]:
        query_date = target_date or self._today()
        rows = self.store.list_events_for_day(query_date)
        return [self._build_report_item_from_row(row) for row in rows]

    def get_summary_for_date(
        self,
        summary_date: str | None = None,
        regenerate: bool = False,
        send_to_feishu: bool = False,
    ) -> dict[str, Any]:
        target_date = summary_date or self._today()
        if not regenerate:
            stored = self._deserialize_summary_record(self.store.get_summary_by_date(target_date))
            if stored is not None:
                return stored
        return self.generate_daily_summary(summary_date=target_date, send_to_feishu=send_to_feishu)

    def start_task(self, camera_ids: list[str] | None = None, duration_seconds: int | None = None) -> dict[str, Any]:
        with self.task_lock:
            if self.task_thread and self.task_thread.is_alive():
                return {"status": "error", "message": "当前已有任务在运行，请稍后再试。"}

            selected_cameras = self._select_cameras(camera_ids)
            if not selected_cameras:
                return {"status": "error", "message": "未找到可执行的摄像头，请检查 camera_ids 或配置。"}

            duration = int(duration_seconds or self.config.storage.clip_duration_seconds)
            task_id = datetime.now().strftime("%Y%m%d_%H%M%S")

            self.task_status = {
                "task_id": task_id,
                "status": "running",
                "started_at": datetime.now().isoformat(timespec="seconds"),
                "finished_at": "",
                "duration_seconds": duration,
                "camera_ids": [camera.camera_id for camera in selected_cameras],
                "message": "任务已启动，正在准备视频片段并进入分析流程。",
                "event_count": 0,
            }
            self.latest_report = []

            self.task_thread = threading.Thread(
                target=self._run_task,
                args=(task_id, selected_cameras, duration),
                daemon=True,
            )
            self.task_thread.start()

        return {
            "status": "success",
            "task_id": task_id,
            "started_at": self.task_status["started_at"],
            "finished_at": "",
            "duration_seconds": duration,
            "camera_ids": [camera.camera_id for camera in selected_cameras],
            "event_count": 0,
            "message": "任务已启动，正在准备视频片段并进入分析流程。",
        }

    def run_task_sync(self, camera_ids: list[str] | None = None, duration_seconds: int | None = None) -> dict[str, Any]:
        result = self.start_task(camera_ids=camera_ids, duration_seconds=duration_seconds)
        if result.get("status") != "success":
            return result

        if self.task_thread:
            self.task_thread.join()
        return self.get_overview()

    def _run_task(self, task_id: str, cameras: list[CameraConfig], duration_seconds: int) -> None:
        started_at = datetime.now().isoformat(timespec="seconds")
        self.store.create_task(
            task_id=task_id,
            started_at=started_at,
            status="running",
            trigger_type="manual",
            requested_duration=duration_seconds,
            camera_ids=[camera.camera_id for camera in cameras],
        )
        self.add_log("任务", f"任务 {task_id} 已启动，共 {len(cameras)} 路摄像头，时长 {duration_seconds} 秒。")

        try:
            frame_jobs = self._prepare_frame_jobs_for_cameras(task_id, cameras, duration_seconds)
            graph_result = self.analysis_graph.invoke({"task_id": task_id, "frame_jobs": frame_jobs})

            report_items = list(graph_result.get("report_items", []))
            report_items.sort(key=lambda item: (item.get("timestamp", ""), int(item.get("event_id", 0))))
            self.latest_report = report_items

            finished_at = datetime.now().isoformat(timespec="seconds")
            camera_runs = self.store.get_camera_runs_by_task(task_id)
            completed_runs = [run for run in camera_runs if str(run.get("status", "")) == "completed"]
            failed_runs = [run for run in camera_runs if str(run.get("status", "")) == "failed"]

            task_status_value = "completed"
            task_message = f"任务完成，共生成 {len(report_items)} 条关键帧分析记录。"
            task_error_message = ""

            if camera_runs and not completed_runs:
                task_status_value = "failed"
                failed_names = " / ".join(str(run.get("camera_name", run.get("camera_id", ""))) for run in failed_runs) or "全部摄像头"
                failure_reasons = "；".join(
                    str(run.get("error_message", "")).strip()
                    for run in failed_runs
                    if str(run.get("error_message", "")).strip()
                )
                task_message = f"任务失败：{failed_names} 均未录制成功，未生成视频。"
                task_error_message = failure_reasons
            elif completed_runs and failed_runs:
                task_status_value = "partial_failed"
                failed_names = " / ".join(str(run.get("camera_name", run.get("camera_id", ""))) for run in failed_runs)
                task_message = (
                    f"任务部分完成：成功录制 {len(completed_runs)} 路，失败 {len(failed_runs)} 路，"
                    f"共生成 {len(report_items)} 条关键帧分析记录。"
                )
                task_error_message = f"{failed_names} 录制失败。"

            self.store.update_task(task_id, task_status_value, finished_at, task_error_message)
            self.task_status = {
                "task_id": task_id,
                "status": task_status_value,
                "started_at": started_at,
                "finished_at": finished_at,
                "duration_seconds": duration_seconds,
                "camera_ids": [camera.camera_id for camera in cameras],
                "message": task_message,
                "event_count": len(report_items),
            }
            if self.capture_mode == "remote_manifest":
                self._mark_remote_clips_processed(task_id)
            self.add_log("任务", f"任务 {task_id} 状态：{task_status_value}，共生成 {len(report_items)} 条事件。")
        except Exception as exc:
            finished_at = datetime.now().isoformat(timespec="seconds")
            self.store.update_task(task_id, "failed", finished_at, str(exc))
            self.task_status = {
                "task_id": task_id,
                "status": "failed",
                "started_at": started_at,
                "finished_at": finished_at,
                "duration_seconds": duration_seconds,
                "camera_ids": [camera.camera_id for camera in cameras],
                "message": f"任务失败：{exc}",
                "event_count": 0,
            }
            self.add_log("错误", f"任务 {task_id} 执行失败：{exc}")
        finally:
            self.pending_remote_clips.pop(task_id, None)

    def _prepare_frame_jobs_for_cameras(
        self,
        task_id: str,
        cameras: list[CameraConfig],
        duration_seconds: int,
    ) -> list[FrameJob]:
        if not cameras:
            return []

        if self.capture_mode == "remote_manifest":
            synced_records = self._sync_remote_clips(task_id, cameras)
            if not synced_records:
                self.add_log("远程采集", f"任务 {task_id} 未同步到新的服务器视频片段。")
                return []

            camera_map = {camera.camera_id: camera for camera in cameras}
            prepared_jobs: list[FrameJob] = []
            for record in synced_records:
                camera = camera_map.get(str(record.get("camera_id", "")).strip())
                if camera is None:
                    continue

                local_path = str(record.get("local_path", "")).strip()
                if not local_path:
                    continue

                frames_written = int(record.get("frames_written", 0))
                fps = float(record.get("fps", 0.0))
                status = str(record.get("status", "completed")).strip() or "completed"
                error_message = str(record.get("error_message", "")).strip()
                self.store.add_camera_run(
                    task_id=task_id,
                    camera_id=camera.camera_id,
                    camera_name=camera.name,
                    clip_path=local_path,
                    frames_written=frames_written,
                    fps=fps,
                    status=status,
                    error_message=error_message,
                )

                if status.lower() != "completed":
                    self.add_log("远程采集", f"{camera.name} 远程片段状态异常：{status} {error_message}".strip())
                    continue

                prepared_jobs.extend(
                    self._extract_frame_jobs_from_clip(
                        task_id=task_id,
                        camera=camera,
                        clip_path=local_path,
                        clip_started_at=str(record.get("started_at", datetime.now().isoformat(timespec="seconds"))),
                        frames_written=frames_written,
                        fps=fps,
                    )
                )

            return self._interleave_frame_jobs(prepared_jobs)

        max_workers = max(1, min(len(cameras), int(self.config.storage.camera_capture_workers)))
        prepared_jobs: list[FrameJob] = []
        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="clip-worker") as executor:
            future_map = {
                executor.submit(self._prepare_frame_jobs, task_id, camera, duration_seconds): camera
                for camera in cameras
            }
            for future in as_completed(future_map):
                camera = future_map[future]
                try:
                    prepared_jobs.extend(future.result())
                except Exception as exc:
                    self.add_log("采集", f"{camera.name} 录制或抽帧失败：{exc}")

        return self._interleave_frame_jobs(prepared_jobs)

    def _prepare_frame_jobs(self, task_id: str, camera: CameraConfig, duration_seconds: int) -> list[FrameJob]:
        clip_dir = self.base_dir / task_id / "raw_clips"
        clip_dir.mkdir(parents=True, exist_ok=True)
        clip_path = clip_dir / f"{camera.camera_id}.mp4"

        self.add_log("采集", f"{camera.name} 开始录制本地视频片段。")
        record_result = record_clip(
            source_type=camera.source_type,
            source=camera.effective_source,
            filepath=str(clip_path),
            duration_seconds=duration_seconds,
        )

        run_status = "completed" if record_result.get("success") else "failed"
        self.store.add_camera_run(
            task_id=task_id,
            camera_id=camera.camera_id,
            camera_name=camera.name,
            clip_path=str(clip_path),
            frames_written=int(record_result.get("frames_written", 0)),
            fps=float(record_result.get("fps", 0.0)),
            status=run_status,
            error_message=str(record_result.get("error", "")),
        )

        if not record_result.get("success"):
            self.add_log("采集", f"{camera.name} 录制失败：{record_result.get('error', 'unknown_error')}")
            return []

        return self._extract_frame_jobs_from_clip(
            task_id=task_id,
            camera=camera,
            clip_path=str(clip_path),
            clip_started_at=str(record_result.get("started_at", datetime.now().isoformat(timespec="seconds"))),
            frames_written=int(record_result.get("frames_written", 0)),
            fps=float(record_result.get("fps", 0.0)),
        )

    def answer_question(self, question: str, history: list[dict[str, str]] | None = None) -> dict[str, Any]:
        if not question.strip():
            return {"answer": "请输入要查询的问题。", "references": []}

        cleaned_question = question.strip()
        if self._classify_query_intent(cleaned_question) == "greeting":
            return {
                "answer": "你好，我可以帮你按日期、时段、摄像头、风险等级和人物特征查询监控记录。你可以直接问：4月10号有出现黑色衣服的人吗？",
                "references": [],
                "used_llm": False,
                "standalone_question": cleaned_question,
            }

        result = self.chat_graph.invoke({"question": cleaned_question, "history": list(history or [])})
        return {
            "answer": result.get("answer", "未生成有效回答。"),
            "references": result.get("references", []),
            "used_llm": bool(result.get("used_llm", False)),
            "standalone_question": result.get("standalone_question", cleaned_question),
        }

    def shutdown(self) -> None:
        for service in self.camera_services.values():
            service.release()

    def _select_cameras(self, camera_ids: list[str] | None) -> list[CameraConfig]:
        if not camera_ids:
            return [camera for camera in self.config.cameras if camera.enabled]
        target_ids = set(camera_ids)
        return [camera for camera in self.config.cameras if camera.enabled and camera.camera_id in target_ids]

    def _sanitize_source(self, source: str, source_type: str) -> str:
        source = str(source or "").strip()
        if not source:
            return ""
        if source_type == "local":
            return Path(source).name
        if source_type == "rtsp":
            parsed = urlparse(source)
            if parsed.scheme and parsed.hostname:
                port = f":{parsed.port}" if parsed.port else ""
                return f"{parsed.scheme}://{parsed.hostname}{port}{parsed.path}"
            return "RTSP 地址"
        return source

    def _parse_datetime(self, value: str) -> datetime | None:
        if not value:
            return None
        candidate = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            return None
        if parsed.tzinfo is not None:
            parsed = parsed.replace(tzinfo=None)
        return parsed

    def _format_time_label(self, timestamp: str) -> str:
        parsed = self._parse_datetime(timestamp)
        if parsed:
            return parsed.strftime("%H:%M:%S")
        return timestamp[-8:] if len(timestamp) >= 8 else timestamp

    def _daily_summary_scheduler(self) -> None:
        while True:
            now = datetime.now()
            current_marker = now.strftime("%Y-%m-%d")
            if now.strftime("%H:%M") == self.config.storage.daily_summary_time:
                if current_marker != self.last_scheduler_run_date:
                    try:
                        self.generate_daily_summary(summary_date=current_marker, send_to_feishu=True)
                        self.last_scheduler_run_date = current_marker
                    except Exception as exc:
                        self.add_log("日报", f"定时生成日报失败：{exc}")
            time.sleep(30)
