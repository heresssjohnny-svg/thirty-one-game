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
// (a call, another app) can use it. The mic is also released automatically when the app goes to the
// background or the system takes the mic (incoming call); it is NOT turned back on by itself.
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
    if (document.hidden) {
        pauseMicForInterruption('app hidden');
    } else if (window.__micPausedForInterruption && !micPausedNoticeShown && isLiveKitConnected) {
        micPausedNoticeShown = true;
        window.__micPausedForInterruption = false;
        if (typeof window.showCenterNotification === 'function') window.showCenterNotification('🎙️ Your mic was turned off while you were away — tap Mic to turn it back on');
    }
});
window.addEventListener('pagehide', () => { pauseMicForInterruption('page hidden'); });

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

const toggleLiveKitVoice = toggleVoiceOnOff;

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
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification("Audio route switched to Phone Speaker");
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
window.refreshVoiceParticipantsList = refreshVoiceParticipantsList;
window.setVoiceChatVolume = setVoiceChatVolume;
window.triggerVoiceReconnect = triggerVoiceReconnect;
window.sendVCStatusInternal = sendVCStatusInternal;
