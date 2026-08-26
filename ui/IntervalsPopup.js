import { openPopup } from './Popup.js';

const LABELS = {
    gap_paragraph_ms: 'Pauza: akapit (ms)',
    gap_scene_ms: 'Pauza: scena / separator (ms)',
    max_chunk_chars: 'Limit dlugosci chunka (znaki)',
};

// Popup edycji parametrow pipeline'u: dlugosci gapow (pauz miedzy chunkami)
// i gornego limitu dlugosci chunka. Wartosci sa "wypiekane" przez tokenizer
// po stronie Pythona przy nastepnej tokenizacji - zmiana zadziala po
// ponownym Generate (nie na zywo w trakcie odtwarzania).
// onSaved(newIntervals) - opcjonalne, wolane po udanym zapisie.
export async function showIntervalsPopup(api, onSaved) {
    const intervals = await api.get_intervals();

    const container = document.createElement('div');
    const fields = {};

    Object.entries(LABELS).forEach(([key, label]) => {
        const row = document.createElement('div');
        row.className = 'interval-row';

        const labelEl = document.createElement('label');
        labelEl.textContent = label;

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = key === 'max_chunk_chars' ? '10' : '50';
        input.value = intervals[key] ?? 0;

        row.appendChild(labelEl);
        row.appendChild(input);
        container.appendChild(row);
        fields[key] = input;
    });

    openPopup({
        title: 'Parametry pipeline (gapy, limit chunka)',
        bodyElement: container,
        onSave: async () => {
            const newIntervals = {};
            Object.entries(fields).forEach(([key, input]) => {
                newIntervals[key] = parseInt(input.value, 10) || 0;
            });
            await api.save_intervals(newIntervals);
            onSaved?.(newIntervals);
        },
    });
}
