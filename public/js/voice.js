// public/js/voice.js

let livekitRoom = null;
let isLiveKitConnected = false;
let isVoiceChatActive = false;
let isConnectingVoice = false;
let latestLiveKitHost = null;
let latestLiveKitToken = null;
let currentVoiceVolume = 1.0;
let selectedAudioOutputId = 'default';

// Background audio keep-alive node to prevent mobile OS tab suspension
let keepAliveOscillator = null;
let keepAliveGainNode = null;

function getLiveKitSDK() {
    return window.LivekitClient || window.LiveKitClient || window.livekitClient || null;
}

/**
 * Creates an inaudible background audio loop to keep the audio session
 * active on mobile browsers when the app or tab is minimized.
 */
function startBackgroundKeepAliveOscillator() {
    try {
        if (typeof getAudioContext === 'function') {
            const ctx = getAudioContext();
            if (!ctx) return;
            if (ctx.state === 'suspended') ctx.resume();

            if (!keepAliveOscillator) {
                keepAliveOscillator = ctx.createOscillator();
                keepAliveGainNode = ctx.createGain();

                // Near-zero volume continuous loop keeps the hardware audio route alive
                keepAliveGainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
                keepAliveOscillator.frequency.setValueAtTime(440, ctx.currentTime);

                keepAliveOscillator.connect(keepAliveGainNode);
                keepAliveGainNode.connect(ctx.destination);

                keepAliveOscillator.start();
            }
        }
    } catch (e) {
        console.warn("[LiveKit] Could not initialize keep-alive oscillator:", e);
    }
}

function stopBackgroundKeepAliveOscillator() {
    try {
        if (keepAliveOscillator) {
            keepAliveOscillator.stop();
            keepAliveOscillator.disconnect();
            keepAliveOscillator = null;
        }
        if (keepAliveGainNode) {
            keepAliveGainNode.disconnect();
            keepAliveGainNode = null;
        }
    } catch (e) {}
}

// Accepts either (token, host) or (host, token) to prevent ordering bugs
async function connectLiveKit(arg1, arg2, roomCode) {
    let host = arg1;
    let token = arg2;

    if (typeof arg1 === 'string' && (arg1.startsWith('ey') || arg1.split('.').length === 3)) {
        token = arg1;
        host = arg2;
    }

    return connectToLiveKit(host, token, roomCode);
}

