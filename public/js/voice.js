// public/js/voice.js - LiveKit WebRTC Voice Chat Integration

window.livekitRoom = null;
window.isVoiceConnecting = false;
window.intentionalVoiceDisconnect = false;
window.voiceVolume = 1.0;

// Default to muted (false) on initial join; persists user preference
function getRememberedMicState() {
    return localStorage.getItem('vc_mic_unmuted') === 'true';
}

function setRememberedMicState(isUnmuted) {
    localStorage.setItem('vc_mic_unmuted', isUnmuted ? 'true' : 'false');
}

// -------------------------------------------------------------
// 1. UI STATE HELPERS
// -------------------------------------------------------------
function setVoiceUIState(state) {
    const btn = document.getElementById('vc-main-btn');
    const led = document.getElementById('vc-led');
    if (!btn) return;

    if (state === 'connecting') {
        btn.innerText = '🎙️ Connecting...';
        btn.style.color = '#facc15';
        if (led) {
            led.style.background = '#facc15';
            led.classList.remove('active');
        }
    } else if (state === 'live') {
        btn.innerText = '🎙️ Voice: Live';
        btn.style.color = '#34d399';
        if (led) {
            led.style.background = '#10b981';
            led.classList.add('active');
        }
    } else if (state === 'muted') {
        btn.innerText = '🎙️ Voice: Muted';
        btn.style.color = '#f87171';
        if (led) {
            led.style.background = '#ef4444';
            led.classList.remove('active');
        }
    } else {
        btn.innerText = '🎙️ Voice: Off';
        btn.style.color = '';
        if (led) {
            led.style.background = '#64748b';
            led.classList.remove('active');
        }
    }
}

function updateVoiceParticipantsList() {
    const container1 = document.getElementById('vc-participants-list');
    const container2 = document.querySelector('#vc-participants-modal #vc-participants-list');
    
    if (!window.livekitRoom || window.livekitRoom.state !== 'connected') {
        const emptyMsg = 'No one currently in voice chat.';
        if (container1) container1.innerText = emptyMsg;
        if (container2) container2.innerText = emptyMsg;
        return;
    }

    const participants = [];
    if (window.livekitRoom.localParticipant) {
        const local = window.livekitRoom.localParticipant;
        const isMuted = !local.isMicrophoneEnabled;
        participants.push(`${local.identity || 'You'} (You) - ${isMuted ? '🔇 Muted' : '🎙️ Speaking'}`);
    }

    window.livekitRoom.remoteParticipants.forEach(p => {
        const audioPub = Array.from(p.audioTrackPublications.values())[0];
        const isMuted = !audioPub || audioPub.isMuted;
        participants.push(`${p.identity} - ${isMuted ? '🔇 Muted' : '🎙️ Live'}`);
    });

    const html = participants.map(p => `<div style="padding: 2px 0;">${p}</div>`).join('');
    if (container1) container1.innerHTML = html;
    if (container2) container2.innerHTML = html;
}

// -------------------------------------------------------------
// 2. LIVEKIT ROOM CONNECTION
// -------------------------------------------------------------
window.connectToLiveKitRoom = async function(roomCode, username) {
    if (window.isVoiceConnecting) return;
    if (window.livekitRoom && window.livekitRoom.state === 'connected' && window.livekitRoom.name === roomCode) {
        return;
    }

    const LK = window.LivekitClient || window.livekit;
    if (!LK || !LK.Room) {
        console.warn('[VOICE] LiveKit SDK not available.');
        return;
    }

    window.isVoiceConnecting = true;
    window.intentionalVoiceDisconnect = false;
    setVoiceUIState('connecting');

    try {
        const res = await fetch(`/token?room=${encodeURIComponent(roomCode)}&username=${encodeURIComponent(username)}`);
        if (!res.ok) throw new Error('Token fetch failed');
        const data = await res.json();
        const { token, host } = data;

        if (window.livekitRoom) {
            try { await window.livekitRoom.disconnect(); } catch (e) {}
            window.livekitRoom = null;
        }

        const room = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        // Attach remote incoming audio with background playback support
        room.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'audio') {
                const element = track.attach();
                element.id = `audio-track-${participant.identity}`;
                element.setAttribute('playsinline', 'true');
                element.setAttribute('autoplay', 'true');
                element.volume = window.voiceVolume !== undefined ? window.voiceVolume : 1.0;
                
                // Keep audio element attached directly to body
                document.body.appendChild(element);
                element.play().catch(() => {});
                updateVoiceParticipantsList();
            }
        });

        room.on(LK.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            track.detach();
            const el = document.getElementById(`audio-track-${participant.identity}`);
            if (el) el.remove();
            updateVoiceParticipantsList();
        });

        room.on(LK.RoomEvent.ParticipantConnected, () => updateVoiceParticipantsList());
        room.on(LK.RoomEvent.ParticipantDisconnected, () => updateVoiceParticipantsList());

        // Background auto-reconnection on network drop
        room.on(LK.RoomEvent.Disconnected, () => {
            console.log('[VOICE] Disconnected from room');
            window.livekitRoom = null;
            updateVoiceParticipantsList();

            const currentCode = window.appGlobals?.currentJoinedCode || window.clientState?.code;
            if (currentCode && !window.intentionalVoiceDisconnect) {
                setVoiceUIState('connecting');
                setTimeout(() => {
                    const activeCode = window.appGlobals?.currentJoinedCode || window.clientState?.code;
                    if (activeCode === currentCode && !window.intentionalVoiceDisconnect) {
                        const myUser = (
                            (window.userSession && window.userSession.username) ||
                            document.getElementById('auth-display-user')?.innerText ||
                            document.getElementById('username-input')?.value ||
                            'Player1'
                        ).trim();
                        window.connectToLiveKitRoom(activeCode, myUser);
                    }
                }, 2000);
            } else {
                setVoiceUIState('off');
                if (typeof window.sendSocketMessage === 'function') {
                    window.sendSocketMessage({ type: 'VOICE_STATUS', inVC: false, isMuted: true });
                }
            }
        });

        await room.connect(host, token);
        window.livekitRoom = room;

        // Apply remembered mic state (Defaults to false / MUTED on first run)
        const shouldUnmute = getRememberedMicState();
        await room.localParticipant.setMicrophoneEnabled(shouldUnmute);

        setVoiceUIState(shouldUnmute ? 'live' : 'muted');
        updateVoiceParticipantsList();

        if (typeof window.sendSocketMessage === 'function') {
            window.sendSocketMessage({ type: 'VOICE_STATUS', inVC: true, isMuted: !shouldUnmute });
        }
    } catch (err) {
        console.error('[VOICE] Connection error:', err);
        setVoiceUIState('off');
        if (typeof window.showCenterNotification === 'function') {
            window.showCenterNotification('Voice connection failed: ' + (err.message || 'Check mic permission'));
        }
    } finally {
        window.isVoiceConnecting = false;
    }
};

