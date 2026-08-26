// Zarzadza DOM-em panelu "03 - Queue". Kazda karta ma jeden z 4 stanow:
// pending    - jeszcze nie wygenerowana (nieklikalna)
// generated  - audio gotowe, czeka w kolejce na odtworzenie
// active     - wlasnie czytane (podswietlone slowo jest w tym zdaniu)
// played     - juz przeczytane
// Wszystkie oprocz pending sa klikalne -> onSentenceClick(index) (skok/seek).

const STATE_CLASS = {
    pending: 'sentence--pending',
    generated: 'sentence--generated',
    active: 'sentence--active',
    played: 'sentence--played',
};

export class SentenceQueue {
    constructor(containerElement) {
        this.containerElement = containerElement;
        this.cards = []; // { article, textEl, state } per indeks zdania
        this.onSentenceClick = null; // callback(index), ustawiane z App.js
        this.isHovering = false;

        // Autoscroll pauzuje sie calkowicie kiedy mysz jest nad kolejka -
        // przegladanie/klikanie starszych zdan nie moze byc przerywane skokiem widoku.
        containerElement.addEventListener('mouseenter', () => { this.isHovering = true; });
        containerElement.addEventListener('mouseleave', () => { this.isHovering = false; });
    }

    render(sentences) {
        this.containerElement.innerHTML = '';
        this.cards = sentences.map((sentence, i) => {
            const article = document.createElement('article');
            article.addEventListener('click', () => {
                const card = this.cards[i];
                if (card.state !== 'pending') {
                    this.onSentenceClick?.(i);
                }
            });

            const indexEl = document.createElement('span');
            indexEl.className = 'sentence__index';
            indexEl.textContent = String(i + 1).padStart(2, '0');

            const textEl = document.createElement('p');
            textEl.className = 'sentence__text';
            textEl.textContent = sentence; // zwykly tekst, zanim WordHighlighter podmieni go na spany przy aktywacji

            article.appendChild(indexEl);
            article.appendChild(textEl);
            this.containerElement.appendChild(article);

            const card = { article, textEl, state: null };
            this._setState(card, 'pending');
            return card;
        });
    }

    getTextElement(index) {
        return this.cards[index]?.textEl;
    }

    // Wolane gdy chunk audio dla danego zdania jest gotowy (generateAll).
    markGenerated(index) {
        const card = this.cards[index];
        if (card && card.state === 'pending') this._setState(card, 'generated');
    }

    // Wolane przy kazdej aktywacji zdania (sekwencyjnie po 'ended' albo po
    // kliknieciu/skoku). Kazda karta INNA niz nowy indeks dostaje jednoznaczny
    // stan na podstawie pozycji - niezaleznie co mial WCZESNIEJ (w tym stare
    // 'active' po skoku wstecz, ktore poprzednia wersja pomijala).
    markActive(index) {
        this.cards.forEach((card, i) => {
            if (i === index) {
                this._setState(card, 'active');
            } else if (card.state === 'pending') {
                // jeszcze nie wygenerowane - nie ma czego przestawiac
            } else if (i < index) {
                this._setState(card, 'played');
            } else {
                this._setState(card, 'generated');
            }
        });
        // Grube wycentrowanie na nowej karcie przy aktywacji; scrollWordIntoView
        // (z highlightera) doprecyzuje pozycje w miare czytania slow w chunku.
        this._centerElement(this.cards[index]?.article);
    }

    _setState(card, state) {
        card.state = state;
        card.article.className = `sentence ${STATE_CLASS[state]}`;
    }

    // Autoscroll podaza za AKTYWNYM SLOWEM (span), nie za cala karta - odkad
    // chunk moze miec kilka zdan, slowo wedruje daleko w pionie w obrebie jednej
    // (wysokiej) karty. Wolane z WordHighlighter.onWordChange przy zmianie slowa.
    scrollWordIntoView(span) {
        this._centerElement(span);
    }

    // Centruje element (karte albo span slowa) w viewporcie kolejki, ale TYLKO
    // gdy wyjedzie ze srodkowego pasa (60%) - nie pixel-po-pixelu, zeby nie
    // walczyc z plynnym scrollem. Wylaczone gdy mysz nad kolejka (przegladanie).
    _centerElement(el) {
        if (this.isHovering || !el) return;

        const container = this.containerElement;
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();

        // Element juz w wygodnym srodkowym pasie -> nie ruszaj widoku.
        const band = cRect.height * 0.2;
        if (eRect.top >= cRect.top + band && eRect.bottom <= cRect.bottom - band) return;

        // Pozycja elementu w tresci = offset od gory kontenera + biezacy scroll.
        const elTopInContent = (eRect.top - cRect.top) + container.scrollTop;
        const target = elTopInContent - (container.clientHeight / 2) + (eRect.height / 2);
        const maxScroll = container.scrollHeight - container.clientHeight;
        const clamped = Math.max(0, Math.min(target, maxScroll));

        container.scrollTo({ top: clamped, behavior: 'smooth' });
    }
}
