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

    const api = window.pywebview.api;
    const statusEl = document.getElementById('status');

    function setStatus(text) {
        statusEl.textContent = text;
    }

    // --- dane biezacej ksiazki (rownolegle tablice po indeksie chunka) ---
    let allSentences = [];      // teksty chunkow (z foldGaps)
    let sentenceGaps = [];      // pauza (ms) PO kazdym chunku (z gapa za nim)
    let sentenceData = [];      // { timestamps } - audio zyje tylko w AudioService (M2)
    let sentenceDurations = []; // end_time ostatniego slowa = "slowna" dlugosc chunka
    let totalDuration = 0;      // gapy + suma durations, liczona przyrostowo (M3)
    let okCount = 0;
    let failedCount = 0;
    let ttsQueue = null;
    let genRun = 0;             // id przebiegu Generate; osierocony przebieg po await wychodzi (S3)
    let exporting = false;
    let isSeekingProgress = false;
    let progressInterval = null;

    // ------------------------------------------------------------------
    // PLAYER - jedyne zrodlo prawdy o odtwarzaniu. Kazda zmiana idzie przez
    // dispatch(); przycisk Play/Generate/Export renderowane ze stanu (render).
    //   IDLE     nic nie gralo (autoplay off)      PAUSED    zatrzymane przez usera
    //   PLAYING  gra element <audio>               GAP       pauza miedzy chunkami (timer)
    //   WAITING  chce nastepny chunk, jeszcze nie ma   FINISHED  koniec ksiazki
    // ------------------------------------------------------------------
    const player = {
        state: 'IDLE',
        active: -1,             // aktywny chunk - JEDYNE miejsce, gdzie ten indeks zyje
        pendingAdvance: false,  // pauza w GAP/WAITING: Play ma isc dalej, nie wznawiac starego
        gapTimer: null,
        epoch: 0,               // ++ na nowa ksiazke; timer z poprzedniej jest ignorowany
        status: [],             // per chunk: 'pending' | 'ok' | 'failed'
        gen: 'idle',            // generacja: 'idle' | 'tokenizing' | 'running'
    };

    const isRunningState = (s) => s === 'PLAYING' || s === 'GAP' || s === 'WAITING';

    function clearGap() {
        if (player.gapTimer !== null) clearTimeout(player.gapTimer);
        player.gapTimer = null;
    }

    // pierwszy chunk za aktywnym, ktory nie jest 'failed' (albo -1)
    function nextIndex() {
        for (let i = player.active + 1; i < player.status.length; i++) {
            if (player.status[i] !== 'failed') return i;
        }
        return -1;
    }

    function preloadNext() {
        const n = nextIndex();
        if (n !== -1 && player.status[n] === 'ok') audioService.preload(n);
    }

    function start(i, t = 0) {
        clearGap();
        player.pendingAdvance = false;
        player.active = i;
        player.state = 'PLAYING';
        audioService.start(i, t);
        highlighter.setAudioElement(audioService.element);
        highlighter.setTimestamps(sentenceData[i].timestamps, sentenceQueue.getTextElement(i), allSentences[i]);
        sentenceQueue.markActive(i);
        preloadNext();
    }

    // Nastepny chunk: gotowy -> PLAYING, jeszcze sie generuje -> WAITING,
    // nic juz nie przyjdzie (koniec, Cancel, same bledy) -> FINISHED (S7).
    function advance() {
        clearGap();
        player.pendingAdvance = false;
        const n = nextIndex();
        if (n !== -1 && player.status[n] === 'ok') start(n);
        else if (n !== -1 && player.gen !== 'idle') player.state = 'WAITING';
        else player.state = 'FINISHED';
    }

    function dispatch(ev) {
        const p = player;
        switch (ev.type) {
        case 'NEW_GENERATION': {                    // { count, autoplay }
            p.epoch++;
            clearGap();
            p.pendingAdvance = false;
            p.active = -1;
            p.status = new Array(ev.count).fill('pending');
            // autoplay = "czekam na pierwszy chunk"; advance() wystartuje go sam
            p.state = ev.autoplay ? 'WAITING' : 'IDLE';
            break;
        }
        case 'CHUNK_READY':                         // { index }
        case 'CHUNK_FAILED':                        // { index }
            p.status[ev.index] = ev.type === 'CHUNK_READY' ? 'ok' : 'failed';
            if (p.state === 'WAITING') advance();   // nieudany zostanie przeskoczony
            else if (p.state !== 'IDLE' && p.state !== 'FINISHED') preloadNext();
            break;
        case 'GENERATION_END':                      // koniec albo Cancel
            p.gen = 'idle';
            if (p.state === 'WAITING') advance();   // nic wiecej nie przyjdzie
            break;
        case 'PLAY':
            if (p.status.length === 0) break;
            if (p.state === 'PAUSED') {
                if (p.pendingAdvance) {
                    advance();
                } else {
                    audioService.resume();
                    p.state = 'PLAYING';
                }
            } else if (p.state === 'IDLE') {
                advance();
            } else if (p.state === 'FINISHED') {
                p.active = -1;                      // od poczatku
                advance();
            }
            break;
        case 'PAUSE':
            if (p.state === 'PLAYING') {
                audioService.pause();
            } else if (p.state === 'GAP' || p.state === 'WAITING') {
                clearGap();                         // element juz 'ended' - nie wolno go wznawiac (S2)
                p.pendingAdvance = true;
            } else {
                break;
            }
            p.state = 'PAUSED';
            break;
        case 'ENDED': {
            if (p.state !== 'PLAYING') break;
            const gap = sentenceGaps[p.active] || 0;
            if (gap > 0) {
                const epoch = p.epoch;
                p.state = 'GAP';
                p.gapTimer = setTimeout(() => dispatch({ type: 'GAP_ELAPSED', epoch }), gap);
            } else {
                advance();
            }
            break;
        }
        case 'GAP_ELAPSED':                         // { epoch }
            p.gapTimer = null;
            if (ev.epoch === p.epoch && p.state === 'GAP') advance();
            break;
        case 'JUMP':                                // { index, time } - klik karty albo seek
            if (p.status[ev.index] === 'ok') start(ev.index, ev.time || 0);  // czysci timer (S1)
            break;
        }
        render();
    }

    function render() {
        const playing = isRunningState(player.state);
        playBtn.innerHTML = playing
            ? '<span class="btn__icon">❚❚</span> Pause'
            : '<span class="btn__icon">▸</span> Play';

        const busy = player.gen !== 'idle';
        generateBtn.classList.toggle('btn--cancel', busy);
        generateBtn.classList.toggle('btn--primary', !busy);
        generateBtn.innerHTML = busy
            ? 'Cancel <span class="btn__arrow">✕</span>'
            : 'Generate <span class="btn__arrow">▸</span>';

        // eksport po zakonczeniu/anulowaniu generacji; Python pomija nieudane chunki
        exportBtn.disabled = exporting || busy || okCount === 0;

        // M5: pasek odtwarzania odswiezany tylko gdy cos gra
        if (playing && !progressInterval) {
            progressInterval = setInterval(refreshProgressUI, 200);
        } else if (!playing && progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        refreshProgressUI();
    }

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) seconds = 0;
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function currentPositionSeconds() {
        const a = player.active;
        let position = 0;
        for (let i = 0; i < a; i++) {
            position += (sentenceDurations[i] || 0) + (sentenceGaps[i] || 0) / 1000;
        }
        if (a >= 0) {
            // Zegar audio biegnie tez przez cisze PO ostatnim slowie chunka;
            // przycinamy do dlugosci "slownej" (end_time), zeby pozycja nie
            // przekroczyla totalu (ktory tez jest liczony z end_time + gapy).
            const activeDur = sentenceDurations[a] || 0;
            position += activeDur
                ? Math.min(audioService.element.currentTime, activeDur)
                : audioService.element.currentTime;
        }
        return position;
    }

    function refreshProgressUI() {
        // Total i pozycja z TEGO SAMEGO zrodla: suma end_time slow + gapy.
        progressRange.max = totalDuration > 0 ? totalDuration : 1;
        timeTotal.textContent = formatTime(totalDuration);

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

    // "sekunda w calej ksiazce" -> ktory chunk + offset w nim. Offset przyciety
    // do slownej dlugosci chunka - seek w gap nie wychodzi poza audio (S9).
    function seekToSeconds(targetSeconds) {
        let remaining = targetSeconds;
        const last = sentenceDurations.length - 1;
        for (let i = 0; i <= last; i++) {
            const words = sentenceDurations[i] || 0;
            const dur = words + (sentenceGaps[i] || 0) / 1000;
            if (player.status[i] === 'ok' && (remaining <= dur || i === last)) {
                dispatch({ type: 'JUMP', index: i, time: Math.min(Math.max(0, remaining), words) });
                return;
            }
            remaining -= dur;
        }
    }

    // <a download> na blob URL nie dziala w QtWebEngine - Python otwiera natywny
    // dialog i skleja audio z wlasnego cache (nic duzego nie idzie przez most).
    exportBtn.addEventListener('click', async () => {
        if (exportBtn.disabled) return;
        exporting = true;
        render();
        const originalLabel = exportBtn.innerHTML;
        exportBtn.textContent = 'Zapisywanie…';

        try {
            const result = await api.export_audio(allSentences.length, sentenceGaps);
            if (result && result.error) {
                console.error('Eksport nie powiódł się:', result.error);
                setStatus(`Eksport nie powiódł się: ${result.error}`);
            } else if (result) {
                const skipped = allSentences.length - okCount;
                setStatus(skipped ? `Zapisano (pominięto ${skipped} fragm.): ${result}` : `Zapisano: ${result}`);
            }
        } catch (e) {
            setStatus(`Eksport nie powiódł się: ${e}`);
        } finally {
            exporting = false;
            exportBtn.innerHTML = originalLabel;
            render();
        }
    });

    audioService.onEnded = () => dispatch({ type: 'ENDED' });
    sentenceQueue.onSentenceClick = (index) => dispatch({ type: 'JUMP', index });

    playBtn.addEventListener('click', () => {
        dispatch({ type: isRunningState(player.state) ? 'PAUSE' : 'PLAY' });
    });

    async function loadVoices() {
        const voices = await api.get_voices();
        if (!voices || voices.length === 0) {
            voiceSelect.innerHTML = '<option>brak głosów</option>';
            return;
        }
        voiceSelect.innerHTML = voices.map(v => `<option value="${v}">${v}</option>`).join('');
        voiceSelect.disabled = false;
        if (voices.includes('am_adam')) {
            voiceSelect.value = 'am_adam';
        }
    }

    // Health sprawdzany przy starcie ORAZ przy kazdym Generate - Kokoro moze
    // wstac pozniej niz aplikacja, bez restartu (S5).
    async function checkService() {
        let ok = false;
        try {
            ok = await api.check_tts_service();
        } catch (e) {
            ok = false;
        }
        setStatus(ok ? 'TTS service is running.' : 'TTS service is not running.');
        if (ok && voiceSelect.disabled) await loadVoices();
        return ok;
    }

    checkService();

    generateBtn.addEventListener('click', async (e) => {
        // 2. klik dwukliku (detail = 2) trafilby juz w "Cancel" - ignorujemy go,
        // dwuklik = jeden przebieg. Swiadomy Cancel to osobne klikniecie.
        if (e.detail > 1) return;
        if (player.gen !== 'idle') {
            // Cancel (w trakcie tokenizacji albo generacji). Juz wygenerowane
            // chunki dalej graja; osierocony przebieg wyjdzie po najblizszym await.
            genRun++;
            ttsQueue?.clear();
            dispatch({ type: 'GENERATION_END' });
            return;
        }

        const run = ++genRun;
        const stale = () => run !== genRun;
        player.gen = 'tokenizing';      // synchronicznie, przed pierwszym await (S3)
        render();

        try {
            if (!(await checkService())) {
                if (!stale()) dispatch({ type: 'GENERATION_END' });
                return;
            }
            if (stale()) return;

            const segments = await api.tokenize_text(textInput.value);
            if (stale()) return;
            const { texts: sentences, gapAfter } = foldGaps(segments);
            if (sentences.length === 0) {
                setStatus('Brak tekstu do przeczytania.');
                dispatch({ type: 'GENERATION_END' });
                return;
            }

            // --- nowa ksiazka ---
            allSentences = sentences;
            sentenceGaps = gapAfter;
            sentenceData = [];
            sentenceDurations = [];
            totalDuration = gapAfter.reduce((sum, g) => sum + (g || 0) / 1000, 0);
            okCount = 0;
            failedCount = 0;
            audioService.reset();
            highlighter.setAudioElement(audioService.element);
            highlighter.start(); // petla RAF zyje przez cala sesje, patrz WordHighlighter
            sentenceQueue.render(sentences);
            updateGenProgress(0, sentences.length);
            dispatch({ type: 'NEW_GENERATION', count: sentences.length, autoplay: autoplayCheck.checked });

            // P4: Python musi znac nowa epoke ZANIM poleci pierwszy generate
            await api.reset_generation_cache(run);
            if (stale()) return;

            player.gen = 'running';
            render();
            const queue = new TtsQueue(sentences);
            ttsQueue = queue;

            await queue.generateAll(api, {
                onReady: (data, i) => {
                    if (stale()) return;
                    audioService.cacheBlob(i, data.audio);
                    sentenceData[i] = { timestamps: data.timestamps }; // base64 nie zostaje w JS (M2)
                    const lastWord = data.timestamps[data.timestamps.length - 1];
                    sentenceDurations[i] = lastWord ? lastWord.end_time : 0;
                    totalDuration += sentenceDurations[i];
                    okCount++;
                    sentenceQueue.markGenerated(i);
                    updateGenProgress(okCount + failedCount, sentences.length);
                    dispatch({ type: 'CHUNK_READY', index: i });
                },
                onFailed: (i, error) => {
                    if (stale()) return;
                    failedCount++;
                    sentenceQueue.markFailed(i, error);
                    setStatus(`Nie wygenerowano ${failedCount} fragm. (oznaczone na czerwono).`);
                    updateGenProgress(okCount + failedCount, sentences.length);
                    dispatch({ type: 'CHUNK_FAILED', index: i });
                },
            }, {
                voice: voiceSelect.value,
                speed: parseFloat(speedRange.value),
                epoch: run,
            });

            if (stale()) return;
            dispatch({ type: 'GENERATION_END' });
        } catch (e) {
            console.error('Generate:', e);
            if (!stale()) {
                setStatus(`Błąd generacji: ${e}`);
                ttsQueue?.clear();
                dispatch({ type: 'GENERATION_END' });
            }
        }
    });

    render();
});
