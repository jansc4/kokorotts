import json
from tokenizer import Tokenizer

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
