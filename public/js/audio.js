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

function playSound(type) {
    try {
        let ctx = getAudioContext();
        let now = ctx.currentTime;

        if (type === 'join') {
            let osc1 = ctx.createOscillator();
            let gain1 = ctx.createGain();
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(698.46, now);
            gain1.gain.setValueAtTime(0.7, now);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
            osc1.start(now);
            osc1.stop(now + 0.18);

            let osc2 = ctx.createOscillator();
            let gain2 = ctx.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(1046.50, now + 0.1);
            gain2.gain.setValueAtTime(0.75, now + 0.1);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc2.start(now + 0.1);
            osc2.stop(now + 0.35);
            return;
        }

        let osc = ctx.createOscillator();
        let gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'knock') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(150, now);
            osc.frequency.exponentialRampToValueAtTime(70, now + 0.12);
            gain.gain.setValueAtTime(0.85, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
            osc.start(now);
            osc.stop(now + 0.12);

            let osc2 = ctx.createOscillator();
            let gain2 = ctx.createGain();
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
            osc.type = 'sine';
            osc.frequency.setValueAtTime(420, now);
            osc.frequency.exponentialRampToValueAtTime(210, now + 0.08);
            gain.gain.setValueAtTime(0.6, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.08);
        } else if (type === 'ding') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, now);
            gain.gain.setValueAtTime(0.7, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc.start(now);
            osc.stop(now + 0.35);
        } else if (type === 'thud') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(80, now);
            osc.frequency.exponentialRampToValueAtTime(40, now + 0.09);
            gain.gain.setValueAtTime(0.8, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.09);
            osc.start(now);
            osc.stop(now + 0.09);
        }
    } catch (err) {}
}

function speakKnockedCue() {
    if ('speechSynthesis' in window) {
        try {
            window.speechSynthesis.cancel();
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
    let iosTrigger = document.getElementById('ios-haptic-trigger');
    if (iosTrigger) {
        try {
            iosTrigger.checked = !iosTrigger.checked;
            iosTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch (e) {}
    }
}

function triggerFastTurnPulses() {
    triggerVibration([40, 60, 40]);
    playSound('thud');
    setTimeout(() => playSound('thud'), 100);
}
