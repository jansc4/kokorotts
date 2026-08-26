import { openPopup } from './Popup.js';

// Popup edycji regul normalizacji (regexowe podmiany PRZED synteza - skroty,
// jednostki itd.). Port pomyslu z PiperTTSv2/normalizer.py.
export async function showRulesPopup(api) {
    const rules = await api.get_rules();

    const list = document.createElement('div');

    function renderRow(rule) {
        const row = document.createElement('div');
        row.className = 'rule-row';

        const patternInput = document.createElement('input');
        patternInput.type = 'text';
        patternInput.placeholder = 'wzorzec (regex)';
        patternInput.value = rule.pattern;

        const replacementInput = document.createElement('input');
        replacementInput.type = 'text';
        replacementInput.placeholder = 'zamiennik';
        replacementInput.value = rule.replacement;

        const enabledCheck = document.createElement('input');
        enabledCheck.type = 'checkbox';
        enabledCheck.title = 'Włączona';
        enabledCheck.checked = rule.enabled !== false;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'rule-row__remove';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => row.remove());

        row.appendChild(patternInput);
        row.appendChild(replacementInput);
        row.appendChild(enabledCheck);
        row.appendChild(removeBtn);

        row._getData = () => ({
            pattern: patternInput.value,
            replacement: replacementInput.value,
            flags: rule.flags ?? 0,
            enabled: enabledCheck.checked,
        });

        return row;
    }

    rules.forEach(rule => list.appendChild(renderRow(rule)));

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn--ghost';
    addBtn.textContent = 'Dodaj regułę +';
    addBtn.style.marginTop = '8px';
    addBtn.addEventListener('click', () => {
        list.appendChild(renderRow({ pattern: '', replacement: '', flags: 0, enabled: true }));
    });

    const container = document.createElement('div');
    container.appendChild(list);
    container.appendChild(addBtn);

    openPopup({
        title: 'Reguły normalizacji',
        bodyElement: container,
        onSave: async () => {
            const newRules = Array.from(list.children)
                .map(row => row._getData?.())
                .filter(r => r && r.pattern.trim() !== ''); // puste wzorce pomijamy
            await api.save_rules(newRules);
        },
    });
}
