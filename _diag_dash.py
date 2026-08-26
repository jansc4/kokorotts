# -*- coding: utf-8 -*-
import requests

PROBES = {
    "en-dash ze spacjami  A \u2013 B": "The room was large \u2013 damnable enchantments \u2013 filled with devices.",
    "em-dash ze spacjami  A \u2014 B": "The room was large \u2014 damnable enchantments \u2014 filled with devices.",
    "em-dash bez spacji   A\u2014B":   "The room was large\u2014damnable enchantments\u2014filled with devices.",
    "en-dash bez spacji   A\u2013B":   "The room was large\u2013damnable enchantments\u2013filled with devices.",
    "przecinki (kontrola)":            "The room was large, damnable enchantments, filled with devices.",
    "polpauza jako minus  A - B":      "The room was large - damnable enchantments - filled with devices.",
}

for label, text in PROBES.items():
    try:
        r = requests.post("http://localhost:8880/dev/captioned_speech",
                          json={"input": text, "stream": False, "speed": 1.0, "voice": "am_adam"},
                          timeout=60)
        ts = r.json().get("timestamps") or []
        got = " ".join(t["word"] for t in ts)
        ok = "filled" in got and "devices" in got
        print(f"{'OK  ' if ok else 'URWANE'}  {label}")
        print(f"          -> {got}")
    except Exception as e:
        print(f"BLAD  {label}: {e}")
    print()
