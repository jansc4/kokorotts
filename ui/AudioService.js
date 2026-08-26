// Dwa elementy <audio> na przemian: jeden gra (active), drugi w tle laduje
// nastepne zdanie (standby). Kazdy Blob raz utworzony zyje w blobCache przez
// cala sesje (nie tylko active+standby) - potrzebne zeby: (a) klikniecie w
// DOWOLNA juz wygenerowana karte (rowniez cofniecie) moglo odtworzyc ja bez
// ponownego zapytania do API, (b) sklejenie calosci do eksportu/dokladnego
// duration (patrz getCombinedBlob) bez ponownego dekodowania base64.
export class AudioService {
    constructor() {
        this.audioA = new Audio();
        this.audioB = new Audio();
        this.active = this.audioA;
        this.standby = this.audioB;

        this.blobCache = new Map(); // index -> { blob, url }
        this.activeIndex = null;
        this.standbyIndex = null;

        this.onEnded = null; // callback(), ustawiany z zewnatrz (App.js)

        this.audioA.addEventListener('ended', () => this._handleEnded(this.audioA));
        this.audioB.addEventListener('ended', () => this._handleEnded(this.audioB));
    }

    _handleEnded(source) {
        if (source === this.active) {
            this.onEnded?.();
        }
    }

    get element() {
        return this.active;
    }

    _entryFor(index, base64Audio) {
        if (this.blobCache.has(index)) {
            return this.blobCache.get(index);
        }
        const bytes = this._decode(base64Audio);
        const blob = new Blob([bytes], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const entry = { blob, url };
        this.blobCache.set(index, entry);
        return entry;
    }

    // Wrzuca zdanie do cache NATYCHMIAST po wygenerowaniu, niezaleznie od
    // tego czy kiedykolwiek trafi do standby/active. Bez tego getCombinedBlob
    // nie mialby czego skleic dla zdan, ktorych uzytkownik nie przesluchal
    // sekwencyjnie (bo loadStandby/jumpTo cache'uja tylko "na zadanie").
    cacheBlob(index, base64Audio) {
        this._entryFor(index, base64Audio);
    }

    // Laduje zdanie do STANDBY - kolejne w naturalnej sekwencji, gotowe na 'ended'.
    loadStandby(index, base64Audio) {
        this.standby.src = this._entryFor(index, base64Audio).url;
        this.standby.load();
        this.standbyIndex = index;
    }

    // Zamienia active <-> standby i odtwarza nowy active od zera (gapless,
    // bo standby jest juz zaladowany).
    swap() {
        [this.active, this.standby] = [this.standby, this.active];
        this.activeIndex = this.standbyIndex;
        this.standbyIndex = null;

        this.active.currentTime = 0;
        this.active.play();
    }

    // Skok do DOWOLNEGO juz wygenerowanego zdania - przerywa biezaca sekwencje.
    // startTime > 0 to seek WEWNATRZ tego zdania (uzywane przez pasek postepu
    // calej ksiazki) - ustawiany dopiero po 'loadedmetadata', bo przegladarka
    // moze zignorowac currentTime ustawiony zanim metadane sa gotowe.
    jumpTo(index, base64Audio, startTime = 0) {
        this.active.pause();
        this.active.src = this._entryFor(index, base64Audio).url;
        this.active.load();

        if (startTime > 0) {
            this.active.addEventListener('loadedmetadata', () => {
                this.active.currentTime = startTime;
                this.active.play();
            }, { once: true });
        } else {
            this.active.currentTime = 0;
            this.active.play();
        }

        this.activeIndex = index;
        this.standby.pause();
        this.standby.removeAttribute('src');
        this.standbyIndex = null;
    }

    play() {
        this.active.play();
    }

    pause() {
        this.active.pause();
    }

    // Skleja Bloby zdan 0..count-1 w jeden Blob (bez MediaSource - zwykla
    // konkatenacja binarna, wystarczajaca do eksportu/pomiaru duration).
    // Zwraca null jesli ktoregos jeszcze nie ma w cache (niepelna generacja).
    getCombinedBlob(count) {
        const parts = [];
        for (let i = 0; i < count; i++) {
            const entry = this.blobCache.get(i);
            if (!entry) return null;
            parts.push(entry.blob);
        }
        return new Blob(parts, { type: 'audio/mpeg' });
    }

    // Mierzy PRAWDZIWY czas trwania blobu przez ukryty, niepodlaczony <audio>.
    // Dokladniejsze niz suma end_time z transkryptow (te sa tylko przyblizeniem).
    measureDuration(blob) {
        return new Promise((resolve) => {
            const probe = new Audio();
            const url = URL.createObjectURL(blob);

            const cleanup = (result) => {
                URL.revokeObjectURL(url);
                resolve(result);
            };

            probe.addEventListener('loadedmetadata', () => cleanup(probe.duration), { once: true });
            probe.addEventListener('error', () => cleanup(null), { once: true });
            probe.src = url;
        });
    }

    _decode(base64) {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }

    // Zatrzymuje oba elementy i zwalnia CALY cache blobow - wolane na nowa generacje.
    reset() {
        this.audioA.pause();
        this.audioB.pause();
        this.audioA.removeAttribute('src');
        this.audioB.removeAttribute('src');

        this.blobCache.forEach(entry => URL.revokeObjectURL(entry.url));
        this.blobCache.clear();

        this.active = this.audioA;
        this.standby = this.audioB;
        this.activeIndex = null;
        this.standbyIndex = null;
    }
}
