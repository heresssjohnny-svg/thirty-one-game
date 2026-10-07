// public/js/voice.js
function getLiveKitSDK() {
    return window.LivekitClient || window.LiveKitClient || null;
}

async function connectToLiveKit(host, token) {
    const LK = getLiveKitSDK();
    if (!LK) return;

    if (window.appGlobals.isConnectingVoice) return;
    window.appGlobals.isConnectingVoice = true;

    try {
        if (window.appGlobals.livekitRoom) {
            try { await window.appGlobals.livekitRoom.disconnect(); } catch (e) {}
            window.appGlobals.livekitRoom = null;
        }

        window.appGlobals.livekitRoom = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        window.appGlobals.livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track) => {
            if (track.kind === LK.Track.Kind.Audio || track.kind === 'audio') {
                const audioElem = track.attach();
                audioElem.autoplay = true;
                audioElem.playsInline = true;
                audioElem.volume = 1.0;
                audioElem.setAttribute('playsinline', '');
                audioElem.setAttribute('webkit-playsinline', '');
                
                if (typeof audioElem.setSinkId === 'function') {
                    audioElem.setSinkId('speaker').catch(() => {});
                }
                document.body.appendChild(audioElem);
            }
        });

        window.appGlobals.livekitRoom.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(el => el.remove());
        });

        window.appGlobals.livekitRoom.on(LK.RoomEvent.Disconnected, () => {
            window.appGlobals.isLiveKitConnected = false;
            window.appGlobals.isVoiceChatActive = false;
            updateVoiceUI();
        });

        await window.appGlobals.livekitRoom.connect(host, token);
        window.appGlobals.isLiveKitConnected = true;

        await window.appGlobals.livekitRoom.localParticipant.setMicrophoneEnabled(false);
        window.appGlobals.isVoiceChatActive = false;
        updateVoiceUI();
        sendVCStatusInternal(true, true);
        enableBackgroundAudioKeepAlive();

    } catch (error) {
        console.error("Failed to connect to LiveKit room:", error);
    } finally {
        window.appGlobals.isConnectingVoice = false;
    }
}

if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
    navigator.mediaDevices.ondevicechange = async () => {
        const LK = getLiveKitSDK();
        if (LK && window.appGlobals.livekitRoom && window.appGlobals.livekitRoom.state === 'connected') {
            try {
                const audioDevices = await LK.Room.getLocalDevices('audioinput');
                if (audioDevices && audioDevices.length > 0 && window.appGlobals.isVoiceChatActive) {
                    await window.appGlobals.livekitRoom.switchActiveDevice('audioinput', audioDevices[0].deviceId);
                }
            } catch (e) {
                console.log("Device switch exception:", e);
            }
        }
    };
}

async function toggleVoiceOnOff() {
    if (!window.appGlobals.livekitRoom || !window.appGlobals.isLiveKitConnected) {
        if (window.appGlobals.latestLiveKitHost && window.appGlobals.latestLiveKitToken) {
            const btn = document.getElementById('vc-main-btn');
            if (btn) btn.innerText = 'Connecting...';
            await connectToLiveKit(window.appGlobals.latestLiveKitHost, window.appGlobals.latestLiveKitToken);
        } else {
            initSocketAndSend({ type: 'REQUEST_LIVEKIT_TOKEN' });
            return;
        }
    }

    if (!window.appGlobals.livekitRoom || !window.appGlobals.isLiveKitConnected) return;

    try {
        const ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') ctx.resume();

        if (window.appGlobals.isVoiceChatActive) {
            await window.appGlobals.livekitRoom.localParticipant.setMicrophoneEnabled(false);
            window.appGlobals.isVoiceChatActive = false;
            updateVoiceUI();
            sendVCStatusInternal(true, true);
        } else {
            if (window.appGlobals.livekitRoom.startAudio) await window.appGlobals.livekitRoom.startAudio();
            await window.appGlobals.livekitRoom.localParticipant.setMicrophoneEnabled(true);
            window.appGlobals.isVoiceChatActive = true;
            updateVoiceUI();
            sendVCStatusInternal(true, false);
        }
    } catch (err) {
        console.error("Microphone toggle error:", err);
        window.appGlobals.isVoiceChatActive = false;
        updateVoiceUI();
        alert("Microphone permission denied or unavailable.");
    }
}

function updateVoiceUI() {
    const btn = document.getElementById('vc-main-btn');
    const led = document.getElementById('vc-led');
    if (btn) btn.innerText = window.appGlobals.isVoiceChatActive ? '🎙️ Voice: On' : '🎙️ Voice: Off';
    if (led) {
        if (window.appGlobals.isVoiceChatActive) led.classList.add('active');
        else led.classList.remove('active');
    }
}

async function disconnectLiveKit() {
    if (window.appGlobals.livekitRoom) {
        try { await window.appGlobals.livekitRoom.disconnect(); } catch (e) {}
        window.appGlobals.livekitRoom = null;
    }
    window.appGlobals.isLiveKitConnected = false;
    window.appGlobals.isVoiceChatActive = false;
    updateVoiceUI();
}

function sendVCStatusInternal(inVC, isMuted) {
    initSocketAndSend({ type: 'UPDATE_VC_STATUS', inVC, isMuted });
}

function triggerVoiceReconnect() {
    if (window.appGlobals.latestLiveKitHost && window.appGlobals.latestLiveKitToken) {
        connectToLiveKit(window.appGlobals.latestLiveKitHost, window.appGlobals.latestLiveKitToken);
        showCenterNotification("Reconnecting voice chat...");
    } else {
        initSocketAndSend({ type: 'REQUEST_LIVEKIT_TOKEN' });
    }
    toggleModal('vc-participants-modal');
}

function openVcParticipantsModal() {
    const listDiv = document.getElementById('vc-participants-list');
    if (!window.appGlobals.latestLobbySnapshot) {
        listDiv.innerHTML = 'No active lobby data.';
        toggleModal('vc-participants-modal');
        return;
    }
    const vcUsers = [];
    window.appGlobals.latestLobbySnapshot.players.forEach(p => { if (p.inVC) vcUsers.push({ username: p.username, isMuted: p.isMuted }); });
    window.appGlobals.latestLobbySnapshot.spectators.forEach(s => { if (s.inVC) vcUsers.push({ username: s.username, isMuted: s.isMuted }); });
    if (vcUsers.length === 0) {
        listDiv.innerHTML = 'No one currently in voice chat.';
    } else {
        listDiv.innerHTML = '<ul>' + vcUsers.map(u => `<li style="margin-bottom:4px;"><b>${u.username}</b> ${u.isMuted ? '🔇 (Muted)' : '🎙️ (Active)'}</li>`).join('') + '</ul>';
    }
    toggleModal('vc-participants-modal');
}
