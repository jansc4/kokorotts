// Wspolny, minimalny modal - uzywany przez RulesPopup.js i IntervalsPopup.js.
export function openPopup({ title, bodyElement, onSave, saveLabel = 'Zapisz' }) {
    const root = document.getElementById('popup-root');

    const overlay = document.createElement('div');
    overlay.className = 'popup-overlay';

    const popup = document.createElement('div');
    popup.className = 'popup';

    const header = document.createElement('div');
    header.className = 'popup__header';

    const titleEl = document.createElement('h3');
    titleEl.className = 'popup__title';
    titleEl.textContent = title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'popup__close';
    closeBtn.textContent = '✕';

    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'popup__body';
    body.appendChild(bodyElement);

    const footer = document.createElement('div');
    footer.className = 'popup__footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn--ghost';
    cancelBtn.textContent = 'Anuluj';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn--primary';
    saveBtn.textContent = saveLabel;

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    popup.appendChild(header);
    popup.appendChild(body);
    popup.appendChild(footer);
    overlay.appendChild(popup);
    root.appendChild(overlay);

    function close() {
        overlay.remove();
    }

    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
            await onSave();
            close();
        } finally {
            saveBtn.disabled = false;
        }
    });

    return { close };
}
