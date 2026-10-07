let livekitRoom = null;
let isLiveKitConnected = false;
let isLiveKitMuted = true;
let latestLiveKitHost = null;
let latestLiveKitToken = null;

async function connectToLiveKit(host, token) {
    if (!window.LivekitClient) {
        console.error("LiveKit client SDK not loaded");
        return;
    }
    try {
        if (livekitRoom) await livekitRoom.disconnect();

        latestLiveKitHost = host;
        latestLiveKitToken = token;

        livekitRoom = new LivekitClient.Room({
            adaptiveStream: true,
            dynacast: true
        });

        livekitRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === LivekitClient.Track.Kind.Audio) {
                const element = track.attach();
                element.playsInline = true;
                element.setAttribute('playsinline', '');
                element.setAttribute('webkit-playsinline', '');
                document.body.appendChild(element);
            }
        });

        await livekitRoom.connect(host, token);
        isLiveKitConnected = true;
        await livekitRoom.localParticipant.setMicrophoneEnabled(false);
        isLiveKitMuted = true;
        updateLiveKitUI();
    } catch (error) {
        console.error("Failed to connect to LiveKit room:", error);
    }
}

async function toggleVoiceOnOff() {
    if (!livekitRoom || !isLiveKitConnected) {
        if (latestLiveKitHost && latestLiveKitToken) {
            await connectToLiveKit(latestLiveKitHost, latestLiveKitToken);
        } else {
            console.warn("LiveKit credentials not yet received from server.");
            return;
        }
    }

    isLiveKitMuted = !isLiveKitMuted;
    try {
        if (typeof getAudioContext === 'function') {
            let ctx = getAudioContext();
            if (ctx && ctx.state === 'suspended') ctx.resume();
        }
        await livekitRoom.startAudio();
        await livekitRoom.localParticipant.setMicrophoneEnabled(!isLiveKitMuted);
    } catch (e) {
        console.error("Microphone toggle error:", e);
        isLiveKitMuted = !isLiveKitMuted;
    }
    updateLiveKitUI();
}

function updateLiveKitUI() {
    let btn = document.getElementById('vc-main-btn');
    let led = document.getElementById('vc-led');
    if (isLiveKitMuted) {
        if (btn) btn.innerText = '🎙️ Voice: Off';
        if (led) led.classList.remove('active');
    } else {
        if (btn) btn.innerText = '🎙️ Voice: On';
        if (led) led.classList.add('active');
    }
}

function disconnectLiveKit() {
    if (livekitRoom) {
        try {
            livekitRoom.disconnect();
        } catch (e) {}
        livekitRoom = null;
    }
    isLiveKitConnected = false;
    isLiveKitMuted = true;
    updateLiveKitUI();
}

function openVcParticipantsModal() {
    let listDiv = document.getElementById('vc-participants-list');
    if (!listDiv) return;

    if (!window.appGlobals?.latestLobbySnapshot) {
        listDiv.innerHTML = 'No active lobby data.';
        if (typeof toggleModal === 'function') toggleModal('vc-participants-modal');
        return;
    }

    let lobby = window.appGlobals.latestLobbySnapshot;
    let vcUsers = [];
    (lobby.players || []).forEach(p => { if (p.inVC) vcUsers.push({ username: p.username, isMuted: p.isMuted }); });
    (lobby.spectators || []).forEach(s => { if (s.inVC) vcUsers.push({ username: s.username, isMuted: s.isMuted }); });

    if (vcUsers.length === 0) {
        listDiv.innerHTML = 'No one currently in voice chat.';
    } else {
        listDiv.innerHTML = '<ul>' + vcUsers.map(u => `<li style="margin-bottom:4px;"><b>${u.username}</b> ${u.isMuted ? '🔇 (Muted)' : '🎙️ (Active)'}</li>`).join('') + '</ul>';
    }
    if (typeof toggleModal === 'function') toggleModal('vc-participants-modal');
}

function triggerVoiceReconnect() {
    if (latestLiveKitHost && latestLiveKitToken) {
        connectToLiveKit(latestLiveKitHost, latestLiveKitToken);
        if (typeof showCenterNotification === 'function') {
            showCenterNotification("Reconnecting voice chat...");
        }
    }
    if (typeof toggleModal === 'function') toggleModal('vc-participants-modal');
}
