// Kazde zdanie ma teraz WLASNY, izolowany element <audio> (patrz
// AudioService: dwa na przemian). Zero offsetu/sentenceIndex - wracamy do
// prostej wersji: jeden zestaw timestampow na raz, podmieniany calkowicie
// przy kazdej aktywacji nowego zdania.
export class WordHighlighter {
    constructor(audioElement) {
        this.audio = audioElement;
        this.timestamps = [];
        this.currentIndex = 0;
        this.rafId = null;
        this.onWordChange = null;   // callback(spanElement) - autoscroll za slowem
        this._lastScrolled = -1;
    }

    setAudioElement(audioElement) {
        this.audio = audioElement;
    }

    // Wolane raz na KAZDE aktywowane zdanie (nie doklejanie - podmiana calosci).
    // Kontener musi byc wyczyszczony PRZED budowa spanow - inaczej przy
    // powtornej aktywacji tego samego zdania (np. po skoku wstecz) stare
    // slowa zostana, a nowe dolozylyby sie obok (zdublowany tekst).
    setTimestamps(timestamps, containerElement) {
        // Zdejmij .active z POPRZEDNIEGO zdania - inaczej zloty kolor zostaje
        // na starym slowie na zawsze, bo nikt juz go potem nie sprzata (nie
        // jest juz w this.timestamps po podmianie ponizej).
        this.timestamps.forEach(item => item.element?.classList.remove('active'));

        this.timestamps = timestamps.map(t => ({ ...t, element: null }));
        this.currentIndex = 0;
        this._lastScrolled = -1;

        containerElement.innerHTML = '';

        this.timestamps.forEach(item => {
            const span = document.createElement('span');
            span.textContent = item.word + ' ';
            containerElement.appendChild(span);
            item.element = span;
        });
    }

    applyHighlight(index) {
        this.timestamps.forEach((item, i) => {
            item.element.classList.toggle('active', i === index);
        });
    }

    // Wolane RAZ, na poczatku calej generacji. Petla RAF zyje przez cala
    // sesje - this.audio i this.timestamps sa podmieniane pod spodem przy
    // kazdym swapie (patrz App.js), petla po prostu czyta aktualny stan.
    start() {
        this.stop();

        const loop = () => {
            const t = this.audio.currentTime;
            const current = this.timestamps[this.currentIndex];

            if (!current || t < current.start_time || t > current.end_time) {
                this.currentIndex = this.timestamps.findIndex(
                    w => t >= w.start_time && t <= w.end_time
                );
            }

            // Autoscroll podaza za AKTYWNYM SLOWEM (nie za karta) - kluczowe
            // odkad chunk moze miec kilka zdan i slowo wedruje daleko w pionie.
            if (this.currentIndex >= 0 && this.currentIndex !== this._lastScrolled) {
                this.onWordChange?.(this.timestamps[this.currentIndex]?.element);
                this._lastScrolled = this.currentIndex;
            }

            this.applyHighlight(this.currentIndex);
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    stop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
        }
    }
}
