// public/js/audio.js
let audioCtx = null;
let speechUnlocked = false;
let availableVoices = [];

// Populate voice cache immediately
function loadVoices() {
    if ('speechSynthesis' in window) {
        availableVoices = window.speechSynthesis.getVoices() || [];
    }
}

if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
}

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

// User-gesture unlock for both Web Audio and Speech Synthesis
function unlockAudioEngine() {
    getAudioContext();

    if ('speechSynthesis' in window && !speechUnlocked) {
        // Trigger getVoices to populate engine cache
        loadVoices();

        // Speak an audible non-breaking space with tiny volume to satisfy mobile policies
        const warmUp = new SpeechSynthesisUtterance(' ');
        warmUp.volume = 0.01;
        warmUp.rate = 1.0;
        
        // Ensure voice queue is clear before speaking warmup
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(warmUp);
        speechUnlocked = true;
    }
}

// Attach listeners across all touch/click gestures
document.addEventListener('pointerdown', unlockAudioEngine, { once: false, passive: true });
document.addEventListener('touchstart', unlockAudioEngine, { once: false, passive: true });

function speakKnockedCue() {
    if (!('speechSynthesis' in window)) return;

    // Refresh voices if array is still empty
    if (!availableVoices || availableVoices.length === 0) {
        loadVoices();
    }

    // Clear queue to ensure immediate playback
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance("Knocked!");
    utterance.volume = 1.0;
    utterance.rate = 0.95;
    utterance.pitch = 0.65; // Lower pitch to simulate deep male voice

    if (availableVoices && availableVoices.length > 0) {
        // Find best match for English male voice across platforms
        const maleVoice = availableVoices.find(v => 
            (v.lang.startsWith('en') || v.lang.startsWith('en-US')) && 
            (v.name.toLowerCase().includes('male') || 
             v.name.toLowerCase().includes('david') || 
             v.name.toLowerCase().includes('george') || 
             v.name.toLowerCase().includes('daniel') ||
             v.name.toLowerCase().includes('aaron') ||
             v.name.toLowerCase().includes('james'))
        );

        if (maleVoice) {
            utterance.voice = maleVoice;
        } else {
            // Fallback: pick any English voice available
            const defaultEn = availableVoices.find(v => v.lang.startsWith('en'));
            if (defaultEn) utterance.voice = defaultEn;
        }
    }

    // Workaround for mobile browsers garbage collecting utterances mid-speech
    window._knockUtteranceHolder = utterance;
    utterance.onend = () => {
        window._knockUtteranceHolder = null;
    };
    utterance.onerror = () => {
        window._knockUtteranceHolder = null;
    };

    window.speechSynthesis.speak(utterance);
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
