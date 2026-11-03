// public/js/dealAnim.js - Shuffle & Deal Animation at the start of every hand
//
// Non-invasive: wraps window.updateUIFromLobby (from ui.js). When a lobby snapshot
// transitions INTO 'playing' from a non-playing state (dealerDraw, roundOver, lobby,
// tieBreaker), the freshly rendered cards are hidden, a shuffle + deal overlay runs
// over the felt, and the real cards are revealed when it finishes.
//
// Honors: prefers-reduced-motion, the SFX toggle, and never blocks input for more
// than ~3 seconds (hard safety timeout).

(function () {
    if (window.__dealAnimInstalled) return;
    window.__dealAnimInstalled = true;

    const SHUFFLE_MS = 900;
    const DEAL_STAGGER_MS = 110;
    const CARD_FLIGHT_MS = 420;
    const FLIP_MS = 260;
    const HARD_TIMEOUT_MS = 3200;

    let running = false;
    let lastState = null;
    let safetyTimer = null;

    // -------------------------------------------------------------
    // Styles (injected so no CSS file edit is required)
    // -------------------------------------------------------------
    const style = document.createElement('style');
    style.id = 'deal-anim-styles';
    style.textContent = `
        #deal-anim-layer {
            position: fixed; inset: 0; z-index: 9400; pointer-events: none; overflow: hidden;
        }
        .da-card {
            position: fixed; width: 44px; height: 62px; border-radius: 5px;
            background:
                repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0 4px, transparent 4px 8px),
                linear-gradient(135deg, #0b3d2a 0%, #062a1c 100%);
            border: 2px solid #d4af37; box-shadow: 0 3px 8px rgba(0,0,0,0.6);
            transform: translate(-50%, -50%); will-change: transform, opacity;
            transition: left ${CARD_FLIGHT_MS}ms cubic-bezier(0.22, 0.8, 0.3, 1),
                        top ${CARD_FLIGHT_MS}ms cubic-bezier(0.22, 0.8, 0.3, 1),
                        transform ${CARD_FLIGHT_MS}ms ease, opacity 200ms ease;
            backface-visibility: hidden;
        }
        .da-card.da-face {
            background: #fff; color: #0f172a; border-color: #cbd5e1;
            display: flex; align-items: center; justify-content: center;
            font-weight: 900; font-size: 15px; letter-spacing: 0.5px;
        }
        .da-card.da-face.red { color: #dc2626; }
        .da-shuffle-card {
            position: fixed; width: 44px; height: 62px; border-radius: 5px;
            background: linear-gradient(135deg, #0b3d2a 0%, #062a1c 100%);
            border: 2px solid #d4af37; box-shadow: 0 2px 6px rgba(0,0,0,0.6);
            transform: translate(-50%, -50%); will-change: transform;
        }
        @keyframes da-riffle-left {
            0%   { transform: translate(-50%, -50%) rotate(0deg); }
            25%  { transform: translate(calc(-50% - 34px), -50%) rotate(-10deg); }
            50%  { transform: translate(calc(-50% - 34px), calc(-50% - 6px)) rotate(-4deg); }
            75%  { transform: translate(calc(-50% - 10px), -50%) rotate(3deg); }
            100% { transform: translate(-50%, -50%) rotate(0deg); }
        }
        @keyframes da-riffle-right {
            0%   { transform: translate(-50%, -50%) rotate(0deg); }
            25%  { transform: translate(calc(-50% + 34px), -50%) rotate(10deg); }
            50%  { transform: translate(calc(-50% + 34px), calc(-50% + 6px)) rotate(4deg); }
            75%  { transform: translate(calc(-50% + 10px), -50%) rotate(-3deg); }
            100% { transform: translate(-50%, -50%) rotate(0deg); }
        }
        .da-shuffle-card.left  { animation: da-riffle-left ${SHUFFLE_MS / 2}ms ease-in-out 2; }
        .da-shuffle-card.right { animation: da-riffle-right ${SHUFFLE_MS / 2}ms ease-in-out 2; }
        .da-banner {
            position: fixed; left: 50%; transform: translateX(-50%);
            background: rgba(4, 28, 18, 0.92); color: #fbbf24; border: 1.5px solid #d4af37;
            border-radius: 999px; padding: 5px 14px; font-weight: 800; font-size: 0.8rem;
            letter-spacing: 1px; text-transform: uppercase; box-shadow: 0 4px 14px rgba(0,0,0,0.6);
            opacity: 0; transition: opacity 180ms ease;
        }
        .da-hide-cards #my-cards-container,
        .da-hide-cards .seat-cards,
        .da-hide-cards #deck-center .card-slot.playing-card {
            visibility: hidden !important;
        }
        @media (prefers-reduced-motion: reduce) {
            .da-card, .da-shuffle-card { transition: none !important; animation: none !important; }
        }
    `;
    document.head.appendChild(style);

    // -------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------
    const reducedMotion = () =>
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function center(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }

    function deckOrigin() {
        const deck = document.getElementById('deck-pile') || document.getElementById('deck-center') || document.getElementById('table-oval-container');
        if (deck) return center(deck);
        return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }

    function seatTarget(username) {
        const nodes = document.querySelectorAll('[data-player-username]');
        for (const el of nodes) {
            if ((el.getAttribute('data-player-username') || '').toLowerCase() === String(username).toLowerCase()) {
                const c = center(el);
                return { x: c.x, y: c.y + Math.min(18, c.h * 0.25) };
            }
        }
        return null;
    }

    function myHandTargets(count) {
        const hand = document.getElementById('my-cards-container');
        const out = [];
        if (hand) {
            const cards = hand.querySelectorAll('.my-card, .playing-card');
            if (cards.length >= count) {
                cards.forEach((c, i) => { if (i < count) out.push(center(c)); });
                return out;
            }
            const c = center(hand);
            for (let i = 0; i < count; i++) out.push({ x: c.x + (i - (count - 1) / 2) * 56, y: c.y });
            return out;
        }
        for (let i = 0; i < count; i++) out.push({ x: window.innerWidth / 2 + (i - 1) * 56, y: window.innerHeight - 70 });
        return out;
    }

    function playCardSound() {
        try {
            if (typeof window.isSfxEnabled === 'function' && !window.isSfxEnabled()) return;
            if (typeof window.playSound === 'function') window.playSound('card');
        } catch (e) {}
    }

    function layer() {
        let l = document.getElementById('deal-anim-layer');
        if (!l) {
            l = document.createElement('div');
            l.id = 'deal-anim-layer';
            document.body.appendChild(l);
        }
        return l;
    }

    function cleanup() {
        const l = document.getElementById('deal-anim-layer');
        if (l) l.remove();
        document.body.classList.remove('da-hide-cards');
        running = false;
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    }

    function suitIsRed(s) { return s === '♥' || s === '♦' || s === 'H' || s === 'D'; }

    // -------------------------------------------------------------
    // Sequence
    // -------------------------------------------------------------
    function dealingOrder(lobby) {
        const players = (lobby.players || []).filter(p => !p.eliminated);
        if (players.length === 0) return [];
        // Seats are already rotated so "me" is index 0; dealerIndex refers to the
        // server's un-rotated index, so derive order from the dealer badge if we can.
        let dealerPos = players.findIndex(p => p.username === lobby.dealerName);
        if (dealerPos === -1 && typeof lobby.dealerIndex === 'number') {
            // Fallback: find the seat the UI marked as dealer
            const badge = document.querySelector('.seat .dealer-badge');
            const seatEl = badge ? badge.closest('[data-player-username]') : null;
            const dealerName = seatEl ? seatEl.getAttribute('data-player-username') : null;
            dealerPos = dealerName ? players.findIndex(p => p.username.toLowerCase() === dealerName.toLowerCase()) : -1;
        }
        if (dealerPos === -1) dealerPos = players.length - 1;
        const ordered = [];
        for (let i = 1; i <= players.length; i++) ordered.push(players[(dealerPos + i) % players.length]);
        return ordered;
    }

    function runShuffleAndDeal(lobby) {
        if (running) return;
        running = true;
        document.body.classList.add('da-hide-cards');
        safetyTimer = setTimeout(cleanup, HARD_TIMEOUT_MS);

        const l = layer();
        const origin = deckOrigin();
        const me = (lobby.players || []).find(p => p.isMe && !p.isBot);
        const order = dealingOrder(lobby);
        const reduce = reducedMotion();

        // Banner
        const banner = document.createElement('div');
        banner.className = 'da-banner';
        banner.style.top = `${Math.max(8, origin.y - 70)}px`;
        banner.textContent = 'Shuffling…';
        l.appendChild(banner);
        requestAnimationFrame(() => { banner.style.opacity = '1'; });

        // Shuffle: two half-decks riffling
        const halves = [];
        if (!reduce) {
            for (let i = 0; i < 6; i++) {
                const c = document.createElement('div');
                c.className = 'da-shuffle-card ' + (i % 2 === 0 ? 'left' : 'right');
                c.style.left = `${origin.x}px`;
                c.style.top = `${origin.y - i * 1.5}px`;
                c.style.animationDelay = `${(i % 3) * 40}ms`;
                l.appendChild(c);
                halves.push(c);
            }
            playCardSound();
            setTimeout(playCardSound, SHUFFLE_MS / 2);
        }

        const shuffleDuration = reduce ? 150 : SHUFFLE_MS;

        setTimeout(() => {
            halves.forEach(h => h.remove());
            banner.textContent = 'Dealing…';

            // Deal: 3 rounds, one card per player per round (like a real deal)
            const flights = [];
            let delay = 0;
            const myTargets = me ? myHandTargets(3) : [];

            for (let round = 0; round < 3; round++) {
                order.forEach(p => {
                    const isMe = me && p.username === me.username;
                    const target = isMe ? myTargets[round] : seatTarget(p.username);
                    if (!target) return;
                    flights.push({ target, isMe, round, delay, player: p });
                    delay += reduce ? 20 : DEAL_STAGGER_MS;
                });
            }

            flights.forEach(f => {
                setTimeout(() => {
                    const card = document.createElement('div');
                    card.className = 'da-card';
                    card.style.left = `${origin.x}px`;
                    card.style.top = `${origin.y}px`;
                    card.style.transform = 'translate(-50%, -50%) rotate(-8deg) scale(0.9)';
                    l.appendChild(card);
                    playCardSound();

                    requestAnimationFrame(() => {
                        card.style.left = `${f.target.x}px`;
                        card.style.top = `${f.target.y}px`;
                        card.style.transform = `translate(-50%, -50%) rotate(${f.isMe ? 0 : (Math.random() * 16 - 8)}deg) scale(${f.isMe ? 1.15 : 0.8})`;
                    });

                    const flight = reduce ? 30 : CARD_FLIGHT_MS;
                    setTimeout(() => {
                        if (f.isMe && me.cards && me.cards[f.round]) {
                            // Flip my card face-up
                            const c = me.cards[f.round];
                            const val = c.val || '';
                            const suit = (typeof window.normalizeSuit === 'function') ? window.normalizeSuit(c.suit) : c.suit;
                            card.style.transition = `transform ${FLIP_MS / 2}ms ease-in`;
                            card.style.transform = 'translate(-50%, -50%) rotateY(90deg) scale(1.15)';
                            setTimeout(() => {
                                card.classList.add('da-face');
                                if (suitIsRed(suit)) card.classList.add('red');
                                card.textContent = `${val}${suit}`;
                                card.style.transition = `transform ${FLIP_MS / 2}ms ease-out`;
                                card.style.transform = 'translate(-50%, -50%) rotateY(0deg) scale(1.15)';
                            }, FLIP_MS / 2);
                        } else {
                            // Other seats: fade the card back out after it lands
                            setTimeout(() => { card.style.opacity = '0'; }, 220);
                        }
                    }, flight);
                }, f.delay);
            });

            const total = delay + (reduce ? 60 : CARD_FLIGHT_MS + FLIP_MS + 180);
            setTimeout(() => {
                banner.style.opacity = '0';
                // Fade out everything, then reveal the real cards
                l.style.transition = 'opacity 180ms ease';
                l.style.opacity = '0';
                setTimeout(cleanup, 190);
            }, total);
        }, shuffleDuration);
    }

    // -------------------------------------------------------------
    // Hook into the UI render pipeline
    // -------------------------------------------------------------
    function install() {
        const original = window.updateUIFromLobby;
        if (typeof original !== 'function' || original.__dealAnimWrapped) return false;

        const wrapped = function (lobby) {
            const result = original.apply(this, arguments);
            try {
                if (lobby && lobby.gameState) {
                    const prev = lastState;
                    lastState = lobby.gameState;
                    const startedHand = lobby.gameState === 'playing' &&
                        prev !== 'playing' && prev !== 'finalTurn' && prev !== null;
                    const iAmSeated = (lobby.players || []).some(p => p.isMe && !p.isBot && !p.eliminated);
                    const hasCards = (lobby.players || []).some(p => (p.cardCount || (p.cards && p.cards.length)) > 0);
                    if (startedHand && hasCards && (iAmSeated || (lobby.players || []).length > 0)) {
                        runShuffleAndDeal(lobby);
                    }
                }
            } catch (e) {
                console.warn('[DealAnim] skipped:', e);
                cleanup();
            }
            return result;
        };
        wrapped.__dealAnimWrapped = true;
        window.updateUIFromLobby = wrapped;
        window.renderLobbyState = wrapped;
        return true;
    }

    if (!install()) {
        // ui.js may load after us; retry briefly
        let tries = 0;
        const t = setInterval(() => { if (install() || ++tries > 50) clearInterval(t); }, 100);
    }

    // Exposed for manual testing from the console: window.previewDealAnimation()
    window.previewDealAnimation = function () {
        const snap = window.appGlobals && window.appGlobals.latestLobbySnapshot;
        if (snap) runShuffleAndDeal(snap);
    };
})();
