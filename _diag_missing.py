# -*- coding: utf-8 -*-
import json, requests
from tokenizer import Tokenizer

TEXT = ("Heimler unlocked the door with an absent wave of his hand, the door disassembling "
        "into glimmering light. They stepped in to reveal a massive room, far larger on the "
        "inside than the outside \u2013 damnable space expansion enchantments, they always messed "
        "Levi\u2019s internal compass up \u2013 filled with magical devices scattered all throughout.\n"
        "Not just magical devices. There was a bed in the corner, expertly made with not a "
        "single visible crease in the sheets, a kitchenette, and an entire wall of meal "
        "rations, stacked from floor to ceiling.")

print("=" * 70)
print("KROK 1: co zwraca TOKENIZER")
print("=" * 70)
segs = Tokenizer().tokenize_structured(TEXT, json.load(open("intervals.json")))
for i, s in enumerate(segs):
    if s["kind"] == "gap":
        print(f"[{i}] GAP {s['duration_ms']}ms")
    else:
        print(f"[{i}] CHUNK len={len(s['text'])}")
        print(f"    {s['text']}")
        print(f"    zawiera 'damnable': {'damnable' in s['text']}")
        print(f"    zawiera 'throughout': {'throughout' in s['text']}")

print()
print("=" * 70)
print("KROK 2: co zwraca KOKORO w timestampach")
print("=" * 70)
chunk = next(s["text"] for s in segs if s["kind"] == "chunk")
r = requests.post("http://localhost:8880/dev/captioned_speech",
                  json={"input": chunk, "stream": False, "speed": 1.0, "voice": "am_adam"},
                  timeout=60)
data = r.json()
ts = data.get("timestamps") or []
returned = " ".join(t["word"] for t in ts)
print(f"WYSLANE  ({len(chunk)} zn.): {chunk}")
print()
print(f"WROCILO  ({len(ts)} tokenow): {returned}")
print()
for probe in ["damnable", "enchantments", "compass", "throughout"]:
    print(f"  '{probe}' -> w wyslanym: {probe in chunk} | w timestampach: {probe in returned}")
if ts:
    print(f"  ostatni timestamp: end_time={ts[-1]['end_time']}s, slowo='{ts[-1]['word']}'")
