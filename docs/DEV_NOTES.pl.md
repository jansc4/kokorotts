# KokoroTTS — pywebview Frontend

Lokalny czytnik tekstu oparty na kokoro-fastapi jako backendie TTS i pywebview jako frontendem.

## Stack

| Warstwa | Technologia |
|---|---|
| TTS backend | kokoro-fastapi (Docker, CPU image) |
| TTS model | Kokoro-82M (Apache 2.0, 82M parametrów) |
| Frontend | pywebview (WebKit 605.1.15 na Linux) |
| UI | HTML/CSS/JS (bez frameworka) |
| Python backend | pywebview Api klasa |

## TODO

### Bugi do naprawienia
- [ ] `main.py: generate_sentence()` — twarda obsługa błędu HTTP z Kokoro: sprawdzić `response.ok`/status przed `response.json()`, żeby błąd 500 (np. po tym jak coś prześlizgnie się przez filtr markerów scen) nigdy nie doleciał do JS jako `atob()` na nieprawidłowym/pustym stringu. Na razie tylko `tokenizer.py` filtruje "zdania" bez liter (`_HAS_LETTER`) — to pierwsza linia obrony, backend wciąż nie ma drugiej.
- [ ] `SentenceQueue._autoscrollTo()` — pozycja aktywnej karty liczona błędnie, zjeżdża o jedno zdanie i aktywna karta bywa niewidoczna. Podejrzenie: `article.offsetTop` liczony względem złego `offsetParent`, bo ani `.queue` ani `.panel` nie mają ustawionego `position` (prawdopodobnie offsetParent ląduje na `<body>`, nie na kontenerze scrolla). Naprawić przez `getBoundingClientRect()` (różnica względem kontenera + `scrollTop`) zamiast `offsetTop`.

### Do przemyślenia / poprawy (niesprecyzowane, wrócić po dalszych testach)
- [ ] Intervals popup — eventualne poprawki
- [ ] Progress bar — eventualne poprawki

### UI
- [ ] Przenieść przyciski "Open File" i "Clear" pod przycisk Export, w tej samej kolumnie/stylu co Export (obecnie są nad Play w panelu Controls)

### Obserwacje z sesji
`fast_sentence_segment` (zamiennik spaCy do segmentacji zdań) poprawnie rozwiązuje problem cudzysłowów w dialogach, którego spaCy nie ogarniał — ale markery przejścia sceny w beletrystyce (`*`, `***`) traktuje jako osobne "zdania", tak samo jak zrobiłby to spaCy. To nie jest regres jakości segmentera, tylko brak filtrowania treści bez realnej treści do przeczytania — naprawione filtrem `_HAS_LETTER` w `tokenizer.py`, ale warto mieć z tyłu głowy że to osobna kategoria problemu (filtrowanie treści), nie sama segmentacja granic zdań.


## Serwis TTS

Kokoro-fastapi działa jako osobny serwis na `localhost:8880`.

```bash
# uruchomienie (CPU)
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest

# uruchomienie (GPU - NVIDIA)
docker run --gpus all -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

Serwis wystawia dwa kluczowe endpointy:

`POST /v1/audio/speech` — OpenAI-compatible, HTTP chunked streaming MP3  
`POST /dev/captioned_speech` — zwraca audio (base64) + timestampy per słowo

## Architektura odtwarzania — Opcja C

Zamiast jednego dużego requestu do `/v1/audio/speech`, wysyłamy tekst **zdanie po zdaniu** do `/dev/captioned_speech`.

```
Tekst wejściowy
    ↓
Python (main.py) — tokenizacja na zdania (spaCy)
    ↓
JS wywołuje api.next_sentence() przez pywebview bridge
    ↓
Python POST /dev/captioned_speech { input: "zdanie", stream: false }
    ↓
Odpowiedź: { audio: "base64...", timestamps: [{word, start_time, end_time}] }
    ↓
JS dekoduje base64 → Blob → MSE SourceBuffer
    ↓
