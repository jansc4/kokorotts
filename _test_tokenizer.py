import random
import sys

from tokenizer import Tokenizer, _split_and_tag, _merge, _SPACED_DASH, _TRAILING_DASH

TK = Tokenizer()
ONE = {"max_chunk_chars": 1}   # kazda bezpieczna granica = ciecie -> chunki ~ zdania
FAILS = []


def chunks(text, iv=None):
    return TK.tokenize(text, iv)


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"\n     -> {info!r}"))
    if not cond:
        FAILS.append(name)


def no_bad_dash(cs):
    return not any(_SPACED_DASH.search(c) or _TRAILING_DASH.search(c) for c in cs)


# --- T1: spaced dash po scaleniu ---
c = [s.text for s in _merge([("I was going to –", False, False),
                             ("– Hello there.", False, False)], 350)]
check("T1 merge odtwarza ' – '", c == ["I was going to—Hello there."], c)
for src in ["I was going to – – Hello there.",
            "Wait - no -- yes ― maybe − fine ‒ ok.",
            "I was going to –"]:
    for iv in (None, ONE):
        c = chunks(src, iv)
        check(f"T1 brak spaced dash: {src[:25]!r} iv={iv}", no_bad_dash(c), c)

# --- T2: atrybucja dialogu ---
c = chunks("“Is that so…?” he asked. Then he left.", ONE)
check("T2 'he asked' przyklejone", c[0] == "“Is that so…?” he asked.", c)
c = chunks("Third one?” she asked, smiling.", ONE)
check("T2 'she asked, smiling' przyklejone", c == ["Third one?” she asked, smiling."], c)

# --- T3: limit po cieciu ---
t = [("a" * 10, False, True), ("b" * 10, False, False),
     ("c" * 300, True, True), ("d" * 100, True, True)]
c = [s.text for s in _merge(t, 350)]
check("T3 10,10,300,100 -> zaden >350", max(map(len, c)) <= 350, list(map(len, c)))
check("T3 tekst zachowany", " ".join(c) == " ".join(x[0] for x in t))
c = [s.text for s in _merge([("x" * 900, False, False)], 350)]
check("T3 pojedyncze 900 zostaje", c == ["x" * 900], list(map(len, c)))
rnd = random.Random(7)
ok = True
for _ in range(300):
    t = [("w" * rnd.randint(1, 400), rnd.random() < 0.4, rnd.random() < 0.5)
         for _ in range(rnd.randint(1, 12))]
    sents = {x[0] for x in t}
    for s in _merge(t, 350):
        if len(s.text) > 350 and s.text not in sents:
            ok = False
check("T3 niezmiennik: >limit tylko pojedyncze zdanie (losowe)", ok)

# --- T4: zdania z samych cyfr ---
src = 'He counted. "100." Then: 42! Done.'
check("T4 '100.' zachowane", chunks(src) == [src], chunks(src))
check("T4 '100.' jako osobne zdanie", '"100."' in chunks(src, ONE), chunks(src, ONE))

# --- T5: DFA ---
tg = _split_and_tag('The pipe was 6" wide. He nodded. "Fine." She left.')
check("T5 cal nie przestawia parzystosci", [x[2] for x in tg] == [False, False, True, False], tg)
check("T5 nowa kwestia = bezpieczna granica", [x[1] for x in tg] == [False] * 4, tg)
c = chunks("“A, yes.” “B, no.”", ONE)
check("T5 ciecie przed nowym cudzyslowem", len(c) == 2, c)
tg = _split_and_tag("‘Hello,’ she said. He didn’t move.")
check("T5 dialog w pojedynczych", [x[2] for x in tg] == [True, False], tg)

# --- T6: fss tylko do granic ---
for src in ["[Ding! You have acquired!] Then silence",
            "‘How are you?’ she said.",
            "BOOM! CRASH! The End"]:
    check(f"T6 bez dopisanych znakow: {src[:25]!r}", " ".join(chunks(src, ONE)) == src,
          chunks(src, ONE))

# --- T7: whitespace ---
c = chunks("Chapter 12: The  End of it.", ONE)
check("T7 podwojna spacja", c == ["Chapter 12: The End of it."], c)
c = chunks("Hel\u200blo\u00a0 world.\t Next.")
check("T7 zero-width / nbsp / tab", c == ["Hello world. Next."], c)

