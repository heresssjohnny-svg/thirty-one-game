// public/js/voice.js - Persistent LiveKit Voice Engine, Wake Lock, Real-time Mute Sync & Background Resilience

let livekitRoom = null;
let isLiveKitConnected = false;
let isMicActive = false; // Controls local microphone transmission state
let isConnectingVoice = false;
let latestLiveKitHost = null;
let latestLiveKitToken = null;
let latestLiveKitRoom = null;
let currentVoiceVolume = 1.0;
let selectedAudioOutputId = 'default';

// Automatic voice reconnect bookkeeping (one place decides what the voice button says)
let voiceReconnectPending = false;
let voiceReconnectSafety = null;
let voiceReconnectTimes = [];
function setVoiceReconnectPending(on) {
    voiceReconnectPending = !!on;
    if (voiceReconnectSafety) { clearTimeout(voiceReconnectSafety); voiceReconnectSafety = null; }
    if (on) {
        // never leave the label stuck on "Reconnecting"
        voiceReconnectSafety = setTimeout(() => {
            voiceReconnectPending = false;
            voiceReconnectSafety = null;
            if (typeof updateVoiceUI === 'function') updateVoiceUI();
        }, 15000);
    }
    if (typeof updateVoiceUI === 'function') updateVoiceUI();
}

// Background audio keep-alive: Decoded audio element
let keepAliveAudioElement = null;

// Screen Wake Lock Sentinel
let wakeLockSentinel = null;

// Clean, inaudible 1-second WAV audio loop
const SILENT_WAV_BASE64 = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

function getLiveKitSDK() {
    return window.LivekitClient || window.LiveKitClient || window.livekitClient || null;
}

function getActiveRoomCode() {
    return (window.appGlobals && window.appGlobals.currentJoinedCode) ||
           localStorage.getItem('blitz31_active_room') ||
           latestLiveKitRoom ||
           null;
}

function cleanupRemoteAudioElements() {
    document.querySelectorAll('.lk-remote-audio').forEach(el => {
        try {
            el.pause();
            el.srcObject = null;
            el.remove();
        } catch (e) {}
    });
}

// -------------------------------------------------------------
// 1. SCREEN WAKE LOCK ENGINE
// -------------------------------------------------------------
async function requestScreenWakeLock() {
    try {
        if ('wakeLock' in navigator && !wakeLockSentinel && !document.hidden) {
            wakeLockSentinel = await navigator.wakeLock.request('screen');
            wakeLockSentinel.addEventListener('release', () => {
                wakeLockSentinel = null;
            });
        }
    } catch (err) {
        // Ignored if battery saver or OS denies screen wake locks
    }
}

function releaseScreenWakeLock() {
    if (wakeLockSentinel) {
        wakeLockSentinel.release().catch(() => {});
        wakeLockSentinel = null;
    }
}

// -------------------------------------------------------------
// 2. BACKGROUND AUDIO KEEP-ALIVE ENGINE
// -------------------------------------------------------------
function startBackgroundKeepAliveOscillator() {
    try {
        if (!keepAliveAudioElement) {
            keepAliveAudioElement = document.createElement('audio');
            keepAliveAudioElement.id = 'lk-keepalive-media';
            keepAliveAudioElement.src = SILENT_WAV_BASE64;
            keepAliveAudioElement.loop = true;
            keepAliveAudioElement.volume = 0.01;
            keepAliveAudioElement.setAttribute('playsinline', '');
            keepAliveAudioElement.setAttribute('webkit-playsinline', '');
            keepAliveAudioElement.style.display = 'none';
            document.body.appendChild(keepAliveAudioElement);
        }

        if (keepAliveAudioElement.paused) {
            const playPromise = keepAliveAudioElement.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    if ('mediaSession' in navigator && !navigator.mediaSession.metadata) {
                        navigator.mediaSession.playbackState = 'playing';
                        navigator.mediaSession.metadata = new MediaMetadata({
                            title: "Voice Chat Active",
                            artist: "Blitz 31",
                            album: "Live Game Voice"
                        });
                    }
                }).catch(() => {});
            }
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
            navigator.mediaSession.metadata = null;
        }
    } catch (e) {}
}

