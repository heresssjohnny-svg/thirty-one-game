// public/js/voice.js - Persistent LiveKit Voice Engine, Real-time Mute Sync & Background Resilience

let livekitRoom = null;
let isLiveKitConnected = false;
let isMicActive = false; // Controls local microphone transmission state
let isConnectingVoice = false;
let latestLiveKitHost = null;
let latestLiveKitToken = null;
let latestLiveKitRoom = null;
let currentVoiceVolume = 1.0;
let selectedAudioOutputId = 'default';

// Background audio keep-alive: Decoded audio element to bypass mobile 5-second sleep
let keepAliveAudioElement = null;
let keepAliveAudioContext = null;

// Clean, inaudible 1-second WAV audio loop
const SILENT_WAV_BASE64 = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

function getLiveKitSDK() {
    return window.LivekitClient || window.LiveKitClient || window.livekitClient || null;
}

/**
 * Initializes a decoded HTML5 Audio element loop and MediaSession.
 * This tells the mobile OS that active media playback is in progress,
 * preventing tab suspension and WebRTC disconnections after 5 seconds.
 */
function startBackgroundKeepAliveOscillator() {
    try {
        if (!keepAliveAudioElement) {
            keepAliveAudioElement = document.createElement('audio');
            keepAliveAudioElement.id = 'lk-keepalive-media';
            keepAliveAudioElement.src = SILENT_WAV_BASE64;
            keepAliveAudioElement.loop = true;
            keepAliveAudioElement.volume = 0.01; // Non-zero volume prevents iOS from flagging it as idle
            keepAliveAudioElement.setAttribute('playsinline', '');
            keepAliveAudioElement.setAttribute('webkit-playsinline', '');
            keepAliveAudioElement.style.display = 'none';
            document.body.appendChild(keepAliveAudioElement);
        }

        const playPromise = keepAliveAudioElement.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                if ('mediaSession' in navigator) {
                    navigator.mediaSession.playbackState = 'playing';
                    navigator.mediaSession.metadata = new MediaMetadata({
                        title: "Voice Chat Active",
                        artist: "Blitz 31",
                        album: "Live Game Voice"
                    });
                }
            }).catch(() => {
                // Autoplay policy: will unlock on the first screen tap
            });
        }
    } catch (e) {
        console.warn("[LiveKit] Could not initialize keep-alive:", e);
    }
}

function stopBackgroundKeepAliveOscillator() {
    try {
        if (keepAliveAudioElement) {
            keepAliveAudioElement.pause();
            keepAliveAudioElement.currentTime = 0;
            keepAliveAudioElement.remove();
            keepAliveAudioElement = null;
        }
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'none';
        }
    } catch (e) {}
}

/**
 * Universal token fetcher and connector.
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
 * Connects to the LiveKit voice room and binds real-time mute listeners for all players.
 */
