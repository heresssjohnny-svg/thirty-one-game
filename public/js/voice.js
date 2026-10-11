// public/js/voice.js - Persistent LiveKit Voice Engine, Bluetooth Routing & Background Keep-Alive

let livekitRoom = null;
let isLiveKitConnected = false;
let isMicActive = false; // Controls local microphone transmission state
let isConnectingVoice = false;
let latestLiveKitHost = null;
let latestLiveKitToken = null;
let currentVoiceVolume = 1.0;
let selectedAudioOutputId = 'default';

// Background audio keep-alive: HTML5 Audio loop + AudioContext to bypass mobile 5-second sleep
let silentAudioElement = null;
let keepAliveOscillator = null;
let keepAliveGainNode = null;
let keepAliveAudioContext = null;

// 1-second inaudible WAV base64 payload to hold mobile OS background media priority
const SILENT_WAV_BASE64 = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

function getLiveKitSDK() {
    return window.LivekitClient || window.LiveKitClient || window.livekitClient || null;
}

/**
 * Bypasses mobile OS 5-second background sleep by combining a looped HTML5 Audio element,
 * system MediaSession registration, and a fallback Web Audio oscillator.
 */
function startBackgroundKeepAliveOscillator() {
    // 1. HTML5 Background Media Loop (Prevents iOS Safari & Android from killing the tab)
    try {
        if (!silentAudioElement) {
            silentAudioElement = new Audio(SILENT_WAV_BASE64);
            silentAudioElement.loop = true;
            silentAudioElement.volume = 0.01;
            silentAudioElement.setAttribute('playsinline', '');
            silentAudioElement.setAttribute('webkit-playsinline', '');
        }

        silentAudioElement.play().then(() => {
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: "Voice Chat Active",
                    artist: "Blitz 31",
                    album: "Live Game Voice"
                });
            }
        }).catch(err => {
            console.warn("[LiveKit] Background audio autoplay waiting for touch unlock:", err);
        });
    } catch (err) {
        console.warn("[LiveKit] Could not initialize HTML5 silent keep-alive:", err);
    }

    // 2. Web Audio Context keep-alive
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;

        if (!keepAliveAudioContext) {
            keepAliveAudioContext = new AudioCtx();
        }

        if (keepAliveAudioContext.state === 'suspended') {
            keepAliveAudioContext.resume().catch(() => {});
        }

        if (!keepAliveOscillator) {
            keepAliveOscillator = keepAliveAudioContext.createOscillator();
            keepAliveGainNode = keepAliveAudioContext.createGain();

            keepAliveGainNode.gain.setValueAtTime(0.00001, keepAliveAudioContext.currentTime);
            keepAliveOscillator.frequency.setValueAtTime(440, keepAliveAudioContext.currentTime);

            keepAliveOscillator.connect(keepAliveGainNode);
            keepAliveGainNode.connect(keepAliveAudioContext.destination);

            keepAliveOscillator.start();
        }
    } catch (e) {
        console.warn("[LiveKit] Could not initialize keep-alive oscillator:", e);
    }
}

function stopBackgroundKeepAliveOscillator() {
    // Teardown HTML5 audio keep-alive
    try {
        if (silentAudioElement) {
            silentAudioElement.pause();
            silentAudioElement.currentTime = 0;
            silentAudioElement = null;
        }
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'none';
        }
    } catch (e) {}

    // Teardown Web Audio oscillator
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

/**
 * Universal token fetcher and connector.
 * Accepts either (token, host, roomCode) or (host, token, roomCode).
 */
async function connectLiveKit(arg1, arg2, roomCode) {
    let host = arg1;
    let token = arg2;

    if (typeof arg1 === 'string' && (arg1.startsWith('ey') || arg1.split('.').length === 3)) {
        token = arg1;
        host = arg2;
    }

    return connectToLiveKit(host, token, roomCode);
}

/**
 * Connects to the LiveKit voice room and stays connected at all times.
 * Disconnects any prior room to guarantee strict lobby isolation.
 */
