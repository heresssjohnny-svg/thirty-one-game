window.appGlobals = {
    ws: null,
    isConnected: false,
    pendingQueue: [],
    currentJoinedCode: null,
    latestLobbySnapshot: null,
    lastKnownKnockedBy: null,
    lastTurnUser: '',
    hasChosenPoolCard: false,
    lastPhaseMessage: '',
    lastGameState: '',
    notificationTimer: null
};

window.clientState = {
    username: 'Player1',
    isReady: false,
    playersList: [],
    spectatorsList: [],
    discardTop: null,
    sideBetLedger: {},
    mainGameLedger: {},
    lastDiscardPickup: null,
    pendingBetsForMe: [],
    gameState: 'lobby',
    activeParticipantsCount: 3,
    isSpectator: false,
    tiedParticipantsList: [],
    activeBetsList: [],
    pendingBetsList: [],
    playlist: [],
    currentSongIndex: 0,
    isPlaying: false,
    currentSongElapsedSeconds: 0
};
