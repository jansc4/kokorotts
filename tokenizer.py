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
  2. segmentacja+DFA - fast_sentence_segment wyznacza GRANICE zdan (tekst
     zawsze z oryginalu); DFA cudzyslowow zapisuje per zdanie, czy jego
     poczatek lezy wewnatrz otwartej mowy (potrzebne scalaniu)
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
OPEN_Q, CLOSE_Q, STRAIGHT_Q = "“", "”", '"'
OPEN_SQ, CLOSE_SQ = "‘", "’"
_QUOTE_CHARS = set("\"'“”‘’")
_HAS_LETTER = re.compile(r"[^\W\d_]")            # przynajmniej jedna litera
_HAS_CONTENT = re.compile(r"[^\W_]")             # litera ALBO cyfra ("100." zostaje)

# normalizacja linii (sciezka textarea omija reader._clean): spacje/taby/nbsp -> 1 spacja,
# znaki zero-width out. Podwojna spacja psula granice fss ("The  End" -> "The." | "End.")
_WS = re.compile("[ \t\u00a0\u202f]+")
_ZERO_WIDTH = re.compile("[\u200b\u200c\u200d\ufeff]")

# emfaza markdown (*sigh*, _word_) rozbija fss ("*sigh" | "* Chapter"); kokoro i tak
# gwiazdek nie czyta -> odwijamy przed segmentacja
_EMPH_STAR = re.compile(r"\*+([^*\n]+)\*+")
_EMPH_UNDER = re.compile(r"(?<!\w)_([^_\n]+)_(?!\w)")

# separatory sceny zapisane litera: oOo / o0o / x x x
_SEP_WORD = re.compile(r"^(?:o[o0]o|x\s*x\s*x)$", re.IGNORECASE)


# Kokoro (/dev/captioned_speech) URYWA strumien timestampow na mysliku OTOCZONYM
# SPACJAMI: " - ", " -- ", " - ", " ‒ ", " ― ", " − ". Audio powstaje z calego
# chunka (slychac je), ale timestampy koncza sie w tym miejscu -> reszta chunka
# znika z kolejki i z highlightu. Em-dash jest bezpieczny (zweryfikowane
# empirycznie: em ze spacjami i bez, en bez spacji - wszystkie OK).
# Podmiana jest tez semantycznie poprawna: wtracenie w angielskiej prozie to em-dash.
# UWAGA: to niezmiennik pipeline'u (timestampy musza pokrywac caly chunk),
# dlatego siedzi tutaj, a nie w rules.json - nie ma byc wylaczalne z popupu.
# Stosowane do GOTOWEGO tekstu chunka (flush), bo laczenie zdan spacja potrafi
# odtworzyc " - " ("going to -" + "- Hello"). Ciag kilku myslnikow -> jeden em-dash.
_DASH = r"(?:-{1,3}|[‒–―−])"
_SPACED_DASH = re.compile(r"\s+" + _DASH + r"(?:\s+" + _DASH + r")*\s+")
_TRAILING_DASH = re.compile(r"\s+" + _DASH + r"\Z")


def _fix_spaced_dashes(s: str) -> str:
    return _TRAILING_DASH.sub("—", _SPACED_DASH.sub("—", s))


def _is_separator_line(line: str) -> bool:
    """Linia-separator sceny: krotka, bez liter i cyfr (***, * * *, ---, ###, • • •,
    ⁂, ◆, ..., ⸻, en-dash sam) albo oOo / x x x. Linia z samym cudzyslowem
    ("“…”" - milczaca odpowiedz w dialogu) NIE jest separatorem."""
    s = line.strip()
    if not s:
        return False
    if _SEP_WORD.match(s):
        return True
    return (len(s) <= 40 and not _HAS_CONTENT.search(s)
            and not (set(s) & _QUOTE_CHARS))


def _normalize_line(line: str) -> str:
    return _ZERO_WIDTH.sub("", _WS.sub(" ", line)).strip()


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
        stripped = _normalize_line(line)

        if not stripped or _is_separator_line(stripped):
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
    """'typographic' (“”), 'straight' ("), 'single' (‘’ bez podwojnych), 'none'."""
    if OPEN_Q in text or CLOSE_Q in text:
        return "typographic"
    if STRAIGHT_Q in text:
        return "straight"
    if OPEN_SQ in text:
        return "single"
    return "none"


