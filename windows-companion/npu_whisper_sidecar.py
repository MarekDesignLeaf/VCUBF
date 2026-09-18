"""Persistent Qualcomm QNN Whisper worker for Emma Voice v2.

The parent process sends base64 encoded mono PCM16 frames as JSON lines.  The
Whisper encoder and decoder stay loaded for the lifetime of the one Emma
process, so each utterance uses the Snapdragon NPU without paying model startup
cost again.  Audio exists only in memory and is never written to disk.

Three guards keep the result trustworthy, because Whisper invents text when it
is given anything but speech:

*   A voice-activity gate runs before the model.  A segment without enough
    speech energy is answered with NO_SPEECH and never reaches Whisper, so
    silence cannot become a command and costs no time at all.
*   Decoding is capped by the real length of the audio.  Whisper cannot emit
    more words than the utterance can contain, which ends the repetition loops
    that otherwise run to the full decode length.
*   Every response carries a confidence (the mean probability of the tokens the
    model actually chose) and the measured speech length, so the caller can
    decide to trust the local result or ask the accurate cloud model instead.
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import sys
import time

import numpy as np
import torch
from qai_hub_models.models._shared.hf_whisper.app import HfWhisperApp
from qai_hub_models.utils.onnx.torch_wrapper import OnnxModelTorchWrapper


# --- Voice activity ----------------------------------------------------------
#
# Deliberately an energy gate rather than a learned model: it needs no extra
# download, runs in microseconds on a 20 ms frame, and only has to answer
# "could this be speech at all", not "where exactly does speech start".  The
# floor adapts to the room, so a noisy kitchen does not permanently open the
# gate the way a fixed threshold would.

FRAME_MS = 20
# Below this a frame is silence on any normal microphone (about -48 dBFS).
ABSOLUTE_SPEECH_RMS = 0.004
# Speech has to stand clearly above the room, not merely above zero.
NOISE_FLOOR_MULTIPLIER = 3.0
# Shorter than this is a click, a breath or a door, never a spoken command.
MIN_SPEECH_MS = 200


def speech_activity(audio: np.ndarray, sample_rate: int) -> tuple[float, float, float]:
    """Return (speech_ms, overall_rms, threshold) for one segment."""
    if audio.size == 0:
        return 0.0, 0.0, 0.0
    frame = max(1, int(sample_rate * FRAME_MS / 1000))
    usable = audio[: audio.size - (audio.size % frame)]
    if usable.size == 0:
        usable = audio
        frame = usable.size
    frames = usable.reshape(-1, frame)
    frame_rms = np.sqrt(np.mean(np.square(frames), axis=1))
    # The quietest tenth of the segment is the room, whatever the room is.
    noise_floor = float(np.percentile(frame_rms, 10))
    threshold = max(ABSOLUTE_SPEECH_RMS, noise_floor * NOISE_FLOOR_MULTIPLIER)
    speech_frames = int(np.count_nonzero(frame_rms > threshold))
    overall_rms = float(np.sqrt(np.mean(np.square(audio))))
    return speech_frames * FRAME_MS, overall_rms, threshold


def decode_token_budget(audio_seconds: float, hard_limit: int) -> int:
    """How many tokens an utterance of this length can honestly contain.

    Fast Czech or English speech runs at roughly six tokens a second; ten plus
    a fixed allowance leaves generous headroom while still cutting a runaway
    repetition off early.
    """
    return max(8, min(hard_limit, int(audio_seconds * 10) + 8))


class LanguageLockedWhisperApp(HfWhisperApp):
    """QNN Whisper with the active Secretary language fixed per request.

    Qualcomm's sample app begins decoding with only the start-of-transcript
    token.  Multilingual Whisper then guesses a language for every segment,
    which caused Czech, Polish and English to alternate inside one session.
    Supplying Whisper's normal language/task/no-timestamps prompt preserves
    the NPU path while making the selected application language authoritative.
    """

    forced_language = ""
    #: Set per request from the real audio length; -1 means "no extra cap".
    token_budget = -1
    #: Mean probability of the tokens this model chose for the last chunk.
    last_confidence = 0.0

    def _transcribe_single_chunk(self, audio: np.ndarray) -> list[int]:
        input_features = self.feature_extractor(
            audio, sampling_rate=self.sample_rate, return_tensors="pt"
        )["input_features"]

        kv_cache_cross = self.encoder(input_features)
        if not isinstance(kv_cache_cross, tuple):
            kv_cache_cross = (kv_cache_cross,)
        if not isinstance(kv_cache_cross[0], (tuple, list)):
            kv_cache_cross = (kv_cache_cross,)

        sot = self.config.decoder_start_token_id
        num_decoder_blocks = self.config.decoder_layers
        attention_dim = self.config.d_model
        num_decoder_heads = self.config.decoder_attention_heads
        mask_neg = self.config.mask_neg
        eot = self.config.eos_token_id

        prompt_tokens = [sot]
        if self.forced_language:
            prompt_tokens.extend(
                token
                for _, token in self.tokenizer.get_decoder_prompt_ids(
                    language=self.forced_language,
                    task="transcribe",
                    no_timestamps=True,
                )
            )
        output_ids = torch.tensor([prompt_tokens])
        output_logits = []
        output_length = output_ids.shape[1]

        position_ids = torch.tensor([0], dtype=torch.int32)
        attention_mask = torch.full(
            (1, 1, 1, self.mean_decode_len),
            mask_neg,
            dtype=torch.float32,
        )

        k_cache_self = torch.zeros(
            (
                num_decoder_heads,
                1,
                attention_dim // num_decoder_heads,
                self.mean_decode_len - 1,
            ),
            dtype=torch.float32,
        )
        v_cache_self = torch.zeros(
            (
                num_decoder_heads,
                1,
                self.mean_decode_len - 1,
                attention_dim // num_decoder_heads,
            ),
            dtype=torch.float32,
        )
        kv_cache_self = tuple(
            (k_cache_self, v_cache_self) for _ in range(num_decoder_blocks)
        )

        budget = self.mean_decode_len - 1
        if self.token_budget > 0:
            budget = min(budget, len(prompt_tokens) + self.token_budget)
        chosen_probabilities: list[float] = []

        for n in range(budget):
            input_ids = output_ids[:, n:n + 1].to(torch.int32)
            attention_mask[:, :, :, self.mean_decode_len - n - 1] = 0.0
            flattened_kv_cache_self = tuple(
                item for sublist in kv_cache_self for item in sublist
            )
            flattened_kv_cache_cross = tuple(
                item for sublist in kv_cache_cross for item in sublist
            )
            decoder_output = self.decoder(
                input_ids,
                attention_mask,
                *flattened_kv_cache_self,
                *flattened_kv_cache_cross,
                position_ids,
            )
            if isinstance(decoder_output, tuple) and len(decoder_output) == 2:
                logits, kv_cache_self = decoder_output
            else:
                logits = decoder_output[0]
                kv_cache_self = tuple(
                    decoder_output[i:i + 2]
                    for i in range(1, len(decoder_output), 2)
                )
            output_logits.append(logits.detach().clone())
            output_id = torch.argmax(logits, 1).squeeze(0)
            prompt_consumed = n >= output_length - 1
            if prompt_consumed:
                # The probability the model gave the token it actually emitted.
                # Confident speech sits high; text invented over silence does
                # not, which is what lets the caller tell them apart.
                probabilities = torch.softmax(logits.detach().float().reshape(-1), dim=0)
                chosen_probabilities.append(float(probabilities[int(output_id)]))
            if len(output_logits) == budget or (
                prompt_consumed and output_id == eot
            ):
                output_ids = torch.cat((output_ids, output_id), -1)
                break
            if prompt_consumed:
                output_ids = torch.cat((output_ids, output_id), -1)
            position_ids += 1

        self.last_confidence = (
            float(np.mean(chosen_probabilities)) if chosen_probabilities else 0.0
        )
        return output_ids[0].tolist()


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
        app = LanguageLockedWhisperApp(
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
            language = str(request.get("language") or "").split("-", 1)[0].lower()
            pcm = base64.b64decode(str(request["pcm16"]), validate=True)
            if not pcm or len(pcm) > sample_rate * 2 * 30:
                raise ValueError("PCM_LENGTH_INVALID")
            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            started = time.perf_counter()
            audio_seconds = audio.size / sample_rate if sample_rate else 0.0
            speech_ms, overall_rms, threshold = speech_activity(audio, sample_rate)
            if speech_ms < MIN_SPEECH_MS:
                # Nothing that could be speech: answer without waking the model.
                emit({
                    "type": "transcription",
                    "id": request_id,
                    "text": "",
                    "reason": "NO_SPEECH",
                    "speech_ms": round(speech_ms),
                    "rms": round(overall_rms, 5),
                    "threshold": round(threshold, 5),
                    "confidence": 0.0,
                    "elapsed_ms": round((time.perf_counter() - started) * 1_000),
                })
                continue
            app.forced_language = language
            app.token_budget = decode_token_budget(audio_seconds, app.mean_decode_len - 1)
            text = app.transcribe(audio, sample_rate).strip()
            emit({
                "type": "transcription",
                "id": request_id,
                "text": text,
                "reason": "",
                "speech_ms": round(speech_ms),
                "rms": round(overall_rms, 5),
                "threshold": round(threshold, 5),
                "confidence": round(app.last_confidence, 4),
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
