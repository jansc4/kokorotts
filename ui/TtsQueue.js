export class DataClass {
    constructor(sentences = []) {
        this.sentences = sentences;   // ["Zdanie 1.", "Zdanie 2.", ...] - gole stringi z tokenize_text
        this.chunks = [];             // wyniki generate_sentence, w kolejnosci przychodzenia
        this.generatedCount = 0;
    }
}

export class TtsQueue {
    constructor(sentences) {
        this.queue = new DataClass(sentences);
        this.cancelled = false;
    }

    get() {
        return this.queue;
    }

    clear() {
        this.cancelled = true;
        this.queue = new DataClass();
    }

    // Sekwencyjna petla generujaca. onChunkReady(data, index) wolany PO
    // KAZDYM zdaniu. Bez offsetow - kazde zdanie ma teraz wlasny, izolowany
    // element <audio> (patrz AudioService), wiec nie ma niczego do przesuwania.
    // params = { voice, speed } - te same dla calej generacji.
    async generateAll(api, onChunkReady, params = {}) {
        const { voice, speed } = params;

        for (let i = 0; i < this.queue.sentences.length; i++) {
            if (this.cancelled) return;

            const sentence = this.queue.sentences[i];
            const data = await api.generate_sentence(sentence, i, voice, speed);

            if (this.cancelled) return; // sprawdz tez PO awaicie

            if (data.error) {
                console.error(`Zdanie ${i} nie wygenerowane:`, data.error);
                continue;
            }

            this.queue.chunks[i] = data;
            this.queue.generatedCount++;

            onChunkReady?.(data, i);
        }
    }
}
