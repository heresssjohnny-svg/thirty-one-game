// public/js/audio.js
let audioCtx = null;

function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

// User-gesture touch unlock for Safari/WebKit/Mobile Chrome
window.addEventListener('touchstart', () => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
}, { once: true, passive: true });

window.addEventListener('pointerdown', () => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
}, { once: true, passive: true });

function playSound(type) {
    try {
        const ctx = getAudioContext();
        const now = ctx.currentTime;

        if (type === 'ding') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(587.33, now);
            gain.gain.setValueAtTime(0.7, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc.start(now);
            osc.stop(now + 0.35);
        } else if (type === 'knock') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(150, now);
            osc.frequency.exponentialRampToValueAtTime(70, now + 0.12);
            gain.gain.setValueAtTime(0.85, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
            osc.start(now);
            osc.stop(now + 0.12);

            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.type = 'triangle';
            osc2.frequency.setValueAtTime(140, now + 0.14);
            osc2.frequency.exponentialRampToValueAtTime(65, now + 0.28);
            gain2.gain.setValueAtTime(0.8, now + 0.14);
            gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.28);
            osc2.start(now + 0.14);
            osc2.stop(now + 0.28);
        } else if (type === 'card') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(420, now);
            osc.frequency.exponentialRampToValueAtTime(210, now + 0.08);
            gain.gain.setValueAtTime(0.6, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.08);
        }
    } catch (e) {}
}

function speakKnockedCue() {
    if ('speechSynthesis' in window) {
        try {
            const utterance = new SpeechSynthesisUtterance("Knocked");
            utterance.rate = 1.0;
            utterance.pitch = 1.0;
            utterance.volume = 1.0;
            window.speechSynthesis.speak(utterance);
        } catch (e) {
            console.warn("Speech synthesis unavailable:", e);
        }
    }
}

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
