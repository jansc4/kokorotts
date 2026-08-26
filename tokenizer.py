"""
tokenizer.py - tekst -> lista Segmentow (chunki + gapy) dla pipeline TTS.

Model chunk/gap (zastepuje plaska liste zdan):
  chunk = jednostka GENERACJI. Leci do kokoro jednym requestem; kilka zdan
          moze siedziec w jednym chunku dla spojnej prozodii (tura mowy!).
          Highlight jezdzi po per-word timestamps tego chunka - samowystarczalnych.
  gap   = pauza MIEDZY chunkami. Nie idzie do kokoro. JS robi z niej
          opoznienie przed swap() elementow <audio>.

Trzy warstwy:
  1. struktura       - linie -> bloki prozy | gap sceny | gap akapitu
  2. segmentacja+DFA - fast_sentence_segment tnie proze na zdania; DFA
     cudzyslowow flaguje zdania padajace WEWNATRZ mowy (potrzebne scalaniu)
  3. scalanie        - zdania -> chunki (nie lam tury mowy; limit dlugosci)

Interwaly (dlugosci gapow, limit chunka) czytane z intervals.json przez main.py
i wstrzykiwane do tokenize_structured(). Domyslne ponizej sluza tylko testom.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict

import fast_sentence_segment as fss


DEFAULT_INTERVALS = {
    "gap_paragraph_ms": 250,   # akapit <-> akapit
    "gap_scene_ms": 700,       # ***, en-dash sam w linii, >=2 puste linie
    "max_chunk_chars": 350,    # gorny limit chunka (strzeze TTFB)
}


@dataclass
class Segment:
    kind: str                       # 'chunk' | 'gap'
    text: str | None = None         # None dla gap
    duration_ms: int | None = None  # tylko gap
    gap_type: str | None = None     # 'paragraph' | 'scene' (tylko gap)
    in_speech: bool = False         # chunk zawiera mowe (UI/debug)


# --- znaki ---
OPEN_Q, CLOSE_Q, STRAIGHT_Q = "\u201C", "\u201D", '"'
_SEP_CHARS = set("*-\u2013\u2014_\u00b7=~ \t")   # * - en-dash em-dash _ middot = ~
_HAS_LETTER = re.compile(r"[^\W\d_]")            # przynajmniej jedna litera

# fss dokleja kropke po zdaniu konczacym sie cudzyslowem zamykajacym
# ('impressive."' -> 'impressive.".'). Usuwamy JA TYLKO gdy wewnatrz cudzyslowu
# jest juz interpunkcja konca zdania - nie tykamy legalnego brytyjskiego "yes".
_ADDED_PERIOD = re.compile("([.!?][\u201D\u2019\"'])\\.\\Z")


def _strip_added_period(s: str) -> str:
    return _ADDED_PERIOD.sub(r"\1", s.strip())


# Kokoro (/dev/captioned_speech) URYWA strumien timestampow na en-dashu i na
# zwyklym mysliku OTOCZONYCH SPACJAMI (" - ", " - "). Audio powstaje z calego
# chunka (slychac je), ale timestampy koncza sie w tym miejscu -> reszta chunka
# znika z kolejki i z highlightu. Em-dash jest bezpieczny (zweryfikowane
# empirycznie: em ze spacjami i bez, en bez spacji - wszystkie OK).
# Podmiana jest tez semantycznie poprawna: wtracenie w angielskiej prozie to em-dash.
# UWAGA: to niezmiennik pipeline'u (timestampy musza pokrywac caly chunk),
# dlatego siedzi tutaj, a nie w rules.json - nie ma byc wylaczalne z popupu.
_SPACED_DASH = re.compile(r"\s+[-\u2013]\s+")


def _fix_spaced_dashes(s: str) -> str:
    return _SPACED_DASH.sub("\u2014", s)


def _is_separator_line(line: str) -> bool:
    """Linia zlozona WYLACZNIE ze znakow separatora (np. ***, * * *, ---, en-dash sam)."""
    s = line.strip()
    return bool(s) and all(ch in _SEP_CHARS for ch in s)


# ---------------------------------------------------------------------------
# WARSTWA 1 - struktura (praca LINIAMI, nie zdaniami)
# ---------------------------------------------------------------------------

def _structure(raw: str, iv: dict) -> list:
    """Linie -> lista: ('prose', tekst_akapitu) albo Segment(gap). Nie tnie na zdania.

    Rozroznienie gapow:
      - linia-separator (***, en-dash) w przerwie   -> gap 'scene'
      - >=2 pustych linii                            -> gap 'scene'
      - dokladnie 1 pusta linia                      -> gap 'paragraph'
      - sasiednie linie tresci bez pustej            -> gap 'paragraph'
    """
    out: list = []
    prev_content = False
    blank_run = 0
    run_has_sep = False

    def gap_scene():
        return Segment("gap", duration_ms=iv["gap_scene_ms"], gap_type="scene")

    def gap_para():
        return Segment("gap", duration_ms=iv["gap_paragraph_ms"], gap_type="paragraph")

    for line in raw.split("\n"):
        stripped = line.strip()

        if not stripped or _is_separator_line(line):
            blank_run += 1
            if stripped:                 # niepusta linia-separator (np. ***, en-dash)
                run_has_sep = True
            continue

        # linia z trescia -> najpierw domknij ewentualny gap
        if blank_run > 0:
            out.append(gap_scene() if (run_has_sep or blank_run >= 2) else gap_para())
        elif prev_content:               # sasiednie linie tresci -> granica akapitu
            out.append(gap_para())
        blank_run = 0
        run_has_sep = False

        out.append(("prose", stripped))
        prev_content = True

    return out


# ---------------------------------------------------------------------------
# WARSTWA 2 - segmentacja (fss) + DFA cudzyslowow
# ---------------------------------------------------------------------------

def _detect_quote_style(text: str) -> str:
    """'typographic' gdy kierunkowe, 'straight' gdy tylko proste, 'none' gdy brak."""
    if OPEN_Q in text or CLOSE_Q in text:
        return "typographic"
    if STRAIGHT_Q in text:
        return "straight"
    return "none"


def _split_and_tag(block_text: str) -> list:
    """fss tnie akapit na zdania; DFA cudzyslowow flaguje in_speech.
    Zwraca [(zdanie, in_speech), ...]."""
    # fss.segment zwraca akapity (lista list); blok = jeden akapit -> splaszcz
    sentences = [s for para in fss.segment(block_text) for s in para]
    sentences = [_fix_spaced_dashes(_strip_added_period(s))
                 for s in sentences if _HAS_LETTER.search(s)]

    style = _detect_quote_style(block_text)
    inside = False               # stan wejsciowy w akapit: poza mowa
    tagged: list = []

    for sent in sentences:
        saw_speech = inside      # zdanie zaczyna sie wewnatrz mowy?
        for ch in sent:
            if style == "typographic":
                if ch == OPEN_Q:
                    inside = True
                    saw_speech = True
                elif ch == CLOSE_Q:
                    inside = False
            elif style == "straight":
                if ch == STRAIGHT_Q:
                    inside = not inside
                    if inside:
                        saw_speech = True
            # style == 'none' -> stan bez zmian
        tagged.append((sent, saw_speech))

    return tagged


# ---------------------------------------------------------------------------
# WARSTWA 3 - scalanie zdan w chunki (w obrebie akapitu; gapy sa miedzy)
# ---------------------------------------------------------------------------

def _merge(tagged: list, max_chars: int) -> list:
    """Zdania -> chunki. R1: nie lam tury mowy (przy podziale preferuj granice
    poza mowa). R3: twardy limit dlugosci. Tura dluzsza niz limit -> wymuszony podzial."""
    chunks: list = []
    buf: list = []   # [(tekst, in_speech), ...]

    def joined(items):
        return " ".join(t for t, _ in items)

    def flush(items):
        if items:
            chunks.append(Segment("chunk", text=joined(items),
                                   in_speech=any(s for _, s in items)))

    for sent, spk in tagged:
        if buf and len(joined(buf)) + 1 + len(sent) > max_chars:
            # trzeba lamac: ostatnia granica gdzie NASTEPNE zdanie NIE jest w mowie
            cut = None
            for i in range(1, len(buf)):
                if not buf[i][1]:
                    cut = i
            if cut is not None:            # R1: lam poza mowa
                flush(buf[:cut])
                buf = buf[cut:]
            else:                          # brak bezpiecznej granicy -> wymuszony podzial
                flush(buf)
                buf = []
        buf.append((sent, spk))

    flush(buf)
    return chunks


# ---------------------------------------------------------------------------
# Porzadki: laczenie sasiadujacych gapow, obcinanie gapow na krancach
# ---------------------------------------------------------------------------

def _collapse_gaps(segs: list) -> list:
    """Sasiadujace gapy -> jeden (wiekszy). Obcina gapy z poczatku i konca."""
    out: list = []
    for seg in segs:
        if seg.kind == "gap" and out and out[-1].kind == "gap":
            if seg.duration_ms > out[-1].duration_ms:
                out[-1] = seg           # zachowaj dluzszy (scene > paragraph)
        else:
            out.append(seg)
    while out and out[0].kind == "gap":
        out.pop(0)
    while out and out[-1].kind == "gap":
        out.pop()
    return out


# ---------------------------------------------------------------------------
# API publiczne
# ---------------------------------------------------------------------------

class Tokenizer:
    def tokenize_structured(self, text: str, intervals: dict | None = None) -> list[dict]:
        """Tekst -> lista Segmentow (chunki + gapy) jako dict-y gotowe na most JS.

        chunk: {kind:'chunk', text, in_speech}
        gap:   {kind:'gap', duration_ms, gap_type}
        """
        iv = {**DEFAULT_INTERVALS, **(intervals or {})}
        segs: list = []

        for item in _structure(text, iv):
            if isinstance(item, Segment):          # gap z warstwy 1
                segs.append(item)
            else:                                  # ('prose', tekst_akapitu)
                tagged = _split_and_tag(item[1])
                segs.extend(_merge(tagged, iv["max_chunk_chars"]))

        segs = _collapse_gaps(segs)
        return [asdict(s) for s in segs]

    def tokenize(self, text: str, intervals: dict | None = None) -> list[str]:
        """Wsteczna zgodnosc: tylko teksty chunkow (gapy pominiete)."""
        return [s["text"] for s in self.tokenize_structured(text, intervals)
                if s["kind"] == "chunk"]
