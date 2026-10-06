// public/js/music.js
function parseYouTubeEmbedUrl(url, autoplay = true) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    const autoStr = autoplay ? '1' : '0';
    if (match && match[2].length === 11) {
        return `https://www.youtube.com/embed/${match[2]}?autoplay=${autoStr}&enablejsapi=1`;
    }
    return url;
}

function addNewSongToPlaylist() {
    const titleInput = document.getElementById('new-song-title');
    const urlInput = document.getElementById('new-song-url');
    const title = titleInput.value.trim();
    const rawUrl = urlInput.value.trim();

    if (!title || !rawUrl) {
        alert("Please provide both a song title and a valid YouTube link.");
        return;
    }

    const embedUrl = parseYouTubeEmbedUrl(rawUrl, true);
    initSocketAndSend({ type: 'ADD_PLAYLIST_SONG', title, url: embedUrl });
    titleInput.value = '';
    urlInput.value = '';
    showCenterNotification(`Added "${title}" to queue!`);
}

function sendMusicControl(action, index = null) {
    initSocketAndSend({ type: 'CONTROL_MUSIC', action, index });
}

function adjustIndividualVolume(val) {
    window.appGlobals.individualVolume = parseFloat(val);
    const slider = document.getElementById('individual-volume-slider');
    if (slider) slider.value = window.appGlobals.individualVolume;
    const iframe = document.querySelector('#youtube-embed-container iframe');
    if (iframe?.contentWindow) {
        try {
            iframe.contentWindow.postMessage(JSON.stringify({
                event: 'command',
                func: 'setVolume',
                args: [window.appGlobals.individualVolume * 100]
            }), '*');
        } catch (e) {}
    }
}

function toggleIndividualMusicMute() {
    window.appGlobals.isIndividualMuted = !window.appGlobals.isIndividualMuted;
    const btn = document.getElementById('individual-mute-btn');
    if (btn) btn.innerText = window.appGlobals.isIndividualMuted ? 'Vol: Off' : 'Vol: On';
    const iframe = document.querySelector('#youtube-embed-container iframe');
    if (iframe?.contentWindow) {
        try {
            const funcName = window.appGlobals.isIndividualMuted ? 'mute' : 'unMute';
            iframe.contentWindow.postMessage(JSON.stringify({
                event: 'command',
                func: funcName,
                args: []
            }), '*');
        } catch (e) {}
    }
}

function renderYouTubePlayer(playlist, currentIndex, isPlaying) {
    const container = document.getElementById('youtube-embed-container');
    if (!container) return;
    if (!playlist || playlist.length === 0 || !isPlaying) {
        container.innerHTML = '<div style="color:#64748b; font-size:0.75rem;">No song playing (Paused)</div>';
        window.appGlobals.activeSyncedSongKey = '';
        return;
    }

    const currentSong = playlist[currentIndex] || playlist[0];
    const songUniqueKey = `${currentIndex}_${currentSong.url}_${isPlaying}`;
    const embedUrl = parseYouTubeEmbedUrl(currentSong.url, isPlaying);

    if (window.appGlobals.activeSyncedSongKey !== songUniqueKey) {
        window.appGlobals.activeSyncedSongKey = songUniqueKey;
        container.innerHTML = `
            <iframe width="100%" height="100%" src="${embedUrl}" title="${currentSong.title}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
        `;
    }
}

