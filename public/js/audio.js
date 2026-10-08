// public/js/audio.js

let audioCtx = null;
let gameSfxVolume = 1.0;

// Pre-cached audio elements for mp3 playback
const sfxAudioPool = {
    yourturn: new Audio('/mp3s/yourturn.mp3'),
    knock: new Audio('/mp3s/knock.mp3')
};

// Ensure user interaction unlocks audio playback across mobile browsers
function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

function setGameSfxVolume(val) {
    gameSfxVolume = Math.max(0, Math.min(1, parseFloat(val)));
    const disp = document.getElementById('sfx-vol-display');
    if (disp) {
        disp.innerText = `${Math.round(gameSfxVolume * 100)}%`;
    }
    Object.values(sfxAudioPool).forEach(audio => {
        audio.volume = gameSfxVolume;
    });
}

function playSound(type) {
    if (gameSfxVolume <= 0) return;

    // 1. Attempt playback from static MP3 assets with synthesized fallback
    if (type === 'yourturn' || type === 'turn') {
        playMp3WithFallback(sfxAudioPool.yourturn, () => playSynthesizedDing(true));
        return;
    }

    if (type === 'knock') {
        playMp3WithFallback(sfxAudioPool.knock, () => playSynthesizedKnock());
        return;
    }

    if (type === 'card') {
        playSynthesizedCard();
        return;
    }

    if (type === 'ding') {
        playSynthesizedDing(false);
        return;
    }
}

function playMp3WithFallback(audioEl, fallbackFn) {
    if (audioEl) {
        try {
            audioEl.volume = gameSfxVolume;
            audioEl.currentTime = 0;
            const promise = audioEl.play();
            if (promise !== undefined) {
                promise.catch(() => {
                    // Fallback to Web Audio synthesis if MP3 is missing or blocked
                    if (typeof fallbackFn === 'function') fallbackFn();
                });
            }
        } catch (e) {
            if (typeof fallbackFn === 'function') fallbackFn();
        }
    } else if (typeof fallbackFn === 'function') {
        fallbackFn();
    }
}

// Synthesized Fallback: "Your Turn" two-tone doorbell chime
function playSynthesizedDing(isTwoTone = false) {
    try {
        const ctx = getAudioContext();
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.frequency.setValueAtTime(587.33, now); // D5
        gain1.gain.setValueAtTime(0.7 * gameSfxVolume, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc1.start(now);
        osc1.stop(now + 0.35);

        if (isTwoTone) {
            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.frequency.setValueAtTime(880.00, now + 0.15); // A5
            gain2.gain.setValueAtTime(0.75 * gameSfxVolume, now + 0.15);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
            osc2.start(now + 0.15);
            osc2.stop(now + 0.55);
        }
    } catch (e) {}
}

// Synthesized Fallback: Double wooden table knock
function playSynthesizedKnock() {
    try {
        const ctx = getAudioContext();
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.type = 'triangle';
        osc1.frequency.setValueAtTime(150, now);
        osc1.frequency.exponentialRampToValueAtTime(70, now + 0.12);
        gain1.gain.setValueAtTime(0.85 * gameSfxVolume, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc1.start(now);
        osc1.stop(now + 0.12);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(140, now + 0.14);
        osc2.frequency.exponentialRampToValueAtTime(65, now + 0.28);
        gain2.gain.setValueAtTime(0.8 * gameSfxVolume, now + 0.14);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.28);
        osc2.start(now + 0.14);
        osc2.stop(now + 0.28);
    } catch (e) {}
}

function playSynthesizedCard() {
    try {
        const ctx = getAudioContext();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(420, now);
        osc.frequency.exponentialRampToValueAtTime(210, now + 0.08);
        gain.gain.setValueAtTime(0.6 * gameSfxVolume, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);
    } catch (e) {}
}

// Full 4-note celebration fanfare (C5 -> E5 -> G5 -> C6)
function playCelebrationFanfare() {
    if (gameSfxVolume <= 0) return;

    try {
        const ctx = getAudioContext();
        const now = ctx.currentTime;
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(freq, now + idx * 0.16);
            gain.gain.setValueAtTime(0.4 * gameSfxVolume, now + idx * 0.16);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.16 + 0.9);
            osc.start(now + idx * 0.16);
            osc.stop(now + idx * 0.16 + 0.9);
        });
    } catch (e) {}
}

// Spoken voice cue "Knocked" via Web Speech API
function speakKnockedCue() {
    if ('speechSynthesis' in window && gameSfxVolume > 0) {
        try {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance("Knocked");
            utterance.rate = 1.0;
            utterance.pitch = 1.0;
            utterance.volume = gameSfxVolume;
            window.speechSynthesis.speak(utterance);
        } catch (e) {}
    }
}

// Mobile haptic vibration trigger
function triggerVibration(pattern) {
    if ('vibrate' in navigator) {
        try { navigator.vibrate(pattern); } catch (e) {}
    }
    const iosTrigger = document.getElementById('ios-haptic-trigger');
    if (iosTrigger) {
        try {
            iosTrigger.checked = !iosTrigger.checked;
            iosTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch (e) {}
    }
}

function enableBackgroundAudioKeepAlive() {
    try {
        const ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) {}
}
