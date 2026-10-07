// js/voice.js

let liveKitRoom = null;
let currentVoiceToken = null;
let currentVoiceHost = null;
let voiceChatVolume = 1.0;
let preferredAudioOutputDeviceId = 'default';

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

// Attach output device routing (supports routing to phone speaker / Bluetooth)
async function applyAudioOutputDevice(audioElement) {
    if (!audioElement || typeof audioElement.setSinkId !== 'function') return;
    try {
        await audioElement.setSinkId(preferredAudioOutputDeviceId);
    } catch (err) {
        console.warn('[Voice] setSinkId not supported or failed, falling back to default:', err);
    }
}

async function connectToVoiceChat(host, token) {
    if (!host || !token) {
        console.warn('[Voice] Cannot connect: Missing host or token');
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

        liveKitRoom = new LivekitClient.Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        liveKitRoom.on(LivekitClient.RoomEvent.TrackSubscribed, async (track, publication, participant) => {
            if (track.kind === LivekitClient.Track.Kind.Audio) {
                const element = track.attach();
                element.volume = voiceChatVolume;
                element.id = `lk-audio-${participant.identity}`;
                document.body.appendChild(element);
                await applyAudioOutputDevice(element);
                updateVcParticipantsList();
            }
        });

        liveKitRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(el => el.remove());
            updateVcParticipantsList();
        });

        liveKitRoom.on(LivekitClient.RoomEvent.ParticipantConnected, () => updateVcParticipantsList());
        liveKitRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => updateVcParticipantsList());

        liveKitRoom.on(LivekitClient.RoomEvent.Disconnected, () => {
            updateVoiceUiState(false, false);
            updateVcParticipantsList();
        });

        await liveKitRoom.connect(wsUrl, token);
        console.log('[Voice] Connected to LiveKit room');

        // Requirement 1: Microphone activated and immediately placed into muted state
        try {
            await liveKitRoom.localParticipant.setMicrophoneEnabled(true);
            await liveKitRoom.localParticipant.setMicrophoneEnabled(false);
        } catch (micErr) {
            console.warn('[Voice] Mic initialization deferred:', micErr);
        }

        // Inform UI and websocket that user is connected and muted
        updateVoiceUiState(true, false);
        updateVcParticipantsList();
        populateAudioOutputDevices();

        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({
                type: 'VC_STATUS_UPDATE',
                inVC: true,
                isMuted: true
            });
        }
    } catch (err) {
        console.error('[Voice] LiveKit connection error:', err);
        updateVoiceUiState(false, false);
    }
}

// Requirement 2: Detect Bluetooth / peripheral disconnect and fall back to speaker
if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
    navigator.mediaDevices.ondevicechange = async () => {
        console.log('[Voice] Audio device change detected (e.g. Bluetooth disconnect)');
        await populateAudioOutputDevices();

        // Check if preferred output still exists; if not, route back to default/phone speaker
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const stillExists = devices.some(d => d.kind === 'audiooutput' && d.deviceId === preferredAudioOutputDeviceId);

            if (!stillExists) {
                preferredAudioOutputDeviceId = 'default';
                const outputSelect = document.getElementById('audio-output-select');
                if (outputSelect) outputSelect.value = 'default';
            }

            // Re-apply sink ID to all active room audio elements
            const audioElements = document.querySelectorAll('audio[id^="lk-audio-"]');
            for (const el of audioElements) {
                await applyAudioOutputDevice(el);
            }
        } catch (err) {
            console.warn('[Voice] Error updating audio route on device change:', err);
        }
    };
}

async function populateAudioOutputDevices() {
    const select = document.getElementById('audio-output-select');
    if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');

        select.innerHTML = '';
        if (outputs.length === 0) {
            const opt = document.createElement('option');
            opt.value = 'default';
            opt.text = 'Default Phone Speaker';
            select.appendChild(opt);
            return;
        }

        outputs.forEach((device, idx) => {
            const opt = document.createElement('option');
            opt.value = device.deviceId;
            opt.text = device.label || (idx === 0 ? 'Phone Speaker / Default' : `Speaker ${idx + 1}`);
            select.appendChild(opt);
        });

        select.value = preferredAudioOutputDeviceId;
    } catch (e) {
        console.warn('[Voice] Could not enumerate audio output devices:', e);
    }
}

async function setAudioOutputDevice(deviceId) {
    preferredAudioOutputDeviceId = deviceId || 'default';
    const audioElements = document.querySelectorAll('audio[id^="lk-audio-"]');
    for (const el of audioElements) {
        await applyAudioOutputDevice(el);
    }
}

async function toggleVoiceOnOff() {
    if (!liveKitRoom || liveKitRoom.state !== LivekitClient.ConnectionState.Connected) {
        if (currentVoiceHost && currentVoiceToken) {
            await connectToVoiceChat(currentVoiceHost, currentVoiceToken);
        }
        return;
    }

    const isEnabled = liveKitRoom.localParticipant.isMicrophoneEnabled;
    try {
        await liveKitRoom.localParticipant.setMicrophoneEnabled(!isEnabled);
        const micActive = !isEnabled;
        updateVoiceUiState(true, micActive);

        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({
                type: 'VC_STATUS_UPDATE',
                inVC: true,
                isMuted: !micActive
            });
        }
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
            led.style.background = '#22c55e';
        } else if (connected) {
            led.className = 'led-indicator';
            led.style.background = '#f59e0b';
        } else {
            led.className = 'led-indicator';
            led.style.background = '#64748b';
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
    }
}

function disconnectLiveKit() {
    if (liveKitRoom) {
        liveKitRoom.disconnect();
        liveKitRoom = null;
    }
    updateVoiceUiState(false, false);
}
