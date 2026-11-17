// Testy playera (faza 3 audytu): prawdziwe ui/App.js + AudioService/TtsQueue/SentenceQueue
// na atrapach DOM, <audio> i mostu pywebview - bez okna i bez Kokoro.
// Uruchomienie: node _test_player.mjs
const UI = new URL("./ui/", import.meta.url).href;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tick = () => sleep(5);
let FAILS = 0;
const check = (name, cond, info = "") => {
    console.log((cond ? "ok   " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(info)));
    if (!cond) FAILS++;
};

class El {
    constructor(tag = "div", id = "") {
        this.tag = tag; this.id = id; this.children = []; this.listeners = {};
        this.style = {}; this.textContent = ""; this._html = ""; this.className = "";
        this.disabled = false; this.value = ""; this.checked = false; this.title = "";
        const cls = new Set();
        this.classList = { toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)),
                           add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) };
    }
    set innerHTML(v) { this._html = v; if (v === "") this.children = []; }
    get innerHTML() { return this._html; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    fire(t, ev = {}) { for (const f of this.listeners[t] || []) f(ev); }
    click(detail = 1) { if (!this.disabled) this.fire("click", { detail }); }
    appendChild(c) { this.children.push(c); return c; }
    getBoundingClientRect() { return { top: 0, bottom: 10, height: 10 }; }
    scrollTo() {}
    get clientHeight() { return 100; } get scrollHeight() { return 100; } get scrollTop() { return 0; }
}

