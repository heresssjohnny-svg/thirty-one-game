// public/js/voice.js
let livekitRoom = null;
let isMicActive = false;
let currentVoiceRoomCode = null;
let cachedLiveKitToken = null;
let cachedLiveKitHost = null;

// Voice chat volume (1.0 = 100%)
let livekitVoiceVolume = 1.0;
const subscribedAudioElements = new Set();

let backgroundKeepAliveAudio = null;
let wakeLock = null;

function getLiveKitSDK() {
    return window.LivekitClient || window.LiveKitClient || (window.livekit?.Room ? window.livekit : null);
}

// Adjust volume of all connected remote voice participants
function setVoiceChatVolume(val) {
    livekitVoiceVolume = Math.max(0, Math.min(1, parseFloat(val)));
    subscribedAudioElements.forEach(audioElem => {
        if (audioElem) audioElem.volume = livekitVoiceVolume;
    });

    const display = document.getElementById('lk-vol-display');
    if (display) {
        display.innerText = `${Math.round(livekitVoiceVolume * 100)}%`;
    }
}

function enableBackgroundAudioKeepAlive() {
    try {
        if (!backgroundKeepAliveAudio) {
            backgroundKeepAliveAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==');
            backgroundKeepAliveAudio.loop = true;
            backgroundKeepAliveAudio.volume = 0.01;
        }
        backgroundKeepAliveAudio.play().catch(() => {});

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
            navigator.mediaSession.metadata = new MediaMetadata({
                title: 'Table Voice Room',
                artist: '31! Card Game',
                album: 'Live Voice Chat'
            });
        }
    } catch (e) {}
}

function disableBackgroundAudioKeepAlive() {
    try {
        if (backgroundKeepAliveAudio) {
            backgroundKeepAliveAudio.pause();
            backgroundKeepAliveAudio = null;
        }
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'none';
        }
    } catch (e) {}
}

async function requestScreenWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } catch (err) {}
    }
}

function releaseScreenWakeLock() {
    if (wakeLock) {
        try { wakeLock.release(); } catch (e) {}
        wakeLock = null;
    }
}

async function connectLiveKit(token, host, lobbyCode) {
    if (!token || !host) return;

    const LK = getLiveKitSDK();
    if (!LK) return;

    cachedLiveKitToken = token;
    cachedLiveKitHost = host;
    currentVoiceRoomCode = lobbyCode || window.appGlobals?.currentJoinedCode;

    if (livekitRoom) {
        try { await livekitRoom.disconnect(); } catch (e) {}
        livekitRoom = null;
    }

    try {
        livekitRoom = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track) => {
            if (track.kind === LK.Track.Kind.Audio || track.kind === 'audio') {
                const audioElem = track.attach();
                audioElem.autoplay = true;
                audioElem.playsInline = true;
                audioElem.volume = livekitVoiceVolume;
                audioElem.setAttribute('playsinline', '');
                audioElem.setAttribute('webkit-playsinline', '');
                document.body.appendChild(audioElem);
                subscribedAudioElements.add(audioElem);
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(el => {
                subscribedAudioElements.delete(el);
                el.remove();
            });
        });

        livekitRoom.on(LK.RoomEvent.Disconnected, () => {
            isMicActive = false;
            updateVoiceButtonUI();
            disableBackgroundAudioKeepAlive();
            releaseScreenWakeLock();
            subscribedAudioElements.clear();
        });

        await livekitRoom.connect(host, token);
        await livekitRoom.localParticipant.setMicrophoneEnabled(false);
        isMicActive = false;
        updateVoiceButtonUI();

        enableBackgroundAudioKeepAlive();
        requestScreenWakeLock();

        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({ type: 'VC_STATUS_UPDATE', inVC: true, isMuted: true });
        }
    } catch (err) {
        console.warn("LiveKit connection error:", err);
        isMicActive = false;
        updateVoiceButtonUI();
    }
}

