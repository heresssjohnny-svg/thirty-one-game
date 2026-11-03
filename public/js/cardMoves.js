// public/js/cardMoves.js - Draw / discard flights, round-over reveal, last-5-seconds tick
//
// Non-invasive: wraps window.updateUIFromLobby (already wrapped by dealAnim.js)
// and compares each lobby snapshot with the previous one. ui.js re-renders the
// whole table from every snapshot, so this module only adds short overlays on
// top of what ui.js has already drawn:
//
//   DRAW     a player's card count goes 3 -> 4: a card flies from the deck (or
//            the discard pile, per the server's phase message) to that seat. For
//            the local player it flies to the new card in the hand and the real
//            card is kept hidden until the flight lands.
//   DISCARD  a player's card count goes 4 -> 3: a card (showing the new top of
//            the discard pile) flies from the seat to the discard pile; the real
//            pile top is kept hidden until it lands. For the local player it
//            starts where the tapped card was.
//   SOUND    every draw / discard by anyone plays the 'card' click (ui.js only
//            played it for your own taps).
//   REVEAL   entering roundOver: every seat's cards are hidden, then flipped
//            over one seat at a time (~450 ms apart); players who lost a life in
//            that hand are revealed last.
//   TICK     during the last 5 seconds of your own turn a soft tick plays once a
//            second (ui.js already vibrates on those seconds).
//
// Skipped while the shuffle & deal overlay is running (body.da-hide-cards).
// Honors the SFX toggle and prefers-reduced-motion (no flights/flips, just sounds).

