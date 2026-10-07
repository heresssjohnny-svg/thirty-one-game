// public/js/voice.js
let livekitRoom = null;
let isMicActive = false;
let currentVoiceRoomCode = null;
let cachedLiveKitToken = null;
let cachedLiveKitHost = null;

// Safe accessor for LiveKit Client SDK from CDN
function getLiveKitSDK() {
    return window.LivekitClient || window.LiveKitClient || (window.livekit?.Room ? window.livekit : null);
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
        });

        // Connect specifically to the lobby room
        await livekitRoom.connect(host, token);

        // Ensure player is MUTED by default upon joining
        await livekitRoom.localParticipant.setMicrophoneEnabled(false);
        isMicActive = false;
        updateVoiceButtonUI();

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
 */
async function toggleVoiceOnOff() {
    const LK = getLiveKitSDK();

    // If not connected, attempt auto-reconnect using cached session credentials
    if (!livekitRoom || livekitRoom.state !== 'connected') {
        if (cachedLiveKitToken && cachedLiveKitHost) {
            showCenterNotification("Connecting voice room...");
            await connectLiveKit(cachedLiveKitToken, cachedLiveKitHost, currentVoiceRoomCode);
        } else {
            showCenterNotification("Voice server unavailable.");
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
            // MUTE MICROPHONE
            await livekitRoom.localParticipant.setMicrophoneEnabled(false);
            isMicActive = false;
        } else {
            // UNMUTE MICROPHONE
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
