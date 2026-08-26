import argparse
import base64
import json
import shutil
import subprocess
import webview
import requests
import tokenizer
import reader
import normalizer
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RULES_PATH = os.path.join(BASE_DIR, "rules.json")
INTERVALS_PATH = os.path.join(BASE_DIR, "intervals.json")
DEFAULT_INTERVALS = {"gap_paragraph_ms": 250, "gap_scene_ms": 700, "max_chunk_chars": 350}

tokenize = tokenizer.Tokenizer()
rules = normalizer.load_rules(RULES_PATH)


class Api():

    def __init__(self):
        self.endpoint = "http://localhost:8880"
        self.window = None  # ustawiane po utworzeniu okna, patrz main
        # index -> base64 audio (surowe z Kokoro) - zasila export_audio, zeby
        # nie trzeba bylo przepychac calej ksiazki przez most JS<->Python
        # (QWebChannel) jako jeden ogromny string, patrz export_audio.
        self.sentence_audio_cache = {}
        self._silence_cache = {}  # ms (int) -> mp3 bytes, patrz _silence_mp3

    def check_tts_service(self):
        try:
            response = requests.get(f"{self.endpoint}/health", timeout=3)
            data = response.json()
            return data.get("status") == "healthy"
        except requests.exceptions.RequestException:
            return False

    def get_test_sentence(self):
        try:
            body = {"input": "This is a test sentence for TTS.", "stream": False}
            response = requests.post(f"{self.endpoint}/dev/captioned_speech", json=body, timeout=10)
            data = response.json()
            return data
        except requests.exceptions.RequestException:
            return {"error": "Failed to fetch test sentence"}
        
    def tokenize_text(self, text):
        # Zwraca liste Segmentow (chunki + gapy) jako dict-y dla JS:
        #   {kind:'chunk', text, in_speech}  |  {kind:'gap', duration_ms, gap_type}
        # Interwaly (dlugosci gapow, limit chunka) czytane z intervals.json.
        return tokenize.tokenize_structured(text, self.get_intervals())

    def get_voices(self):
        try:
            response = requests.get(f"{self.endpoint}/v1/audio/voices", timeout=5)
            data = response.json()
            voices = data.get("voices", [])
            # API zwraca albo listę stringow, albo listę obiektow {"id": ...} - ujednolicamy
            return [v if isinstance(v, str) else v.get("id") for v in voices]
        except requests.exceptions.RequestException:
            return []

    def generate_sentence(self, sentence, index, voice=None, speed=1.0):
        # Normalizacja PRZED syntezą - tekst wyświetlany w karcie zdania w JS
        # zostaje oryginalny, tylko to co leci do Kokoro jest podmienione.
        normalized = normalizer.normalize_text(sentence, rules)
        body = {"input": normalized, "stream": False, "speed": speed}
        if voice:
            body["voice"] = voice
        response = requests.post(f"{self.endpoint}/dev/captioned_speech", json=body, timeout=10)
        data = response.json()
        data["index"] = index                    # żeby JS wiedział które to zdanie
        if "audio" in data:
            self.sentence_audio_cache[index] = data["audio"]
        return data

    def reset_generation_cache(self):
        # Wolane z JS na start nowej generacji (obok audioService.reset()),
        # zeby export nie sklejal audio z poprzedniej ksiazki.
        self.sentence_audio_cache = {}
        return {"ok": True}

    def get_rules(self):
        from dataclasses import asdict
        return [asdict(r) for r in rules]

    def save_rules(self, new_rules):
        global rules
        try:
            parsed = [normalizer.NormRule(**r) for r in new_rules]
            normalizer.save_rules(RULES_PATH, parsed)
            rules = parsed
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def get_intervals(self):
        try:
            with open(INTERVALS_PATH, encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return dict(DEFAULT_INTERVALS)

    def save_intervals(self, intervals):
        try:
            with open(INTERVALS_PATH, "w", encoding="utf-8") as f:
                json.dump(intervals, f, indent=2, ensure_ascii=False)
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def open_file(self):
        # reader.file_filter() zwraca format natywny Qt (spacje jako separator
        # rozszerzen w jednym stringu) - pywebview.file_types oczekuje krotki
        # stringow z ";" jako separatorem, wiec nie mozna go uzyc wprost.
        try:
            result = self.window.create_file_dialog(
                webview.FileDialog.OPEN,
                file_types=(
                    "Dokumenty (*.txt;*.md;*.pdf;*.docx;*.epub;*.odt;*.rtf;*.mobi;*.azw;*.azw3)",
                    "Wszystkie pliki (*.*)",
                ),
            )
            if not result:
                return None  # uzytkownik anulowal dialog

            path = result[0] if isinstance(result, (list, tuple)) else result
            missing = reader.missing_deps_for(path)
            if missing:
                return {"error": f"Brakuje zaleznosci: pip install {' '.join(missing)}"}

            text = reader.read_document(path)
            return {"text": text, "filename": os.path.basename(path)}
        except Exception as e:
            return {"error": str(e)}

    def _silence_mp3(self, ms):
        # Ciche zdanie mp3 o zadanej dlugosci, generowane przez ffmpeg
        # (anullsrc). Cache'owane per dlugosc - w calej ksiazce wystepuja
        # zazwyczaj tylko 2 wartosci (gap_paragraph_ms, gap_scene_ms), wiec
        # ffmpeg odpala sie co najwyzej kilka razy, nie per-gap.
        #
        # WAZNE: to musi byc PRAWDZIWY, poprawnie zakodowany mp3 - surowe
        # zera PCM wklejone w strumien mp3 daja szum/artefakty, nie cisze,
        # bo dekoder czyta je jako (nieprawidlowe) ramki mp3.
        if ms <= 0:
            return b""
        if ms in self._silence_cache:
            return self._silence_cache[ms]
        if not shutil.which("ffmpeg"):
            return b""  # brak ffmpeg - eksport dziala, ale bez przerw (patrz export_audio)

        seconds = ms / 1000
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                "-t", str(seconds),
                "-q:a", "9",
                "-f", "mp3", "-",
            ],
            capture_output=True,
        )
        silence = result.stdout if result.returncode == 0 else b""
        self._silence_cache[ms] = silence
        return silence

    def export_audio(self, count, gaps=None):
        # <a download> na blob URL nie dziala w QtWebEngine bez recznego
        # podpiecia downloadRequested po stronie hosta - zamiast tego uzywamy
        # natywnego dialogu pywebview, ktory dziala zawsze niezaleznie od backendu.
        #
        # Audio KAZDEGO zdania jest juz w self.sentence_audio_cache (patrz
        # generate_sentence) - sklejamy je tutaj, PO STRONIE PYTHONA, zamiast
        # przepychac cala ksiazke jako jeden base64 string przez most JS<->Python
        # (QWebChannel). Dla duzych ksiazek ten most zawodzil (payload rzedu
        # dziesiatek/setek MB w jednym wywolaniu), co dawalo plik 0B: open()
        # w trybie "wb" ucina plik do zera NATYCHMIAST przy otwarciu, a jesli
        # dekodowanie uszkodzonego base64 rzucalo wyjatek, plik zostawal pusty.
        #
        # gaps[i] to pauza (ms) PO zdaniu i - ta sama tablica, ktora JS uzywa
        # do setTimeout miedzy zdaniami przy zywym odtwarzaniu (sentenceGaps).
        # Bez tego eksport sklejal zdania bez przerw miedzy akapitami/scenami.
        try:
            missing = [i for i in range(count) if i not in self.sentence_audio_cache]
            if missing:
                return {"error": f"Brak w cache audio dla zdan: {missing}"}

            gaps = gaps or []

            # Dekodujemy WSZYSTKO przed otwarciem pliku docelowego - jesli tu
            # cos wybuchnie, istniejacy plik pod tym samym path nie zostanie
            # ucięty do zera (patrz komentarz wyzej).
            parts = []
            for i in range(count):
                parts.append(base64.b64decode(self.sentence_audio_cache[i]))
                gap_ms = gaps[i] if i < len(gaps) else 0
                if gap_ms > 0:
                    parts.append(self._silence_mp3(gap_ms))
            audio_bytes = b"".join(parts)

            result = self.window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename="kokorotts-export.mp3",
                file_types=("MP3 Audio (*.mp3)", "Wszystkie pliki (*.*)"),
            )
            if not result:
                return None  # uzytkownik anulowal dialog

            path = result[0] if isinstance(result, (list, tuple)) else result
            with open(path, "wb") as f:
                f.write(audio_bytes)
            return path
        except Exception as e:
            return {"error": str(e)}



if __name__ == "__main__":


    parser = argparse.ArgumentParser(description="KokoroTTS - Text-to-Speech Application")
    parser.add_argument("--dev", action="store_true", help="Run in development mode")
    args = parser.parse_args()

    api = Api()
    url = os.path.join(BASE_DIR, "ui", "index.html") if not args.dev else os.path.join(BASE_DIR, "ui", "DevMode.html")
    if args.dev:
        print("Running in development mode")
        api.window = webview.create_window("KokoroTTS", url=url, js_api=api, width=800, height=600)
        webview.start(debug=args.dev)
    else:
        print("Running in production mode")
        api.window = webview.create_window("KokoroTTS", url=url, js_api=api, width=800, height=600)
        webview.start(debug=False)