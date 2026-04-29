from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_MOSS_ROOT = Path(r"D:\camera_agent_data\local_models\moss")
DEFAULT_SOURCE_DIR = DEFAULT_MOSS_ROOT / "MOSS-TTS-Nano"
DEFAULT_MODEL_DIR = DEFAULT_SOURCE_DIR / "models"
DEFAULT_OUTPUT_DIR = Path(r"D:\camera_agent_data\_voice\outputs")
DEFAULT_VOICE = "Junhao"

TEXT_REPLACEMENTS = {
    "cam01": "一号摄像头",
    "cam02": "二号摄像头",
    "Cam_01": "一号摄像头",
    "Cam_02": "二号摄像头",
    "Cam-01": "一号摄像头",
    "Cam-02": "二号摄像头",
    "TTS": "语音合成",
    "ASR": "语音识别",
    "RAG": "检索增强生成",
    "LLM": "大语言模型",
    "VLM": "视觉大模型",
    "RTSP": "视频流",
    "JSON": "结构化结果",
    "HTTP": "网络请求",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Persistent MOSS-TTS-Nano ONNX CPU HTTP server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=5091, help="Bind port")
    parser.add_argument("--source-dir", default=str(DEFAULT_SOURCE_DIR), help="MOSS-TTS-Nano source repository path")
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR), help="ONNX model parent directory")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Generated audio output directory")
    parser.add_argument("--cpu-threads", type=int, default=max(2, min(8, int(os.cpu_count() or 4))))
    parser.add_argument("--max-new-frames", type=int, default=220, help="Upper bound for generated audio frames")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="Built-in MOSS voice preset")
    parser.add_argument("--sample-mode", choices=("greedy", "fixed", "full"), default="fixed")
    parser.add_argument("--prompt-audio-path", default="", help="Optional reference audio path for voice cloning")
    return parser


def normalize_text_for_tts(text: str) -> str:
    clean_text = str(text or "").strip()
    if not clean_text:
        return "已生成语音播报。"

    normalized = clean_text
    normalized = re.sub(r"```.*?```", " ", normalized, flags=re.S)
    normalized = re.sub(r"`([^`]+)`", r"\1", normalized)
    normalized = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", normalized)
    normalized = re.sub(r"https?://\S+", " ", normalized)
    normalized = normalized.replace("\r", " ").replace("\n", " ")

    for source, target in TEXT_REPLACEMENTS.items():
        normalized = normalized.replace(source, target)

    normalized = re.sub(r"[A-Za-z_][A-Za-z0-9_./:-]*", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized or "已生成语音播报。"


class MossOnnxRuntime:
    def __init__(
        self,
        *,
        source_dir: Path,
        model_dir: Path,
        output_dir: Path,
        cpu_threads: int,
        max_new_frames: int,
        default_voice: str,
        sample_mode: str,
        prompt_audio_path: str,
    ) -> None:
        self.source_dir = Path(source_dir).expanduser().resolve()
        self.model_dir = Path(model_dir).expanduser().resolve()
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.cpu_threads = max(1, int(cpu_threads))
        self.max_new_frames = max(32, int(max_new_frames))
        self.default_voice = str(default_voice or DEFAULT_VOICE).strip() or DEFAULT_VOICE
        self.sample_mode = str(sample_mode or "fixed").strip() or "fixed"
        self.prompt_audio_path = str(prompt_audio_path or "").strip()
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.lock = threading.Lock()
        self._runtime: Any | None = None
        self._load_error = ""

    @property
    def loaded(self) -> bool:
        return self._runtime is not None

    def _ensure_source_importable(self) -> None:
        if not self.source_dir.exists():
            raise RuntimeError(
                "MOSS-TTS-Nano source directory not found. "
                f"Expected: {self.source_dir}. Please clone https://github.com/OpenMOSS/MOSS-TTS-Nano.git first."
            )
        source_text = str(self.source_dir)
        if source_text not in sys.path:
            sys.path.insert(0, source_text)

    def _ensure_runtime(self) -> Any:
        if self._runtime is not None:
            return self._runtime

        self._ensure_source_importable()
        try:
            from onnx_tts_runtime import OnnxTtsRuntime
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "MOSS-TTS-Nano ONNX dependencies are missing. "
                "Install the repository requirements in the TTS environment first."
            ) from exc

        self._runtime = OnnxTtsRuntime(
            model_dir=str(self.model_dir),
            thread_count=self.cpu_threads,
            max_new_frames=self.max_new_frames,
            sample_mode=self.sample_mode,
            output_dir=str(self.output_dir),
        )
        try:
            self._runtime.warmup()
        except Exception:
            # Warmup improves first response latency, but a failed warmup should not hide
            # a later successful synthesis attempt after assets finish downloading.
            pass
        return self._runtime

    def synthesize(self, *, text: str, output_path: Path, speed: float, voice: str) -> dict[str, Any]:
        del speed
        clean_text = str(text or "").strip()
        if not clean_text:
            return {"status": "error", "message": "Missing text content for synthesis"}

        spoken_text = normalize_text_for_tts(clean_text)
        selected_voice = str(voice or self.default_voice).strip() or self.default_voice
        output_path = Path(output_path).expanduser().resolve().with_suffix(".wav")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with self.lock:
            try:
                runtime = self._ensure_runtime()
                start_time = time.perf_counter()
                result = runtime.synthesize(
                    text=spoken_text,
                    voice=selected_voice,
                    prompt_audio_path=self.prompt_audio_path or None,
                    output_audio_path=str(output_path),
                    sample_mode=self.sample_mode,
                    do_sample=self.sample_mode != "greedy",
                    streaming=False,
                    max_new_frames=self.max_new_frames,
                    voice_clone_max_text_tokens=75,
                    enable_wetext=False,
                    enable_normalize_tts_text=True,
                    seed=42,
                )
                elapsed_seconds = time.perf_counter() - start_time
            except Exception as exc:
                self._load_error = f"{type(exc).__name__}: {exc}"
                return {"status": "error", "message": self._load_error}

        audio_path = Path(str(result.get("audio_path") or output_path)).resolve()
        if not audio_path.exists() or audio_path.stat().st_size <= 0:
            return {"status": "error", "message": "MOSS-TTS-Nano did not generate a playable audio file."}

        return {
            "status": "success",
            "output_path": str(audio_path),
            "text": clean_text,
            "spoken_text": spoken_text,
            "provider": "moss_tts_nano_onnx_cpu",
            "device": "cpu",
            "voice": selected_voice,
            "elapsed_seconds": round(float(elapsed_seconds), 3),
        }


