// public/js/audio.js
let audioCtx = null;
let masterGainNode = null;
let knockAudioBuffer = null;
let yourTurnAudioBuffer = null;

let gameSfxVolume = 1.0;

// Asset paths
const KNOCK_AUDIO_PATH = '/mp3s/knock.mp3';
const YOUR_TURN_AUDIO_PATH = '/mp3s/yourturn.mp3';
const YOUR_TURN_FALLBACK_PATH = '/mp3/yourturn.mp3';

// Pre-instantiated HTML5 fallback elements
const yourTurnHtml5Audio = new Audio(YOUR_TURN_AUDIO_PATH);
const knockHtml5Audio = new Audio(KNOCK_AUDIO_PATH);

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

function setGameSfxVolume(val) {
    gameSfxVolume = Math.max(0, Math.min(1, parseFloat(val)));
    const ctx = getAudioContext();
    if (ctx && masterGainNode) {
        masterGainNode.gain.setValueAtTime(gameSfxVolume, ctx.currentTime);
    }
    yourTurnHtml5Audio.volume = gameSfxVolume;
    knockHtml5Audio.volume = gameSfxVolume;

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

// Mobile browser unlock: Resumes audio context and primes media on first touch
function unlockAudioEngine() {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
        ctx.resume();
    }
    try {
        yourTurnHtml5Audio.load();
        knockHtml5Audio.load();
    } catch (e) {}

    if (!knockAudioBuffer || !yourTurnAudioBuffer) {
        preloadAudioFiles();
    }
}

document.addEventListener('pointerdown', unlockAudioEngine, { once: false, passive: true });
document.addEventListener('touchstart', unlockAudioEngine, { once: false, passive: true });
preloadAudioFiles();

function playBufferOrAudio(buffer, fallbackUrl, htmlAudioEl) {
    if (gameSfxVolume <= 0) return;

    const ctx = getAudioContext();
    // 1. Web Audio API buffer playback (bypasses mobile async WebSocket autoplay blocking)
    if (ctx && buffer && masterGainNode) {
        try {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(masterGainNode);
            source.start(0);
            return;
        } catch (e) {
            console.warn("Buffer playback failed, using HTML5 fallback:", e);
        }
    }

    // 2. HTML5 audio fallback
    try {
        const audio = htmlAudioEl || new Audio(fallbackUrl);
        audio.volume = gameSfxVolume;
        audio.currentTime = 0;
        audio.play().catch(() => {});
    } catch (e) {}
}

// Explicit turn cue function
function playYourTurnCue() {
    playBufferOrAudio(yourTurnAudioBuffer, YOUR_TURN_AUDIO_PATH, yourTurnHtml5Audio);
}

function speakKnockedCue() {
    playBufferOrAudio(knockAudioBuffer, KNOCK_AUDIO_PATH, knockHtml5Audio);
}

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
            gain.connect(masterGainNode || ctx.destination);
            osc.frequency.setValueAtTime(freq, now + idx * 0.16);
            gain.gain.setValueAtTime(0.35 * gameSfxVolume, now + idx * 0.16);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.16 + 0.9);
            osc.start(now + idx * 0.16);
            osc.stop(now + idx * 0.16 + 0.9);
        });
    } catch (e) {}
}

function playSound(type) {
    if (type === 'yourturn' || type === 'turn') {
        playYourTurnCue();
        return;
    }
    if (type === 'knock') {
        speakKnockedCue();
        return;
    }

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
            gain.gain.setValueAtTime(0.25 * gameSfxVolume, now);
            gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.08);
        } else if (type === 'ding') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, now);
            gain.gain.setValueAtTime(0.4 * gameSfxVolume, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc.start(now);
            osc.stop(now + 0.35);
        }
    } catch (e) {}
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
