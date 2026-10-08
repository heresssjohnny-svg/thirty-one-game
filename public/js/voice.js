// public/js/voice.js - LiveKit SFU Client Coordinator & Voice Settings

let liveKitRoom = null;
let isMicMuted = true;
let isVoiceConnected = false;
let currentVoiceVolume = 1.0;
let currentSelectedAudioOutputDeviceId = '';

// --- 1. Connection Lifecycle ---

async function connectToLiveKitVoice(serverUrl, token) {
    if (!serverUrl || !token) return;

    if (liveKitRoom) {
        await leaveLiveKitVoice();
    }

    try {
        const RoomClass = window.LivekitClient ? window.LivekitClient.Room : (window.LiveKit ? window.LiveKit.Room : null);
        if (!RoomClass) return;

        liveKitRoom = new RoomClass({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        // Track Subscribed (Receiving remote audio)
        liveKitRoom.on(window.LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'audio') {
                const audioElement = track.attach();
                audioElement.id = `audio-${participant.identity}`;
                audioElement.volume = currentVoiceVolume;

                if (currentSelectedAudioOutputDeviceId && typeof audioElement.setSinkId === 'function') {
                    audioElement.setSinkId(currentSelectedAudioOutputDeviceId).catch(() => {});
                }

                document.body.appendChild(audioElement);
            }
        });

        // Track Unsubscribed (Cleaning up remote audio element)
        liveKitRoom.on(window.LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            track.detach().forEach(el => el.remove());
        });

        // Connection State Changes
        liveKitRoom.on(window.LivekitClient.RoomEvent.Disconnected, () => {
            isVoiceConnected = false;
            updateVoiceStatusUI();
        });

        await liveKitRoom.connect(serverUrl, token);
        isVoiceConnected = true;

        // Default to muted upon entering
        await liveKitRoom.localParticipant.setMicrophoneEnabled(false);
        isMicMuted = true;

        updateVoiceStatusUI();
        refreshAudioOutputDevices();
    } catch (err) {
        isVoiceConnected = false;
        updateVoiceStatusUI();
    }
}

async function leaveLiveKitVoice() {
    if (liveKitRoom) {
        try {
            await liveKitRoom.disconnect();
        } catch (e) {}
        liveKitRoom = null;
    }

    // Clean up all detached audio elements
    document.querySelectorAll("audio[id^='audio-']").forEach(el => el.remove());

    isVoiceConnected = false;
    isMicMuted = true;
    updateVoiceStatusUI();
}

// --- 2. Mic Mute / Unmute Toggle ---

async function toggleVoiceOnOff() {
    if (!liveKitRoom || !isVoiceConnected) {
        // Trigger reconnection handshake if room exists in snapshot
        if (window.latestLobbySnapshot?.code && window.clientState?.livekitToken) {
            connectToLiveKitVoice(window.latestLobbySnapshot.livekitHost, window.clientState.livekitToken);
        }
        return;
    }

    try {
        isMicMuted = !isMicMuted;
        await liveKitRoom.localParticipant.setMicrophoneEnabled(!isMicMuted);
        updateVoiceStatusUI();

        // Broadcast mute state update to table
        if (typeof dispatchSocketAction === 'function') {
            dispatchSocketAction({ type: 'UPDATE_MUTE_STATUS', isMuted: isMicMuted });
        }
    } catch (err) {
        console.warn("Failed to toggle mic state:", err);
    }
}

function updateVoiceStatusUI() {
    const led = document.getElementById('vc-led');
    const mainBtn = document.getElementById('vc-main-btn');

    if (!isVoiceConnected) {
        if (led) {
            led.className = 'led-indicator';
            led.style.background = '#64748b'; // Gray / Off
        }
        if (mainBtn) mainBtn.innerText = '🎙️ Voice: Off';
        return;
    }

    if (isMicMuted) {
        if (led) {
            led.className = 'led-indicator';
            led.style.background = '#f59e0b'; // Amber / Muted
        }
        if (mainBtn) mainBtn.innerText = '🎙️ Muted';
    } else {
        if (led) {
            led.className = 'led-indicator active';
            led.style.background = '#10b981'; // Green / Transmitting
        }
        if (mainBtn) mainBtn.innerText = '🎙️ Live';
    }
}

// --- 3. Audio Device Selector & Volume Sliders ---

async function refreshAudioOutputDevices() {
    const select = document.getElementById('audio-output-select');
    if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

        select.innerHTML = '';
        if (audioOutputs.length === 0) {
            select.innerHTML = '<option value="">Default Speaker</option>';
            return;
        }

        audioOutputs.forEach((device, index) => {
            const opt = document.createElement('option');
            opt.value = device.deviceId;
            opt.text = device.label || `Speaker / Output ${index + 1}`;
            if (device.deviceId === currentSelectedAudioOutputDeviceId) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });

        select.onchange = (e) => {
            setAudioOutputDevice(e.target.value);
        };
    } catch (e) {}
}

async function setAudioOutputDevice(deviceId) {
    currentSelectedAudioOutputDeviceId = deviceId;
    const remoteAudios = document.querySelectorAll("audio[id^='audio-']");
    for (const audioEl of remoteAudios) {
        if (typeof audioEl.setSinkId === 'function') {
            try {
                await audioEl.setSinkId(deviceId);
            } catch (err) {}
        }
    }
}

function setVoiceChatVolume(val) {
    currentVoiceVolume = Math.max(0, Math.min(1, Number(val)));
    document.querySelectorAll("audio[id^='audio-']").forEach(el => {
        el.volume = currentVoiceVolume;
    });
}

// Attach to window
window.connectToLiveKitVoice = connectToLiveKitVoice;
window.leaveLiveKitVoice = leaveLiveKitVoice;
window.toggleVoiceOnOff = toggleVoiceOnOff;
window.updateVoiceStatusUI = updateVoiceStatusUI;
window.setVoiceChatVolume = setVoiceChatVolume;
window.refreshAudioOutputDevices = refreshAudioOutputDevices;
window.setAudioOutputDevice = setAudioOutputDevice;