JS odtwarza + highlight aktualnego słowa przez audio.currentTime vs timestamps
```

### Opcja C — sekwencyjne requesty per zdanie

- pierwsze zdanie leci zanim reszta się wygeneruje (pseudo-streaming)
- pełne timestampy per słowo dla każdego zdania
- możliwość highlightu aktualnie czytanego słowa
- generacja idzie w tle dopóki nie zatrzymana
- pełna kontrola kolejki (pause, skip, back) po stronie klienta

Latencja zmierzona na CPU: ~3s generacji na ~5s audio — zanim skończy się zdanie 1, zdanie 2 jest gotowe.

## MSE (MediaSource Extensions)

Potwierdzone działanie w pywebview na Linux (WebKit 605.1.15):

```json
{
  "mediaSource": true,
  "mp3Support": true,
  "userAgent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15"
}
```

MP3 chunki z każdego zdania trafiają do `SourceBuffer` i są odtwarzane sekwencyjnie bez przerw.

### Seek i pasek postępu

`audio.duration` w MSE jest niedostępne podczas generowania (zwraca `Infinity`). Rozwiązanie:

- po każdym `appendBuffer` aktualizujemy `mediaSource.duration` ręcznie (sumując długości zdań)
- seek działa tylko do ostatniego ukończonego zdania
- pasek postępu: `audio.currentTime / mediaSource.duration`
- generacja kontynuuje w tle niezależnie od odtwarzania

```javascript
// po każdym chunku:
globalOffset += sentenceDuration
mediaSource.duration = globalOffset
```

### Mapa czasowa zdań

Każde zdanie ma przypisany offset w globalnej osi czasu:

```javascript
sentences = [
  { id: 0, text: "...", offset: 0,    duration: 4.2, timestamps: [...] },
  { id: 1, text: "...", offset: 4.2,  duration: 3.8, timestamps: [...] },
  { id: 2, text: "...", offset: 8.0,  duration: 5.1, timestamps: [...] },
]
```

Seek do zdania N: `audio.currentTime = sentences[N].offset`
Aktywne zdanie: znajdź N gdzie `offset[N] <= currentTime < offset[N+1]`
Aktywne słowo: `currentTime - offset[N]` vs `timestamps` danego zdania

## Timestampy — format odpowiedzi /dev/captioned_speech

```json
{
  "audio_format": "audio/mpeg",
  "audio": "SUQzBAA...(base64 MP3)",
  "timestamps": [
    {"word": "Hello", "start_time": 0.022, "end_time": 0.372},
    {"word": "world", "start_time": 0.372, "end_time": 0.847},
    {"word": ".",     "start_time": 0.847, "end_time": 0.947}
  ]
}
```

Czasy są względne do początku danego zdania. Żeby uzyskać czas globalny: `start_time + sentence.offset`.

## UI — decyzje projektowe

### Layout — trzy kolumny

```
┌─────────────────┬──────────┬──────────────────────┐
│                 │          │                      │
│   TEXT AREA     │  TOOLS   │  KOLEJKA / PLAYER    │
│   (textarea)    │          │                      │
│                 │          │                      │
├─────────────────┤          │                      │
│   PLAYER        │          │                      │
└─────────────────┴──────────┴──────────────────────┘
```

### Motyw

- ciemny, czarne tło
- zielony kolor tekstu / elementów
- złote akcenty (przyciski, aktywne elementy)
- inspiracja: FastKoko (czyste karty, dużo przestrzeni)

### Text area

- zwykły `<textarea>` — edytowalny
- brak highlightu zdań w text area (zachowanie edycji ważniejsze)
- użytkownik może poprawiać tekst przed odtwarzaniem

### Kolejka zdań — panel prawy

Przewijana lista zdań z aktywnym zdaniem zawsze na środku:

```
  [ zdanie #2 ]          ← poprzednie, przyciszone
  [ zdanie #3 ]          ← poprzednie, przyciszone
  [ ZDANIE #4 AKTYWNE ]  ← duże, highlight per słowo
  [ zdanie #5 ]          ← następne, przyciszone
  [ zdanie #6 ]          ← następne, przyciszone
```

- animacja przesuwania: `transition: transform 0.3s ease`
- aktywne zdanie: pełna jasność, większy font
- poprzednie/następne: `opacity: 0.4`
- podgląd pracy spaCy (widać jak dzieli tekst)

### Highlight słów

- kolor tekstu aktywnego słowa (nie tło)
- interpunkcja (`.`, `,`, `!`, `?`) filtrowana — nie highlightowana
- implementacja: każde słowo w `<span class="word" data-index="N">`

```css
.word.active {
    color: gold; /* złoty akcent */
}
```

### Player

- pasek postępu: `currentTime / mediaSource.duration` (aktualizowany dynamicznie)
- play / pause / stop
- seek wstecz: skok do początku poprzedniego zdania
- seek wprzód: skok do następnego ukończonego zdania
- volume, speed

## Struktura projektu

```
KokoroTTS/
├── main.py              # pywebview window + Api klasa + argparse
├── tokenizer.py         # spaCy tokenizacja na zdania
├── ui/
│   ├── index.html
│   ├── style.css
│   └── src/
│       ├── App.js
│       ├── services/
│       │   ├── AudioService.js    # MSE + SourceBuffer + mediaSource.duration
│       │   └── TtsQueue.js        # kolejka zdań, mapa czasowa, generacja w tle
│       ├── components/
│       │   ├── TextEditor.js      # textarea
│       │   ├── PlayerControls.js  # play/pause/stop/seek/progress
│       │   └── SentenceQueue.js   # przewijana kolejka z highlightem słów
│       └── state/
│           └── PlayerState.js     # currentTime, activeSentence, activeWord
├── pyproject.toml
└── README.md
```

## Podział odpowiedzialności

**Python (Api klasa):**
- `check_tts_service()` — sprawdzenie czy kokoro-fastapi żyje (`/health`)
- `tokenize(text)` — spaCy, zwraca listę zdań
- `get_sentence(text, voice)` — POST `/dev/captioned_speech`, zwraca `{audio, timestamps}`
- `get_voices()` — GET `/v1/audio/voices`
- odczyt plików (PDF, EPUB, DOCX, TXT) — reader.py

**JavaScript:**
- `TtsQueue` — kolejka zdań, generacja w tle, mapa czasowa
- `AudioService` — MSE SourceBuffer, `mediaSource.duration`, seek
- `SentenceQueue` — renderowanie kolejki, animacja, highlight słów
- `PlayerControls` — pasek postępu, przyciski, volume/speed
- `PlayerState` — stan globalny (currentSentence, currentWord, isPlaying)

## Głosy

Dostępne przez `GET /v1/audio/voices`. Przykładowe angielskie:

- `af_heart` — ciepły, naturalny (rekomendowany)
- `af_nova` — wyraźny
- `af_bella` — łagodny
- `am_adam`, `am_eric` — męskie

Mieszanie głosów: `af_heart(2)+af_bella(1)` — 67% heart, 33% bella.

## Specyfikacja funkcjonalna

### Text Area (lewa kolumna, góra)

- `<textarea>` — edytowalny, paste i ręczna edycja
- przycisk **Upload Text** — otwiera plik (TXT, PDF, EPUB, DOCX)
- przycisk **Clear Text** — czyści textarea jednym kliknięciem
- licznik znaków (np. `16759 characters`)
- dwa tryby renderowania tekstu (przełącznik):
  - **Strony** — paginacja (N chars/page), tylko aktywna strona w DOM, wydajne dla długich tekstów
  - **Ciągły scroll** — cały tekst w DOM, prostszy UX
- nawigacja stron: `← Previous` / `Page N of M` / `Next →`
- normalizacja czcionki (rozmiar/font — TODO: szczegóły)

### Tools (środkowa kolumna)

- **Wybór głosu** — lista z wyszukiwaniem, każdy głos ma przycisk próbki (odtwarza krótki sample)
- **Język** — dropdown, zmienia jednocześnie model i reguły tokenizacji
- **Speed** — slider, prędkość generacji (parametr do kokoro-fastapi, nie `playbackRate`)
- **Volume** — slider, głośność odtwarzania (`audio.volume`)
- **Autoplay** — checkbox; gdy zaznaczony: po kliknięciu Generuj od razu zaczyna odtwarzać
- **Przycisk Generuj** — duży, główny CTA; uruchamia generację całego tekstu zdanie po zdaniu
- **Przycisk Cancel** — przerywa generację w tle
- popup/overlay progress podczas długiej generacji
- **Reguły** — przycisk otwiera popup z dwiema zakładkami:
  - *Tokenizacja* — wyjątki dla spaCy (np. `Dr.` nie dziel), dodawanie przez zaznaczenie w tekście
  - *Wymowa* — reguły podstawień (np. `API` → `ejpiaaj`), dodawanie ręcznie
  - TODO: v2, ale architektura musi to przewidywać

### Kolejka / Player (prawa kolumna)

**Kolejka zdań:**
- przewijana lista, aktywne zdanie zawsze wycentrowane
- animacja przesuwania przy zmianie zdania (`transition: transform 0.3s ease`)
- aktywne zdanie: pełna jasność, highlight per słowo (kolor tekstu, złoty akcent)
- poprzednie/następne: `opacity: 0.4`, mniejszy font
- podczas pauzy: można scrollować kolejkę ręcznie
- po wznowieniu: odtwarza od zdania które jest wycentrowane w oknie
  - jeśli to zdanie jest wcześniej niż `currentTime` → seek wstecz w buforze
  - jeśli to zdanie jest później niż wygenerowane → flush bufora, restart generacji od tego zdania

**Pasek postępu:**
- `audio.currentTime / mediaSource.duration` (duration aktualizowane po każdym chunku)
- dwa wskaźniki: postęp odtwarzania + postęp generacji w skali dokumentu
- klikalny seek (tylko do wygenerowanych zdań)

**Przyciski playera:**
- **Play / Pause** — toggle
- **Stop** — zatrzymaj i wróć do początku
- **‹** — skok do początku aktualnego zdania (lub poprzedniego jeśli na początku)
- **›** — skok do następnego ukończonego zdania

**Tryby odtwarzania:**
- **Streaming RT** — generacja i odtwarzanie jednocześnie (opcja C, domyślna)
- **Generuj i pobierz** — generuje całość, potem oferuje pobranie pliku MP3; oba tryby dostępne naraz, pobieranie możliwe też po streamingu

## Postęp implementacji

- [x] środowisko (uv, pywebview + GTK)
- [x] main.py — argparse, Api klasa, okno pywebview
- [x] testowy pipeline: zdanie → `/dev/captioned_speech` → MSE → odtwarzanie
- [ ] tokenizer.py — spaCy
- [ ] TtsQueue.js — kolejka + mapa czasowa + generacja w tle
- [ ] AudioService.js — pełny (mediaSource.duration, seek)
- [ ] SentenceQueue.js — UI kolejki z animacją i highlightem
- [ ] PlayerControls.js — pasek postępu + przyciski
- [ ] index.html / style.css — layout trzy kolumny, motyw
- [ ] reader.py — odczyt plików
- [ ] eksport audio

## Następne kroki

1. tokenizer.py — spaCy, endpoint `tokenize(text)` w Api
2. TtsQueue.js — kolejka zdań, generacja w tle
3. AudioService.js — rozbudowa o `mediaSource.duration` i seek
4. UI — layout, motyw, SentenceQueue z animacją
5. PlayerControls — pasek postępu
6. reader.py

## Decyzje techniczne

**Normalizacja czcionki:**
`<textarea>` przyjmuje tylko plain text — problem z formatowaniem ze schowka znika sam.
Jeśli w przyszłości pojawi się `contenteditable`, trzeba obsłużyć paste event i stripować HTML.

**Speed:**
Parametr `speed` wysyłany do kokoro-fastapi w body requestu — nie `audio.playbackRate`.
Zmiana speed nie wpływa na zdania już w buforze, tylko na kolejne generowane.
Flush bufora przy zmianie speed — zbyt duży koszt za zbyt rzadki przypadek. Nie implementujemy.
Użytkownik słyszy zmianę po kilku sekundach — akceptowalne.

**Eksport MP3:**
JS skleja `ArrayBuffer`y z SourceBuffera w jeden Blob → `URL.createObjectURL` → `<a download>`.
Sprawdzić implementację w FastKoko jako punkt odniesienia.

**Próbka głosu:**
Stały tekst (hardcoded), nie fragment z textarea.

**Seek przy ręcznym scrollu kolejki (pauza → wznów):**
- zdanie wcześniej niż `currentTime` → seek wstecz w buforze MSE
- zdanie później niż wygenerowane → flush bufora + restart generacji od tego zdania
- flush bufora to rzadki przypadek ale musi być obsłużony

## Notatki

- kokoro-fastapi traktujemy jak LM Studio — osobny serwis, zawsze żyje w tle
- `/dev/captioned_speech` to endpoint deweloperski, może się zmienić między wersjami
- interpunkcja (`.`, `,`, `!`, `?`) pojawia się jako osobne tokeny w timestamps — filtruj
- `start_time` w timestamps jest względny do początku zdania — dodaj `sentence.offset`
- autoplay zablokowany przez przeglądarkę bez interakcji użytkownika — play tylko przez przycisk
- `mediaSource.duration` można ustawiać ręcznie — jedyny sposób na seek podczas generowania
