// public/js/audio.js
let audioCtx = null;
let masterGainNode = null;
let knockAudioBuffer = null;
let yourTurnAudioBuffer = null;

// Default SFX volume level (1.0 = 100%)
let gameSfxVolume = 1.0;

// Audio asset paths
const KNOCK_AUDIO_PATH = '/mp3s/knock.mp3';
const YOUR_TURN_AUDIO_PATH = '/mp3s/yourturn.mp3';
const YOUR_TURN_FALLBACK_PATH = '/mp3/yourturn.mp3';

function getAudioContext() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            audioCtx = new AudioContextClass();
            masterGainNode = audioCtx.createGain();
            masterGainNode.gain.setValueAtTime(gameSfxVolume, audioCtx.currentTime);
            masterGainNode.connect(audioCtx.destination);
        }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

// Volume slider handler for game MP3s and sound effects
function setGameSfxVolume(val) {
    gameSfxVolume = Math.max(0, Math.min(1, parseFloat(val)));
    const ctx = getAudioContext();
    if (ctx && masterGainNode) {
        masterGainNode.gain.setValueAtTime(gameSfxVolume, ctx.currentTime);
    }
    const display = document.getElementById('sfx-vol-display');
    if (display) {
        display.innerText = `${Math.round(gameSfxVolume * 100)}%`;
    }
}

async function loadAudioBuffer(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        const ctx = getAudioContext();
        if (!ctx) return null;
        return await ctx.decodeAudioData(arrayBuffer);
    } catch (err) {
        return null;
    }
}

async function preloadAudioFiles() {
    if (!knockAudioBuffer) {
        knockAudioBuffer = await loadAudioBuffer(KNOCK_AUDIO_PATH);
    }
    if (!yourTurnAudioBuffer) {
        yourTurnAudioBuffer = await loadAudioBuffer(YOUR_TURN_AUDIO_PATH);
        if (!yourTurnAudioBuffer) {
            yourTurnAudioBuffer = await loadAudioBuffer(YOUR_TURN_FALLBACK_PATH);
        }
    }
}

function unlockAudioEngine() {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
        ctx.resume();
    }
    if (!knockAudioBuffer || !yourTurnAudioBuffer) {
        preloadAudioFiles();
    }
}

document.addEventListener('pointerdown', unlockAudioEngine, { once: false, passive: true });
document.addEventListener('touchstart', unlockAudioEngine, { once: false, passive: true });
preloadAudioFiles();

function playBufferOrAudio(buffer, fallbackUrl) {
    const ctx = getAudioContext();
    if (ctx && buffer && masterGainNode) {
        try {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(masterGainNode);
            source.start(0);
            return;
        } catch (e) {
            console.warn("Buffer playback error, falling back to Audio element:", e);
        }
    }

    try {
        const audio = new Audio(fallbackUrl);
        audio.volume = gameSfxVolume;
        audio.play().catch(() => {});
    } catch (e) {}
}

function speakKnockedCue() {
    playBufferOrAudio(knockAudioBuffer, KNOCK_AUDIO_PATH);
}

function playYourTurnCue() {
    playBufferOrAudio(yourTurnAudioBuffer, YOUR_TURN_AUDIO_PATH);
}

function playSound(type) {
    const ctx = getAudioContext();
    if (!ctx || !masterGainNode) return;

    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(masterGainNode);

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
            speakKnockedCue();
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