async function connectToLiveKit(host, token, roomCode) {
    const targetRoom = roomCode || (window.appGlobals && window.appGlobals.currentJoinedCode) || 'lobby';

    if (!host || !token) {
        await requestVoiceToken(targetRoom);
        return;
    }

    let cleanHost = host.trim();
    if (!cleanHost.startsWith('ws://') && !cleanHost.startsWith('wss://') && !cleanHost.startsWith('http://') && !cleanHost.startsWith('https://')) {
        cleanHost = 'wss://' + cleanHost;
    }

    // If already connected to this exact lobby room, do not reconnect
    if (livekitRoom && isLiveKitConnected) {
        if (livekitRoom.name === targetRoom && latestLiveKitToken === token) {
            return;
        }
        console.log(`[LiveKit] Switching from room ${livekitRoom.name} to ${targetRoom}...`);
        try {
            await livekitRoom.disconnect();
        } catch (e) {}
        livekitRoom = null;
        isLiveKitConnected = false;
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
        livekitRoom = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
            stopLocalTrackOnUnpublish: false, // Prevents track destruction on mobile background sleep
            reconnectPolicy: {
                maxAttempts: 15,
                initialDelay: 200,
                maxDelay: 2000
            },
            audioCaptureDefaults: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        // Remote participant audio playback
        livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === LK.Track.Kind.Audio || track.kind === 'audio') {
                const audioElem = track.attach();
                audioElem.autoplay = true;
                audioElem.playsInline = true;
                audioElem.volume = currentVoiceVolume;
                audioElem.setAttribute('playsinline', '');
                audioElem.setAttribute('webkit-playsinline', '');
                audioElem.classList.add('lk-remote-audio');

                // Route audio through selected output (Bluetooth speaker / phone speaker)
                if (selectedAudioOutputId && typeof audioElem.setSinkId === 'function') {
                    audioElem.setSinkId(selectedAudioOutputId).catch(() => {
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
            isMicActive = false;
            stopBackgroundKeepAliveOscillator();
            updateVoiceUI();
            sendVCStatusInternal(false, true);
            refreshVoiceParticipantsList();

            // Auto-reconnect if dropped unexpectedly during an active match
            if (window.clientState && window.clientState.gameState !== 'mainMenu') {
                setTimeout(triggerVoiceReconnect, 1500);
            }
        });

        await livekitRoom.connect(cleanHost, token);
        isLiveKitConnected = true;

        // Check whether this is a mid-game window reopen/reconnect or an initial connection
        const savedMicState = localStorage.getItem('blitz31_mic_state');

        if (savedMicState === 'true') {
            // Mid-game window reopen/reconnection: restore active microphone
            try {
                if (livekitRoom.startAudio) {
                    await livekitRoom.startAudio();
                }
                await livekitRoom.localParticipant.setMicrophoneEnabled(true);
                isMicActive = true;
                sendVCStatusInternal(true, false);
            } catch (micErr) {
                console.warn("[LiveKit] Reopening window mic restore blocked:", micErr);
                await livekitRoom.localParticipant.setMicrophoneEnabled(false);
                isMicActive = false;
                localStorage.setItem('blitz31_mic_state', 'false');
                sendVCStatusInternal(true, true);
            }
        } else {
            // Initial connection: always connect muted by default
            await livekitRoom.localParticipant.setMicrophoneEnabled(false);
            isMicActive = false;
            localStorage.setItem('blitz31_mic_state', 'false');
            sendVCStatusInternal(true, true);
        }

        startBackgroundKeepAliveOscillator();
        updateVoiceUI();
        refreshAudioOutputDevices();
        refreshVoiceParticipantsList();

        console.log(`[LiveKit] Connected to isolated lobby room: ${targetRoom}`);
    } catch (error) {
        console.error("[LiveKit] Connection failed:", error);
        isLiveKitConnected = false;
        isMicActive = false;
        updateVoiceUI();
    } finally {
        isConnectingVoice = false;
    }
}

/**
 * Toggles local microphone state only. The room connection remains active at all times.
 */
async function toggleVoiceOnOff() {
    startBackgroundKeepAliveOscillator();

    // If room is not yet connected, establish persistent connection first
    if (!livekitRoom || !isLiveKitConnected) {
        updateVoiceButtonState('Connecting...');
        if (latestLiveKitHost && latestLiveKitToken) {
            await connectToLiveKit(latestLiveKitHost, latestLiveKitToken);
        } else {
            await requestVoiceToken();
            return;
        }
    }

    if (!livekitRoom || !isLiveKitConnected) return;

    try {
        if (keepAliveAudioContext && keepAliveAudioContext.state === 'suspended') {
            await keepAliveAudioContext.resume();
        }

        if (isMicActive) {
            // Mute Microphone
            await livekitRoom.localParticipant.setMicrophoneEnabled(false);
            isMicActive = false;
            localStorage.setItem('blitz31_mic_state', 'false');
            updateVoiceUI();
            sendVCStatusInternal(true, true);
        } else {
            // Unmute Microphone
            if (livekitRoom.startAudio) {
                await livekitRoom.startAudio();
            }
            await livekitRoom.localParticipant.setMicrophoneEnabled(true);
            isMicActive = true;
            localStorage.setItem('blitz31_mic_state', 'true');
            updateVoiceUI();
            sendVCStatusInternal(true, false);
        }
    } catch (err) {
        console.error("[LiveKit] Mic toggle error:", err);
        isMicActive = false;
        localStorage.setItem('blitz31_mic_state', 'false');
        updateVoiceUI();
        sendVCStatusInternal(isLiveKitConnected, true);
        alert("Microphone permission denied or audio input device unavailable.");
    }
}

const toggleLiveKitVoice = toggleVoiceOnOff;

/**
 * Updates Voice Button and LED Indicators
 */
function updateVoiceUI() {
    const btnMain = document.getElementById('vc-main-btn');
    const btnHud = document.getElementById('voice-btn') || document.getElementById('voice-toggle-btn');
    const led = document.getElementById('vc-led');

    const label = isMicActive ? '🎙️ Mic: On' : '🔇 Mic: Off';

    if (btnMain) {
        btnMain.innerText = label;
        btnMain.classList.toggle('active', isMicActive);
    }
    if (btnHud) {
        btnHud.innerText = label;
        btnHud.classList.toggle('active', isMicActive);
        btnHud.classList.toggle('ready-active', isMicActive);
    }
    if (led) {
        led.classList.toggle('active', isMicActive);
    }
}

function updateVoiceButtonState(text) {
    const btnMain = document.getElementById('vc-main-btn');
    const btnHud = document.getElementById('voice-btn') || document.getElementById('voice-toggle-btn');
    if (btnMain) btnMain.innerText = text;
    if (btnHud) btnHud.innerText = text;
}

/**
 * Broadcasts mic state to the server and optimistically updates seat visuals.
 */
function sendVCStatusInternal(inVC, isMuted) {
    const payload = {
        type: 'UPDATE_VC_STATUS',
        inVC: Boolean(inVC),
        isMuted: Boolean(isMuted)
    };

    if (typeof sendSocket === 'function') {
        sendSocket(payload);
    } else if (typeof window.sendSocket === 'function') {
        window.sendSocket(payload);
    } else if (typeof initSocketAndSend === 'function') {
        initSocketAndSend(payload);
    } else if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(payload);
    } else if (window.appGlobals && window.appGlobals.ws && window.appGlobals.ws.readyState === 1) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    }

    if (window.clientState) {
        window.clientState.inVC = Boolean(inVC);
        window.clientState.isMuted = Boolean(isMuted);
    }

    if (window.appGlobals && window.appGlobals.latestLobbySnapshot) {
        const snap = window.appGlobals.latestLobbySnapshot;
        const myName = (window.clientState && window.clientState.username) || '';
        const myPlayer = (snap.players || []).find(p => p.username.toLowerCase() === myName.toLowerCase());
        if (myPlayer) {
            myPlayer.inVC = Boolean(inVC);
            myPlayer.isMuted = Boolean(isMuted);
            if (typeof window.updateUIFromLobby === 'function') {
                window.updateUIFromLobby(snap);
            }
        }
    }
}

