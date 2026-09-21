import { openPopup } from './Popup.js';

// Maly popup "Znajdz i zamien" - dziala na tekscie w polu Input (#text-input).
// Zamiana jest doslowna (nie regex) - regexy mamy w Rules.
export function showFindReplacePopup(textInput) {
    const container = document.createElement('div');
    container.className = 'find-replace';

    function makeField(labelText, placeholder) {
        const wrap = document.createElement('label');
        wrap.className = 'find-replace__field';
        const label = document.createElement('span');
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = placeholder;
        wrap.appendChild(label);
        wrap.appendChild(input);
        container.appendChild(wrap);
        return input;
    }

    const findInput = makeField('Znajdź', 'szukany tekst');
    const replaceInput = makeField('Zamień na', 'zamiennik (puste = usuń)');

    const caseLabel = document.createElement('label');
    caseLabel.className = 'find-replace__check';
    const caseCheck = document.createElement('input');
    caseCheck.type = 'checkbox';
    caseLabel.appendChild(caseCheck);
    caseLabel.appendChild(document.createTextNode(' Rozróżniaj wielkość liter'));
    container.appendChild(caseLabel);

    const countEl = document.createElement('div');
    countEl.className = 'find-replace__count';
    container.appendChild(countEl);

    function buildRegex() {
        const needle = findInput.value;
        if (needle === '') return null;
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(escaped, caseCheck.checked ? 'gu' : 'giu');
    }

    function updateCount() {
        const re = buildRegex();
        if (!re) {
            countEl.textContent = '';
            return;
        }
        const n = (textInput.value.match(re) || []).length;
        countEl.textContent = `Znaleziono: ${n}`;
    }

    findInput.addEventListener('input', updateCount);
    caseCheck.addEventListener('change', updateCount);

    openPopup({
        title: 'Znajdź i zamień',
        bodyElement: container,
        saveLabel: 'Zamień wszystko',
        className: 'popup--small',
        onSave: async () => {
            const re = buildRegex();
            if (!re) return;
            const replacement = replaceInput.value;
            // funkcja zamiast stringa - "$1", "$&" itd. w zamienniku zostaja doslowne
            textInput.value = textInput.value.replace(re, () => replacement);
            textInput.dispatchEvent(new Event('input', { bubbles: true }));
        },
    });

    findInput.focus();
}
