// Kazde zdanie ma WLASNY, izolowany element <audio> (AudioService: dwa na
// przemian). Jeden zestaw spanow na raz, podmieniany przy aktywacji chunka.
//
// H1: karta pokazuje ORYGINALNY tekst chunka; tokeny Kokoro (znormalizowane:
// "Doctor" dla "Dr.", "one hundred dollars" dla "$100", "chi" z reguly dla "Qi")
// sa na niego NAKLADANE. Token nieznaleziony w tekscie czeka w `pending`, a
// fragment tekstu przed nastepnym znalezionym slowem dostaje jego czasy.
// Urwane timestampy nie kasuja juz reszty tekstu - zostaje jako zwykly tekst.

const HAS_ALNUM = /[\p{L}\p{N}]/u;
const MAX_SKIP = 40;   // token szukany najwyzej 40 znakow za kursorem

// do wyszukiwania: bez wielkosci liter, typograficzny apostrof = prosty.
// Dlugosc musi zostac ta sama (indeksy sluza do ciecia ORYGINALU).
function searchable(s) {
    const low = s.toLowerCase().replace(/[‘’]/g, "'");
    return low.length === s.length ? low : s;
}

export class WordHighlighter {
    constructor(audioElement) {
        this.audio = audioElement;
        this.spans = [];         // [{ el, start, end }] w kolejnosci tekstu
        this.current = -1;       // indeks podswietlonego spanu
        this.lastT = 0;
        this.rafId = null;
        this.onWordChange = null;   // callback(spanElement) - autoscroll za slowem
    }

    setAudioElement(audioElement) {
        this.audio = audioElement;
    }

    // Wolane raz na KAZDE aktywowane zdanie (podmiana calosci). text = oryginal
    // chunka; kontener czyszczony przed budowa (inaczej skok wstecz dublowalby tekst).
    setTimestamps(timestamps, containerElement, text = containerElement.textContent) {
        this._setActive(-1);     // zdejmij .active ze starego chunka
        this.spans = [];
        this.lastT = 0;
        containerElement.innerHTML = '';

        const emitText = (s) => {
            if (s) containerElement.appendChild(document.createTextNode(s));
        };
        const emitSpan = (s, start, end) => {
            const span = document.createElement('span');
            span.textContent = s;
            containerElement.appendChild(span);
            this.spans.push({ el: span, start, end });
        };
        // fragment z czasami pominietych tokenow; biale znaki na brzegach poza spanem
        const emitPending = (s, pending) => {
            const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
            emitText(m[1]);
            emitSpan(m[2], pending[0].start_time, pending[pending.length - 1].end_time);
            emitText(m[3]);
        };

        const hay = searchable(text);
        let cursor = 0;
        let pending = [];
        for (const tok of timestamps) {
            const word = String(tok.word ?? '');
            if (!HAS_ALNUM.test(word)) continue;            // interpunkcja jako token
            const idx = hay.indexOf(searchable(word), cursor);
            if (idx >= 0 && idx - cursor <= MAX_SKIP) {
                const gap = text.slice(cursor, idx);
                if (pending.length && gap.trim()) emitPending(gap, pending);
                else emitText(gap);
                emitSpan(text.slice(idx, idx + word.length), tok.start_time, tok.end_time);
                cursor = idx + word.length;
                pending = [];
            } else {
                pending.push(tok);
            }
        }
        const tail = text.slice(cursor);
        if (pending.length && tail.trim()) emitPending(tail, pending);
        else emitText(tail);
    }

    _setActive(i) {
        if (this.current >= 0) this.spans[this.current]?.el.classList.remove('active');
        this.current = i;
        if (i >= 0) {
            const el = this.spans[i].el;
            el.classList.add('active');
            this.onWordChange?.(el);
        }
    }

    // H2: ostatni span z start <= t - podswietlenie trzyma sie slowa w pauzach.
    // H3: szukanie od biezacego indeksu w przod; od zera tylko gdy t sie cofnal.
    _indexAt(t) {
        let i = t < this.lastT ? -1 : this.current;
        while (i + 1 < this.spans.length && this.spans[i + 1].start <= t) i++;
        return i;
    }

    // Wolane RAZ, na poczatku generacji. Petla RAF zyje przez cala sesje -
    // this.audio i this.spans sa podmieniane pod spodem (patrz App.js).
    start() {
        this.stop();
        const loop = () => {
            this.rafId = requestAnimationFrame(loop);
            const a = this.audio;
            if (!a || a.paused || this.spans.length === 0) return;   // H3: nic do roboty
            const t = a.currentTime;
            const i = this._indexAt(t);
            this.lastT = t;
            if (i !== this.current) this._setActive(i);              // H3: DOM tylko przy zmianie
        };
        this.rafId = requestAnimationFrame(loop);
    }

    stop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
}
