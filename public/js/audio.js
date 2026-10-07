// public/js/audio.js
let audioCtx = null;
let speechInitialized = false;

function getAudioContext() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            audioCtx = new AudioContextClass();
        }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

// Unlock audio and speech synthesis on user interaction
function unlockAudioEngine() {
    getAudioContext();

    if ('speechSynthesis' in window && !speechInitialized) {
        const silentUtterance = new SpeechSynthesisUtterance('');
        silentUtterance.volume = 0;
        window.speechSynthesis.speak(silentUtterance);
        speechInitialized = true;
    }
}

document.addEventListener('pointerdown', unlockAudioEngine, { once: false, passive: true });
document.addEventListener('touchstart', unlockAudioEngine, { once: false, passive: true });

function speakKnockedCue() {
    if (!('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel(); // Stop any pending speech

    const utterance = new SpeechSynthesisUtterance("Knocked!");
    utterance.volume = 1.0;
    utterance.rate = 0.95;  // Slightly deliberate pace
    utterance.pitch = 0.65; // Lower pitch for a deep male voice tone

    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
        // Attempt to select an English male voice if available on system
        const maleVoice = voices.find(v => 
            v.lang.startsWith('en') && 
            (v.name.toLowerCase().includes('male') || 
             v.name.toLowerCase().includes('david') || 
             v.name.toLowerCase().includes('george') || 
             v.name.toLowerCase().includes('daniel') ||
             v.name.toLowerCase().includes('james'))
        );
        if (maleVoice) {
            utterance.voice = maleVoice;
        }
    }

    window.speechSynthesis.speak(utterance);
}

// Pre-load voices for browsers that fetch them asynchronously
if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}

function playSound(type) {
    const ctx = getAudioContext();
    if (!ctx) return;

    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        const now = ctx.currentTime;

        if (type === 'card') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(320, now);
            osc.frequency.exponentialRampToValueAtTime(140, now + 0.08);
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.08);
        } else if (type === 'knock') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(160, now);
            osc.frequency.exponentialRampToValueAtTime(45, now + 0.22);
            gain.gain.setValueAtTime(0.6, now);
            gain.gain.linearRampToValueAtTime(0.01, now + 0.22);
            osc.start(now);
            osc.stop(now + 0.22);
        }
    } catch (e) {
        console.warn("Sound play error:", e);
    }
}

function triggerVibration(pattern) {
    if ('vibrate' in navigator) {
        try {
            navigator.vibrate(pattern);
        } catch (e) {}
    }
}
