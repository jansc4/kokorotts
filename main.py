import argparse
import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
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

# jedno polaczenie keep-alive do Kokoro zamiast nowego TCP per chunk
SESSION = requests.Session()
TTS_TIMEOUT = (3, 60)          # (connect, read) - dlugi chunk moze generowac sie kilka s

# detektor urwanych timestampow (P2): slowo wejscia vs token z litera/cyfra
_WORD = re.compile(r"\w+(?:['’]\w+)*")     # didn't = 1 slowo, jak token Kokoro
_HAS_ALNUM = re.compile(r"[^\W_]")


class Api():

    def __init__(self):
        self.endpoint = "http://localhost:8880"
        self.window = None  # ustawiane po utworzeniu okna, patrz main
        # index -> bajty mp3 z Kokoro - zasila export_audio, zeby nie trzeba
        # bylo przepychac calej ksiazki przez most JS<->Python (QWebChannel)
        # jako jeden ogromny string, patrz export_audio.
        # BAJTY, nie base64: -25% pamieci, a b64decode przy generacji od razu
        # waliduje odpowiedz.
        self.sentence_audio_cache = {}
        self._silence_cache = {}  # ms (int) -> mp3 bytes, patrz _silence_mp3
        # Epoka generacji (P4): anulowany request w locie nie moze wpisac sie
        # do cache nastepnej ksiazki. JS podaje epoke w reset i w kazdym generate.
        self.epoch = 0

    def check_tts_service(self):
        try:
            response = SESSION.get(f"{self.endpoint}/health", timeout=3)
            data = response.json()
            return data.get("status") == "healthy"
        except requests.exceptions.RequestException:
            return False

    def get_test_sentence(self):
        try:
            body = {"input": "This is a test sentence for TTS.", "stream": False}
            response = SESSION.post(f"{self.endpoint}/dev/captioned_speech", json=body, timeout=TTS_TIMEOUT)
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
            response = SESSION.get(f"{self.endpoint}/v1/audio/voices", timeout=5)
            data = response.json()
            voices = data.get("voices", [])
            # API zwraca albo listę stringow, albo listę obiektow {"id": ...} - ujednolicamy
            return [v if isinstance(v, str) else v.get("id") for v in voices]
        except requests.exceptions.RequestException:
            return []

    def generate_sentence(self, sentence, index, voice=None, speed=1.0, epoch=None):
        # Kontrakt dla JS - NIGDY nie rzuca przez most, zawsze jedno z:
        #   {index, audio, timestamps, ...[, truncated]}  sukces
        #   {index, error}                                 blad (HTTP, timeout, zla odpowiedz, regula)
        #   {index, stale}                                 wynik anulowanej generacji (inna epoka)
        # Normalizacja PRZED syntezą - do Kokoro leci tekst po regulach.
        # (Karta zdania w JS pokazuje dzis tokeny Kokoro, nie oryginal - patrz audyt H1.)
        if epoch is not None and epoch != self.epoch:
            return {"index": index, "stale": True}
        try:
            normalized = normalizer.normalize_text(sentence, rules)
            body = {"input": normalized, "stream": False, "speed": speed}
            if voice:
                body["voice"] = voice
            response = SESSION.post(f"{self.endpoint}/dev/captioned_speech",
                                    json=body, timeout=TTS_TIMEOUT)
            try:
                data = response.json()
            except ValueError:
                data = None
            if not response.ok:
                # Kokoro 500 ma ksztalt {"detail": {...}} - bez top-level "error"
                detail = data.get("detail", data) if isinstance(data, dict) else response.text[:200]
                return {"index": index, "error": f"HTTP {response.status_code}: {detail}"}
            audio = data.get("audio") if isinstance(data, dict) else None
            timestamps = data.get("timestamps") if isinstance(data, dict) else None
            if not isinstance(audio, str) or not audio or not isinstance(timestamps, list):
                return {"index": index, "error": "Niepelna odpowiedz Kokoro (brak audio/timestamps)"}
            audio_bytes = base64.b64decode(audio, validate=True)
        except Exception as e:   # requests.*, binascii.Error, cokolwiek z normalizera
            return {"index": index, "error": f"{type(e).__name__}: {e}"}

        if epoch is not None and epoch != self.epoch:   # anulowano w trakcie requestu
            return {"index": index, "stale": True}
        self.sentence_audio_cache[index] = audio_bytes
        data["index"] = index                    # żeby JS wiedział które to zdanie

        # P2: Kokoro potrafi urwac timestampy w srodku chunka (audio kompletne).
        # Znane wyzwalacze usuwa tokenizer; ten detektor lapie nieznane.
        n_in = len(_WORD.findall(normalized))
        n_ts = sum(1 for t in timestamps
                   if isinstance(t, dict) and _HAS_ALNUM.search(str(t.get("word", ""))))
        if n_in and n_ts < 0.7 * n_in:
            data["truncated"] = True
            print(f"[truncated] chunk {index}: {n_ts}/{n_in} slow z timestampem: {normalized!r}",
                  file=sys.stderr)
        return data

    def reset_generation_cache(self, epoch=None):
        # Wolane z JS na start nowej generacji (obok audioService.reset()),
        # zeby export nie sklejal audio z poprzedniej ksiazki. JS musi to
        # AWAITOWAC przed pierwszym generate_sentence z nowa epoka.
        self.sentence_audio_cache = {}
        if epoch is not None:
            self.epoch = epoch
        return {"ok": True}

    def get_rules(self):
        from dataclasses import asdict
        return [asdict(r) for r in rules]

    def save_rules(self, new_rules):
        global rules
        try:
            parsed = [normalizer.NormRule(**r) for r in new_rules]
            # niepoprawny regex nie moze trafic do rules.json (P3) - inaczej
            # kazde generate_sentence by rzucalo
            bad = normalizer.invalid_rules(parsed)
            if bad:
                return {"error": "Niepoprawne reguly: " + "; ".join(bad)}
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

        # LAME dokleja ~46 ms opoznienia enkodera (1105 probek @24 kHz) i dopelnia
        # do ramki 24 ms; bez naglowka Xing dekoder tego nie przytnie. Skracamy
        # zadanie, zeby wynik ~= ms (blad < 1 ramka) - inaczej kazdy gap w
        # eksporcie bylby ~60 ms dluzszy niz przy zywym odtwarzaniu.
        seconds = max(ms / 1000 - 0.046, 0.024)
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                "-t", str(seconds),
                # te same parametry co mp3 z Kokoro (24 kHz mono CBR 128k, ffprobe) -
                # wymagane przez concat -c copy w export_audio; bez ID3/Xing,
                # zeby nawet surowe sklejanie nie wstawialo naglowkow w srodek strumienia
                "-b:a", "128k", "-id3v2_version", "0", "-write_xing", "0",
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
        # w trybie "wb" ucina plik do zera NATYCHMIAST przy otwarciu.
        # Dlatego piszemy do path + ".part" i dopiero na koncu os.replace -
        # istniejacy plik docelowy nigdy nie zostaje uciety przez nieudany eksport.
        #
        # gaps[i] to pauza (ms) PO zdaniu i - ta sama tablica, ktora JS uzywa
        # do setTimeout miedzy zdaniami przy zywym odtwarzaniu (sentenceGaps).
        # Bez tego eksport sklejal zdania bez przerw miedzy akapitami/scenami.
        part = None
        try:
            missing = [i for i in range(count) if i not in self.sentence_audio_cache]
            if missing:
                return {"error": f"Brak w cache audio dla zdan: {missing}"}

            result = self.window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename="kokorotts-export.mp3",
                file_types=("MP3 Audio (*.mp3)", "Wszystkie pliki (*.*)"),
            )
            if not result:
                return None  # uzytkownik anulowal dialog

            path = result[0] if isinstance(result, (list, tuple)) else result
            part = path + ".part"
            items = self._export_items(count, gaps or [])
            if not self._concat_ffmpeg(items, part):
                with open(part, "wb") as f:      # fallback: surowe sklejanie, strumieniowo
                    for key in items:
                        f.write(self._part_bytes(key))
            os.replace(part, path)
            return path
        except Exception as e:
            if part and os.path.exists(part):
                os.remove(part)
            return {"error": str(e)}

    def _export_items(self, count, gaps):
        # Kolejnosc kawalkow eksportu jako klucze: ("c", i) chunk | ("s", ms) cisza.
        # Bajty pobierane leniwie (_part_bytes) - zadnego b"".join calej ksiazki.
        items = []
        for i in range(count):
            items.append(("c", i))
            gap_ms = int(gaps[i]) if i < len(gaps) and gaps[i] else 0
            if gap_ms > 0 and self._silence_mp3(gap_ms):
                items.append(("s", gap_ms))
        return items

    def _part_bytes(self, key):
        kind, n = key
        return self.sentence_audio_cache[n] if kind == "c" else self._silence_mp3(n)

    def _concat_ffmpeg(self, items, out_path):
        # P6: kazdy chunk Kokoro ma wlasny tag ID3 na poczatku, a surowe
        # sklejenie nie ma globalnego naglowka dlugosci -> odtwarzacze
        # zanizaly czas trwania. Demuxer concat + "-c copy" (bez rekodowania)
        # zdejmuje tagi z wejsc i zapisuje poprawny naglowek Xing.
        # False -> wywolujacy robi surowe sklejanie.
        if not shutil.which("ffmpeg"):
            return False
        with tempfile.TemporaryDirectory(prefix="kokorotts-export-") as td:
            files = {}
            lines = []
            for key in items:
                if key not in files:            # cisza danej dlugosci zapisywana raz
                    p = os.path.join(td, f"{key[0]}{key[1]:06d}.mp3")
                    with open(p, "wb") as f:
                        f.write(self._part_bytes(key))
                    files[key] = p
                lines.append(f"file '{files[key]}'\n")
            listfile = os.path.join(td, "list.txt")
            with open(listfile, "w", encoding="utf-8") as f:
                f.writelines(lines)
            r = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-f", "concat", "-safe", "0", "-i", listfile,
                 "-c", "copy", "-f", "mp3", out_path],
                capture_output=True, text=True,
            )
            if r.returncode != 0:
                print(f"[export] ffmpeg concat nieudany, surowe sklejanie: {r.stderr[-500:]}",
                      file=sys.stderr)
                return False
            return True



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