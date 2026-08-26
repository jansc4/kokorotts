"""
reader.py — ekstrakcja tekstu z formatów dokumentów.

Obsługiwane formaty:
  PDF   — pdfplumber
  DOCX  — python-docx
  ODT   — odfpy
  RTF   — striprtf
  EPUB  — ebooklib + beautifulsoup4
  MOBI  — mobi (opcjonalnie), fallback: instrukcja konwersji
  TXT   — wbudowany

Instalacja zależnosci:
  pip install pdfplumber python-docx odfpy striprtf ebooklib beautifulsoup4
  pip install mobi   # opcjonalnie dla .mobi
"""

from __future__ import annotations

import re
from pathlib import Path


# ====================================================================== #
#  Helpers                                                                #
# ====================================================================== #

def _clean(text: str) -> str:
    """Podstawowe sprzatanie: wiele bialych znakow, zachowanie akapitow."""
    # Normalizuj koniec linii
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Usun wielokrotne spacje w linii (nie dotykaj \n)
    lines = [re.sub(r" {2,}", " ", line).strip() for line in text.split("\n")]
    # Sciskaj wiecej niz 2 puste linie do jednej pustej
    result: list[str] = []
    blank_count = 0
    for line in lines:
        if line == "":
            blank_count += 1
            if blank_count <= 1:
                result.append("")
        else:
            blank_count = 0
            result.append(line)
    return "\n".join(result).strip()


# ====================================================================== #
#  Readery per format                                                     #
# ====================================================================== #

def _read_txt(path: Path) -> str:
    for enc in ("utf-8", "utf-8-sig", "cp1250", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def _read_pdf(path: Path) -> str:
    try:
        import pdfplumber
    except ImportError:
        raise ImportError("Zainstaluj pdfplumber:  pip install pdfplumber")

    parts: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=2, y_tolerance=3)
            if text:
                parts.append(text)
    return "\n\n".join(parts)


def _read_docx(path: Path) -> str:
    try:
        from docx import Document
    except ImportError:
        raise ImportError("Zainstaluj python-docx:  pip install python-docx")

    doc = Document(str(path))
    parts: list[str] = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def _read_odt(path: Path) -> str:
    try:
        from odf.opendocument import load as odf_load
        from odf.text import P
        from odf import teletype
    except ImportError:
        raise ImportError("Zainstaluj odfpy:  pip install odfpy")

    doc   = odf_load(str(path))
    parts: list[str] = []
    for elem in doc.text.getElementsByType(P):
        text = teletype.extractText(elem).strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def _read_rtf(path: Path) -> str:
    try:
        from striprtf.striprtf import rtf_to_text
    except ImportError:
        raise ImportError("Zainstaluj striprtf:  pip install striprtf")

    raw = _read_txt(path)
    return rtf_to_text(raw)


