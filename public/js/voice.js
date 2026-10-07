// public/js/voice.js
let livekitRoom = null;
let isMicActive = false;
let currentVoiceRoomCode = null;
let cachedLiveKitToken = null;
let cachedLiveKitHost = null;

// Background keep-alive audio element & WakeLock
let backgroundKeepAliveAudio = null;
let wakeLock = null;

// Safe accessor for LiveKit Client SDK from CDN
function getLiveKitSDK() {
    return window.LivekitClient || window.LiveKitClient || (window.livekit?.Room ? window.livekit : null);
}

/**
 * Activates an audible near-silent audio loop and MediaSession metadata
 * to grant the browser PWA background audio execution permissions.
 */
function enableBackgroundAudioKeepAlive() {
    try {
        if (!backgroundKeepAliveAudio) {
            // Low-volume 1-second silent WAV base64 loop
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
    } catch (e) {
        console.warn("Background audio keep-alive notice:", e);
    }
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

/**
 * Automatically joins the LiveKit voice room for the current lobby.
 * Always initializes in a MUTED state on entry.
 */
async function connectLiveKit(token, host, lobbyCode) {
    if (!token || !host) return;

    const LK = getLiveKitSDK();
    if (!LK) {
        console.warn("LiveKit client SDK not loaded. Voice chat disabled.");
        return;
    }

    cachedLiveKitToken = token;
    cachedLiveKitHost = host;
    currentVoiceRoomCode = lobbyCode || window.appGlobals?.currentJoinedCode;

    // Disconnect if already connected to an existing room
    if (livekitRoom) {
        try {
            await livekitRoom.disconnect();
        } catch (e) {}
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

        // Attach remote incoming audio streams
        livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track, pub, participant) => {
            if (track.kind === LK.Track.Kind.Audio || track.kind === 'audio') {
                const audioElem = track.attach();
                audioElem.autoplay = true;
                audioElem.playsInline = true;
                audioElem.setAttribute('playsinline', '');
                audioElem.setAttribute('webkit-playsinline', '');
                document.body.appendChild(audioElem);
            }
        });

        // Clean up detached remote audio streams
        livekitRoom.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(el => el.remove());
        });

        livekitRoom.on(LK.RoomEvent.Disconnected, () => {
            isMicActive = false;
            updateVoiceButtonUI();
            disableBackgroundAudioKeepAlive();
            releaseScreenWakeLock();
        });

        // Connect specifically to the lobby room
        await livekitRoom.connect(host, token);

        // Ensure player is MUTED by default upon joining while keeping connection open
        await livekitRoom.localParticipant.setMicrophoneEnabled(false);
        isMicActive = false;
        updateVoiceButtonUI();

        // Start background keep-alive audio & wake lock to prevent background drop
        enableBackgroundAudioKeepAlive();
        requestScreenWakeLock();

        // Broadcast muted in-VC status to the server
        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({ type: 'VC_STATUS_UPDATE', inVC: true, isMuted: true });
        }
    } catch (err) {
        console.warn("LiveKit auto-join notice:", err);
        isMicActive = false;
        updateVoiceButtonUI();
    }
}

/**
 * Toggles microphone recording on/off via LiveKit local participant tracks.
 * Does NOT disconnect from the room.
 */
async function toggleVoiceOnOff() {
    const LK = getLiveKitSDK();

    // If not connected, attempt auto-reconnect using cached session credentials
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
            // MUTE MICROPHONE (Stops publishing mic stream; preserves room connection & incoming audio)
            await livekitRoom.localParticipant.setMicrophoneEnabled(false);
            isMicActive = false;
        } else {
            // UNMUTE MICROPHONE (Enables publishing mic stream)
            if (livekitRoom.startAudio) {
                await livekitRoom.startAudio();
            }
            await livekitRoom.localParticipant.setMicrophoneEnabled(true);
            isMicActive = true;
        }

        updateVoiceButtonUI();

        // Sync mute status with seat nameplate badge
        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({ type: 'VC_STATUS_UPDATE', inVC: true, isMuted: !isMicActive });
        }
    } catch (err) {
        console.error("Microphone hardware toggle error:", err);
        isMicActive = false;
        updateVoiceButtonUI();
        showCenterNotification("Microphone permission required.");
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Backwards compatibility alias
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

/**
 * Completely disconnects and cleans up the voice session.
 * Called when leaving the lobby or resetting to the main menu.
 */
function disconnectLiveKit() {
    if (livekitRoom) {
        try {
            livekitRoom.disconnect();
        } catch (e) {}
        livekitRoom = null;
    }
    isMicActive = false;
    cachedLiveKitToken = null;
    cachedLiveKitHost = null;
    currentVoiceRoomCode = null;
    updateVoiceButtonUI();
    disableBackgroundAudioKeepAlive();
    releaseScreenWakeLock();
}

function openVcParticipantsModal() {
    const listDiv = document.getElementById('vc-participants-list');
    if (!listDiv) return;

    if (!window.appGlobals?.latestLobbySnapshot) {
        listDiv.innerHTML = 'No active lobby data.';
        toggleModal('vc-participants-modal');
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
    toggleModal('vc-participants-modal');
}

function triggerVoiceReconnect() {
    if (cachedLiveKitToken && cachedLiveKitHost) {
        connectLiveKit(cachedLiveKitToken, cachedLiveKitHost, currentVoiceRoomCode);
        showCenterNotification("Reconnecting lobby voice chat...");
    }
    toggleModal('vc-participants-modal');
}

// Background tab restoration handler
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // Re-acquire screen wake lock on return
        if (livekitRoom && livekitRoom.state === 'connected') {
            requestScreenWakeLock();
            enableBackgroundAudioKeepAlive();
        } else if (cachedLiveKitToken && cachedLiveKitHost && window.appGlobals?.currentJoinedCode) {
            // Re-establish session if dropped during an extended background period
            connectLiveKit(cachedLiveKitToken, cachedLiveKitHost, window.appGlobals.currentJoinedCode);
        }
    }
});