/**
 * Requests a token from backend HTTP route or WebSocket fallback
 */
async function requestVoiceToken(roomCode) {
    const targetRoom = roomCode || (window.appGlobals && window.appGlobals.currentJoinedCode) || 'lobby';
    const myUsername = (window.clientState && window.clientState.username) || 'Player';

    try {
        const res = await fetch('/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName: targetRoom, participantName: myUsername })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.token) {
                await connectToLiveKit(data.host, data.token, targetRoom);
                return;
            }
        }
    } catch (e) {
        console.warn("[LiveKit] HTTP token fetch failed, attempting WebSocket fallback:", e.message);
    }

    const wsPayload = { type: 'REQUEST_LIVEKIT_TOKEN', room: targetRoom };
    if (typeof sendSocket === 'function') {
        sendSocket(wsPayload);
    } else if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(wsPayload);
    }
}

function triggerVoiceReconnect() {
    if (latestLiveKitHost && latestLiveKitToken) {
        connectToLiveKit(latestLiveKitHost, latestLiveKitToken);
    } else {
        requestVoiceToken();
    }
}

/**
 * Exits voice chat only when explicitly leaving the table/lobby.
 */
async function disconnectLiveKit() {
    stopBackgroundKeepAliveOscillator();
    if (livekitRoom) {
        try { await livekitRoom.disconnect(); } catch (e) {}
        livekitRoom = null;
    }
    latestLiveKitHost = null;
    latestLiveKitToken = null;
    isLiveKitConnected = false;
    isMicActive = false;

    // Reset saved mic state so subsequent table joins start muted
    localStorage.removeItem('blitz31_mic_state');

    updateVoiceUI();
    sendVCStatusInternal(false, true);
    refreshVoiceParticipantsList();
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
 * Bluetooth & Speaker Route Switching
 */
async function setAudioOutputDevice(deviceId) {
    selectedAudioOutputId = deviceId || 'default';
    const remoteAudios = document.querySelectorAll('.lk-remote-audio');

    for (const audioEl of remoteAudios) {
        if (typeof audioEl.setSinkId === 'function') {
            try {
                await audioEl.setSinkId(selectedAudioOutputId);
            } catch (err) {
                console.warn("[LiveKit] Failed to set sink ID:", err);
                try { await audioEl.setSinkId('default'); } catch (e) {}
            }
        }
    }

    const select = document.getElementById('audio-output-select') || document.getElementById('setting-audio-output');
    if (select && select.value !== selectedAudioOutputId) {
        select.value = selectedAudioOutputId;
    }
}

/**
 * Enumerates audio devices, identifies Bluetooth accessories,
 * and automatically falls back to phone speaker if Bluetooth disconnects.
 */
async function refreshAudioOutputDevices() {
    const select = document.getElementById('audio-output-select') || document.getElementById('setting-audio-output');
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
            const label = d.label ? `${prefix}${d.label}` : `Audio Output ${i + 1}`;

            if (d.deviceId === selectedAudioOutputId) {
                isSelectedDeviceStillConnected = true;
            }

            optionsHtml += `<option value="${d.deviceId}">${label}</option>`;
        });

        select.innerHTML = optionsHtml;

        // Automatically fallback to phone speaker if active Bluetooth device drops
        if (selectedAudioOutputId !== 'default' && !isSelectedDeviceStillConnected) {
            console.log("[LiveKit] Bluetooth audio disconnected. Reverting to Phone Speaker.");
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
        listDiv.innerHTML = '<span style="color:var(--text-muted); font-size:0.8rem;">Connecting to voice chat...</span>';
        return;
    }

    const participants = [];
    if (livekitRoom.localParticipant) {
        const localName = livekitRoom.localParticipant.identity || livekitRoom.localParticipant.name || 'You';
        participants.push({ name: `${localName} (You)`, isMuted: !isMicActive });
    }

    if (livekitRoom.remoteParticipants) {
        livekitRoom.remoteParticipants.forEach(rp => {
            const hasAudio = rp.audioTrackPublications && rp.audioTrackPublications.size > 0;
            const rName = rp.identity || rp.name || 'Player';
            participants.push({ name: rName, isMuted: !hasAudio || !rp.isSpeaking });
        });
    }

    listDiv.innerHTML = '<ul style="padding-left:14px; margin:0; font-size:0.8rem;">' + participants.map(u => `
        <li style="margin-bottom:3px;"><b>${u.name}</b> ${u.isMuted ? '🔇 (Muted)' : '🎙️ (Active)'}</li>
    `).join('') + '</ul>';
}

