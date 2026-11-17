// Sekwencyjna generacja chunkow. Kazdy chunk konczy sie DOKLADNIE jednym
// callbackiem: onReady(data, i) albo onFailed(i, error) - nigdy dziura bez
// informacji (S4). Generacja nie jest rownolegla celowo (Kokoro jest szybszy
// niz odtwarzanie, patrz audyt).
export class TtsQueue {
    constructor(sentences) {
        this.sentences = sentences;   // teksty chunkow z tokenize_text
        this.cancelled = false;
    }

    clear() {
        this.cancelled = true;
    }

    // params = { voice, speed, epoch } - te same dla calej generacji.
    // epoch idzie do Pythona: wynik anulowanej generacji wraca jako {stale}.
    async generateAll(api, { onReady, onFailed }, params = {}) {
        const { voice, speed, epoch } = params;

        for (let i = 0; i < this.sentences.length; i++) {
            if (this.cancelled) return;

            let data = null;
            for (let attempt = 0; attempt < 2; attempt++) {   // jedna ponowka
                data = await this._call(api, this.sentences[i], i, voice, speed, epoch);
                if (this.cancelled || data.stale) return;     // sprawdz tez PO awaicie
                if (!data.error) break;
                console.error(`Zdanie ${i} nie wygenerowane (proba ${attempt + 1}):`, data.error);
            }

            if (data.error) {
                onFailed?.(i, data.error);
                continue;
            }
            if (data.truncated) {
                console.warn(`Zdanie ${i}: timestampy urwane przez Kokoro (tekst w stderr Pythona)`);
            }
            onReady?.(data, i);
        }
    }

    // Most moze odrzucic Promise (wyjatek po stronie Pythona) - zamieniamy na {error}.
    async _call(api, sentence, i, voice, speed, epoch) {
        try {
            const data = await api.generate_sentence(sentence, i, voice, speed, epoch);
            return data && typeof data === 'object' ? data : { error: 'pusta odpowiedz' };
        } catch (e) {
            return { error: String(e) };
        }
    }
}