const AUDIO = [];
class FakeAudio extends El {
    constructor() { super("audio"); AUDIO.push(this);
        this.paused = true; this.currentTime = 0; this.duration = NaN; this._src = ""; this.onloadedmetadata = null; }
    set src(v) { this._src = v; } get src() { return this._src; }
    removeAttribute() { this._src = ""; }
    load() { this.duration = 2; this.currentTime = 0; setTimeout(() => this.onloadedmetadata?.(), 1); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
}

const els = {};
globalThis.document = { getElementById: (id) => (els[id] ||= new El("div", id)), createElement: (t) => new El(t) };
const winL = {};
globalThis.window = { addEventListener: (t, f) => (winL[t] ||= []).push(f) };
globalThis.Audio = FakeAudio;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// URL bloba -> indeks chunka (createObjectURL wolane w kolejnosci cacheBlob)
const urlIndex = new Map();
const realCreate = URL.createObjectURL;
let nextUrlIdx = null;
URL.createObjectURL = (b) => { const u = realCreate(b); urlIndex.set(u, nextUrlIdx); return u; };

const B64 = Buffer.from("ID3fake-mp3").toString("base64");
const api = {
    healthy: true, gens: [], segments: [], exports: 0, resets: [], tokenizes: 0,
    check_tts_service: async () => api.healthy,
    get_voices: async () => ["am_adam"],
    tokenize_text: async () => { api.tokenizes++; return api.segments; },
    reset_generation_cache: async (e) => { api.resets.push(e); return { ok: true }; },
    generate_sentence: (s, i, v, sp, epoch) => new Promise(res => api.gens.push({ i, epoch, res })),
    export_audio: async () => { api.exports++; return "/tmp/x.mp3"; },
};
window.pywebview = { api };

const okData = (i) => ({ index: i, audio: B64, timestamps: [{ word: "w" + i, start_time: 0, end_time: 1.5 }] });
async function resolveGen(i, data) {
    let g;
    for (let k = 0; k < 100 && !(g = api.gens.find(g => g.i === i && !g.done)); k++) await tick();
    if (!g) throw new Error("brak requestu dla chunka " + i);
    g.done = true; nextUrlIdx = i; g.res(data ?? okData(i)); await tick();
}
const book = (n, gap) => {
    const s = [];
    for (let i = 0; i < n; i++) { s.push({ kind: "chunk", text: "c" + i }); if (gap && i < n - 1) s.push({ kind: "gap", duration_ms: gap }); }
    return s;
};
const $ = (id) => els[id];
const playingAudio = () => AUDIO.filter(a => !a.paused);
const playingIdx = () => playingAudio().map(a => urlIndex.get(a.src));
const cards = () => $("sentence-queue").children;
const cardState = (i) => cards()[i].className.replace("sentence sentence--", "");
const btn = (id) => $(id).innerHTML;
const endActive = async () => { const a = playingAudio(); if (a.length !== 1) throw new Error("graja: " + a.length);
    a[0].paused = true; a[0].fire("ended"); await tick(); };

await import(UI + "App.js");
winL.pywebviewready.forEach(f => f());
await tick();

// ---------- A: autoplay, pauza w gapie (S2), brak zombie-timera (S1) ----------
$("autoplay-check").checked = true;
api.segments = book(4, 300);
$("generate-btn").click();
check("S3 Cancel widoczny synchronicznie", btn("generate-btn").includes("Cancel"));
await resolveGen(0);
check("A autoplay gra chunk 0", JSON.stringify(playingIdx()) === "[0]", playingIdx());
check("A przycisk Pause", btn("play-btn").includes("Pause"));
await endActive();
check("A GAP: nic nie gra, przycisk dalej Pause", playingAudio().length === 0 && btn("play-btn").includes("Pause"));
$("play-btn").click();                       // pauza W GAPIE
check("A pauza w gapie -> Play", btn("play-btn").includes("Play"));
await resolveGen(1); await resolveGen(2);
await sleep(400);
check("S1/S2 po 400 ms dalej cisza (timer skasowany, brak replay)", playingAudio().length === 0, playingIdx());
$("play-btn").click();
check("A Play po pauzie w gapie -> chunk 1", JSON.stringify(playingIdx()) === "[1]", playingIdx());

// ---------- B: klik karty w trakcie gapu (S1) ----------
await endActive();                           // koniec 1 -> GAP 300
cards()[0].fire("click");                    // skok wstecz w gapie
await sleep(400);
check("S1 klik karty w gapie: gra 0, timer nie przeskoczyl", JSON.stringify(playingIdx()) === "[0]", playingIdx());
check("B karta 0 active", cardState(0) === "active", cardState(0));

// ---------- C: WAITING na chunk 3, koniec ksiazki (S7) ----------
cards()[2].fire("click");
await endActive();                           // koniec 2 -> GAP
await sleep(350);                            // GAP minal, chunk 3 nie gotowy -> WAITING
check("C WAITING: cisza, przycisk Pause", playingAudio().length === 0 && btn("play-btn").includes("Pause"));
await resolveGen(3);
check("C chunk 3 startuje sam po wygenerowaniu", JSON.stringify(playingIdx()) === "[3]", playingIdx());
await tick();
check("C generacja skonczona -> Generate, export aktywny",
      btn("generate-btn").includes("Generate") && !$("export-btn").disabled);
await endActive();
check("S7 FINISHED: Play, cisza", btn("play-btn").includes("Play") && playingAudio().length === 0);
$("play-btn").click();
check("S7 Play po koncu -> od chunka 0", JSON.stringify(playingIdx()) === "[0]", playingIdx());

// ---------- D: dwuklik Generate, Cancel -> Generate (S3) ----------
const runsBefore = api.resets.length, tokBefore = api.tokenizes;
api.segments = book(3, 0);
$("generate-btn").click(1); $("generate-btn").click(2);
await sleep(30);
check("S3 dwuklik = jeden przebieg", api.tokenizes - tokBefore === 1 && api.resets.length - runsBefore === 1,
      [api.tokenizes - tokBefore, api.resets.length - runsBefore]);
check("D w trakcie generacji: Cancel", btn("generate-btn").includes("Cancel"));
const oldReq = api.gens.find(g => !g.done);
$("generate-btn").click();                    // Cancel
check("D po Cancel: Generate", btn("generate-btn").includes("Generate"));
$("generate-btn").click();                    // od razu nowy Generate
check("D nowy Generate od razu pokazuje Cancel", btn("generate-btn").includes("Cancel"));
oldReq.done = true; oldReq.res(okData(oldReq.i)); await sleep(20);
check("S3 stary przebieg nie resetuje przycisku", btn("generate-btn").includes("Cancel"));
await resolveGen(0); await resolveGen(1); await resolveGen(2);
await tick();
check("D nowy przebieg konczy sie normalnie", btn("generate-btn").includes("Generate"));
check("D epoka w generate = id przebiegu", api.gens.at(-1).epoch === api.resets.at(-1), [api.gens.at(-1).epoch, api.resets.at(-1)]);
check("D tylko jeden element gra", playingAudio().length <= 1, playingIdx());

// ---------- E: nieudany chunk (S4) ----------
api.segments = book(3, 0);
$("generate-btn").click();
await resolveGen(0);
await endActive();                           // czeka na 1 -> WAITING
await resolveGen(1, { index: 1, error: "HTTP 500" });
await resolveGen(1, { index: 1, error: "HTTP 500" });   // ponowka
check("S4 karta 1 failed", cardState(1) === "failed", cardState(1));
check("S4 dalej WAITING (na 2)", playingAudio().length === 0 && btn("play-btn").includes("Pause"));
await resolveGen(2);
check("S4 przeskok nad nieudanym -> gra 2", JSON.stringify(playingIdx()) === "[2]", playingIdx());
await tick();
check("S4 export aktywny mimo bledu", !$("export-btn").disabled);
$("export-btn").click(); await sleep(10);
check("S4 export wywolany, status o pominieciu", api.exports === 1 && $("status").textContent.includes("pominięto 1"),
      $("status").textContent);
cards()[1].fire("click");
check("S4 karta failed nieklikalna", JSON.stringify(playingIdx()) === "[2]", playingIdx());

// ---------- F: Kokoro wylaczone przy starcie (S5) ----------
api.healthy = false;
$("generate-btn").click(); await sleep(20);
check("S5 brak Kokoro: status + przycisk wraca", $("status").textContent.includes("not running") &&
      btn("generate-btn").includes("Generate"));
api.healthy = true;
api.segments = book(1, 0);
$("generate-btn").click(); await resolveGen(0);
check("S5 Kokoro wstalo: generacja dziala bez restartu", JSON.stringify(playingIdx()) === "[0]", playingIdx());

console.log(FAILS ? `\nBLEDY: ${FAILS}` : "\nWSZYSTKO OK");
process.exit(FAILS ? 1 : 0);
