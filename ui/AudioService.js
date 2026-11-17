// Dwa elementy <audio> na przemian: jeden gra (active), drugi w tle laduje
// nastepne zdanie (standby). Kazdy Blob raz utworzony zyje w blobCache przez
// cala sesje - klik w DOWOLNA juz wygenerowana karte (rowniez cofniecie)
// odtwarza ja bez ponownego zapytania do API. Base64 dekodowany RAZ (cacheBlob);
// App.js nie trzyma potem audio (M2).
//
// Indeksy: AudioService wie tylko, CO jest w standby (standbyIndex) - ktore
// zdanie jest aktywne, wie wylacznie player w App.js.
export class AudioService {
    constructor() {
        this.audioA = new Audio();
        this.audioB = new Audio();
        this.active = this.audioA;
        this.standby = this.audioB;

        this.blobCache = new Map(); // index -> object URL
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

    has(index) {
        return this.blobCache.has(index);
    }

    // Wrzuca zdanie do cache NATYCHMIAST po wygenerowaniu.
    cacheBlob(index, base64Audio) {
        if (this.blobCache.has(index)) return;
        const blob = new Blob([this._decode(base64Audio)], { type: 'audio/mpeg' });
        this.blobCache.set(index, URL.createObjectURL(blob));
    }

    // Podlaczka nastepnego zdania do STANDBY (gapless swap na 'ended').
    preload(index) {
        if (this.standbyIndex === index || !this.blobCache.has(index)) return;
        this.standby.onloadedmetadata = null;
        this.standby.src = this.blobCache.get(index);
        this.standby.load();
        this.standbyIndex = index;
    }

    // Startuje zdanie od startTime. Jesli czeka w standby (i od zera) -> swap,
    // inaczej laduje je wprost do active. Wychodzacy element ZAWSZE pauzowany,
    // zeby nigdy nie graly dwa strumienie naraz (S2).
    start(index, startTime = 0) {
        if (this.standbyIndex === index && startTime <= 0) {
            this.active.pause();
            [this.active, this.standby] = [this.standby, this.active];
            this.standbyIndex = null;
            this.active.onloadedmetadata = null;
            this.active.currentTime = 0;
            this._play(this.active);
            return;
        }

        const el = this.active;
        el.pause();
        el.src = this.blobCache.get(index);
        el.load();
        if (this.standbyIndex === index) {     // standby trzyma to samo - i tak nieaktualne
            this.standby.removeAttribute('src');
            this.standbyIndex = null;
        }
        if (startTime > 0) {
            // currentTime ustawiony przed metadanymi bywa ignorowany. Wlasciwosc
            // (nie addEventListener) - kolejny skok nadpisuje stary handler (S6).
            el.onloadedmetadata = () => {
                el.onloadedmetadata = null;
                el.currentTime = Math.min(startTime, Math.max(0, el.duration - 0.05)); // S9
                this._play(el);
            };
        } else {
            el.onloadedmetadata = null;
            this._play(el);
        }
    }

    resume() {
        this._play(this.active);
    }

    pause() {
        this.active.pause();
    }

    // play() zwraca Promise; przerwany load daje AbortError - to nie blad (S8).
    _play(el) {
        el.play()?.catch((e) => {
            if (e.name !== 'AbortError') console.error('audio.play():', e);
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
        for (const el of [this.audioA, this.audioB]) {
            el.pause();
            el.onloadedmetadata = null;
            el.removeAttribute('src');
        }
        this.blobCache.forEach(url => URL.revokeObjectURL(url));
        this.blobCache.clear();

        this.active = this.audioA;
        this.standby = this.audioB;
        this.standbyIndex = null;
    }
}
