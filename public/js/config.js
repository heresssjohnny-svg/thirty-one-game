// public/js/config.js
window.clientState = {
    username: 'Player1',
    isReady: false,
    playersList: [],
    spectatorsList: [],
    discardTop: null,
    sideBetLedger: {},
    mainGameLedger: {},
    botBetLedger: {},
    lastDiscardPickup: null,
    gameState: 'lobby',
    activeParticipantsCount: 3,
    isSpectator: false,
    tiedParticipantsList: [],
    activeBetsList: [],
    pendingBetsList: []
};

window.appGlobals = {
    ws: null,
    isConnected: false,
    pendingQueue: [],
    lastKnownKnockedBy: null,
    hasChosenPoolCard: false,
    lastPhaseMessage: '',
    lastGameState: '',
    currentJoinedCode: null,
    latestLobbySnapshot: null,
    lastCelebratedWinner: null,
    
    // LiveKit Voice Chat State
    livekitRoom: null,
    isLiveKitConnected: false,
    isVoiceChatActive: false,
    isConnectingVoice: false,
    latestLiveKitHost: null,
    latestLiveKitToken: null,

    // YouTube Audio State
    activeSyncedSongKey: '',
    individualVolume: 0.8,
    isIndividualMuted: false
};
