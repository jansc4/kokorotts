import { AudioService } from './AudioService.js';
import { WordHighlighter } from './WordHighlighter.js';
import { TtsQueue } from './TtsQueue.js';
import { SentenceQueue } from './SentenceQueue.js';
import { showRulesPopup } from './RulesPopup.js';
import { showIntervalsPopup } from './IntervalsPopup.js';
import { showFindReplacePopup } from './FindReplacePopup.js';


window.addEventListener("pywebviewready", () => {
    console.log("PyWebView is ready!");

    const audioService = new AudioService();
    const highlighter = new WordHighlighter(audioService.element);
    const sentenceQueue = new SentenceQueue(document.getElementById('sentence-queue'));

    // Autoscroll kolejki podaza za aktywnym slowem (highlighter dyktuje, kolejka
    // przewija) - dziala tez wewnatrz wysokich, wielozdaniowych chunkow.
    highlighter.onWordChange = (span) => sentenceQueue.scrollWordIntoView(span);

    const generateBtn = document.getElementById('generate-btn');
    const playBtn = document.getElementById('play-btn');
    const autoplayCheck = document.getElementById('autoplay-check');
    const voiceSelect = document.getElementById('voice-select');
    const speedRange = document.getElementById('speed-range');
    const speedValue = document.getElementById('speed-value');
    const progressRange = document.getElementById('progress-range');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');
    const exportBtn = document.getElementById('export-btn');
    const openFileBtn = document.getElementById('open-file-btn');
    const openFileName = document.getElementById('open-file-name');
    const textInput = document.getElementById('text-input');
    const clearBtn = document.getElementById('clear-btn');
    const findReplaceBtn = document.getElementById('find-replace-btn');
    const rulesBtn = document.getElementById('rules-btn');
    const intervalsBtn = document.getElementById('intervals-btn');
    const genProgress = document.getElementById('gen-progress');
    const genProgressFill = document.getElementById('gen-progress-fill');
    const genProgressLabel = document.getElementById('gen-progress-label');

    // Pasek postepu GENERACJI (ile zdan juz przyszlo z Kokoro) - niezalezny
    // od paska odtwarzania (ktory sledzi czas odsluchu calej ksiazki).
    function updateGenProgress(done, total) {
        genProgress.classList.toggle('gen-progress--hidden', total === 0);
        genProgress.classList.toggle('gen-progress--done', total > 0 && done >= total);
        genProgressFill.style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
        genProgressLabel.textContent = `${done} / ${total}`;
    }

    // Segmenty z tokenize_text (chunki + gapy) -> rownolegle tablice: teksty
    // chunkow i pauza (ms) NASTEPUJACA po kazdym chunku (z gapa za nim).
    // Gapy sa juz wypieczone po stronie Pythona (duration_ms), wiec JS tylko
    // je odczytuje - zadnego wykrywania interpunkcji ani zywej kopii interwalow.
    function foldGaps(segments) {
        const texts = [];
        const gapAfter = [];
        for (const seg of segments) {
            if (seg.kind === 'chunk') {
                texts.push(seg.text);
                gapAfter.push(0);
            } else if (seg.kind === 'gap' && gapAfter.length > 0) {
                gapAfter[gapAfter.length - 1] = seg.duration_ms || 0;
            }
        }
        return { texts, gapAfter };
    }

    clearBtn.addEventListener('click', () => {
        textInput.value = '';
        openFileName.textContent = '';
    });

    findReplaceBtn.addEventListener('click', () => {
        showFindReplacePopup(textInput);
    });

    rulesBtn.addEventListener('click', () => {
        showRulesPopup(window.pywebview.api);
    });

    intervalsBtn.addEventListener('click', () => {
        // Gapy sa wypiekane przez tokenizer po stronie Pythona -> zmiana
        // interwalow zadziala po ponownym Generate, nie na zywo.
        showIntervalsPopup(window.pywebview.api);
    });

    openFileBtn.addEventListener('click', async () => {
        openFileBtn.disabled = true;
        const originalLabel = openFileBtn.innerHTML;
        openFileBtn.textContent = 'Wczytywanie…';

        try {
            const result = await window.pywebview.api.open_file();
            if (!result) return; // uzytkownik anulowal dialog
            if (result.error) {
                openFileName.textContent = result.error;
                return;
            }
            textInput.value = result.text;
            openFileName.textContent = result.filename;
        } finally {
            openFileBtn.disabled = false;
            openFileBtn.innerHTML = originalLabel;
        }
    });

    speedRange.addEventListener('input', () => {
        speedValue.textContent = `${parseFloat(speedRange.value).toFixed(1)}×`;
    });

    let ttsQueue = null;
    let isGenerating = false;  // czy generacja TRWA (a nie tylko: czy istnieje kolejka)

    // Pelny, trwaly cache kazdego wygenerowanego zdania (audio+timestamps) -
    // potrzebny zeby klikniecie w DOWOLNA juz wygenerowana karte (rowniez
    // cofniecie) moglo je odtworzyc bez ponownego zapytania do API.
    let sentenceData = [];
    let allSentences = [];     // teksty chunkow (z foldGaps) - rownolegle do sentenceData
    let sentenceGaps = [];     // pauza (ms) po kazdym chunku (z gapa za nim); rownolegla do sentenceData
    let activeIndex = -1;      // ktore zdanie aktualnie gra (-1 = jeszcze nic)
    let standbyIndex = null;   // ktore zdanie jest zaladowane w standby (albo null)
    let awaitingPlayback = false; // true = jak tylko cos wpadnie do standby, aktywuj od razu

    // Pasek postepu calej ksiazki. sentenceDurations to ZYWA ESTYMACJA z
    // end_time transkryptu (aktualizowana w miare generowania) - po
    // zakonczeniu generacji korygowana na PRAWDZIWY, zmierzony czas trwania
    // (finalDuration) przez AudioService.measureDuration na sklejonym blobie.
    let sentenceDurations = [];
    let finalDuration = null;
    let totalDurationEstimate = 0;
    let combinedBlobForExport = null;
    let isSeekingProgress = false;
    let progressInterval = null;

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) seconds = 0;
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function currentPositionSeconds() {
        let position = 0;
        for (let i = 0; i < activeIndex; i++) {
            position += (sentenceDurations[i] || 0) + (sentenceGaps[i] || 0) / 1000;
        }
        if (activeIndex >= 0) {
            // Zegar audio biegnie tez przez cisze PO ostatnim slowie chunka;
            // przycinamy do dlugosci "slownej" (end_time), zeby pozycja nie
            // przekroczyla totalu (ktory tez jest liczony z end_time + gapy).
            const activeDur = sentenceDurations[activeIndex] || 0;
            position += activeDur
                ? Math.min(audioService.element.currentTime, activeDur)
                : audioService.element.currentTime;
        }
        return position;
    }

    function refreshProgressUI() {
        // Total i pozycja licza sie z TEGO SAMEGO zrodla: suma end_time slow
        // + gapy (totalDurationEstimate). Pomiar sklejonego MP3 (finalDuration)
        // bywa krotszy niz suma czesci -> powodowal overshoot suwaka. Nie uzywany.
        const total = totalDurationEstimate;
        progressRange.max = total > 0 ? total : 1;
        timeTotal.textContent = formatTime(total);

        if (!isSeekingProgress) {
            const position = currentPositionSeconds();
            progressRange.value = position;
            timeCurrent.textContent = formatTime(position);
        }
    }

    progressRange.addEventListener('input', () => {
        isSeekingProgress = true;
        timeCurrent.textContent = formatTime(parseFloat(progressRange.value));
    });

    progressRange.addEventListener('change', () => {
        seekToSeconds(parseFloat(progressRange.value));
        isSeekingProgress = false;
    });

    // Zamienia "sekunda w calej ksiazce" na "ktore zdanie + offset w nim".
    function seekToSeconds(targetSeconds) {
        let remaining = targetSeconds;
        for (let i = 0; i < sentenceDurations.length; i++) {
            const dur = (sentenceDurations[i] || 0) + (sentenceGaps[i] || 0) / 1000;
            if (remaining <= dur || i === sentenceDurations.length - 1) {
                jumpToSentence(i, Math.max(0, remaining));
                return;
            }
            remaining -= dur;
        }
    }

    // <a download> na blob URL nie dziala w QtWebEngine bez recznego podpiecia
    // downloadRequested po stronie hosta - wiec zamiast tego Python otwiera
    // PRAWDZIWY, natywny dialog zapisu.
    //
    // Audio KAZDEGO zdania Python juz ma w sentence_audio_cache (zcache'owane
    // w generate_sentence) - eksport tylko podaje LICZBE zdan, a sklejanie
    // dzieje sie po stronie Pythona. Wczesniej cala ksiazka (Blob sklejony w
    // JS) leciala jako jeden base64 string przez most JS<->Python
    // (QWebChannel) - dla duzych plikow ten most zawodzil i dawal plik 0B.
    exportBtn.addEventListener('click', async () => {
        if (!combinedBlobForExport) return;

        exportBtn.disabled = true;
        const originalLabel = exportBtn.innerHTML;
        exportBtn.textContent = 'Zapisywanie…';

        try {
            const result = await window.pywebview.api.export_audio(allSentences.length, sentenceGaps);
            if (result && result.error) {
                console.error('Eksport nie powiódł się:', result.error);
            }
        } finally {
            exportBtn.disabled = false;
            exportBtn.innerHTML = originalLabel;
        }
    });

    function setGenerateButtonState(generating) {
        generateBtn.classList.toggle('btn--cancel', generating);
        generateBtn.classList.toggle('btn--primary', !generating);
        generateBtn.innerHTML = generating
            ? 'Cancel <span class="btn__arrow">✕</span>'
            : 'Generate <span class="btn__arrow">▸</span>';
    }

    function setPlayButtonState(playing) {
        playBtn.innerHTML = playing
            ? '<span class="btn__icon">❚❚</span> Pause'
            : '<span class="btn__icon">▸</span> Play';
    }

    // Sprawdza czy standby jest puste i czy kolejne zdanie (activeIndex + 1)
    // jest juz wygenerowane - jesli tak, laduje je. Wolane po kazdym nowym
    // chunku ORAZ po kazdej aktywacji (bo wtedy zwalnia sie standby).
    function tryFillStandby() {
        if (standbyIndex !== null) return;
        const nextIndex = activeIndex + 1;
        const data = sentenceData[nextIndex];
        if (!data) return;

        audioService.loadStandby(nextIndex, data.audio);
        standbyIndex = nextIndex;

        if (awaitingPlayback) {
            activateStandby();
        }
    }

    function activateStandby() {
        if (standbyIndex === null) {
            awaitingPlayback = true; // nic gotowego - czekaj na najblizszy przychodzacy chunk
            setPlayButtonState(false); // audio realnie stoi w miejscu - przycisk ma to odzwierciedlac
            return;
        }
        awaitingPlayback = false;

        const index = standbyIndex;
        standbyIndex = null;
        activeIndex = index;

        audioService.swap();
        highlighter.setAudioElement(audioService.element);
        highlighter.setTimestamps(sentenceData[index].timestamps, sentenceQueue.getTextElement(index));
        sentenceQueue.markActive(index);
        setPlayButtonState(true);

        tryFillStandby();
    }

    // Klik w karte zdania (dowolne juz wygenerowane, w tym cofniecie), albo
    // seek z paska postepu (wtedy startTime = sekunda WEWNATRZ tego zdania).
    function jumpToSentence(index, startTime = 0) {
        const data = sentenceData[index];
        if (!data) return;

        audioService.jumpTo(index, data.audio, startTime);
        activeIndex = index;
        standbyIndex = null;
        awaitingPlayback = false;

        highlighter.setAudioElement(audioService.element);
        highlighter.setTimestamps(data.timestamps, sentenceQueue.getTextElement(index));
        sentenceQueue.markActive(index);
        setPlayButtonState(true);

        tryFillStandby(); // sprobuj od razu podladowac kolejne po skoku
    }

    // Pauza PO zdaniu ktore wlasnie sie skonczylo, wg jego znaku konczacego -
    // dotyczy TYLKO naturalnego przejscia (ended), nie skoku/klikniecia karty.
    audioService.onEnded = () => {
        // Pauza = gap NASTEPUJACY po chunku ktory wlasnie sie skonczyl.
        // Dotyczy tylko naturalnego przejscia (ended), nie skoku/klikniecia karty.
        const delay = sentenceGaps[activeIndex] || 0;
        if (delay > 0) {
            setTimeout(() => activateStandby(), delay);
        } else {
            activateStandby();
        }
    };
    sentenceQueue.onSentenceClick = (index) => jumpToSentence(index);

    playBtn.addEventListener('click', () => {
        if (audioService.element.paused) {
            if (audioService.element.src) {
                audioService.play();
                setPlayButtonState(true);
            } else {
                // nic jeszcze nie gralo - to pierwszy klik Play przy wylaczonym autoplay
                activateStandby();
            }
        } else {
            audioService.pause();
            setPlayButtonState(false);
        }
    });

    window.pywebview.api.check_tts_service().then((result) => {
        if (!result) {
            console.log("TTS service is not running.");
            document.getElementById("status").textContent = "TTS service is not running.";
            return;
        }

        console.log("TTS service is running.");
        document.getElementById("status").textContent = "TTS service is running.";

        window.pywebview.api.get_voices().then((voices) => {
            if (!voices || voices.length === 0) {
                voiceSelect.innerHTML = '<option>brak głosów</option>';
                return;
            }
            voiceSelect.innerHTML = voices.map(v => `<option value="${v}">${v}</option>`).join('');
            voiceSelect.disabled = false;
            if (voices.includes('am_adam')) {
                voiceSelect.value = 'am_adam';
            }
        });

        generateBtn.addEventListener('click', async () => {
            if (isGenerating) {
                // Klik W TRAKCIE generacji = Cancel. Po zakonczeniu generacji
                // isGenerating jest false, wiec kolejny klik startuje nowa
                // generacje (a nie "anuluje" skonczona kolejke - stary bug).
                ttsQueue?.clear();
                isGenerating = false;
                setGenerateButtonState(false);
                return;
            }

            const text = document.getElementById('text-input').value;
            const segments = await window.pywebview.api.tokenize_text(text);
            const { texts: sentences, gapAfter } = foldGaps(segments);
            sentenceGaps = gapAfter;

            audioService.reset();
            window.pywebview.api.reset_generation_cache(); // czysci sentence_audio_cache w Pythonie (patrz export_audio)
            highlighter.setAudioElement(audioService.element);
            highlighter.start(); // petla RAF zyje przez cala sesje, patrz WordHighlighter
            sentenceQueue.render(sentences);
            setPlayButtonState(false);

            sentenceData = [];
            allSentences = sentences;
            activeIndex = -1;
            standbyIndex = null;
            awaitingPlayback = autoplayCheck.checked; // aktywuj natychmiast po pierwszym chunku

            sentenceDurations = [];
            finalDuration = null;
            totalDurationEstimate = 0;
            combinedBlobForExport = null;
            exportBtn.disabled = true;
            refreshProgressUI();
            updateGenProgress(0, sentences.length);

            if (progressInterval) clearInterval(progressInterval);
            progressInterval = setInterval(refreshProgressUI, 200);

            ttsQueue = new TtsQueue(sentences);
            isGenerating = true;
            setGenerateButtonState(true);

            await ttsQueue.generateAll(window.pywebview.api, (data, index) => {
                sentenceData[index] = data;
                audioService.cacheBlob(index, data.audio);

                const lastWord = data.timestamps[data.timestamps.length - 1];
                sentenceDurations[index] = lastWord ? lastWord.end_time : 0;
                totalDurationEstimate = sentenceDurations.reduce((sum, d) => sum + (d || 0), 0)
                    + sentenceGaps.reduce((sum, g) => sum + (g || 0) / 1000, 0);

                sentenceQueue.markGenerated(index);
                tryFillStandby();
                refreshProgressUI();
                updateGenProgress(sentenceData.filter(Boolean).length, sentences.length);
            }, {
                voice: voiceSelect.value,
                speed: parseFloat(speedRange.value),
            });

            isGenerating = false;
            setGenerateButtonState(false);

            // Generacja skonczona (nie anulowana) - sklej wszystko RAZ, zmierz
            // prawdziwy czas trwania i odblokuj eksport.
            if (!ttsQueue.cancelled) {
                const combined = audioService.getCombinedBlob(sentences.length);
                if (combined) {
                    combinedBlobForExport = combined;
                    finalDuration = await audioService.measureDuration(combined);
                    exportBtn.disabled = false;
                    refreshProgressUI();
                }
            }
        });
    });
});
