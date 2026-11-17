"""
normalizer.py - regexowe podmiany tekstu PRZED synteza (skroty, jednostki).
Port z PiperTTSv2, rozszerzony o pole "enabled" per regula.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path


@dataclass
class NormRule:
    pattern: str
    replacement: str
    flags: int = 0      # re.IGNORECASE = 2, re.MULTILINE = 8, itd.
    enabled: bool = True

    def apply(self, text: str) -> str:
        return re.sub(self.pattern, self.replacement, text, flags=self.flags)


def load_rules(path: str | Path) -> list[NormRule]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return [NormRule(**entry) for entry in data]


def save_rules(path: str | Path, rules: list[NormRule]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump([asdict(r) for r in rules], f, indent=2, ensure_ascii=False)


def invalid_rules(rules: list[NormRule]) -> list[str]:
    """Opisy WLACZONYCH regul z niepoprawnym wzorcem albo zamiennikiem.
    Wylaczone pomijamy (np. szkic '???'), bo wlaczenie i tak przechodzi przez zapis.
    sub() na pustym tekscie kompiluje szablon zamiennika od razu (zle \\1 = blad)."""
    bad = []
    for rule in rules:
        if not rule.enabled:
            continue
        try:
            re.compile(rule.pattern, rule.flags).sub(rule.replacement, "")
        except (re.error, TypeError) as e:
            bad.append(f"{rule.pattern!r}: {e}")
    return bad


def normalize_text(text: str, rules: list[NormRule]) -> str:
    """Stosuje WLACZONE reguly kolejno na tekscie. Kolejnosc ma znaczenie.
    Regula z bledem (np. reczna edycja rules.json) jest pomijana, nie wywala generacji."""
    for rule in rules:
        if rule.enabled:
            try:
                text = rule.apply(text)
            except re.error as e:
                print(f"[normalizer] pomijam regule {rule.pattern!r}: {e}", file=sys.stderr)
    return text