def _read_epub(path: Path) -> str:
    try:
        import ebooklib
        from ebooklib import epub
        from bs4 import BeautifulSoup
    except ImportError:
        raise ImportError(
            "Zainstaluj ebooklib i beautifulsoup4:\n"
            "  pip install ebooklib beautifulsoup4"
        )

    book = epub.read_epub(str(path), options={"ignore_ncx": True})

    # Buduj mapę id→item dla szybkiego lookup
    item_map = {item.id: item for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT)}

    # Spine = kolejność rozdziałów zdefiniowana w EPUB
    # book.spine to lista krotek (id, liniowy_bool)
    ordered_items = []
    for spine_id, _ in book.spine:
        item = item_map.get(spine_id)
        if item is not None:
            ordered_items.append(item)

    # Fallback jeśli spine pusty — stara metoda
    if not ordered_items:
        ordered_items = list(book.get_items_of_type(ebooklib.ITEM_DOCUMENT))

    parts: list[str] = []
    for item in ordered_items:
        soup = BeautifulSoup(item.get_content(), "html.parser")
        for tag in soup(["script", "style", "head"]):
            tag.decompose()
        for elem in soup.find_all(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li"]):
            text = elem.get_text(" ", strip=True)
            if text:
                parts.append(text)

    return "\n\n".join(parts)


def _read_mobi(path: Path) -> str:
    # Proba przez biblioteke mobi
    try:
        import mobi
    except ImportError:
        raise ImportError(
            "Format MOBI wymaga biblioteki mobi:\n"
            "  pip install mobi\n\n"
            "Alternatywnie skonwertuj plik do EPUB przez Calibre:\n"
            "  ebook-convert plik.mobi plik.epub"
        )
    try:
        tempdir, filepath = mobi.extract(str(path))
        # mobi.extract zwraca EPUB lub HTML — probujemy EPUB
        epub_path = Path(tempdir) / Path(filepath).stem
        for candidate in Path(tempdir).rglob("*.epub"):
            return _read_epub(candidate)
        # Fallback: HTML
        for candidate in Path(tempdir).rglob("*.html"):
            try:
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(candidate.read_bytes(), "html.parser")
                return soup.get_text("\n\n", strip=True)
            except Exception:
                pass
        raise RuntimeError("Nie udalo sie odczytac zawartosci MOBI.")
    except Exception as exc:
        raise RuntimeError(
            f"Blad odczytu MOBI: {exc}\n\n"
            "Skonwertuj plik do EPUB przez Calibre:\n"
            "  ebook-convert plik.mobi plik.epub"
        )


# ====================================================================== #
#  Dispatcher                                                             #
# ====================================================================== #

SUPPORTED_EXTENSIONS = {
    ".txt":  _read_txt,
    ".md":   _read_txt,
    ".pdf":  _read_pdf,
    ".docx": _read_docx,
    ".odt":  _read_odt,
    ".rtf":  _read_rtf,
    ".epub": _read_epub,
    ".mobi": _read_mobi,
    ".azw":  _read_mobi,
    ".azw3": _read_mobi,
}


def read_document(path: str | Path) -> str:
    """
    Ekstrahuje tekst z dokumentu.

    Args:
        path: Sciezka do pliku.

    Returns:
        Czysty tekst gotowy do wklejenia w pole tekstowe.

    Raises:
        ValueError: Nieobslugiwany format.
        ImportError: Brak wymaganej biblioteki (z instrukcja instalacji).
        RuntimeError: Blad odczytu.
    """
    path = Path(path)
    ext  = path.suffix.lower()
    reader = SUPPORTED_EXTENSIONS.get(ext)
    if reader is None:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS.keys()))
        raise ValueError(
            f"Nieobslugiwany format: '{ext}'\n"
            f"Obslugiwane formaty: {supported}"
        )
    raw = reader(path)
    return _clean(raw)


def file_filter() -> str:
    """Zwraca string filtrow do QFileDialog."""
    return (
        "Dokumenty (*.txt *.md *.pdf *.docx *.odt *.rtf *.epub *.mobi *.azw *.azw3);;"
        "PDF (*.pdf);;"
        "Word (*.docx);;"
        "OpenDocument (*.odt);;"
        "EPUB (*.epub);;"
        "MOBI / AZW (*.mobi *.azw *.azw3);;"
        "RTF (*.rtf);;"
        "Tekst (*.txt *.md);;"
        "Wszystkie pliki (*.*)"
    )


def missing_deps_for(path: str | Path) -> list[str]:
    """
    Sprawdza jakich pakietow brakuje dla danego formatu.
    Zwraca liste komend pip do instalacji.
    """
    ext = Path(path).suffix.lower()
    deps = {
        ".pdf":  ["pdfplumber"],
        ".docx": ["python-docx"],
        ".odt":  ["odfpy"],
        ".rtf":  ["striprtf"],
        ".epub": ["ebooklib", "beautifulsoup4"],
        ".mobi": ["mobi", "ebooklib", "beautifulsoup4"],
        ".azw":  ["mobi", "ebooklib", "beautifulsoup4"],
        ".azw3": ["mobi", "ebooklib", "beautifulsoup4"],
    }
    required = deps.get(ext, [])
    missing: list[str] = []
    for pkg in required:
        import importlib
        # Mapowanie nazwa-pip -> nazwa-import
        import_name = {
            "python-docx":   "docx",
            "beautifulsoup4": "bs4",
            "ebooklib":       "ebooklib",
            "pdfplumber":     "pdfplumber",
            "odfpy":          "odf",
            "striprtf":       "striprtf",
            "mobi":           "mobi",
        }.get(pkg, pkg)
        try:
            importlib.import_module(import_name)
        except ImportError:
            missing.append(pkg)
    return missing