class MossTTSHandler(BaseHTTPRequestHandler):
    runtime: MossOnnxRuntime | None = None

    def do_GET(self) -> None:
        if self.path == "/health":
            runtime = self.runtime
            self._send_json(
                {
                    "status": "success",
                    "ready": runtime is not None,
                    "loaded": bool(runtime.loaded) if runtime is not None else False,
                    "provider": "moss_tts_nano_onnx_cpu",
                    "device": "cpu",
                }
            )
            return
        self._send_json({"status": "error", "message": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if self.path != "/synthesize":
            self._send_json({"status": "error", "message": "Not found"}, status=HTTPStatus.NOT_FOUND)
            return
        if self.runtime is None:
            self._send_json({"status": "error", "message": "TTS runtime not ready"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception as exc:
            self._send_json({"status": "error", "message": f"Invalid request body: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        text = str(payload.get("text", "")).strip()
        output_path = Path(str(payload.get("output_path", "")).strip()).expanduser()
        speed = float(payload.get("speed", 1.0))
        voice = str(payload.get("voice", DEFAULT_VOICE)).strip() or DEFAULT_VOICE
        if not text:
            self._send_json({"status": "error", "message": "Missing text content for synthesis"}, status=HTTPStatus.BAD_REQUEST)
            return
        if not str(output_path).strip():
            self._send_json({"status": "error", "message": "Missing output_path"}, status=HTTPStatus.BAD_REQUEST)
            return

        result = self.runtime.synthesize(text=text, output_path=output_path, speed=speed, voice=voice)
        status = HTTPStatus.OK if str(result.get("status")).lower() == "success" else HTTPStatus.INTERNAL_SERVER_ERROR
        self._send_json(result, status=status)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    args = build_parser().parse_args()
    MossTTSHandler.runtime = MossOnnxRuntime(
        source_dir=Path(args.source_dir),
        model_dir=Path(args.model_dir),
        output_dir=Path(args.output_dir),
        cpu_threads=args.cpu_threads,
        max_new_frames=args.max_new_frames,
        default_voice=args.voice,
        sample_mode=args.sample_mode,
        prompt_audio_path=args.prompt_audio_path,
    )
    server = ThreadingHTTPServer((args.host, args.port), MossTTSHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
