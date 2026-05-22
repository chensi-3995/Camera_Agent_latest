from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path

from recorder_core import RecorderService, load_config


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Record RTSP camera segments on the server.")
    parser.add_argument(
        "--config",
        default="server_config.json",
        help="Path to server recorder config file.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Record exactly one segment per enabled camera and then exit.",
    )
    parser.add_argument(
        "--camera-id",
        default="",
        help="Only record a single camera when used with --once.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    config_path = Path(args.config).resolve()
    config = load_config(str(config_path))
    service = RecorderService(config)

    if args.once:
        results = service.run_once(camera_id=args.camera_id or None)
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    stop_requested = {"value": False}

    def handle_signal(signum, frame) -> None:  # type: ignore[unused-argument]
        stop_requested["value"] = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    service.start()
    print(f"server recorder started with {len([c for c in config.cameras if c.enabled])} cameras")
    print(f"segment_seconds={config.segment_seconds}")
    print(f"storage_dir={config.storage_dir}")
    print(f"manifest_path={config.manifest_path}")

    try:
        while not stop_requested["value"]:
            time.sleep(1)
    finally:
        service.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