async function connectToLiveKit(host, token, roomCode) {
    const targetRoom = roomCode || (window.appGlobals && window.appGlobals.currentJoinedCode) || localStorage.getItem('blitz31_active_room') || 'lobby';

    if (!host || !token) {
        await requestVoiceToken(targetRoom);
        return;
    }

    let cleanHost = host.trim();
    if (!cleanHost.startsWith('ws://') && !cleanHost.startsWith('wss://') && !cleanHost.startsWith('http://') && !cleanHost.startsWith('https://')) {
        cleanHost = 'wss://' + cleanHost;
    }

    if (livekitRoom && isLiveKitConnected) {
        if (livekitRoom.name === targetRoom && latestLiveKitToken === token) {
            return;
        }
        try {
            await livekitRoom.disconnect();
        } catch (e) {}
        livekitRoom = null;
        isLiveKitConnected = false;
    }

    latestLiveKitHost = cleanHost;
    latestLiveKitToken = token;
    latestLiveKitRoom = targetRoom;

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
            stopLocalTrackOnUnpublish: false, // Prevents media stream destruction during network route hops
            reconnectPolicy: {
                maxAttempts: 15,
                initialDelay: 300,
                maxDelay: 2500
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

                if (selectedAudioOutputId && typeof audioElem.setSinkId === 'function') {
                    audioElem.setSinkId(selectedAudioOutputId).catch(() => {
                        selectedAudioOutputId = 'default';
                        audioElem.setSinkId('default').catch(() => {});
                    });
                }

                document.body.appendChild(audioElem);
                syncRemoteParticipantMuteState(participant, publication.isMuted);
                refreshVoiceParticipantsList();
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            track.detach().forEach(el => el.remove());
            if (participant) {
                syncRemoteParticipantMuteState(participant, true);
            }
            refreshVoiceParticipantsList();
        });

        // Real-time track mute/unmute events from other players over WebRTC
        livekitRoom.on(LK.RoomEvent.TrackMuted, (publication, participant) => {
            if (publication.kind === 'audio' || publication.source === LK.Track.Source.Microphone) {
                syncRemoteParticipantMuteState(participant, true);
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackUnmuted, (publication, participant) => {
            if (publication.kind === 'audio' || publication.source === LK.Track.Source.Microphone) {
                syncRemoteParticipantMuteState(participant, false);
            }
        });

        livekitRoom.on(LK.RoomEvent.ParticipantConnected, (participant) => {
            syncRemoteParticipantMuteState(participant, true);
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.ActiveSpeakersChanged, () => {
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.Disconnected, () => {
            isLiveKitConnected = false;
            stopBackgroundKeepAliveOscillator();
            updateVoiceUI();
            refreshVoiceParticipantsList();

            // Auto-reconnect if dropped unexpectedly during an active match
            if (window.clientState && window.clientState.gameState !== 'mainMenu') {
                setTimeout(triggerVoiceReconnect, 1500);
            }
        });

        await livekitRoom.connect(cleanHost, token);
        isLiveKitConnected = true;

        // Check if mid-game window reopen/reconnect or an initial connection
        const savedMicState = localStorage.getItem('blitz31_mic_state');

        if (savedMicState === 'true') {
            try {
                if (livekitRoom.startAudio) {
                    await livekitRoom.startAudio();
                }
                await livekitRoom.localParticipant.setMicrophoneEnabled(true);
                isMicActive = true;
                sendVCStatusInternal(true, false);
            } catch (micErr) {
                console.warn("[LiveKit] Reopen mic restore blocked:", micErr);
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
 * Synchronizes remote participant mute/unmute state directly into seat visuals.
 */
function syncRemoteParticipantMuteState(participant, isMuted) {
    if (!participant) return;
    const participantName = (participant.identity || participant.name || '').trim();
    if (!participantName) return;

    if (window.appGlobals && window.appGlobals.latestLobbySnapshot) {
        const snap = window.appGlobals.latestLobbySnapshot;
        const player = (snap.players || []).find(p => p.username.toLowerCase() === participantName.toLowerCase());
        if (player) {
            player.inVC = true;
            player.isMuted = Boolean(isMuted);
            if (typeof window.updateUIFromLobby === 'function') {
                window.updateUIFromLobby(snap);
            }
        }
        const spectator = (snap.spectators || []).find(s => s.username && s.username.toLowerCase() === participantName.toLowerCase());
        if (spectator) {
            spectator.inVC = true;
            spectator.isMuted = Boolean(isMuted);
        }
    }
    refreshVoiceParticipantsList();
}

/**
 * Toggles local microphone state.
 */
async function toggleVoiceOnOff() {
    startBackgroundKeepAliveOscillator();

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
        if (isMicActive) {
            // Soft mute: disable the media stream track before calling setMicrophoneEnabled
            const micPub = livekitRoom.localParticipant.getTrackPublication(getLiveKitSDK().Track.Source.Microphone);
            if (micPub && micPub.track) {
                micPub.track.mediaStreamTrack.enabled = false;
            }
            await livekitRoom.localParticipant.setMicrophoneEnabled(false);

            isMicActive = false;
            localStorage.setItem('blitz31_mic_state', 'false');
            updateVoiceUI();
            sendVCStatusInternal(true, true);
        } else {
            // Unmute
            if (livekitRoom.startAudio) {
                await livekitRoom.startAudio();
            }
            await livekitRoom.localParticipant.setMicrophoneEnabled(true);

            const micPub = livekitRoom.localParticipant.getTrackPublication(getLiveKitSDK().Track.Source.Microphone);
            if (micPub && micPub.track) {
                micPub.track.mediaStreamTrack.enabled = true;
            }

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
 * Broadcasts mute status to the server with room and username attached.
 */
function sendVCStatusInternal(inVC, isMuted) {
    const targetRoom = (window.appGlobals && window.appGlobals.currentJoinedCode) || localStorage.getItem('blitz31_active_room') || latestLiveKitRoom || '';
    const myName = (window.clientState && window.clientState.username) || (document.getElementById('username-input')?.value || '').trim() || localStorage.getItem('saved_username') || '';

    const payload = {
        type: 'UPDATE_VC_STATUS',
        room: targetRoom,
        code: targetRoom,
        username: myName,
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

async function requestVoiceToken(roomCode) {
    const targetRoom = roomCode || (window.appGlobals && window.appGlobals.currentJoinedCode) || localStorage.getItem('blitz31_active_room') || 'lobby';
    const myUsername = (window.clientState && window.clientState.username) || localStorage.getItem('saved_username') || 'Player';

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

    const wsPayload = { type: 'REQUEST_LIVEKIT_TOKEN', room: targetRoom, code: targetRoom };
    if (typeof sendSocket === 'function') {
        sendSocket(wsPayload);
    } else if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(wsPayload);
    }
}

function triggerVoiceReconnect() {
    if (latestLiveKitHost && latestLiveKitToken) {
        connectToLiveKit(latestLiveKitHost, latestLiveKitToken, latestLiveKitRoom);
    } else {
        requestVoiceToken();
    }
}

async function disconnectLiveKit() {
    stopBackgroundKeepAliveOscillator();
    if (livekitRoom) {
        try { await livekitRoom.disconnect(); } catch (e) {}
        livekitRoom = null;
    }
    latestLiveKitHost = null;
    latestLiveKitToken = null;
    latestLiveKitRoom = null;
    isLiveKitConnected = false;
    isMicActive = false;

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

async function setAudioOutputDevice(deviceId) {
    selectedAudioOutputId = deviceId || 'default';
    const remoteAudios = document.querySelectorAll('.lk-remote-audio');

    for (const audioEl of remoteAudios) {
        if (typeof audioEl.setSinkId === 'function') {
            try {
                await audioEl.setSinkId(selectedAudioOutputId);
            } catch (err) {
                try { await audioEl.setSinkId('default'); } catch (e) {}
            }
        }
    }

    const select = document.getElementById('audio-output-select') || document.getElementById('setting-audio-output');
    if (select && select.value !== selectedAudioOutputId) {
        select.value = selectedAudioOutputId;
    }
}

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

        if (selectedAudioOutputId !== 'default' && !isSelectedDeviceStillConnected) {
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
            let isMuted = true;
            if (rp.audioTrackPublications) {
                for (const pub of rp.audioTrackPublications.values()) {
                    if (pub.track && !pub.isMuted) {
                        isMuted = false;
                        break;
                    }
                }
            } else if (rp.isMicrophoneEnabled) {
                isMuted = false;
            }
            const rName = rp.identity || rp.name || 'Player';
            participants.push({ name: rName, isMuted: isMuted });
        });
    }

    listDiv.innerHTML = '<ul style="padding-left:14px; margin:0; font-size:0.8rem;">' + participants.map(u => `
        <li style="margin-bottom:3px;"><b>${u.name}</b> ${u.isMuted ? '🔇 (Muted)' : '🎙️ (Active)'}</li>
    `).join('') + '</ul>';
}

if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
    navigator.mediaDevices.ondevicechange = () => {
        refreshAudioOutputDevices();
    };
}

// Background Resilience: Instant Reconnect on Screen Wake / Tab Focus
async function handleScreenResumeVoice() {
    if (document.hidden) return;

    startBackgroundKeepAliveOscillator();

    // If the connection dropped in the background, reconnect immediately
    if (!isLiveKitConnected || !livekitRoom || livekitRoom.state !== 'connected') {
        triggerVoiceReconnect();
        return;
    }

    // If the mic was active before backgrounding, re-assert capture
    if (isMicActive && livekitRoom.localParticipant) {
        try {
            if (livekitRoom.startAudio) {
                await livekitRoom.startAudio();
            }
            await livekitRoom.localParticipant.setMicrophoneEnabled(true);
        } catch (err) {
            console.warn("[LiveKit] Screen resume failed to unmute:", err);
        }
    }
}

document.addEventListener('visibilitychange', handleScreenResumeVoice);
window.addEventListener('pageshow', handleScreenResumeVoice);
window.addEventListener('focus', handleScreenResumeVoice);

// Universal audio unlock on user gesture
function unlockAudioOnFirstTouch() {
    startBackgroundKeepAliveOscillator();
    if (keepAliveAudioElement && keepAliveAudioElement.paused) {
        keepAliveAudioElement.play().catch(() => {});
    }
    if (livekitRoom && livekitRoom.startAudio) {
        livekitRoom.startAudio().catch(() => {});
    }
}

window.addEventListener('touchstart', unlockAudioOnFirstTouch, { passive: true });
window.addEventListener('pointerdown', unlockAudioOnFirstTouch, { passive: true });
window.addEventListener('click', unlockAudioOnFirstTouch);

// Global Exports
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
