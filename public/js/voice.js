// js/voice.js

let liveKitRoom = null;
let currentVoiceToken = null;
let currentVoiceHost = null;
let voiceChatVolume = 1.0;

function formatLiveKitUrl(hostUrl) {
    if (!hostUrl) return '';
    let url = hostUrl.trim();
    if (url.startsWith('https://')) {
        url = url.replace('https://', 'wss://');
    } else if (url.startsWith('http://')) {
        url = url.replace('http://', 'ws://');
    } else if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
        url = 'wss://' + url;
    }
    return url;
}

async function connectToVoiceChat(host, token) {
    if (!host || !token) {
        console.warn('[Voice] Cannot connect: Missing host or token');
        showCenterNotification("Voice chat credentials unavailable");
        updateVoiceUiState(false, true);
        return;
    }

    currentVoiceHost = host;
    currentVoiceToken = token;

    const wsUrl = formatLiveKitUrl(host);

    try {
        if (liveKitRoom) {
            await liveKitRoom.disconnect();
            liveKitRoom = null;
        }

        // LiveKit Client SDK instance
        liveKitRoom = new LivekitClient.Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        // Track audio level / publication events
        liveKitRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === LivekitClient.Track.Kind.Audio) {
                const element = track.attach();
                element.volume = voiceChatVolume;
                element.id = `lk-audio-${participant.identity}`;
                document.body.appendChild(element);
                updateVcParticipantsList();
            }
        });

        liveKitRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            track.detach().forEach(el => el.remove());
            updateVcParticipantsList();
        });

        liveKitRoom.on(LivekitClient.RoomEvent.ParticipantConnected, () => updateVcParticipantsList());
        liveKitRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => updateVcParticipantsList());

        liveKitRoom.on(LivekitClient.RoomEvent.Disconnected, () => {
            updateVoiceUiState(false, true);
            updateVcParticipantsList();
        });

        await liveKitRoom.connect(wsUrl, token);
        console.log('[Voice] Connected to LiveKit room');

        // Publish local mic (muted by default until toggled)
        await liveKitRoom.localParticipant.setMicrophoneEnabled(false);
        updateVoiceUiState(true, false);
        updateVcParticipantsList();
    } catch (err) {
        console.error('[Voice] LiveKit connection error:', err);
        showCenterNotification("Voice room unavailable");
        updateVoiceUiState(false, true);
    }
}

async function toggleVoiceOnOff() {
    if (!liveKitRoom || liveKitRoom.state !== LivekitClient.ConnectionState.Connected) {
        if (currentVoiceHost && currentVoiceToken) {
            await connectToVoiceChat(currentVoiceHost, currentVoiceToken);
        } else {
            showCenterNotification("Voice server not configured.");
        }
        return;
    }

    const isEnabled = liveKitRoom.localParticipant.isMicrophoneEnabled;
    try {
        await liveKitRoom.localParticipant.setMicrophoneEnabled(!isEnabled);
        const micActive = !isEnabled;
        updateVoiceUiState(true, micActive);

        initSocketAndSend({
            type: 'VC_STATUS_UPDATE',
            inVC: true,
            isMuted: !micActive
        });
    } catch (err) {
        console.error('[Voice] Failed to toggle mic:', err);
    }
}

function updateVoiceUiState(connected, micActive) {
    const led = document.getElementById('vc-led');
    const mainBtn = document.getElementById('vc-main-btn');

    if (led) {
        if (connected && micActive) {
            led.className = 'led-indicator active';
        } else if (connected) {
            led.className = 'led-indicator';
            led.style.background = '#f59e0b'; // Amber for muted/listening
        } else {
            led.className = 'led-indicator';
            led.style.background = '#64748b'; // Gray for off
        }
    }

    if (mainBtn) {
        if (!connected) {
            mainBtn.innerText = '🎙️ Voice: Off';
        } else if (micActive) {
            mainBtn.innerText = '🎙️ Mic: On';
        } else {
            mainBtn.innerText = '🔇 Mic: Muted';
        }
    }
}

function setVoiceChatVolume(val) {
    voiceChatVolume = parseFloat(val);
    const display = document.getElementById('lk-vol-display');
    if (display) display.innerText = `${Math.round(voiceChatVolume * 100)}%`;

    document.querySelectorAll('audio[id^="lk-audio-"]').forEach(el => {
        el.volume = voiceChatVolume;
    });
}

function updateVcParticipantsList() {
    const container = document.getElementById('vc-participants-list');
    if (!container) return;

    if (!liveKitRoom || liveKitRoom.state !== LivekitClient.ConnectionState.Connected) {
        container.innerHTML = '<span style="color:#64748b;">Not connected to voice chat.</span>';
        return;
    }

    const participants = Array.from(liveKitRoom.remoteParticipants.values());
    if (participants.length === 0) {
        container.innerHTML = '<span>You are alone in voice chat.</span>';
        return;
    }

    container.innerHTML = participants.map(p => {
        const isSpeaking = p.isSpeaking ? '🗣️' : '';
        const isMuted = !p.isMicrophoneEnabled ? '🔇' : '🎙️';
        return `<div style="display:flex; justify-content:space-between; margin-bottom:2px;">
            <span>${p.identity} ${isSpeaking}</span>
            <span>${isMuted}</span>
        </div>`;
    }).join('');
}

function triggerVoiceReconnect() {
    if (currentVoiceHost && currentVoiceToken) {
        connectToVoiceChat(currentVoiceHost, currentVoiceToken);
    } else {
        showCenterNotification("No voice session to reconnect.");
    }
}

function disconnectLiveKit() {
    if (liveKitRoom) {
        liveKitRoom.disconnect();
        liveKitRoom = null;
    }
    updateVoiceUiState(false, false);
}