// -------------------------------------------------------------
// 3. LIVEKIT CONNECTION & EVENT LIFECYCLE
// -------------------------------------------------------------
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
    const targetRoom = roomCode || getActiveRoomCode();
    if (!targetRoom) return;

    if (!host || !token) {
        await requestVoiceToken(targetRoom);
        return;
    }

    let cleanHost = host.trim();
    if (!cleanHost.startsWith('ws://') && !cleanHost.startsWith('wss://') && !cleanHost.startsWith('http://') && !cleanHost.startsWith('https://')) {
        cleanHost = 'wss://' + cleanHost;
    }

    if (livekitRoom && isLiveKitConnected) {
        // Already in this table's voice room: keep the call. A fresh token arrives
        // on every game-socket rejoin (LOBBY_JOINED) and every reconnect attempt;
        // tearing the room down for it used to start a disconnect -> reconnect
        // loop that flipped the button between "Mic: Off (listening)" and
        // "Voice: Off".
        const sameRoom = livekitRoom.name === targetRoom || latestLiveKitRoom === targetRoom;
        if (sameRoom && livekitRoom.state !== 'disconnected') {
            latestLiveKitHost = cleanHost;
            latestLiveKitToken = token;
            updateVoiceUI();
            return;
        }
        // Switching tables: close the old room on purpose (its Disconnected
        // handler must not schedule a reconnect)
        const oldRoom = livekitRoom;
        oldRoom.__blitzIntentional = true;
        livekitRoom = null;
        isLiveKitConnected = false;
        try {
            await oldRoom.disconnect();
        } catch (e) {}
        cleanupRemoteAudioElements();
    } else if (livekitRoom && !isConnectingVoice) {
        // A half-dead room from an earlier failed attempt: retire it quietly
        livekitRoom.__blitzIntentional = true;
        try { livekitRoom.disconnect(); } catch (e) {}
        livekitRoom = null;
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
        cleanupRemoteAudioElements();

        const thisRoom = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
            stopLocalTrackOnUnpublish: false,
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
        livekitRoom = thisRoom;

        // Remote participant audio playback
        livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            const trackKind = track.kind || '';
            if (trackKind === 'audio' || (LK.Track && trackKind === LK.Track.Kind.Audio)) {
                // Remove any stale audio element for this track sid
                if (track.sid) {
                    document.querySelectorAll(`.lk-remote-audio[data-track-sid="${track.sid}"]`).forEach(el => el.remove());
                }

                const audioElem = track.attach();
                audioElem.autoplay = true;
                audioElem.playsInline = true;
                audioElem.volume = currentVoiceVolume;
                audioElem.setAttribute('playsinline', '');
                audioElem.setAttribute('webkit-playsinline', '');
                audioElem.classList.add('lk-remote-audio');
                if (track.sid) audioElem.setAttribute('data-track-sid', track.sid);
                try { audioElem.setAttribute('data-identity', String((participant && (participant.identity || participant.name)) || '')); } catch (e) {}
                if (typeof window.isPlayerBlocked === 'function' && participant && window.isPlayerBlocked(participant.identity || participant.name)) { audioElem.muted = true; audioElem.setAttribute('data-sf-muted', '1'); }

                if (selectedAudioOutputId && selectedAudioOutputId !== 'default' && typeof audioElem.setSinkId === 'function') {
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

        livekitRoom.on(LK.RoomEvent.TrackMuted, (publication, participant) => {
            if (publication.kind === 'audio' || publication.source === 'microphone' || (LK.Track && publication.source === LK.Track.Source.Microphone)) {
                syncRemoteParticipantMuteState(participant, true);
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackUnmuted, (publication, participant) => {
            if (publication.kind === 'audio' || publication.source === 'microphone' || (LK.Track && publication.source === LK.Track.Source.Microphone)) {
                syncRemoteParticipantMuteState(participant, false);
            }
        });

        livekitRoom.on(LK.RoomEvent.ParticipantConnected, (participant) => {
            syncRemoteParticipantMuteState(participant, true);
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.ParticipantDisconnected, () => {
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.ActiveSpeakersChanged, () => {
            refreshVoiceParticipantsList();
        });

        livekitRoom.on(LK.RoomEvent.Disconnected, (reason) => {
            // Ignore rooms we closed on purpose or that were already replaced
            if (thisRoom.__blitzIntentional || thisRoom !== livekitRoom) return;
            isLiveKitConnected = false;
            cleanupRemoteAudioElements();
            stopBackgroundKeepAliveOscillator();

            // Kicked because the same player joined voice from another device/tab, or we are
            // reconnecting in a tight loop: stop, so two sessions do not keep kicking each other
            // (that fight is what made the button flip between "Voice: Off" and "Mic: Off (listening)")
            const now = Date.now();
            voiceReconnectTimes = voiceReconnectTimes.filter(t => now - t < 60000);
            const dup = !!(LK.DisconnectReason && reason === LK.DisconnectReason.DUPLICATE_IDENTITY);
            if (dup || voiceReconnectTimes.length >= 4) {
                setVoiceReconnectPending(false);
                updateVoiceUI();
                refreshVoiceParticipantsList();
                if (typeof window.showCenterNotification === 'function') {
                    window.showCenterNotification(dup
                        ? '🎙️ Voice is open on another device or tab. Tap Voice to use it here.'
                        : '🎙️ Voice keeps disconnecting. Tap Voice to try again.');
                }
                return;
            }

            const activeRoom = getActiveRoomCode();
            if (activeRoom && window.clientState && window.clientState.gameState !== 'mainMenu') {
                voiceReconnectTimes.push(now);
                setVoiceReconnectPending(true);   // keeps a steady "Reconnecting" label instead of flipping to "Voice: Off"
                setTimeout(triggerVoiceReconnect, 1500);
            } else {
                updateVoiceUI();
            }
            refreshVoiceParticipantsList();
        });

        await thisRoom.connect(cleanHost, token);
        if (thisRoom !== livekitRoom || thisRoom.__blitzIntentional) {
            // Left the table (or switched) while connecting: drop this room
            try { thisRoom.disconnect(); } catch (e) {}
            return;
        }
        isLiveKitConnected = true;
        setVoiceReconnectPending(false);

        requestScreenWakeLock();

        // Check stored mic state, but do not clear storage on initial muted connect
        const savedMicState = localStorage.getItem('blitz31_mic_state');

        if (savedMicState === 'true' && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) {
            try {
                if (livekitRoom.startAudio) {
                    await livekitRoom.startAudio();
                }
                await livekitRoom.localParticipant.setMicrophoneEnabled(true);
                isMicActive = true;
                setTimeout(refreshAudioOutputDevices, 400);
                watchMicTrack();
                sendVCStatusInternal(true, false);
            } catch (micErr) {
                console.warn("[LiveKit] Reopen mic restore blocked by browser policy:", micErr);
                isMicActive = false;
                sendVCStatusInternal(true, true);
            }
        } else {
            isMicActive = false;
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
        setVoiceReconnectPending(false);
        updateVoiceUI();
    } finally {
        isConnectingVoice = false;
    }
}

// -------------------------------------------------------------
// 4. MICROPHONE TRANSMISSION, SOFT-MUTE & HOST FORCE-MUTE
// -------------------------------------------------------------
// Turning the mic off RELEASES the microphone (stops the track) instead of only muting it, so the phone
// (a call, another app) can use it. It stays on in the background, and is released automatically only when
// the system takes the mic (incoming call); it is NOT turned back on by itself.
function micSourceName() {
    const LK = getLiveKitSDK();
    return (LK && LK.Track && LK.Track.Source) ? LK.Track.Source.Microphone : 'microphone';
}
async function releaseLocalMic() {
    if (!livekitRoom || !livekitRoom.localParticipant) return;
    const pub = livekitRoom.localParticipant.getTrackPublication(micSourceName());
    const track = pub && pub.track;
    if (!track) return;
    try { await livekitRoom.localParticipant.unpublishTrack(track, true); } catch (e) {}
    try { track.stop(); } catch (e) {}
    try { if (track.mediaStreamTrack) track.mediaStreamTrack.stop(); } catch (e) {}
}
let micPausedNoticeShown = false;
async function pauseMicForInterruption(reason) {
    if (!isMicActive) { await releaseLocalMic(); return; }
    console.log('[LiveKit] Releasing mic:', reason);
    isMicActive = false;
    localStorage.setItem('blitz31_mic_state', 'false');   // don't grab it again on a reconnect
    await releaseLocalMic();
    updateVoiceUI();
    sendVCStatusInternal(isLiveKitConnected, true);
    micPausedNoticeShown = false;
    window.__micPausedForInterruption = true;
}
function watchMicTrack() {
    try {
        const pub = livekitRoom && livekitRoom.localParticipant.getTrackPublication(micSourceName());
        const mst = pub && pub.track && pub.track.mediaStreamTrack;
        if (!mst || mst.__blitzWatched) return;
        mst.__blitzWatched = true;
        // the OS took the microphone (phone call, Siri, another app recording)
        mst.addEventListener('mute', () => { if (isMicActive) pauseMicForInterruption('track muted by system'); });
        mst.addEventListener('ended', () => { if (isMicActive) pauseMicForInterruption('track ended'); });
    } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
    // The mic stays on in the background; it is only released when the phone takes it (track mute/ended)
    // or when the player turns it off. On return, say so if the phone took it meanwhile.
    if (!document.hidden && window.__micPausedForInterruption && !micPausedNoticeShown && isLiveKitConnected) {
        micPausedNoticeShown = true;
        window.__micPausedForInterruption = false;
        if (typeof window.showCenterNotification === 'function') window.showCenterNotification('🎙️ Your phone needed the mic, so it was turned off — tap Mic to turn it back on');
    }
});

async function toggleVoiceOnOff() {
    voiceReconnectTimes = [];   // a manual tap always gets a fresh start
    startBackgroundKeepAliveOscillator();

    // 1. Prevent Race Condition: Let connectToLiveKit handle the initial unmute
    if (!livekitRoom || !isLiveKitConnected) {
        updateVoiceButtonState('Connecting...');
        localStorage.setItem('blitz31_mic_state', 'true'); // Save intent for connectToLiveKit
        if (latestLiveKitHost && latestLiveKitToken) {
            await connectToLiveKit(latestLiveKitHost, latestLiveKitToken, getActiveRoomCode());
        } else {
            await requestVoiceToken(getActiveRoomCode());
        }
        return;
    }

    const LK = getLiveKitSDK();
    const micSource = (LK && LK.Track && LK.Track.Source) ? LK.Track.Source.Microphone : 'microphone';

    try {
        if (isMicActive) {
            // 2. Mic off: release the microphone hardware so calls / other apps can use it
            await releaseLocalMic();
            window.__micPausedForInterruption = false;

            isMicActive = false;
            localStorage.setItem('blitz31_mic_state', 'false');
            updateVoiceUI();
            sendVCStatusInternal(true, true);
        } else {
            // 3. Unmute
            if (livekitRoom.startAudio) {
                await livekitRoom.startAudio();
            }

            // Only request new hardware access if the track was entirely missing
            const micPub = livekitRoom.localParticipant.getTrackPublication(micSource);
            if (!micPub || !micPub.track) {
                await livekitRoom.localParticipant.setMicrophoneEnabled(true);
            } else {
                if (typeof micPub.unmute === 'function' && micPub.isMuted) {
                    await micPub.unmute();
                }
                if (micPub.track.mediaStreamTrack) {
                    micPub.track.mediaStreamTrack.enabled = true;
                }
            }

            isMicActive = true;
                setTimeout(refreshAudioOutputDevices, 400);
            window.__micPausedForInterruption = false;
            localStorage.setItem('blitz31_mic_state', 'true');
            watchMicTrack();
            updateVoiceUI();
            sendVCStatusInternal(true, false);
        }
    } catch (err) {
        console.error("[LiveKit] Mic toggle error:", err);
        isMicActive = false;
        updateVoiceUI();
        sendVCStatusInternal(isLiveKitConnected, true);
        alert("Microphone permission denied or audio input device unavailable.");
    }
}


/**
 * Invoked when the room creator (host) mutes this player's microphone
 */
async function forceMuteLocalMicByAdmin(hostName) {
    isMicActive = false;
    localStorage.setItem('blitz31_mic_state', 'false');

    const LK = getLiveKitSDK();
    const micSource = (LK && LK.Track && LK.Track.Source) ? LK.Track.Source.Microphone : 'microphone';

    try {
        if (livekitRoom && livekitRoom.localParticipant) {
            const micPub = livekitRoom.localParticipant.getTrackPublication(micSource);
            if (micPub) {
                if (micPub.track && micPub.track.mediaStreamTrack) {
                    micPub.track.mediaStreamTrack.enabled = false;
                }
                if (typeof micPub.mute === 'function') {
                    await micPub.mute();
                }
            }
            if (typeof livekitRoom.localParticipant.setMicrophoneEnabled === 'function') {
                await livekitRoom.localParticipant.setMicrophoneEnabled(false);
            }
            await releaseLocalMic();
        }
    } catch (e) {
        console.warn("[LiveKit] Admin force-mute error:", e);
    }

    updateVoiceUI();
    sendVCStatusInternal(isLiveKitConnected, true);

    if (typeof window.showCenterNotification === 'function') {
        window.showCenterNotification(`🔇 ${hostName || 'The host'} muted your microphone.`);
    }
}

function updateVoiceUI() {
    const btnMain = document.getElementById('vc-main-btn');
    const btnHud = document.getElementById('voice-btn') || document.getElementById('voice-toggle-btn');
    const led = document.getElementById('vc-led');

    const label = isMicActive
        ? '🎙️ Mic: On'
        : (isLiveKitConnected ? '🔇 Mic: Off (listening)'
            : (voiceReconnectPending ? '⏳ Voice: Reconnecting…' : '🎙️ Voice: Off'));

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

function syncRemoteParticipantMuteState(participant, isMuted, inVC = true) {
    if (!participant) return;
    const participantName = (typeof participant === 'string' ? participant : (participant.identity || participant.name || '')).trim();
    if (!participantName) return;

    if (window.appGlobals && window.appGlobals.latestLobbySnapshot) {
        const snap = window.appGlobals.latestLobbySnapshot;
        const player = (snap.players || []).find(p => p.username.toLowerCase() === participantName.toLowerCase());
        if (player) {
            player.inVC = Boolean(inVC);
            player.isMuted = Boolean(isMuted);
        }
        const spectator = (snap.spectators || []).find(s => s.username && s.username.toLowerCase() === participantName.toLowerCase());
        if (spectator) {
            spectator.inVC = Boolean(inVC);
            spectator.isMuted = Boolean(isMuted);
        }
        if (typeof window.updateUIFromLobby === 'function') {
            window.updateUIFromLobby(snap);
        }
    }
    refreshVoiceParticipantsList();
}

function sendVCStatusInternal(inVC, isMuted) {
    const targetRoom = getActiveRoomCode() || '';
    const myName = (typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '') ||
                   (window.clientState && window.clientState.username) ||
                   (document.getElementById('username-input')?.value || '').trim() ||
                   localStorage.getItem('saved_username') || '';

    // Send VC_STATUS_UPDATE to match server/game/wsHandler.js
    const payload = {
        type: 'VC_STATUS_UPDATE',
        room: targetRoom,
        code: targetRoom,
        username: myName,
        inVC: Boolean(inVC),
        isMuted: Boolean(isMuted)
    };

    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(payload);
    } else if (typeof window.sendSocket === 'function') {
        window.sendSocket(payload);
    } else if (window.appGlobals && window.appGlobals.ws && window.appGlobals.ws.readyState === 1) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    }

    if (window.clientState) {
        window.clientState.inVC = Boolean(inVC);
        window.clientState.isMuted = Boolean(isMuted);
    }

    if (window.appGlobals && window.appGlobals.latestLobbySnapshot && myName) {
        const snap = window.appGlobals.latestLobbySnapshot;
        const myPlayer = (snap.players || []).find(p => p.username.toLowerCase() === myName.toLowerCase());
        if (myPlayer) {
            myPlayer.inVC = Boolean(inVC);
            myPlayer.isMuted = Boolean(isMuted);
        }
        const mySpec = (snap.spectators || []).find(s => s.username && s.username.toLowerCase() === myName.toLowerCase());
        if (mySpec) {
            mySpec.inVC = Boolean(inVC);
            mySpec.isMuted = Boolean(isMuted);
        }
        if (typeof window.updateUIFromLobby === 'function') {
            window.updateUIFromLobby(snap);
        }
    }
    refreshVoiceParticipantsList();
}

// -------------------------------------------------------------
// 5. FRESH TOKEN FETCH & EXPLICIT DISCONNECT
// -------------------------------------------------------------
async function requestVoiceToken(roomCode) {
    const targetRoom = roomCode || getActiveRoomCode();
    if (!targetRoom) return;

    const myUsername = (typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '') ||
                       (window.clientState && window.clientState.username) ||
                       localStorage.getItem('saved_username') ||
                       'Player';

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
    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(wsPayload);
    } else if (typeof window.sendSocket === 'function') {
        window.sendSocket(wsPayload);
    }
}

function triggerVoiceReconnect() {
    const targetRoom = getActiveRoomCode();
    if (!targetRoom) return;
    // Already connected (or a connect / SDK auto-reconnect is under way): nothing to do
    if (isConnectingVoice) return;
    if (livekitRoom && isLiveKitConnected && livekitRoom.state !== 'disconnected') return;
    requestVoiceToken(targetRoom);
}

async function disconnectLiveKit() {
    releaseScreenWakeLock();
    stopBackgroundKeepAliveOscillator();
    cleanupRemoteAudioElements();

    if (livekitRoom) {
        const oldRoom = livekitRoom;
        oldRoom.__blitzIntentional = true;
        livekitRoom = null;
        try { await oldRoom.disconnect(); } catch (e) {}
    }
    latestLiveKitHost = null;
    latestLiveKitToken = null;
    latestLiveKitRoom = null;
    if (window.appGlobals) window.appGlobals.lastConnectedLiveKitRoom = null;
    isLiveKitConnected = false;
    isMicActive = false;
    voiceReconnectTimes = [];
    setVoiceReconnectPending(false);

    localStorage.removeItem('blitz31_mic_state');

    updateVoiceUI();
    sendVCStatusInternal(false, true);
    refreshVoiceParticipantsList();
}

// -------------------------------------------------------------
// 6. AUDIO ROUTING & DEVICE MANAGEMENT
// -------------------------------------------------------------
function setVoiceChatVolume(val) {
    currentVoiceVolume = parseFloat(val);
    const disp = document.getElementById('lk-vol-display');
    if (disp) disp.innerText = `${Math.round(currentVoiceVolume * 100)}%`;

    document.querySelectorAll('.lk-remote-audio').forEach(audioEl => {
        audioEl.volume = currentVoiceVolume;
    });
}

// ---------------------------------------------------------------------------------------------
// AUDIO OUTPUT (speaker / Bluetooth / earpiece)
// What a web page may do differs by device:
//   * Computers (and browsers that list speakers): real output devices -> setSinkId on every <audio>.
//   * Android Chrome usually lists NO separate speakers. It does list the microphone routes
//     ("Speakerphone", "Bluetooth headset", "Headset earpiece", "Wired headset"); choosing one of those
//     as the mic moves the voice-chat sound with it. So there we offer those routes and switch the mic.
//   * iPhone: the phone decides; nothing can be chosen from a web page.
// Device names are only visible after microphone permission was given once.
// Option values: 'default' | 'out:<deviceId>' | 'in:<deviceId>'. The choice is remembered by name.
// ---------------------------------------------------------------------------------------------
const AUDIO_ROUTE_KEY = 'blitz31_audio_route';
let audioRouteValue = 'default';
let audioRouteOptions = [];
let lastBluetoothSeen = null;

function audioRouteKind(label) {
    const l = String(label || '').toLowerCase();
    if (/bluetooth|airpods|buds|\bbt\b|wireless|hands-?free|a2dp|sco/.test(l)) return 'bt';
    if (/speakerphone|speaker/.test(l)) return 'speaker';
    if (/earpiece|receiver/.test(l)) return 'earpiece';
    if (/wired|headphone|headset|usb/.test(l)) return 'wired';
    return 'other';
}
function audioRouteLabel(kind, label, viaMic) {
    const clean = String(label || '').replace(/[<>&"']/g, '');
    if (kind === 'bt') return '🎧 Bluetooth' + (clean && !/^bluetooth( headset)?$/i.test(clean) ? ': ' + clean : '');
    if (kind === 'speaker') return viaMic ? '🔊 Phone speaker' : '🔊 ' + (clean || 'Speaker');
    if (kind === 'earpiece') return '📞 Earpiece (hold to ear)';
    if (kind === 'wired') return '🎧 ' + (clean || 'Wired headset');
    return '🔊 ' + (clean || 'Audio output');
}
function setAudioHint(text) {
    const h = document.getElementById('audio-output-hint');
    if (h) h.textContent = text || '';
}

async function applyAudioRoute() {
    const v = audioRouteValue || 'default';
    // 1. real speakers
    const sink = v.indexOf('out:') === 0 ? v.slice(4) : 'default';
    selectedAudioOutputId = sink;
    for (const el of document.querySelectorAll('audio')) {
        if (typeof el.setSinkId !== 'function') continue;
        try { await el.setSinkId(sink === 'default' ? '' : sink); }
        catch (err) { try { await el.setSinkId(''); } catch (e) {} }
    }
    // 2. Android: the route follows the microphone
    if (v.indexOf('in:') === 0 && livekitRoom && isLiveKitConnected && isMicActive && typeof livekitRoom.switchActiveDevice === 'function') {
        try { await livekitRoom.switchActiveDevice('audioinput', v.slice(3)); }
        catch (e) { console.warn('[LiveKit] could not switch audio route:', e); }
    }
}

async function setAudioOutputDevice(value) {
    let v = value || 'default';
    if (v !== 'default' && v.indexOf('out:') !== 0 && v.indexOf('in:') !== 0) v = 'out:' + v;   // older callers pass a bare id
    audioRouteValue = v;
    const opt = audioRouteOptions.find(o => o.value === v);
    try { localStorage.setItem(AUDIO_ROUTE_KEY, JSON.stringify({ value: v, label: opt ? opt.raw : '' })); } catch (e) {}
    await applyAudioRoute();
    const select = document.getElementById('audio-output-select') || document.getElementById('setting-audio-output');
    if (select && select.value !== v) select.value = v;
    if (v.indexOf('in:') === 0 && !(isLiveKitConnected && isMicActive)) {
        if (typeof window.showCenterNotification === 'function') window.showCenterNotification('Saved. It applies when voice chat is on and your mic is on.');
    } else if (opt && v !== 'default' && typeof window.showCenterNotification === 'function') {
        window.showCenterNotification('Audio: ' + opt.label);
    }
}

async function refreshAudioOutputDevices() {
    const select = document.getElementById('audio-output-select') || document.getElementById('setting-audio-output');
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        setAudioHint('This browser lets the phone choose where sound plays.');
        return;
    }
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const named = (d) => d.label && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
        const outs = devices.filter(d => d.kind === 'audiooutput' && named(d));
        const ins = devices.filter(d => d.kind === 'audioinput' && named(d));
        const anyLabel = devices.some(d => d.label);

        const options = [];
        if (outs.length) {
            outs.forEach(d => { const k = audioRouteKind(d.label); options.push({ value: 'out:' + d.deviceId, kind: k, raw: d.label, label: audioRouteLabel(k, d.label, false) }); });
        } else {
            // no speaker list (typical on Android): offer the phone's routes, which switch together with the mic
            ins.forEach(d => {
                const k = audioRouteKind(d.label);
                if (k === 'other') return;
                if (options.some(o => o.kind === k && k !== 'bt')) return;
                options.push({ value: 'in:' + d.deviceId, kind: k, raw: d.label, label: audioRouteLabel(k, d.label, true) });
            });
        }
        audioRouteOptions = options;

        // restore the remembered choice (ids can change between visits, so fall back to the name)
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(AUDIO_ROUTE_KEY) || 'null'); } catch (e) {}
        let want = audioRouteValue !== 'default' ? audioRouteValue : (saved && saved.value) || 'default';
        if (want !== 'default' && !options.some(o => o.value === want)) {
            const byName = saved && saved.label ? options.find(o => o.raw === saved.label) : null;
            const gone = audioRouteValue !== 'default' && !byName;
            want = byName ? byName.value : 'default';
            if (gone && typeof window.showCenterNotification === 'function') window.showCenterNotification('That audio device disconnected. Back to automatic.');
        }
        const changed = want !== audioRouteValue;
        audioRouteValue = want;

        if (select) {
            select.innerHTML = '<option value="default">Automatic (phone decides)</option>' +
                options.map(o => `<option value="${o.value.replace(/"/g, '&quot;')}">${o.label}</option>`).join('');
            select.value = audioRouteValue;
        }

        const bt = options.some(o => o.kind === 'bt') || ins.some(d => audioRouteKind(d.label) === 'bt');
        if (!anyLabel) setAudioHint('Turn voice chat on once (and allow the microphone) so the game can see your speakers and Bluetooth.');
        else if (!options.length) setAudioHint('This browser lets the phone choose. Use your phone\'s own Bluetooth / media output control to switch.');
        else if (!outs.length) setAudioHint((bt ? '🎧 Bluetooth found. ' : 'No Bluetooth found. ') + 'On this phone the choice applies to voice chat while your mic is on; with the mic off the phone decides.');
        else setAudioHint(bt ? '🎧 Bluetooth found.' : 'No Bluetooth found. Connect it in your phone settings and it will show up here.');

        if (lastBluetoothSeen !== null && bt !== lastBluetoothSeen && typeof window.showCenterNotification === 'function') {
            window.showCenterNotification(bt ? '🎧 Bluetooth connected. Choose it in Settings → Audio Output.' : '🎧 Bluetooth disconnected.');
        }
        lastBluetoothSeen = anyLabel ? bt : lastBluetoothSeen;

        if (changed || audioRouteValue !== 'default') await applyAudioRoute();
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
        <li style="margin-bottom:3px;"><b>${String(u.name).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</b> ${u.isMuted ? '🔇 (Muted)' : '🎙️ (Active)'}</li>
    `).join('') + '</ul>';
}

// Bluetooth / headphones connected or removed: phones often report it a moment late, so look twice
if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', () => {
        refreshAudioOutputDevices();
        setTimeout(refreshAudioOutputDevices, 1500);
    });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAudioOutputDevices(); });
setTimeout(refreshAudioOutputDevices, 2500);

// -------------------------------------------------------------
// 7. BACKGROUND RESILIENCE, SCREEN RESUME & RECONNECT LISTENERS
// -------------------------------------------------------------
async function handleScreenResumeVoice() {
    if (document.hidden) return;

    const activeRoom = getActiveRoomCode();
    if (!activeRoom) return; // Do not auto-connect voice while on the main menu or login screen

    requestScreenWakeLock();
    startBackgroundKeepAliveOscillator();

    // If disconnected while sleeping, reconnect voice with a fresh token (but let the
    // SDK finish its own reconnect when it is already 'reconnecting'/'connecting')
    const lkState = livekitRoom ? livekitRoom.state : 'disconnected';
    if (!livekitRoom || lkState === 'disconnected' || (!isLiveKitConnected && lkState !== 'reconnecting' && lkState !== 'connecting')) {
        if (!isConnectingVoice) {
            triggerVoiceReconnect();
        }
        return;
    }

    if (livekitRoom.startAudio) {
        livekitRoom.startAudio().catch(() => {});
    }
}

document.addEventListener('visibilitychange', handleScreenResumeVoice);
window.addEventListener('pageshow', handleScreenResumeVoice);
window.addEventListener('focus', handleScreenResumeVoice);

// Universal initial user-gesture audio unlock (executes once only)
function unlockAudioOnFirstTouch() {
    if (getActiveRoomCode()) {
        startBackgroundKeepAliveOscillator();
        requestScreenWakeLock();
    }
    if (livekitRoom && livekitRoom.startAudio) {
        livekitRoom.startAudio().catch(() => {});
    }

    window.removeEventListener('touchstart', unlockAudioOnFirstTouch);
    window.removeEventListener('pointerdown', unlockAudioOnFirstTouch);
    window.removeEventListener('click', unlockAudioOnFirstTouch);
}

window.addEventListener('touchstart', unlockAudioOnFirstTouch, { passive: true });
window.addEventListener('pointerdown', unlockAudioOnFirstTouch, { passive: true });
window.addEventListener('click', unlockAudioOnFirstTouch);

// Global Exports
window.connectLiveKit = connectLiveKit;
window.connectToLiveKit = connectToLiveKit;
window.connectToLiveKitRoom = connectToLiveKit;   // legacy alias used by older callers
window.forceMuteLocalMic = forceMuteLocalMicByAdmin;
window.syncRemoteParticipantMuteState = syncRemoteParticipantMuteState;
window.toggleVoiceOnOff = toggleVoiceOnOff;
window.toggleLiveKitVoice = toggleVoiceOnOff;
window.forceMuteLocalMicByAdmin = forceMuteLocalMicByAdmin;
window.disconnectLiveKit = disconnectLiveKit;
window.setAudioOutputDevice = setAudioOutputDevice;
window.refreshAudioOutputDevices = refreshAudioOutputDevices;
window.__audioRoute = { apply: applyAudioRoute, state: () => ({ value: audioRouteValue, options: audioRouteOptions }) };
window.refreshVoiceParticipantsList = refreshVoiceParticipantsList;
window.setVoiceChatVolume = setVoiceChatVolume;
window.triggerVoiceReconnect = triggerVoiceReconnect;
window.sendVCStatusInternal = sendVCStatusInternal;