// Hardware device listener for instant Bluetooth connect/disconnect detection
if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
    navigator.mediaDevices.ondevicechange = () => {
        refreshAudioOutputDevices();
    };
}

// Background resilience: keep audio awake and recover if the OS pauses Web Audio or local mic
document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && isLiveKitConnected && livekitRoom) {
        if (keepAliveAudioContext && keepAliveAudioContext.state === 'suspended') {
            keepAliveAudioContext.resume().catch(() => {});
        }
        startBackgroundKeepAliveOscillator();

        // If the mic was on before switching apps/tabs, re-assert the track
        if (isMicActive && livekitRoom.localParticipant) {
            try {
                if (livekitRoom.startAudio) {
                    await livekitRoom.startAudio();
                }
                await livekitRoom.localParticipant.setMicrophoneEnabled(true);
            } catch (err) {
                console.warn("[LiveKit] Background recovery failed to unmute:", err);
            }
        }
    }
});

// Auto-activate audio context and silent loop on first screen tap anywhere
window.addEventListener('click', () => {
    if (keepAliveAudioContext && keepAliveAudioContext.state === 'suspended') {
        keepAliveAudioContext.resume().catch(() => {});
    }
    if (silentAudioElement && silentAudioElement.paused && isLiveKitConnected) {
        silentAudioElement.play().catch(() => {});
    }
}, { once: true });

// Export global handlers
window.connectLiveKit = connectLiveKit;
window.connectToLiveKit = connectToLiveKit;
window.toggleVoiceOnOff = toggleVoiceOnOff;
window.toggleLiveKitVoice = toggleVoiceOnOff;
window.disconnectLiveKit = disconnectLiveKit;
window.setAudioOutputDevice = setAudioOutputDevice;
window.refreshAudioOutputDevices = refreshAudioOutputDevices;
window.setVoiceChatVolume = setVoiceChatVolume;
window.triggerVoiceReconnect = triggerVoiceReconnect;
window.sendVCStatusInternal = sendVCStatusInternal;
