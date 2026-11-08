"""The local engine worker: runs inside an engine's own venv, never the
backend's. `python tts_worker.py <engine> <models_dir>` loads one engine
(bluetts, melo or nabra), prints `{"ready": true}`, then answers one JSON line
per request `{"text", "voice", "lang", "out"}`: it writes a wav to `out` and
prints `{"duration": seconds}` or `{"error": message}`.

Only the stdlib is imported at the top so the backend's tests can import the
pure text helpers below without torch or onnx.
"""

import json
import os
import sys
import time


def arabic_prepare(text: str, normalize, diacritize) -> str:
    """Plain MSA to fully vowelled text: `normalize` is Nabra's
    `normalize_text` (returns (text, _)), `diacritize` the libtashkeel
    diacritizer. Pure, so the backend's suite checks it with fakes."""
    normalized, _ = normalize(text)
    return diacritize(normalized, taskeen_threshold=0.8)


def _write_wav(path: str, samples, rate: int) -> float:
    import numpy as np
    import soundfile as sf

    arr = np.asarray(samples, dtype="float32").reshape(-1)
    sf.write(path, arr, rate)
    return len(arr) / rate if rate else 0.0


SHORT_LINE_CHARS = 20


def _load_bluetts(models: str):
    sys.path.insert(0, f"{models}/src/Light-BlueTTS/src")
    from blue_onnx import BlueTTS

    engines = {}

    def load(voice: str):
        if voice not in engines:
            engines[voice] = BlueTTS(
                onnx_dir=f"{models}/bluetts2.5-onnx",
                style_json=f"{models}/src/Light-BlueTTS/voices/{voice}.json",
                renikud_path=f"{models}/renikud/model.onnx",
            )
        return engines[voice]

    def synth(text: str, voice: str, lang: str):
        # The duration head works in coarse steps (~0.14 s), so a very short
        # line gets a window too small for its words ("Woher kommst du?" came
        # out as "herbst du", and two different lines had identical lengths).
        # Slower pace and more steps give the words room.
        if len(text) <= SHORT_LINE_CHARS:
            return load(voice).synthesize(text, lang=lang, speed=0.75, total_step=10)
        return load(voice).synthesize(text, lang=lang)

    load("noa")  # the default de and he voice, loaded before "ready"
    return synth


def _load_melo(models: str):
    sys.path.insert(0, f"{models}/src/MeloTTS")
    from melo.api import TTS

    engines = {}

    def synth(text: str, voice: str, lang: str):
        # `voice` is Melo's language model name ("KR", "ZH"); one speaker each.
        if voice not in engines:
            engines[voice] = TTS(language=voice, device="cpu")
        m = engines[voice]
        sid = list(m.hps.data.spk2id.values())[0]
        audio = m.tts_to_file(text, sid, None, speed=1.0, quiet=True)
        return audio, m.hps.data.sampling_rate

    # Warm the voice the first request will use (the backend passes it).
    first = os.environ.get("SHADOW_TTS_WARM_VOICE") or "KR"
    sample = {"ZH": ("你好。", "zh")}.get(first, ("안녕하세요.", "ko"))
    synth.__dict__["warm"] = lambda: synth(sample[0], first, sample[1])
    return synth


def _load_nabra(models: str):
    import numpy as np
    import torch

    d = f"{models}/nabra"
    sys.path.insert(0, d)
    sys.path.insert(0, f"{models}/src/Oddadmix-kokoro")
    from arabic_g2p import ArabicG2P, EXTRA_SYMBOLS, clean_phonemes, normalize_text
    from kokoro import KModel, KPipeline
    from kokoro import pipeline as kp
    from piper.tashkeel import TashkeelDiacritizer

    km = KModel(repo_id="oddadmix/Nabra-82M-v0.1", config=f"{d}/config.json",
                model=f"{d}/kokoro_arabic.pth", disable_complex=True).eval()
    km.vocab.update(EXTRA_SYMBOLS)
    kp.LANG_CODES.setdefault("ar", "ar")
    pipe = KPipeline(lang_code="ar", repo_id="oddadmix/Nabra-82M-v0.1", model=km)
    g2p = ArabicG2P(diacritize=False)
    pipe.g2p = lambda t: (clean_phonemes(g2p._g2p(t)[0]), None)
    voices = {}
    tashkeel = TashkeelDiacritizer()

    def synth(text: str, voice: str, lang: str):
        if voice not in voices:
            voices[voice] = torch.load(f"{d}/{voice}.pt", map_location="cpu", weights_only=True)
        vowelled = arabic_prepare(text, normalize_text, tashkeel)
        audio = np.concatenate([
            x.detach().cpu().numpy() for _, _, x in pipe(vowelled, voice=voices[voice], speed=1.0)
        ])
        return audio, 24000

    return synth


LOADERS = {"bluetts": _load_bluetts, "melo": _load_melo, "nabra": _load_nabra}


def main(argv: list[str]) -> int:
    engine, models = argv[1], argv[2]
    # The engines print progress to stdout; the protocol keeps the real one.
    out = sys.stdout
    sys.stdout = sys.stderr

    def reply(obj: dict) -> None:
        print(json.dumps(obj), file=out, flush=True)

    try:
        synth = LOADERS[engine](models)
        warm = getattr(synth, "warm", None)
        if warm:
            warm()
    except Exception as exc:  # the backend reads this as a failed start
        reply({"ready": False, "error": f"{type(exc).__name__}: {exc}"[:300]})
        return 2
    reply({"ready": True})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            t0 = time.time()
            samples, rate = synth(req["text"], req["voice"], req["lang"])
            duration = _write_wav(req["out"], samples, int(rate))
            reply({"duration": duration, "took": round(time.time() - t0, 2)})
        except Exception as exc:
            reply({"error": f"{type(exc).__name__}: {exc}"[:300]})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
