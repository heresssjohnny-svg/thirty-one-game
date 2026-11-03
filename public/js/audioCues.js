// public/js/audioCues.js - De-duplicates and sequences the knock / your-turn cues
//
// Why: when a player knocks, ui.js plays the knock cue twice in the button
// handler (safePlaySound('knock') + speakKnockedCue()) and then twice again
// when the server's state update arrives, so the knocker heard it 4x and
// everyone else 2x. The "your turn" cue could also fire in the same tick as
// the knock when the next player is you.
//
// This module is loaded last and wraps window.playSound (the real player from
// app.js) so that:
//   - a knock cue is played at most once per KNOCK_DEDUPE_MS
//   - a your-turn cue requested shortly after a knock is held until
//     TURN_AFTER_KNOCK_MS after the knock started (knock first, then your turn)
//   - a your-turn cue is played at most once per TURN_DEDUPE_MS
// All the aliases ui.js / audio.js use (safePlaySound, triggerAudioCue,
// speakKnockedCue, playYourTurnCue) are pointed at the same wrapper.

(function () {
    if (window.__audioCuesInstalled) return;
    window.__audioCuesInstalled = true;

    const KNOCK_DEDUPE_MS = 2500;
    const TURN_DEDUPE_MS = 1500;
    const TURN_AFTER_KNOCK_MS = 1800;

    let lastKnockAt = 0;
    let lastTurnAt = 0;
    let pendingTurnTimer = null;

    function install() {
        const base = window.playSound;
        if (typeof base !== 'function' || base.__cueWrapped) return false;

        const wrapped = function (cueType) {
            const type = (cueType === 'turn') ? 'yourturn' : cueType;
            const now = Date.now();

            if (type === 'knock') {
                if (now - lastKnockAt < KNOCK_DEDUPE_MS) return;
                lastKnockAt = now;
                return base.call(this, 'knock');
            }

            if (type === 'yourturn') {
                const sinceKnock = now - lastKnockAt;
                if (sinceKnock >= 0 && sinceKnock < TURN_AFTER_KNOCK_MS) {
                    // Let the knock finish first, then announce the turn
                    if (pendingTurnTimer) return;
                    pendingTurnTimer = setTimeout(() => {
                        pendingTurnTimer = null;
                        lastTurnAt = Date.now();
                        base.call(window, 'yourturn');
                    }, TURN_AFTER_KNOCK_MS - sinceKnock);
                    return;
                }
                if (now - lastTurnAt < TURN_DEDUPE_MS) return;
                lastTurnAt = now;
                return base.call(this, 'yourturn');
            }

            return base.apply(this, arguments);
        };
        wrapped.__cueWrapped = true;

        window.playSound = wrapped;
        window.safePlaySound = wrapped;
        window.triggerAudioCue = wrapped;
        window.speakKnockedCue = function () { wrapped('knock'); };
        window.playYourTurnCue = function () { wrapped('yourturn'); };
        return true;
    }

    if (!install()) {
        let tries = 0;
        const t = setInterval(() => { if (install() || ++tries > 50) clearInterval(t); }, 100);
    }
})();