async function connectToLiveKit(host, token, roomCode) {
    if (!host || !token) {
        console.warn("[LiveKit] Host or Token is missing. Waiting for token grant...");
        return;
    }

    let cleanHost = host.trim();
    if (!cleanHost.startsWith('ws://') && !cleanHost.startsWith('wss://') && !cleanHost.startsWith('http://') && !cleanHost.startsWith('https://')) {
        cleanHost = 'wss://' + cleanHost;
    }

    latestLiveKitHost = cleanHost;
    latestLiveKitToken = token;

    const LK = getLiveKitSDK();
    if (!LK) {
        console.error("[LiveKit] SDK not loaded from CDN.");
        return;
    }

    if (isConnectingVoice) return;
    isConnectingVoice = true;

    try {
        if (livekitRoom) {
            try { await livekitRoom.disconnect(); } catch (e) {}
            livekitRoom = null;
        }

        livekitRoom = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === LK.Track.Kind.Audio || track.kind === 'audio') {
                const audioElem = track.attach();
                audioElem.autoplay = true;
                audioElem.playsInline = true;
                audioElem.volume = currentVoiceVolume;
                audioElem.setAttribute('playsinline', '');
                audioElem.setAttribute('webkit-playsinline', '');
                audioElem.classList.add('lk-remote-audio');

                // Route to currently selected speaker or Bluetooth output
                if (selectedAudioOutputId && typeof audioElem.setSinkId === 'function') {
                    audioElem.setSinkId(selectedAudioOutputId).catch(() => {
                        // Fallback to default phone speaker on failure
                        selectedAudioOutputId = 'default';
                        audioElem.setSinkId('default').catch(() => {});
                    });
                }

                document.body.appendChild(audioElem);
                refreshVoiceParticipantsList();
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(el => el.remove());
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.ParticipantConnected, () => {
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.ParticipantDisconnected, () => {
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.Disconnected, () => {
            isLiveKitConnected = false;
            isVoiceChatActive = false;
            stopBackgroundKeepAliveOscillator();
            updateVoiceUI();
            refreshVoiceParticipantsList();
        });

        await livekitRoom.connect(cleanHost, token);
        isLiveKitConnected = true;

        // Enter lobby muted by default
        await livekitRoom.localParticipant.setMicrophoneEnabled(false);
        isVoiceChatActive = false;
        updateVoiceUI();
        sendVCStatusInternal(true, true);
        refreshAudioOutputDevices();
        refreshVoiceParticipantsList();

        startBackgroundKeepAliveOscillator();
        console.log("[LiveKit] Successfully connected to room:", cleanHost);
    } catch (error) {
        console.error("[LiveKit] Connection error:", error);
        isLiveKitConnected = false;
        isVoiceChatActive = false;
        updateVoiceUI();
    } finally {
        isConnectingVoice = false;
    }
}

async function toggleVoiceOnOff() {
    if (!livekitRoom || !isLiveKitConnected) {
        if (latestLiveKitHost && latestLiveKitToken) {
            const btn = document.getElementById('vc-main-btn');
            if (btn) btn.innerText = 'Connecting...';
            await connectToLiveKit(latestLiveKitHost, latestLiveKitToken);
        } else {
            if (typeof initSocketAndSend === 'function') {
                initSocketAndSend({ type: 'REQUEST_LIVEKIT_TOKEN' });
            }
            return;
        }
    }

    if (!livekitRoom || !isLiveKitConnected) return;

    try {
        if (typeof getAudioContext === 'function') {
            const ctx = getAudioContext();
            if (ctx && ctx.state === 'suspended') ctx.resume();
        }

        if (isVoiceChatActive) {
            await livekitRoom.localParticipant.setMicrophoneEnabled(false);
            isVoiceChatActive = false;
            updateVoiceUI();
            sendVCStatusInternal(true, true);
        } else {
            if (livekitRoom.startAudio) await livekitRoom.startAudio();
            await livekitRoom.localParticipant.setMicrophoneEnabled(true);
            isVoiceChatActive = true;
            updateVoiceUI();
            sendVCStatusInternal(true, false);
            startBackgroundKeepAliveOscillator();
        }
    } catch (err) {
        console.error("[LiveKit] Mic toggle error:", err);
        isVoiceChatActive = false;
        updateVoiceUI();
        alert("Microphone permission denied or device not found.");
    }
}

const toggleLiveKitVoice = toggleVoiceOnOff;

function updateVoiceUI() {
    const btn = document.getElementById('vc-main-btn');
    const led = document.getElementById('vc-led');
    if (btn) {
        btn.innerText = isVoiceChatActive ? '🎙️ Voice: On' : '🎙️ Voice: Off';
    }
    if (led) {
        if (isVoiceChatActive) led.classList.add('active');
        else led.classList.remove('active');
    }
}

async function disconnectLiveKit() {
    stopBackgroundKeepAliveOscillator();
    if (livekitRoom) {
        try { await livekitRoom.disconnect(); } catch (e) {}
        livekitRoom = null;
    }
    isLiveKitConnected = false;
    isVoiceChatActive = false;
    updateVoiceUI();
    refreshVoiceParticipantsList();
}

function sendVCStatusInternal(inVC, isMuted) {
    if (typeof initSocketAndSend === 'function') {
        initSocketAndSend({ type: 'UPDATE_VC_STATUS', inVC, isMuted });
    }
}

function triggerVoiceReconnect() {
    if (latestLiveKitHost && latestLiveKitToken) {
        connectToLiveKit(latestLiveKitHost, latestLiveKitToken);
        if (typeof showCenterNotification === 'function') {
            showCenterNotification("Reconnecting voice chat...");
        }
    } else {
        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({ type: 'REQUEST_LIVEKIT_TOKEN' });
        }
    }
}

function setVoiceChatVolume(val) {
    currentVoiceVolume = parseFloat(val);
    const disp = document.getElementById('lk-vol-display');
    if (disp) disp.innerText = `${Math.round(currentVoiceVolume * 100)}%`;

    document.querySelectorAll('.lk-remote-audio').forEach(audioEl => {
        audioEl.volume = currentVoiceVolume;
    });
}

/**
 * Changes audio output route to Bluetooth, Headset, or Phone Speaker
 */