def _sentences(block: str) -> list:
    """fss TYLKO do granic. fss modyfikuje tekst (dokleja kropki: 'acquired!].',
    'silence.', '‘How are you?’.'; potrafi tez kropke zjesc), wiec bierzemy
    z fss jedynie pozycje POCZATKU zdania w oryginale i tniemy oryginal miedzy nimi.
    Zaden znak nie jest dodany ani zgubiony."""
    starts = [0]
    cursor = 0
    for s in (s for para in fss.segment(block) for s in para):
        s = s.strip()
        # fss psuje tylko KONIEC zdania (dopisana/zjedzona kropka) -> sonda go pomija
        probe = s[:min(12, len(s) - 1)] if len(s) > 1 else s
        if not probe:
            continue
        pos = block.find(probe, cursor)
        if pos < 0:                      # fss zmienil poczatek -> brak granicy, zlej z poprzednim
            continue
        if pos > starts[-1]:
            starts.append(pos)
        # przeskocz cialo zdania (z zapasem na znaki dodane/usuniete przez fss),
        # zeby probe nastepnego zdania nie trafila wewnatrz biezacego
        cursor = pos + max(len(probe), len(s) - 3)
    ends = starts[1:] + [len(block)]
    return [p for p in (block[a:b].strip() for a, b in zip(starts, ends)) if p]


def _glue_lowercase(sents: list) -> list:
    """Atrybucja dialogu: fss tnie '“Is that so…?” he asked.' na dwa zdania.
    Zdanie, ktorego pierwsza litera jest mala, doklejamy do poprzedniego -
    inaczej scalanie chetnie tnie dokladnie w tym miejscu."""
    out: list = []
    for s in sents:
        m = _HAS_LETTER.search(s)
        if out and m and m.group().islower():
            out[-1] = out[-1] + " " + s
        else:
            out.append(s)
    return out


def _split_and_tag(block_text: str) -> list:
    """Akapit -> [(zdanie, starts_inside, in_speech), ...].

    starts_inside = stan DFA na pierwszym znaku zdania (wewnatrz otwartego
                    cudzyslowu?). Ciecie PRZED zdaniem jest bezpieczne iff False -
                    zdanie otwierajace nowa kwestie to dobra granica.
    in_speech     = zdanie dotyka mowy (tylko dla UI).
    DFA idzie po WSZYSTKICH zdaniach; filtr zdan bez tresci dopiero potem,
    zeby wyrzucony fragment z cudzyslowem nie przestawil parzystosci."""
    block = _EMPH_UNDER.sub(r"\1", _EMPH_STAR.sub(r"\1", block_text))
    sentences = _glue_lowercase(_sentences(block))

    style = _detect_quote_style(block)
    inside = False               # stan wejsciowy w akapit: poza mowa
    tagged: list = []

    for sent in sentences:
        starts_inside = inside
        saw_speech = inside
        for i, ch in enumerate(sent):
            if style == "typographic":
                if ch == OPEN_Q:
                    inside = saw_speech = True
                elif ch == CLOSE_Q:
                    inside = False
            elif style == "straight":
                # " tuz po cyfrze to cal (6" wide), nie cudzyslow
                if ch == STRAIGHT_Q and not (i and sent[i - 1].isdigit()):
                    inside = not inside
                    saw_speech = saw_speech or inside
            elif style == "single":
                # ’ przed litera to apostrof (didn’t), nie zamkniecie
                if ch == OPEN_SQ:
                    inside = saw_speech = True
                elif ch == CLOSE_SQ and not (i + 1 < len(sent) and sent[i + 1].isalpha()):
                    inside = False
            # style == 'none' -> stan bez zmian
        tagged.append((sent, starts_inside, saw_speech))

    # kokoro zwraca 500 na wejsciu bez liter i cyfr ("***", '"')
    return [t for t in tagged if _HAS_CONTENT.search(t[0])]


# ---------------------------------------------------------------------------
# WARSTWA 3 - scalanie zdan w chunki (w obrebie akapitu; gapy sa miedzy)
# ---------------------------------------------------------------------------

def _merge(tagged: list, max_chars: int) -> list:
    """Zdania -> chunki. R1: nie lam tury mowy (tnij tylko przed zdaniem, ktore
    nie zaczyna sie wewnatrz cudzyslowu). R3: limit dlugosci - po kazdym cieciu
    sprawdzany ponownie. Brak bezpiecznej granicy -> wymuszony podzial.
    Chunk przekracza limit tylko gdy jest pojedynczym zdaniem."""
    chunks: list = []
    buf: list = []   # [(tekst, starts_inside, in_speech), ...]

    def joined(items):
        return " ".join(t for t, _, _ in items)

    def flush(items):
        if items:
            chunks.append(Segment("chunk", text=_fix_spaced_dashes(joined(items)),
                                  in_speech=any(s for _, _, s in items)))

    for item in tagged:
        while buf and len(joined(buf)) + 1 + len(item[0]) > max_chars:
            if not item[1]:                # granica przed nowym zdaniem jest bezpieczna
                flush(buf)
                buf = []
                break
            # ostatnia bezpieczna granica wewnatrz bufora
            cut = next((i for i in range(len(buf) - 1, 0, -1) if not buf[i][1]), None)
            if cut is None:                # brak bezpiecznej granicy -> wymuszony podzial
                flush(buf)
                buf = []
                break
            flush(buf[:cut])               # R1: lam poza mowa, potem sprawdz limit znowu
            buf = buf[cut:]
        buf.append(item)

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
