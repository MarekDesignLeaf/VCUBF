"""Persistent Qualcomm QNN Whisper worker for Emma Voice v2.

The parent process sends base64 encoded mono PCM16 frames as JSON lines.  The
Whisper encoder and decoder stay loaded for the lifetime of the one Emma
process, so each utterance uses the Snapdragon NPU without paying model startup
cost again.  Audio exists only in memory and is never written to disk.
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import sys
import time

import numpy as np
from qai_hub_models.models._shared.hf_whisper.app import HfWhisperApp
from qai_hub_models.utils.onnx.torch_wrapper import OnnxModelTorchWrapper


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", required=True)
    parser.add_argument("--model-size", default="base")
    args = parser.parse_args()

    root = Path(args.app_root).resolve()
    encoder = root / "models" / "encoder.onnx"
    decoder = root / "models" / "decoder.onnx"
    if not encoder.is_file() or not decoder.is_file():
        emit({"type": "fatal", "error": "NPU_WHISPER_MODEL_MISSING"})
        return 2

    try:
        app = HfWhisperApp(
            OnnxModelTorchWrapper.OnNPU(str(encoder)),
            OnnxModelTorchWrapper.OnNPU(str(decoder)),
            f"openai/whisper-{args.model_size}",
        )
    except Exception as exc:
        emit({"type": "fatal", "error": f"NPU_WHISPER_LOAD_FAILED_{type(exc).__name__}"})
        return 3

    emit({
        "type": "ready",
        "provider": "QNNExecutionProvider",
        "device": "Qualcomm Hexagon NPU",
        "model": f"whisper-{args.model_size}",
    })

    for line in sys.stdin:
        request_id = -1
        try:
            request = json.loads(line)
            request_id = int(request["id"])
            sample_rate = int(request.get("sample_rate", 24_000))
            pcm = base64.b64decode(str(request["pcm16"]), validate=True)
            if not pcm or len(pcm) > sample_rate * 2 * 30:
                raise ValueError("PCM_LENGTH_INVALID")
            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            started = time.perf_counter()
            text = app.transcribe(audio, sample_rate).strip()
            emit({
                "type": "transcription",
                "id": request_id,
                "text": text,
                "elapsed_ms": round((time.perf_counter() - started) * 1_000),
            })
        except Exception as exc:
            emit({
                "type": "error",
                "id": request_id,
                "error": f"NPU_WHISPER_TRANSCRIPTION_FAILED_{type(exc).__name__}",
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
