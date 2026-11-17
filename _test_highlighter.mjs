// Testy WordHighlighter (faza 4 audytu): wyrownanie tokenow Kokoro na oryginalny tekst
// i wybor podswietlanego slowa. Uruchomienie: node _test_highlighter.mjs
let FAILS = 0;
const check = (n, c, info = "") => { console.log((c ? "ok   " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(info))); if (!c) FAILS++; };

class Node_ { constructor(t) { this.textContent = t; } }
class El {
    constructor() { this.children = []; this._t = ""; const s = new Set();
        this.classList = { add: c => s.add(c), remove: c => s.delete(c), has: c => s.has(c) }; }
    appendChild(c) { this.children.push(c); return c; }
    set innerHTML(v) { this.children = []; }
    set textContent(v) { this._t = v; } get textContent() { return this.children.length ? this.children.map(c => c.textContent).join("") : this._t; }
}
globalThis.document = { createElement: () => new El(), createTextNode: (t) => new Node_(t) };
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
const { WordHighlighter } = await import(new URL("./ui/WordHighlighter.js", import.meta.url).href);

const ts = (words) => words.map((w, i) => ({ word: w, start_time: i, end_time: i + 0.8 }));
const spansOf = (h) => h.spans.map(s => s.el.textContent);

// 1. przyklad z audytu (prawdziwe tokeny Kokoro)
let text = 'Dr. Smith paid $100, didn\'t he? "Yes," she said.';
let h = new WordHighlighter(null); let box = new El();
h.setTimestamps(ts(["Doctor", "Smith", "paid", "one", "hundred", "dollars", ",", "didn't", "he", "?", '"', "Yes", ",", '"', "she", "said", "."]), box, text);
check("H1 tekst karty = oryginal", box.textContent === text, box.textContent);
check("H1 spany", JSON.stringify(spansOf(h)) === JSON.stringify(["Dr.", "Smith", "paid", "$100,", "didn't", "he", "Yes", "she", "said"]), spansOf(h));
const s100 = h.spans[3];
check("H1 '$100,' ma czasy one..dollars", s100.start === 3 && s100.end === 5.8, s100);

// 2. urwane timestampy - reszta tekstu zostaje
text = "[Ding! You have gained 1,000 XP] <Level 3> sigh Lv. 10 reached.";
h = new WordHighlighter(null); box = new El();
h.setTimestamps(ts(["Ding", "!", "You", "have", "gained", "one", "thousand", "XP", "Level", "three", "sigh", "Lv", ".", "ten"]), box, text);
check("H1 urwane: tekst kompletny", box.textContent === text, box.textContent);
check("H1 urwane: ogon z czasem oczekujacego 'ten'", spansOf(h).at(-1) === ". 10 reached." && h.spans.at(-1).start === 13, spansOf(h));

// 3. regula Qi -> chi, apostrof typograficzny, wielkosc liter
text = "Qi flowed. He didn’t stop. THE END";
h = new WordHighlighter(null); box = new El();
h.setTimestamps(ts(["chi", "flowed", ".", "He", "didn't", "stop", ".", "The", "End"]), box, text);
check("H1 Qi/apostrof/case: tekst", box.textContent === text, box.textContent);
check("H1 Qi/apostrof/case: spany", JSON.stringify(spansOf(h)) === JSON.stringify(["Qi", "flowed", "He", "didn’t", "stop", "THE", "END"]), spansOf(h));

// 4. H2/H3: indeks w pauzach i przy cofnieciu
h = new WordHighlighter(null); box = new El();
h.setTimestamps(ts(["a", "b", "c", "d"]), box, "a b c d");
const at = (t) => { const i = h._indexAt(t); h.lastT = t; if (i !== h.current) h._setActive(i); return i; };
check("H2 przed pierwszym slowem -1", at(-0.5) === -1);
check("H2 w pauzie miedzy slowami trzyma poprzednie", at(1.9) === 1);
check("H3 do przodu", at(3.5) === 3);
check("H3 cofniecie", at(0.2) === 0);
check("H3 jeden aktywny span", h.spans.filter(s => s.el.classList.has("active")).length === 1);
h.setTimestamps(ts(["x"]), new El(), "x");
check("H1 stary span traci .active po podmianie", !box.children.some(c => c.classList?.has("active")));

console.log(FAILS ? `\nBLEDY: ${FAILS}` : "\nWSZYSTKO OK");
process.exit(FAILS ? 1 : 0);
