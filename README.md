🇵🇱 [Polska wersja](README.pl.md)

# KokoroTTS

A local desktop reader that turns text and documents into speech using the [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model — with per-word highlighting as it reads, so you can actually follow along in real time instead of just listening.

![KokoroTTS](Koko-tts_gui.png)

## Why

Most TTS readers are either a black-box "read the whole document" button or a cloud API you have to trust with your text. This one talks to a local [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) service, reads books and documents sentence by sentence, and shows you exactly which word is being spoken as it plays — closer to a karaoke-style reading aid than a plain audiobook player.

## Features

- **Real-time reading highlight** — as audio plays, the word currently being spoken lights up in a scrolling sentence queue, synced to Kokoro's per-word timestamps.
- **Reads documents, not just plain text** — TXT, MD, PDF, DOCX, ODT, RTF, EPUB, MOBI/AZW/AZW3, extracted and cleaned before synthesis.
- **Sentence-by-sentence streaming** — text is generated chunk by chunk instead of one giant request, so playback starts almost immediately while the rest keeps generating in the background.
- **Smart chunking around dialogue** — a custom tokenizer merges sentences into "speech turns" so synthesis never cuts mid-quote, and filters out scene-break markers (`***`, stray dashes) that aren't meant to be read aloud.
- **Configurable Rules** — an in-app popup for regex find/replace rules (e.g. `Qi` → `chi`) applied to the text before it reaches the TTS engine, for names, abbreviations, or units the model mispronounces.
- **Configurable Intervals** — another popup controls the pause length between paragraphs and scene breaks, and the max characters per synthesis chunk, so pacing can be tuned per book or voice.
- **MP3 export** — stitches every generated sentence, with the same pauses used during playback, into one downloadable file.
- Voice mixing, speed/volume controls, and a live voice list pulled from the backend.

## Tech stack

Python (pywebview + PyQt6/QtWebEngine) desktop shell · vanilla HTML/CSS/JS frontend (MediaSource Extensions for gapless sentence playback) · `pdfplumber` / `python-docx` / `odfpy` / `striprtf` / `ebooklib` for document extraction · `fast-sentence-segment` for sentence splitting · [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (Docker, CPU or GPU image) running the Kokoro-82M model as the TTS backend.

## Credits

This app is a frontend built on top of [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) by remsky — a FastAPI wrapper (Apache 2.0) around the [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) text-to-speech model. All the actual speech synthesis happens there; this project talks to its API, feeds it documents, and builds the reading/highlighting UI around it.

Thank you to remsky and the Kokoro-FastAPI project — I learned a lot from reading through that codebase while building this one.

## Status

Personal project, actively developed. The core pipeline — document import → sentence-by-sentence generation → gapless playback → real-time word highlight → MP3 export — works end-to-end. A few UI rough edges (queue auto-scroll position, popup polish) are still being ironed out.

## Running it

Start the TTS backend (separate service, needs to be running before the app):

```bash
# CPU
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest

# GPU (NVIDIA)
docker run --gpus all -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

Then run the app:

```bash
uv sync
python main.py
```