async function toggleVoiceOnOff() {
    const LK = getLiveKitSDK();

    if (!livekitRoom || livekitRoom.state !== 'connected') {
        if (cachedLiveKitToken && cachedLiveKitHost) {
            showCenterNotification("Connecting voice room...");
            await connectLiveKit(cachedLiveKitToken, cachedLiveKitHost, currentVoiceRoomCode);
        } else {
            showCenterNotification("Voice room unavailable.");
            return;
        }
    }

    if (!livekitRoom || !livekitRoom.localParticipant) {
        showCenterNotification("Voice room connecting, please tap again in a moment.");
        return;
    }

    const btn = document.getElementById('vc-main-btn');
    if (btn) btn.disabled = true;

    try {
        if (isMicActive) {
            await livekitRoom.localParticipant.setMicrophoneEnabled(false);
            isMicActive = false;
        } else {
            if (livekitRoom.startAudio) await livekitRoom.startAudio();
            await livekitRoom.localParticipant.setMicrophoneEnabled(true);
            isMicActive = true;
        }

        updateVoiceButtonUI();

        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({ type: 'VC_STATUS_UPDATE', inVC: true, isMuted: !isMicActive });
        }
    } catch (err) {
        console.error("Microphone toggle error:", err);
        isMicActive = false;
        updateVoiceButtonUI();
        showCenterNotification("Microphone permission required.");
    } finally {
        if (btn) btn.disabled = false;
    }
}

const toggleLiveKitVoice = toggleVoiceOnOff;

function updateVoiceButtonUI() {
    const btn = document.getElementById('vc-main-btn');
    const led = document.getElementById('vc-led');

    if (btn) {
        btn.innerText = isMicActive ? '🎙️ Voice: On' : '🎙️ Voice: Off';
    }
    if (led) {
        if (isMicActive) {
            led.classList.add('active');
        } else {
            led.classList.remove('active');
        }
    }
}

function disconnectLiveKit() {
    if (livekitRoom) {
        try { livekitRoom.disconnect(); } catch (e) {}
        livekitRoom = null;
    }
    isMicActive = false;
    cachedLiveKitToken = null;
    cachedLiveKitHost = null;
    currentVoiceRoomCode = null;
    updateVoiceButtonUI();
    disableBackgroundAudioKeepAlive();
    releaseScreenWakeLock();
    subscribedAudioElements.clear();
}

function updateVcParticipantsList() {
    const listDiv = document.getElementById('vc-participants-list');
    if (!listDiv) return;

    if (!window.appGlobals?.latestLobbySnapshot) {
        listDiv.innerHTML = 'No active lobby data.';
        return;
    }

    const lobby = window.appGlobals.latestLobbySnapshot;
    const vcUsers = [];
    (lobby.players || []).forEach(p => { if (p.inVC) vcUsers.push({ username: p.username, isMuted: p.isMuted }); });
    (lobby.spectators || []).forEach(s => { if (s.inVC) vcUsers.push({ username: s.username, isMuted: s.isMuted }); });

    if (vcUsers.length === 0) {
        listDiv.innerHTML = 'No one currently in voice chat.';
    } else {
        listDiv.innerHTML = '<ul>' + vcUsers.map(u => `<li style="margin-bottom:4px;"><b>${u.username}</b> ${u.isMuted ? '🔇 (Muted)' : '🎙️ (Active)'}</li>`).join('') + '</ul>';
    }
}

function triggerVoiceReconnect() {
    if (cachedLiveKitToken && cachedLiveKitHost) {
        connectLiveKit(cachedLiveKitToken, cachedLiveKitHost, currentVoiceRoomCode);
        showCenterNotification("Reconnecting lobby voice chat...");
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        if (livekitRoom && livekitRoom.state === 'connected') {
            requestScreenWakeLock();
            enableBackgroundAudioKeepAlive();
        } else if (cachedLiveKitToken && cachedLiveKitHost && window.appGlobals?.currentJoinedCode) {
            connectLiveKit(cachedLiveKitToken, cachedLiveKitHost, window.appGlobals.currentJoinedCode);
        }
    }
});