(function () {
    if (window.__cardMovesInstalled) return;
    window.__cardMovesInstalled = true;

    const FLIGHT_MS = 380;
    const REVEAL_GAP_MS = 450;
    const REVEAL_FLIP_MS = 320;
    const TAP_MEMORY_MS = 4000;
    const DECK_BG = 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)';

    const style = document.createElement('style');
    style.id = 'card-moves-styles';
    style.textContent = `
        #card-moves-layer { position: fixed; inset: 0; z-index: 9300; pointer-events: none; overflow: hidden; }
        .cm-card {
            position: fixed; width: 50px; height: 72px; border-radius: 5px;
            background: ${DECK_BG}; border: 2px solid #ffffff;
            box-shadow: 0 4px 10px rgba(0,0,0,0.6);
            transform: translate(-50%, -50%); will-change: transform, left, top;
            transition: left ${FLIGHT_MS}ms cubic-bezier(0.25, 0.8, 0.3, 1),
                        top ${FLIGHT_MS}ms cubic-bezier(0.25, 0.8, 0.3, 1),
                        transform ${FLIGHT_MS}ms ease, opacity 160ms ease;
        }
        .cm-card:not(.cm-face)::after {
            content: ''; position: absolute; left: 9%; top: 9%; width: 82%; height: 82%;
            border: 1px dashed rgba(255,255,255,0.4); border-radius: 4px;
        }
        .cm-card.cm-face {
            background: #fff; border-color: #cbd5e1; color: #0f172a;
            display: flex; align-items: center; justify-content: center;
            font-weight: 800; font-size: 1.05rem; font-family: inherit;
        }
        .cm-card.cm-face.cm-red { color: #dc2626; }
        .cm-hidden-card { visibility: hidden !important; }
        .cm-reveal-wait { visibility: hidden !important; }
        .cm-reveal-flip { animation: cm-flip ${REVEAL_FLIP_MS}ms ease-out both; transform-origin: center; }
        @keyframes cm-flip {
            0%   { transform: perspective(400px) rotateY(90deg) scale(1.05); opacity: 0.2; }
            60%  { transform: perspective(400px) rotateY(-12deg) scale(1.08); opacity: 1; }
            100% { transform: perspective(400px) rotateY(0deg) scale(1); opacity: 1; }
        }
    `;
    document.head.appendChild(style);

    // ---- helpers ------------------------------------------------------
    const reducedMotion = () =>
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function sfxOn() {
        try { return typeof window.isSfxEnabled !== 'function' || window.isSfxEnabled(); } catch (e) { return true; }
    }
    function cardSound() {
        try { if (sfxOn() && typeof window.playSound === 'function') window.playSound('card'); } catch (e) {}
    }
    function center(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }
    function layer() {
        let l = document.getElementById('card-moves-layer');
        if (!l) { l = document.createElement('div'); l.id = 'card-moves-layer'; document.body.appendChild(l); }
        return l;
    }
    function deckEl() { return document.getElementById('deck-pile'); }
    function discardEl() {
        const area = document.getElementById('deck-center');
        return area ? area.querySelector('.card-slot:not(#deck-pile)') : null;
    }
    function seatEl(username) {
        const want = String(username || '').toLowerCase();
        const nodes = document.querySelectorAll('[data-player-username]');
        for (const el of nodes) {
            if ((el.getAttribute('data-player-username') || '').toLowerCase() === want) return el;
        }
        return null;
    }
    function seatPoint(username) {
        const el = seatEl(username);
        if (!el) return null;
        const c = center(el);
        return { x: c.x, y: c.y + Math.min(18, c.h * 0.25) };
    }
    function myCardEls() {
        const hand = document.getElementById('my-cards-container');
        return hand ? Array.from(hand.querySelectorAll('.my-card, .playing-card')) : [];
    }
    function normSuit(s) {
        return (typeof window.normalizeSuit === 'function') ? window.normalizeSuit(s) : s;
    }
    function isRed(s) { return s === '♥' || s === '♦' || s === 'H' || s === 'D'; }
    function cardCountOf(p) {
        if (typeof p.cardCount === 'number') return p.cardCount;
        return Array.isArray(p.cards) ? p.cards.length : 0;
    }
    function dealing() { return document.body.classList.contains('da-hide-cards'); }

    // ---- flights --------------------------------------------------------
    function fly(from, to, opts) {
        opts = opts || {};
        if (reducedMotion()) { if (opts.onLand) opts.onLand(); return; }
        const l = layer();
        const c = document.createElement('div');
        c.className = 'cm-card';
        if (opts.face) {
            const suit = normSuit(opts.face.suit);
            c.classList.add('cm-face');
            if (isRed(suit)) c.classList.add('cm-red');
            c.textContent = `${opts.face.val || ''}${suit || ''}`;
        }
        if (opts.size) { c.style.width = `${opts.size.w}px`; c.style.height = `${opts.size.h}px`; }
        c.style.left = `${from.x}px`;
        c.style.top = `${from.y}px`;
        c.style.transform = `translate(-50%, -50%) rotate(${opts.fromRot || 0}deg) scale(${opts.fromScale || 1})`;
        l.appendChild(c);
        requestAnimationFrame(() => {
            c.style.left = `${to.x}px`;
            c.style.top = `${to.y}px`;
            c.style.transform = `translate(-50%, -50%) rotate(${opts.toRot || 0}deg) scale(${opts.toScale || 1})`;
        });
        setTimeout(() => {
            if (opts.onLand) { try { opts.onLand(); } catch (e) {} }
            c.style.opacity = '0';
            setTimeout(() => c.remove(), 180);
        }, FLIGHT_MS + 20);
    }

    // Remember where the local player tapped, so the discard flight starts there
    let lastTap = null;
    function wrapDiscardTap() {
        const base = window.discardCard;
        if (typeof base !== 'function' || base.__cmWrapped) return false;
        const wrapped = function (cardIndex) {
            try {
                const els = myCardEls();
                const el = els[Number(cardIndex)];
                lastTap = { at: Date.now(), point: el ? center(el) : null };
            } catch (e) { lastTap = null; }
            return base.apply(this, arguments);
        };
        wrapped.__cmWrapped = true;
        window.discardCard = wrapped;
        return true;
    }

    function animateDraw(p, isMe, me, lobby, prevDiscard) {
        const fromDiscard = /discard pile/i.test(lobby.phaseMessage || '') &&
            (lobby.phaseMessage || '').toLowerCase().includes(String(p.username).toLowerCase());
        const srcEl = fromDiscard ? discardEl() : deckEl();
        const from = srcEl ? center(srcEl) : null;
        if (!from) return;
        const size = { w: from.w || 52, h: from.h || 74 };
        const face = fromDiscard && prevDiscard ? prevDiscard : null;

        if (isMe) {
            const els = myCardEls();
            const target = els.length ? els[els.length - 1] : null;
            if (!target) return;
            target.classList.add('cm-hidden-card');
            const to = center(target);
            const newCard = (me.cards && me.cards.length) ? me.cards[me.cards.length - 1] : null;
            fly(from, { x: to.x, y: to.y }, {
                face: face || newCard, size, toScale: to.w ? (to.w / size.w) : 1.6, fromRot: -6,
                onLand: () => target.classList.remove('cm-hidden-card')
            });
            // Safety: never leave the real card hidden
            setTimeout(() => target.classList.remove('cm-hidden-card'), FLIGHT_MS + 600);
        } else {
            const to = seatPoint(p.username);
            if (!to) return;
            fly(from, to, { face, size, toScale: 0.7, toRot: Math.random() * 20 - 10 });
        }
    }

    function animateDiscard(p, isMe, lobby) {
        const pileEl = discardEl();
        if (!pileEl) return;
        const to = center(pileEl);
        const size = { w: to.w || 52, h: to.h || 74 };
        const face = lobby.discardTop || null;

        let from = null;
        let fromScale = 0.7;
        if (isMe) {
            if (lastTap && Date.now() - lastTap.at < TAP_MEMORY_MS && lastTap.point) {
                from = lastTap.point;
                fromScale = lastTap.point.w ? lastTap.point.w / size.w : 1.6;
            } else {
                const hand = document.getElementById('my-cards-container');
                if (hand) { from = center(hand); fromScale = 1.4; }
            }
            lastTap = null;
        } else {
            from = seatPoint(p.username);
        }
        if (!from) return;

        pileEl.classList.add('cm-hidden-card');
        fly(from, { x: to.x, y: to.y }, {
            face, size, fromScale, toScale: 1, fromRot: Math.random() * 16 - 8,
            onLand: () => pileEl.classList.remove('cm-hidden-card')
        });
        setTimeout(() => pileEl.classList.remove('cm-hidden-card'), FLIGHT_MS + 600);
    }

    // ---- round-over reveal -------------------------------------------
    let reveal = null; // { order: [names], shownUpTo: n, timers: [] }

    function clearReveal() {
        if (reveal) reveal.timers.forEach(clearTimeout);
        reveal = null;
    }

    function applyRevealVisibility() {
        if (!reveal) return;
        reveal.order.forEach((name, i) => {
            const seat = seatEl(name);
            if (!seat) return;
            const parts = seat.querySelectorAll('.seat-cards, .showdown-score-pill');
            parts.forEach(el => {
                if (i < reveal.shownUpTo) el.classList.remove('cm-reveal-wait');
                else el.classList.add('cm-reveal-wait');
            });
        });
    }

    function startReveal(lobby, prevPlayers) {
        clearReveal();
        const players = (lobby.players || []).filter(p => Array.isArray(p.cards) && p.cards.length > 0);
        if (players.length < 2) return;
        const lost = p => {
            const before = prevPlayers[String(p.username).toLowerCase()];
            return before && typeof before.lives === 'number' && typeof p.lives === 'number' && p.lives < before.lives;
        };
        const safe = players.filter(p => !lost(p)).map(p => p.username);
        const losers = players.filter(p => lost(p)).map(p => p.username);
        const order = safe.concat(losers);
        const reduce = reducedMotion();

        reveal = { order, shownUpTo: 0, timers: [] };
        applyRevealVisibility();

        order.forEach((name, i) => {
            const t = setTimeout(() => {
                if (!reveal) return;
                reveal.shownUpTo = i + 1;
                applyRevealVisibility();
                const seat = seatEl(name);
                if (seat && !reduce) {
                    seat.querySelectorAll('.seat-cards').forEach(el => {
                        el.classList.remove('cm-reveal-flip');
                        void el.offsetWidth;
                        el.classList.add('cm-reveal-flip');
                    });
                }
                cardSound();
                if (i === order.length - 1) {
                    const done = setTimeout(() => { reveal = null; }, REVEAL_FLIP_MS + 50);
                    if (reveal) reveal.timers.push(done);
                }
            }, 250 + i * REVEAL_GAP_MS);
            reveal.timers.push(t);
        });
    }

    // ---- last-5-seconds tick -------------------------------------------
    let latest = null;
    let lastTickSecond = null;

    function tick() {
        try {
            const ctx = (typeof window.getAudioContext === 'function') ? window.getAudioContext() : null;
            if (!ctx) return;
            const vol = (typeof window.getSfxVolume === 'function') ? window.getSfxVolume() : 0.6;
            if (vol <= 0) return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            const now = ctx.currentTime;
            osc.type = 'square';
            osc.frequency.setValueAtTime(1400, now);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.18 * vol, now + 0.005);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
            osc.start(now);
            osc.stop(now + 0.07);
        } catch (e) {}
    }

    function tickWatch() {
        const lobby = latest;
        if (!lobby || dealing()) { lastTickSecond = null; return; }
        if ((lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') || !lobby.turnDeadline) { lastTickSecond = null; return; }
        const me = (lobby.players || []).find(p => p.isMe);
        if (!me || String(me.username).toLowerCase() !== String(lobby.currentTurnUser || '').toLowerCase()) { lastTickSecond = null; return; }
        const skew = (typeof lobby.serverNow === 'number' && typeof lobby.__receivedAt === 'number') ? (lobby.serverNow - lobby.__receivedAt) : 0;
        const secsLeft = Math.ceil((lobby.turnDeadline - (Date.now() + skew)) / 1000);
        if (secsLeft >= 1 && secsLeft <= 5) {
            if (lastTickSecond !== secsLeft) { lastTickSecond = secsLeft; if (sfxOn()) tick(); }
        } else {
            lastTickSecond = null;
        }
    }
    setInterval(tickWatch, 120);

    // ---- snapshot diffing ---------------------------------------------
    let prev = null; // { state, players: {name: {count, lives}}, discardTop }

    function summarize(lobby) {
        const players = {};
        (lobby.players || []).forEach(p => {
            players[String(p.username).toLowerCase()] = { count: cardCountOf(p), lives: p.lives };
        });
        return { state: lobby.gameState, players, discardTop: lobby.discardTop || null };
    }

    function onSnapshot(lobby) {
        if (!lobby || !lobby.gameState) return;
        try { lobby.__receivedAt = Date.now(); } catch (e) {}
        latest = lobby;
        const cur = summarize(lobby);
        const before = prev;
        prev = cur;
        if (!before) return;

        const inPlay = lobby.gameState === 'playing' || lobby.gameState === 'finalTurn';
        const wasInPlay = before.state === 'playing' || before.state === 'finalTurn';

        // Round over: staggered reveal, losers last
        if (lobby.gameState === 'roundOver') {
            if (before.state !== 'roundOver') startReveal(lobby, before.players);
            else applyRevealVisibility();   // ui.js re-rendered mid-reveal
            return;
        }
        if (reveal) clearReveal();

        if (!inPlay || !wasInPlay || dealing()) return;

        const me = (lobby.players || []).find(p => p.isMe);
        (lobby.players || []).forEach(p => {
            const b = before.players[String(p.username).toLowerCase()];
            if (!b) return;
            const now = cardCountOf(p);
            const isMe = !!(me && me.username === p.username);
            if (now === b.count + 1) {
                cardSound();
                animateDraw(p, isMe, me, lobby, before.discardTop);
            } else if (now === b.count - 1 && b.count > 0) {
                cardSound();
                animateDiscard(p, isMe, lobby);
            }
        });
    }

    // ---- hook into the UI render pipeline -----------------------------
    function install() {
        const original = window.updateUIFromLobby;
        if (typeof original !== 'function' || original.__cardMovesWrapped) return false;
        const wrapped = function (lobby) {
            const result = original.apply(this, arguments);
            try { onSnapshot(lobby); } catch (e) { console.warn('[CardMoves] skipped:', e); }
            return result;
        };
        wrapped.__cardMovesWrapped = true;
        window.updateUIFromLobby = wrapped;
        window.renderLobbyState = wrapped;
        return true;
    }

    let tries = 0;
    const t = setInterval(() => {
        const a = install() || (window.updateUIFromLobby && window.updateUIFromLobby.__cardMovesWrapped);
        const b = wrapDiscardTap() || (window.discardCard && window.discardCard.__cmWrapped);
        if ((a && b) || ++tries > 50) clearInterval(t);
    }, 100);
    install();
    wrapDiscardTap();
})();