# --- T8: emfaza ---
c = chunks("BOOM! CRASH! *sigh* Chapter 12: The End.", ONE)
check("T8 *sigh* odwiniete", " ".join(c) == "BOOM! CRASH! sigh Chapter 12: The End.", c)
check("T8 _really_ / snake_case", chunks("I _really_ like my_var_name.") ==
      ["I really like my_var_name."], chunks("I _really_ like my_var_name."))

# --- T9: separatory sceny ---
for sep in ["###", "• • •", "⁂", "◆", "...", "⸻",
            "oOo", "o0o", "x x x", "***", "–", "---"]:
    s = TK.tokenize_structured(f"First.\n{sep}\nSecond.")
    got = [x["gap_type"] or x["kind"] for x in s]
    check(f"T9 separator {sep!r}", got == ["chunk", "scene", "chunk"], got)
s = TK.tokenize_structured("First.\n“…”\nSecond.")
check("T9 linia '“…”' to nie scena",
      [x["gap_type"] for x in s if x["kind"] == "gap"] == ["paragraph"], s)

# --- T10: tekst lamany twardo ---
src = "This is a long sentence that was\nhard wrapped by the source file\nat eighty columns."
c = chunks(src)
check("T10 zawijany -> jeden akapit", c == [src.replace("\n", " ")], c)
src = ("An exam-\nple of wrap-\nping text that\ngoes on and on.\n\n"
       "Second para that\nis also wrapped\nhere, yes.")
s = TK.tokenize_structured(src)
got = [x["text"] or x["gap_type"] for x in s]
check("T10 przeniesienia + bloki", got == ["An example of wrapping text that goes on and on.",
      "paragraph", "Second para that is also wrapped here, yes."], got)
s = TK.tokenize_structured("Chapter 3\n“Hi.”\n“Bye.”\nHe left.")
check("T10 zwykly tekst bez zmian", sum(x["kind"] == "chunk" for x in s) == 4, s)

print(f"\n{'WSZYSTKO OK' if not FAILS else f'BLEDY: {len(FAILS)}'}\n")

EX = """That Thalion had no patron caused quite different reactions. Cassandra burst out laughing. Most of the gods simply shrugged it off\u2014they didn't really care. But Solan\u2026 Solan was one step away from exploding.
The fact that a human had come this far on his own was more than impressive. Nyssa had a skill that allowed her to determine whether someone was telling the truth, and it confirmed that Thalion wasn't lying. Otherwise, Solan would never have believed him.
Cassandra, meanwhile, was visibly excited.
\u201CPlease, can you ask him what other forms he has\u2014and what rarity they are? A wyvern of that strength at E-grade is already impressive.\u201D
\u201CImpossible. Tell that whelp to shift into that form. I won't believe he has an Eclipsari form unless I see it with my own eyes.\u201D
Nyssa's voice sounded more like a hiss than speech.



\"My sister appears to be consuming its soul and flesh alike with her flesh sculpting, and is likely to emerge from its corpse in a new form soon. She might be able to harness some of its abilities in some way,\" Yuki noted, carefully keeping the heavens-shaking fury from her voice, lest she terrify her companion more than he already was. \"The Greater Nameless could emit unnatural shadows that smother all the senses, and its webbing could do the same. Has Kiku displayed any capabilities that were new to you?\"



When I open my eyes, I feel the subtle shift in my strength and perception.
This pill has done exactly what it said it would, break barriers. Now, I'm slightly stronger, but I'm right back to where I've started\u2026
\u2013
An entire week goes by."""

segs = Tokenizer().tokenize_structured(EX)
for i, s in enumerate(segs):
    if s["kind"] == "gap":
        print(f"[{i:02d}] GAP {s['duration_ms']}ms ({s['gap_type']})")
    else:
        L = len(s["text"])
        flag = " SPEECH" if s["in_speech"] else ""
        warn = "  >LIMIT" if L > 350 else ""
        print(f"[{i:02d}] CHUNK len={L}{flag}{warn}")
        print(f"     {s['text']}")
print(f"\nRAZEM: {len(segs)} segmentow, {sum(1 for s in segs if s['kind']=='chunk')} chunkow, {sum(1 for s in segs if s['kind']=='gap')} gapow")
