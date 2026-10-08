// public/js/config.js - Client State & Global Config

window.GOOGLE_CLIENT_ID = "420400140659-rpsr8gccd88sbbjiibq0dt2196ftgrb9.apps.googleusercontent.com";

window.clientState = {
    username: '',
    lobbyCode: '',
    seat: null,
    lives: 2,
    cards: [],
    gameState: 'lobby',
    turnIndex: 0,
    dealerIndex: 0,
    currentTurnUser: '',
    knockedBy: null,
    isBot: false,
    inVC: false,
    isMuted: true,
    lastDiscardPickup: null,
    fedCardReminder: null,
    activeBets: [],
    pendingBets: [],
    globalProposals: []
};

window.appGlobals = {
    ws: null,
    livekitRoom: null,
    audioContext: null,
    reconnectAttempts: 0,
    isTabActive: true
};
