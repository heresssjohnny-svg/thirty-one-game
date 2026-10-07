let currentPlaylistQueue = [];
let activeSyncedSongKey = '';
let individualVolume = 0.8;
let isIndividualMuted = false;

function extractYouTubeVideoId(url) {
    const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regExp);
    return (match && match[1]) ? match[1] : null;
}

function addNewSongToPlaylist() {
    const titleInput = document.getElementById('new-song-title');
    const urlInput = document.getElementById('new-song-url');
    if (!titleInput || !urlInput) return;

    const title = titleInput.value.trim();
    const rawUrl = urlInput.value.trim();

    if (!title || !rawUrl) {
        alert("Please provide both a song title and a valid YouTube link.");
        return;
    }

    const videoId = extractYouTubeVideoId(rawUrl);
    if (!videoId) {
        alert("Could not recognize YouTube URL. Please use a link from youtu.be or youtube.com");
        return;
    }

    const cleanEmbedUrl = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
    initSocketAndSend({ type: 'ADD_PLAYLIST_SONG', title, url: cleanEmbedUrl });
    titleInput.value = '';
    urlInput.value = '';
    if (typeof showCenterNotification === 'function') {
        showCenterNotification(`Added "${title}" to queue!`);
    }
}

function removeSongFromPlaylist(index) {
    initSocketAndSend({ type: 'REMOVE_PLAYLIST_SONG', index });
}

function sendMusicControl(action, index = null) {
    initSocketAndSend({ type: 'CONTROL_MUSIC', action, index });
}

function adjustIndividualVolume(val) {
    individualVolume = parseFloat(val);
    const slider = document.getElementById('individual-volume-slider');
    if (slider) slider.value = individualVolume;

    const iframe = document.querySelector('#youtube-embed-container iframe');
    if (iframe && iframe.contentWindow) {
        try {
            iframe.contentWindow.postMessage(JSON.stringify({
                event: 'command',
                func: 'setVolume',
                args: [individualVolume * 100]
            }), '*');
        } catch (e) {}
    }
}

function toggleIndividualMusicMute() {
    isIndividualMuted = !isIndividualMuted;
    const btn = document.getElementById('individual-mute-btn');
    if (btn) btn.innerText = isIndividualMuted ? 'Vol: Off' : 'Vol: On';

    const iframe = document.querySelector('#youtube-embed-container iframe');
    if (iframe && iframe.contentWindow) {
        try {
            const funcName = isIndividualMuted ? 'mute' : 'unMute';
            iframe.contentWindow.postMessage(JSON.stringify({
                event: 'command',
                func: funcName,
                args: []
            }), '*');
        } catch (e) {}
    }
}

function renderYouTubePlayer(playlist, currentIndex, isPlaying, elapsedSeconds = 0) {
    const container = document.getElementById('youtube-embed-container');
    const queueContainer = document.getElementById('playlist-container');

    if (queueContainer) {
        if (!playlist || playlist.length === 0) {
            queueContainer.innerHTML = '<div style="padding:4px; color:#64748b;">No songs in queue. Add a YouTube song below.</div>';
        } else {
            queueContainer.innerHTML = playlist.map((s, i) => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:3px; ${i === currentIndex ? 'color:var(--accent-gold); font-weight:bold; background:rgba(250,204,21,0.1); border-radius:4px;' : ''}">
                    <span onclick="sendMusicControl('SELECT', ${i})" style="cursor:pointer; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${i + 1}. ${s.title}</span>
                    <button class="secondary" style="font-size:0.6rem; padding:1px 5px; margin-left:4px;" onclick="removeSongFromPlaylist(${i})">✕</button>
                </div>
            `).join('');
        }
    }

    if (!container) return;
    if (!playlist || playlist.length === 0 || !isPlaying) {
        container.innerHTML = '<div style="color:#64748b; font-size:0.75rem;">No song playing (Paused)</div>';
        activeSyncedSongKey = '';
        return;
    }

    const currentSong = playlist[currentIndex] || playlist[0];
    const songUniqueKey = `${currentIndex}_${currentSong.url}_${isPlaying}`;

    if (activeSyncedSongKey !== songUniqueKey) {
        activeSyncedSongKey = songUniqueKey;
        const separator = currentSong.url.includes('?') ? '&' : '?';
        const syncedUrl = `${currentSong.url}${separator}start=${elapsedSeconds}&autoplay=1`;
        container.innerHTML = `
            <iframe width="100%" height="100%" src="${syncedUrl}" title="${currentSong.title}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
        `;
    } else {
        const iframe = document.querySelector('#youtube-embed-container iframe');
        if (iframe && iframe.contentWindow && elapsedSeconds > 0) {
            try {
                iframe.contentWindow.postMessage(JSON.stringify({
                    event: 'command',
                    func: 'seekTo',
                    args: [elapsedSeconds, true]
                }), '*');
            } catch (e) {}
        }
    }
}