async function setAudioOutputDevice(deviceId) {
    selectedAudioOutputId = deviceId || 'default';
    const remoteAudios = document.querySelectorAll('.lk-remote-audio');

    for (const audioEl of remoteAudios) {
        if (typeof audioEl.setSinkId === 'function') {
            try {
                await audioEl.setSinkId(selectedAudioOutputId);
            } catch (err) {
                console.warn("[LiveKit] Unable to set audio sink on element:", err);
                // Graceful fallback to default phone speaker
                try { await audioEl.setSinkId('default'); } catch (e) {}
            }
        }
    }

    const select = document.getElementById('audio-output-select');
    if (select && select.value !== selectedAudioOutputId) {
        select.value = selectedAudioOutputId;
    }
}

/**
 * Enumerates audio devices, identifies Bluetooth accessories,
 * and handles fallbacks if a Bluetooth device is disconnected.
 */
async function refreshAudioOutputDevices() {
    const select = document.getElementById('audio-output-select');
    if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

        let isSelectedDeviceStillConnected = false;

        let optionsHtml = '<option value="default">Phone Speaker / Default</option>';
        audioOutputs.forEach((d, i) => {
            if (d.deviceId === 'default') return;

            const isBluetooth = d.label && (
                d.label.toLowerCase().includes('bluetooth') ||
                d.label.toLowerCase().includes('airpods') ||
                d.label.toLowerCase().includes('buds') ||
                d.label.toLowerCase().includes('headset') ||
                d.label.toLowerCase().includes('wireless')
            );

            const prefix = isBluetooth ? '🎧 Bluetooth: ' : '🔊 ';
            const label = d.label ? `${prefix}${d.label}` : `Speaker / Audio Output ${i + 1}`;

            if (d.deviceId === selectedAudioOutputId) {
                isSelectedDeviceStillConnected = true;
            }

            optionsHtml += `<option value="${d.deviceId}">${label}</option>`;
        });

        select.innerHTML = optionsHtml;

        // If previously selected Bluetooth device was disconnected, seamlessly fallback to phone speaker
        if (selectedAudioOutputId !== 'default' && !isSelectedDeviceStillConnected) {
            console.log("[LiveKit] Audio device disconnected. Reverting to Phone Speaker.");
            await setAudioOutputDevice('default');
            if (typeof showCenterNotification === 'function') {
                showCenterNotification("Audio route switched to Phone Speaker");
            }
        } else {
            select.value = selectedAudioOutputId;
        }
    } catch (e) {
        console.warn("[LiveKit] Device enumeration error:", e);
    }
}

function refreshVoiceParticipantsList() {
    const listDiv = document.getElementById('vc-participants-list');
    if (!listDiv) return;

    if (!livekitRoom || !isLiveKitConnected) {
        listDiv.innerHTML = 'Not connected to voice chat.';
        return;
    }

    const participants = [];
    if (livekitRoom.localParticipant) {
        const localName = livekitRoom.localParticipant.identity || livekitRoom.localParticipant.name || 'You';
        participants.push({ name: `${localName} (You)`, isMuted: !isVoiceChatActive });
    }

    if (livekitRoom.remoteParticipants) {
        livekitRoom.remoteParticipants.forEach(rp => {
            const isSpeaking = rp.isSpeaking;
            const hasAudio = rp.audioTrackPublications && rp.audioTrackPublications.size > 0;
            const rName = rp.identity || rp.name || 'Remote User';
            participants.push({ name: rName, isMuted: !hasAudio || !isSpeaking });
        });
    }

    if (participants.length === 0) {
        listDiv.innerHTML = 'No one currently in voice chat.';
    } else {
        listDiv.innerHTML = '<ul style="padding-left:14px; margin:0;">' + participants.map(u => `
            <li style="margin-bottom:3px;"><b>${u.name}</b> ${u.isMuted ? '🔇 (Muted)' : '🎙️ (Active)'}</li>
        `).join('') + '</ul>';
    }
}

// React instantly when Bluetooth headphones connect or disconnect
if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
    navigator.mediaDevices.ondevicechange = () => {
        refreshAudioOutputDevices();
    };
}

// Reactivate audio context and resume stream if browser tab becomes visible again
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isLiveKitConnected) {
        if (typeof getAudioContext === 'function') {
            const ctx = getAudioContext();
            if (ctx && ctx.state === 'suspended') {
                ctx.resume();
            }
        }
        startBackgroundKeepAliveOscillator();
    }
});