// -------------------------------------------------------------
// 3. MAIN BUTTON TOGGLE ACTION (MUTE / UNMUTE / REMEMBER)
// -------------------------------------------------------------
window.toggleVoiceOnOff = async function() {
    const roomCode = window.appGlobals?.currentJoinedCode || window.clientState?.code;
    const myUser = (
        (window.userSession && window.userSession.username) ||
        document.getElementById('auth-display-user')?.innerText ||
        document.getElementById('username-input')?.value ||
        'Player1'
    ).trim();

    // 1. If not connected, connect (starts in remembered state or muted)
    if (!window.livekitRoom || window.livekitRoom.state !== 'connected') {
        if (!roomCode) {
            if (typeof window.showCenterNotification === 'function') {
                window.showCenterNotification('Join a game table first to use voice chat.');
            }
            return;
        }
        await window.connectToLiveKitRoom(roomCode, myUser);
        return;
    }

    // 2. Toggle Microphone & Save Preference
    const local = window.livekitRoom.localParticipant;
    if (local.isMicrophoneEnabled) {
        // Mute
        await local.setMicrophoneEnabled(false);
        setRememberedMicState(false);
        setVoiceUIState('muted');
        updateVoiceParticipantsList();
        if (typeof window.sendSocketMessage === 'function') {
            window.sendSocketMessage({ type: 'VOICE_STATUS', inVC: true, isMuted: true });
        }
    } else {
        // Unmute
        await local.setMicrophoneEnabled(true);
        setRememberedMicState(true);
        setVoiceUIState('live');
        updateVoiceParticipantsList();
        if (typeof window.sendSocketMessage === 'function') {
            window.sendSocketMessage({ type: 'VOICE_STATUS', inVC: true, isMuted: false });
        }
    }
};

// -------------------------------------------------------------
// 4. SETTINGS & VOLUME CONTROLS
// -------------------------------------------------------------
window.setVoiceChatVolume = function(val) {
    const num = parseFloat(val);
    window.voiceVolume = isNaN(num) ? 1.0 : num;
    const display = document.getElementById('lk-vol-display');
    if (display) display.innerText = Math.round(window.voiceVolume * 100) + '%';

    document.querySelectorAll('audio[id^="audio-track-"]').forEach(el => {
        el.volume = window.voiceVolume;
    });
};

window.setAudioOutputDevice = async function(deviceId) {
    if (window.livekitRoom && typeof window.livekitRoom.switchActiveDevice === 'function') {
        try {
            await window.livekitRoom.switchActiveDevice('audiooutput', deviceId);
        } catch (e) {
            console.warn('[VOICE] Output device switch error:', e);
        }
    }
};

window.triggerVoiceReconnect = async function() {
    if (window.livekitRoom) {
        try { await window.livekitRoom.disconnect(); } catch (e) {}
        window.livekitRoom = null;
    }
    const roomCode = window.appGlobals?.currentJoinedCode || window.clientState?.code;
    const myUser = (
        (window.userSession && window.userSession.username) ||
        document.getElementById('auth-display-user')?.innerText ||
        document.getElementById('username-input')?.value ||
        'Player1'
    ).trim();

    if (roomCode) {
        await window.connectToLiveKitRoom(roomCode, myUser);
    }
};

// Explicit disconnect on leaving table
window.disconnectVoiceOnExit = function() {
    window.intentionalVoiceDisconnect = true;
    if (window.livekitRoom) {
        try { window.livekitRoom.disconnect(); } catch (e) {}
        window.livekitRoom = null;
    }
    setVoiceUIState('off');
};
