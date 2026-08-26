import { AudioService } from './AudioService.js';
import { WordHighlighter } from './WordHighlighter.js';


window.addEventListener("pywebviewready", () => {
    console.log("PyWebView is ready!");

    const audioService = new AudioService();
    audioService.init();

    const highlighter = new WordHighlighter(
    audioService.audio,
    document.getElementById('text-display')
    );
    

    window.pywebview.api.check_tts_service().then((result) => {
        if (result) {
            console.log("TTS service is running.");
            document.getElementById("status").textContent = "TTS service is running.";
            document.getElementById('play-btn').addEventListener('click', () => {
                window.pywebview.api.get_test_sentence().then((data) => {
                    if (data.error) {
                        console.error(data.error);
                    } else {
                        audioService.appendChunk(data.audio);
                        highlighter.setTimestamps(data.timestamps);
                        audioService.play();
                        highlighter.start();
                    
                }});
            });

            document.getElementById('generate-btn').addEventListener('click', () => {
                const text = document.getElementById('text-input').value;
                window.pywebview.api.generate_tts(text).then((data) => {
                    if (data.error) {
                        console.error(data.error);
                    } else {
                        audioService.init(); // reset the audio service for new TTS
                        audioService.appendChunk(data.audio);
                        highlighter.setAudioElement(audioService.audio); // highlighter musi wskazywać na NOWY element audio
                        highlighter.setTimestamps(data.timestamps);
                        audioService.play();
                        highlighter.start();
                    }
    });
});
            

        } else {
            console.log("TTS service is not running.");
            document.getElementById("status").textContent = "TTS service is not running.";
        }
    });
});

