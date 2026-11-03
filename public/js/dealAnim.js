// public/js/dealAnim.js - Shuffle & Deal Animation at the start of every hand
//
// Non-invasive: wraps window.updateUIFromLobby (from ui.js). When a lobby snapshot
// opens a shuffle & deal window (lobby.dealingUntil in the future, gameState
// 'playing'), the freshly rendered cards are hidden and a dealer-style shuffle
// plays over the felt: split the deck, riffle the two halves together, bridge
// (bow + cascade), square up — repeated for roughly 10-15s — then three rounds
// of cards are dealt around the table and the real hand is revealed.
//
// Timing is driven by the server: lobbyManager.startRound() sets dealingUntil
// (DEAL_ANIMATION_MS, default 16s) and refuses turn actions, holds bots and the
// turn timer until then, so the first player's clock never starts mid-shuffle.
// The animation sizes itself to end just before the window closes. If a server
// without the window is ever hit (no dealingUntil), a short ~3.5s version runs.
//
// Honors prefers-reduced-motion (banner only, quick deal) and the SFX toggle.

(function () {
    if (window.__dealAnimInstalled) return;
    window.__dealAnimInstalled = true;

    // ---- timing -------------------------------------------------------
    const FALLBACK_TOTAL_MS = 3500;     // no server window: old quick version
    const END_MARGIN_MS = 450;          // finish this long before dealingUntil
    const SHUFFLE_CYCLE_MS = 3900;      // split + riffle + bridge + square up
    const DEAL_STAGGER_MS = 110;
    const CARD_FLIGHT_MS = 420;
    const FLIP_MS = 260;
    const SHUFFLE_CARDS = 20;           // visual thickness of the deck

    let running = false;
    let lastState = null;
    let timers = [];
    let startedWithWindow = false;

    // ---- styles -------------------------------------------------------
    const style = document.createElement('style');
    style.id = 'deal-anim-styles';
    style.textContent = `
        #deal-anim-layer {
            position: fixed; inset: 0; z-index: 9400; pointer-events: none; overflow: hidden;
        }
        .da-stage {
            position: fixed; width: 0; height: 0;
            perspective: 520px; transform-style: preserve-3d;
        }
        .da-sc {
            position: absolute; left: 0; top: 0; border-radius: 5px;
            background:
                repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0 4px, transparent 4px 8px),
                linear-gradient(135deg, #0b3d2a 0%, #062a1c 100%);
            border: 2px solid #d4af37; box-shadow: 0 2px 5px rgba(0,0,0,0.55);
            will-change: transform; backface-visibility: hidden;
            transition: transform 300ms cubic-bezier(0.3, 0.7, 0.3, 1);
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
        .da-banner {
            position: fixed; left: 50%; transform: translateX(-50%);
            background: rgba(4, 28, 18, 0.92); color: #fbbf24; border: 1.5px solid #d4af37;
            border-radius: 999px; padding: 5px 14px; font-weight: 800; font-size: 0.8rem;
            letter-spacing: 1px; text-transform: uppercase; box-shadow: 0 4px 14px rgba(0,0,0,0.6);
            opacity: 0; transition: opacity 180ms ease; white-space: nowrap;
        }
        .da-banner small {
            display: block; font-size: 0.62rem; letter-spacing: 0.5px; text-transform: none;
            color: #cbd5e1; font-weight: 600; margin-top: 2px; text-align: center;
        }
        .da-hide-cards #my-cards-container,
        .da-hide-cards .seat-cards,
        .da-hide-cards #deck-center .card-slot.playing-card,
        .da-hide-cards #discard-top-card {
            visibility: hidden !important;
        }
        .da-hide-cards #deck-pile,
        .da-hide-cards #discard-pile,
        .da-hide-cards #my-cards-container,
        .da-hide-cards #knock-btn {
            pointer-events: none !important;
        }
    `;
    document.head.appendChild(style);

    // ---- helpers ------------------------------------------------------
    const reducedMotion = () =>
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }

    function center(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }

    function deckOrigin() {
        const deck = document.getElementById('deck-pile') || document.getElementById('deck-center') || document.getElementById('table-oval-container');
        if (deck) return center(deck);
        return { x: window.innerWidth / 2, y: window.innerHeight / 2, w: 50, h: 70 };
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
        timers.forEach(clearTimeout);
        timers = [];
        const l = document.getElementById('deal-anim-layer');
        if (l) l.remove();
        document.body.classList.remove('da-hide-cards');
        running = false;
        startedWithWindow = false;
    }

    function suitIsRed(s) { return s === '♥' || s === '♦' || s === 'H' || s === 'D'; }

    function dealingOrder(lobby) {
        const players = (lobby.players || []).filter(p => !p.eliminated);
        if (players.length === 0) return [];
        let dealerPos = players.findIndex(p => p.username === lobby.dealerName);
        if (dealerPos === -1) {
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

    // How long the server window has left, in local ms (serverNow cancels clock skew)
    function windowRemaining(lobby) {
        if (!lobby || !lobby.dealingUntil) return 0;
        const skew = (typeof lobby.serverNow === 'number') ? (lobby.serverNow - Date.now()) : 0;
        return lobby.dealingUntil - (Date.now() + skew);
    }

    // ---- the shuffle --------------------------------------------------
    // A stage div sits at the deck's centre; SHUFFLE_CARDS card backs are
    // positioned inside it with transforms, so rotateX in the bridge reads as
    // real bending thanks to the stage's perspective.
    function buildShuffleStage(l, origin) {
        const stage = document.createElement('div');
        stage.className = 'da-stage';
        stage.style.left = `${origin.x}px`;
        stage.style.top = `${origin.y}px`;
        l.appendChild(stage);

        const w = Math.max(40, Math.min(60, Math.round((origin.w || 50) * 0.95)));
        const h = Math.round(w * 1.42);
        const cards = [];
        for (let i = 0; i < SHUFFLE_CARDS; i++) {
            const c = document.createElement('div');
            c.className = 'da-sc';
            c.style.width = `${w}px`;
            c.style.height = `${h}px`;
            c.style.marginLeft = `${-w / 2}px`;
            c.style.marginTop = `${-h / 2}px`;
            c.__st = { x: 0, y: -i * 0.6, rot: 0, rx: 0, z: i };
            stage.appendChild(c);
            cards.push(c);
        }
        cards.forEach(c => apply(c, c.__st, 0));
        return { stage, cards, w, h };
    }

    function apply(c, st, dur, ease) {
        Object.assign(c.__st, st);
        const s = c.__st;
        c.style.transition = dur ? `transform ${dur}ms ${ease || 'cubic-bezier(0.3, 0.7, 0.3, 1)'}` : 'none';
        c.style.transform = `translate(${s.x}px, ${s.y}px) rotateX(${s.rx}deg) rotate(${s.rot}deg)`;
        if (typeof s.z === 'number') c.style.zIndex = String(10 + s.z);
    }

    // One full dealer cycle: split → riffle → bridge → square up.
    function shuffleCycle(stageObj, t0, cycleMs) {
        const { cards, w } = stageObj;
        const n = cards.length;
        // Keep the hands moving at a believable speed: at most ±15% stretch;
        // any extra time in the slot is spent with the pack resting squared up.
        const k = Math.max(0.85, Math.min(1.15, cycleMs / SHUFFLE_CYCLE_MS));
        const T = (ms) => Math.round(ms * k);
        const half = Math.round(w * 0.85);

        // 1. SPLIT: cut the deck in two, halves tilt toward each other, inner edge lifted
        later(() => {
            cards.forEach((c, i) => {
                const left = i % 2 === 0;
                const idxInHalf = Math.floor(i / 2);
                apply(c, {
                    x: left ? -half : half,
                    y: -idxInHalf * 1.1,
                    rot: left ? -9 : 9,
                    rx: 22,
                    z: idxInHalf
                }, T(420), 'cubic-bezier(0.4, 0, 0.2, 1)');
            });
            playCardSound();
        }, t0);

        // 2. RIFFLE: thumbs release cards alternately left/right into the centre, bottom-up
        const riffleStart = t0 + T(650);
        const riffleStep = T(58);
        const order = [];
        for (let i = 0; i < n / 2; i++) { order.push(i * 2); order.push(i * 2 + 1); }
        order.forEach((ci, j) => {
            later(() => {
                apply(cards[ci], {
                    x: (Math.random() - 0.5) * 4,
                    y: -j * 0.6 + (Math.random() - 0.5) * 2,
                    rot: (Math.random() - 0.5) * 5,
                    rx: 0,
                    z: j
                }, T(230), 'cubic-bezier(0.2, 0.9, 0.3, 1)');
                if (j % 4 === 0) playCardSound();
            }, riffleStart + j * riffleStep);
        });
        const riffleEnd = riffleStart + n * riffleStep + T(240);

        // 3. BRIDGE: bend the interleaved pack into an arch (cards bow back and
        //    stair upward so the thickness shows), hold, then let it cascade
        //    flat from the top card down like a waterfall.
        const bowStart = riffleEnd + T(90);
        later(() => {
            const sorted = cards.slice().sort((a, b) => a.__st.z - b.__st.z);
            sorted.forEach((c, j) => {
                const f = j / (sorted.length - 1);
                apply(c, {
                    rx: 58 + f * 14,
                    y: -6 - f * 30,
                    x: (f - 0.5) * 6,
                    rot: (f - 0.5) * 6
                }, T(420), 'cubic-bezier(0.3, 0.6, 0.3, 1)');
            });
            playCardSound();
        }, bowStart);
        const cascadeStart = bowStart + T(620);
        later(() => {
            const sorted = cards.slice().sort((a, b) => b.__st.z - a.__st.z); // top card first
            sorted.forEach((c, j) => {
                later(() => {
                    apply(c, {
                        rx: 0,
                        y: -c.__st.z * 0.6 + 2,
                        rot: (Math.random() - 0.5) * 4,
                        x: (Math.random() - 0.5) * 4
                    }, T(240), 'cubic-bezier(0.5, 0.05, 0.3, 1)');
                    if (j % 5 === 0) playCardSound();
                }, j * T(42));
            });
        }, cascadeStart);
        const cascadeEnd = cascadeStart + n * T(42) + T(260);

        // 4. SQUARE UP: tap the pack neat
        later(() => { cards.forEach(c => apply(c, { x: 3, rot: c.__st.rot + 1.5 }, T(130), 'ease-out')); }, cascadeEnd + T(40));
        later(() => { cards.forEach(c => apply(c, { x: 0, rot: 0, y: -c.__st.z * 0.6 }, T(170), 'ease-in-out')); playCardSound(); }, cascadeEnd + T(190));
    }

    // ---- the deal -----------------------------------------------------
    function dealDurationFor(order, reduce) {
        const flights = order.length * 3;
        return flights * (reduce ? 20 : DEAL_STAGGER_MS) + (reduce ? 60 : CARD_FLIGHT_MS + FLIP_MS + 180);
    }

    function runDeal(l, origin, lobby, me, order, reduce, onDone) {
        const flights = [];
        let delay = 0;
        const myTargets = me ? myHandTargets(3) : [];

        for (let round = 0; round < 3; round++) {
            order.forEach(p => {
                const isMe = me && p.username === me.username;
                const target = isMe ? myTargets[round] : seatTarget(p.username);
                if (!target) return;
                flights.push({ target, isMe, round, delay });
                delay += reduce ? 20 : DEAL_STAGGER_MS;
            });
        }

        flights.forEach(f => {
            later(() => {
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
                later(() => {
                    if (f.isMe && me.cards && me.cards[f.round]) {
                        const c = me.cards[f.round];
                        const val = c.val || '';
                        const suit = (typeof window.normalizeSuit === 'function') ? window.normalizeSuit(c.suit) : c.suit;
                        card.style.transition = `transform ${FLIP_MS / 2}ms ease-in`;
                        card.style.transform = 'translate(-50%, -50%) rotateY(90deg) scale(1.15)';
                        later(() => {
                            card.classList.add('da-face');
                            if (suitIsRed(suit)) card.classList.add('red');
                            card.textContent = `${val}${suit}`;
                            card.style.transition = `transform ${FLIP_MS / 2}ms ease-out`;
                            card.style.transform = 'translate(-50%, -50%) rotateY(0deg) scale(1.15)';
                        }, FLIP_MS / 2);
                    } else {
                        later(() => { card.style.opacity = '0'; }, 220);
                    }
                }, flight);
            }, f.delay);
        });

        later(onDone, dealDurationFor(order, reduce));
    }

    // ---- the whole sequence -------------------------------------------
    function runShuffleAndDeal(lobby) {
        if (running) return;
        running = true;
        document.body.classList.add('da-hide-cards');

        const remaining = windowRemaining(lobby);
        startedWithWindow = remaining > 0;
        const reduce = reducedMotion();
        const me = (lobby.players || []).find(p => p.isMe && !p.isBot);
        const order = dealingOrder(lobby);
        const dealMs = dealDurationFor(order, reduce);

        // Total budget: fit inside the server window, or the quick fallback
        const total = startedWithWindow ? Math.max(1500, remaining - END_MARGIN_MS) : FALLBACK_TOTAL_MS;
        const shuffleMs = Math.max(reduce ? 300 : 900, total - dealMs - 350);

        // Hard stop so the overlay can never outlive the window by much
        later(cleanup, total + 1500);

        const l = layer();
        const origin = deckOrigin();

        const banner = document.createElement('div');
        banner.className = 'da-banner';
        banner.style.top = `${Math.max(8, origin.y - 78)}px`;
        banner.innerHTML = 'Shuffling…';
        l.appendChild(banner);
        requestAnimationFrame(() => { banner.style.opacity = '1'; });

        let stageObj = null;
        if (!reduce) {
            stageObj = buildShuffleStage(l, origin);
            // As many cycles as fit at a natural pace (3–4 for the default 16s window);
            // each cycle gets an equal slot and rests squared-up for any leftover time.
            const cycles = Math.max(1, Math.min(5, Math.round(shuffleMs / SHUFFLE_CYCLE_MS)));
            const cycleMs = Math.floor(shuffleMs / cycles);
            for (let i = 0; i < cycles; i++) shuffleCycle(stageObj, 120 + i * cycleMs, cycleMs - 60);
        } else if (startedWithWindow) {
            banner.innerHTML = 'Shuffling…<small>Dealing in a moment</small>';
        }

        later(() => {
            if (stageObj) stageObj.stage.remove();
            banner.innerHTML = 'Dealing…';
            runDeal(l, origin, lobby, me, order, reduce, () => {
                banner.style.opacity = '0';
                l.style.transition = 'opacity 180ms ease';
                l.style.opacity = '0';
                later(cleanup, 190);
            });
        }, shuffleMs);
    }

    // ---- hook into the UI render pipeline -----------------------------
    function install() {
        const original = window.updateUIFromLobby;
        if (typeof original !== 'function' || original.__dealAnimWrapped) return false;

        const wrapped = function (lobby) {
            const result = original.apply(this, arguments);
            try {
                if (lobby && lobby.gameState) {
                    const prev = lastState;
                    lastState = lobby.gameState;
                    const hasCards = (lobby.players || []).some(p => (p.cardCount || (p.cards && p.cards.length)) > 0);
                    const remaining = windowRemaining(lobby);

                    if (running) {
                        // Server says the turn has started (or the round was aborted): never keep cards hidden
                        if (lobby.gameState !== 'playing' || (startedWithWindow && remaining <= 0)) cleanup();
                    } else if (lobby.gameState === 'playing' && hasCards) {
                        const enteredPlaying = prev !== 'playing' && prev !== 'finalTurn' && prev !== null;
                        const joinedMidDeal = remaining > 3000;   // reload / reconnect while the table is still dealing
                        if (enteredPlaying || joinedMidDeal) runShuffleAndDeal(lobby);
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
        let tries = 0;
        const t = setInterval(() => { if (install() || ++tries > 50) clearInterval(t); }, 100);
    }

    // Console testing: window.previewDealAnimation(seconds)
    window.previewDealAnimation = function (seconds) {
        const snap = window.appGlobals && window.appGlobals.latestLobbySnapshot;
        if (!snap) return;
        const copy = Object.assign({}, snap);
        if (seconds) { copy.dealingUntil = Date.now() + seconds * 1000; copy.serverNow = Date.now(); }
        runShuffleAndDeal(copy);
    };
})();
