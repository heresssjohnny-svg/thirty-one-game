// public/js/voice.js
let livekitRoom = null;
let isMicActive = false;

async function connectLiveKit(token, host) {
    if (!token || !host) return;
    const LK = window.LivekitClient || window.LiveKitClient;[span_4](start_span)[span_4](end_span)[span_5](start_span)[span_5](end_span)
    if (!LK) return;

    try {
        if (livekitRoom) {
            await livekitRoom.disconnect();
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
        });[span_6](start_span)[span_6](end_span)[span_7](start_span)[span_7](end_span)

        livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track, pub, participant) => {
            if (track.kind === LK.Track.Kind.Audio || track.kind === 'audio') {[span_8](start_span)[span_8](end_span)[span_9](start_span)[span_9](end_span)
                const audioElem = track.attach();[span_10](start_span)[span_10](end_span)[span_11](start_span)[span_11](end_span)
                audioElem.autoplay = true;
                audioElem.volume = 1.0;
                document.body.appendChild(audioElem);[span_12](start_span)[span_12](end_span)[span_13](start_span)[span_13](end_span)
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(el => el.remove());
        });

        livekitRoom.on(LK.RoomEvent.Disconnected, () => {
            isMicActive = false;
            updateVoiceButtonUI();
        });

        await livekitRoom.connect(host, token);[span_14](start_span)[span_14](end_span)[span_15](start_span)[span_15](end_span)[span_16](start_span)[span_16](end_span)

        // Join room muted by default
        await livekitRoom.localParticipant.setMicrophoneEnabled(false);
        isMicActive = false;
        updateVoiceButtonUI();

        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({ type: 'VC_STATUS_UPDATE', inVC: true, isMuted: true });
        }
    } catch (err) {
        console.warn("LiveKit connection notice:", err);
    }
}

async function toggleVoiceOnOff() {
    if (!livekitRoom) {
        if (window.appGlobals?.currentJoinedCode) {
            showCenterNotification("Connecting voice room...");
            return;
        }
        return;
    }

    const btn = document.getElementById('vc-main-btn');
    if (btn) btn.disabled = true;

    try {
        if (isMicActive) {
            await livekitRoom.localParticipant.setMicrophoneEnabled(false);
            isMicActive = false;
        } else {
            if (livekitRoom.startAudio) await livekitRoom.startAudio();
            await livekitRoom.localParticipant.setMicrophoneEnabled(true);
            isMicActive = true;
        }

        updateVoiceButtonUI();

        if (typeof initSocketAndSend === 'function') {
            initSocketAndSend({ type: 'VC_STATUS_UPDATE', inVC: true, isMuted: !isMicActive });
        }
    } catch (err) {
        console.error("Microphone permission/device error:", err);
        isMicActive = false;
        updateVoiceButtonUI();
        showCenterNotification("Microphone access denied or unavailable.");
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Alias to ensure any legacy button calls function properly
const toggleLiveKitVoice = toggleVoiceOnOff;

function updateVoiceButtonUI() {
    const btn = document.getElementById('vc-main-btn');
    const led = document.getElementById('vc-led');

    if (btn) {
        btn.innerText = isMicActive ? '🎙️ Voice: On' : '🎙️ Voice: Off';
    }
    if (led) {
        if (isMicActive) {
            led.classList.add('active');
        } else {
            led.classList.remove('active');
        }
    }
}

function disconnectLiveKit() {
    if (livekitRoom) {
        try { livekitRoom.disconnect(); } catch (e) {}[span_17](start_span)[span_17](end_span)
        livekitRoom = null;
    }
    isMicActive = false;
    updateVoiceButtonUI();
}
