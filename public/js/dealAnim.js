// public/js/dealAnim.js - Shuffle & Deal Animation at the start of every hand
//
// Non-invasive: wraps window.updateUIFromLobby (from ui.js). When a lobby snapshot
// opens a shuffle & deal window (lobby.dealingUntil in the future, gameState
// 'playing'), the freshly rendered cards and the centre piles are hidden and a
// dealer's riffle shuffle plays where the deck sits: two hands cut the pack,
// riffle the halves together (cards lying horizontally, thumbs on the inner
// edges), bridge it (arch + cascade) and square it up — about 8 seconds —
// then three rounds of cards are dealt around the table and the real hand is
// revealed.
//
// Timing is driven by the server: lobbyManager.startRound() sets dealingUntil
// (DEAL_ANIMATION_MS, default 11.5s) and refuses turn actions, holds bots and
// the turn timer until then, so the first player's clock never starts mid-shuffle.
// The animation sizes itself to end just before the window closes. If a server
// without the window is ever hit (no dealingUntil), a short ~3.5s version runs.
//
// Honors prefers-reduced-motion (2s static banner, quick deal, then the hand is
// shown while the server window runs out) and the SFX toggle.

(function () {
    if (window.__dealAnimInstalled) return;
    window.__dealAnimInstalled = true;

    // ---- timing -------------------------------------------------------
    const FALLBACK_TOTAL_MS = 3500;     // no server window: old quick version
    const END_MARGIN_MS = 450;          // finish this long before dealingUntil
    const SHUFFLE_CYCLE_MS = 3900;      // cut + riffle + bridge + square up
    const DEAL_STAGGER_MS = 110;
    const CARD_FLIGHT_MS = 420;
    const FLIP_MS = 260;
    const SHUFFLE_CARDS = 20;           // visual thickness of the pack
    const REDUCED_SHUFFLE_MS = 2000;    // prefers-reduced-motion: static banner only

    let running = false;
    let lastState = null;
    let timers = [];
    let startedWithWindow = false;
    let animatedUntil = 0;              // dealingUntil of the window already animated

    // ---- styles -------------------------------------------------------
    // Card backs copy the table's deck: .card-slot.back in table.css
    const DECK_BG = 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)';
    const style = document.createElement('style');
    style.id = 'deal-anim-styles';
    style.textContent = `
        #deal-anim-layer {
            position: fixed; inset: 0; z-index: 9400; pointer-events: none; overflow: hidden;
        }
        .da-stage {
            position: fixed; width: 0; height: 0;
            perspective: 600px; transform-style: preserve-3d;
        }
        .da-sc {
            position: absolute; left: 0; top: 0; border-radius: 6px;
            background: ${DECK_BG};
            border: 2px solid #ffffff; box-shadow: 0 2px 5px rgba(0,0,0,0.55);
            will-change: transform; backface-visibility: hidden;
            transition: transform 300ms cubic-bezier(0.3, 0.7, 0.3, 1);
        }
        .da-sc::after, .da-card:not(.da-face)::after {
            content: ''; position: absolute; left: 9%; top: 9%; width: 82%; height: 82%;
            border: 1px dashed rgba(255,255,255,0.4); border-radius: 4px;
        }
        .da-hand {
            position: absolute; left: 0; top: 0; will-change: transform;
            transition: transform 320ms cubic-bezier(0.3, 0.7, 0.3, 1), opacity 200ms ease;
            filter: drop-shadow(0 3px 4px rgba(0,0,0,0.45));
        }
        .da-hand svg { display: block; width: 100%; height: 100%; }
        .da-card {
            position: fixed; width: 44px; height: 62px; border-radius: 5px;
            background: ${DECK_BG};
            border: 2px solid #ffffff; box-shadow: 0 3px 8px rgba(0,0,0,0.6);
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
        /* While shuffling/dealing: hide hands, seat cards and the centre piles */
        .da-hide-cards #my-cards-container,
        .da-hide-cards .seat-cards,
        .da-hide-cards #deck-center,
        .da-hide-cards .table-center-area {
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

    // Centre of the deck/discard area (hidden while we run; layout is kept)
    function tableOrigin() {
        const area = document.getElementById('deck-center') || document.querySelector('.table-center-area');
        const deck = document.getElementById('deck-pile');
        if (area) {
            const c = center(area);
            const d = deck ? center(deck) : null;
            return { x: c.x, y: c.y, w: d ? d.w : 90, h: d ? d.h : 126 };
        }
        if (deck) return center(deck);
        const table = document.getElementById('table-oval-container');
        if (table) { const c = center(table); return { x: c.x, y: c.y, w: 90, h: 126 }; }
        return { x: window.innerWidth / 2, y: window.innerHeight / 2, w: 90, h: 126 };
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

    // ---- the shuffle stage ----------------------------------------------
    // Top-down view. Cards lie horizontally (long edge left-right). Two hands
    // hold the halves from the outside: fingers over the far edge, thumbs on
    // the inner edges where the cards are released during the riffle.
    function handSvg(side) {
        // Right hand (fingers pointing up/away, thumb toward the centre on the left);
        // the left hand is the mirror image.
        const flip = side === 'left' ? 'transform="scale(-1,1) translate(-100,0)"' : '';
        return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <g ${flip} fill="#e9b78f" stroke="#b8805a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
                <rect x="30" y="4" width="12" height="46" rx="6"/>
                <rect x="45" y="0" width="12" height="50" rx="6"/>
                <rect x="60" y="2" width="12" height="48" rx="6"/>
                <rect x="75" y="8" width="12" height="42" rx="6"/>
                <path d="M28 44 Q27 70 42 86 Q60 96 80 86 Q92 76 90 48 Z"/>
                <path d="M30 52 Q14 60 6 78 Q4 90 14 90 Q24 88 34 70 Z"/>
                <path d="M36 92 Q58 100 82 90" fill="none" stroke="#b8805a" stroke-width="2"/>
            </g>
        </svg>`;
    }

    function buildShuffleStage(l, origin) {
        const stage = document.createElement('div');
        stage.className = 'da-stage';
        stage.style.left = `${origin.x}px`;
        stage.style.top = `${origin.y}px`;
        l.appendChild(stage);

        // Landscape cards sized from the deck slot
        const cw = Math.max(64, Math.min(96, Math.round((origin.h || 126) * 0.72)));
        const ch = Math.round(cw * 0.68);
        const cards = [];
        for (let i = 0; i < SHUFFLE_CARDS; i++) {
            const c = document.createElement('div');
            c.className = 'da-sc';
            c.style.width = `${cw}px`;
            c.style.height = `${ch}px`;
            c.style.marginLeft = `${-cw / 2}px`;
            c.style.marginTop = `${-ch / 2}px`;
            c.__st = { x: 0, y: -i * 0.5, rot: 0, ry: 0, z: i };
            stage.appendChild(c);
            cards.push(c);
        }
        cards.forEach(c => applyCard(c, c.__st, 0));

        const hs = Math.round(ch * 1.45);
        const hands = {};
        ['left', 'right'].forEach(side => {
            const h = document.createElement('div');
            h.className = 'da-hand';
            h.style.width = `${hs}px`;
            h.style.height = `${hs}px`;
            h.style.marginLeft = `${-hs / 2}px`;
            h.style.marginTop = `${-hs / 2}px`;
            h.style.zIndex = '200';
            h.innerHTML = handSvg(side);
            const sign = side === 'left' ? -1 : 1;
            h.__st = { x: sign * (cw * 0.62), y: ch * 0.12, rot: sign * 8 };
            stage.appendChild(h);
            hands[side] = h;
            applyHand(h, h.__st, 0);
        });

        return { stage, cards, hands, cw, ch };
    }

    function applyCard(c, st, dur, ease) {
        Object.assign(c.__st, st);
        const s = c.__st;
        c.style.transition = dur ? `transform ${dur}ms ${ease || 'cubic-bezier(0.3, 0.7, 0.3, 1)'}` : 'none';
        c.style.transform = `translate(${s.x}px, ${s.y}px) rotateY(${s.ry}deg) rotate(${s.rot}deg)`;
        if (typeof s.z === 'number') c.style.zIndex = String(10 + s.z);
    }

    function applyHand(h, st, dur, ease) {
        Object.assign(h.__st, st);
        const s = h.__st;
        h.style.transition = dur ? `transform ${dur}ms ${ease || 'cubic-bezier(0.3, 0.7, 0.3, 1)'}` : 'none';
        h.style.transform = `translate(${s.x}px, ${s.y}px) rotate(${s.rot}deg)`;
    }

    // One dealer cycle: cut → riffle → bridge → square up.
    function shuffleCycle(stageObj, t0, cycleMs) {
        const { cards, hands, cw, ch } = stageObj;
        const n = cards.length;
        // Believable hand speed: at most ±15% stretch; leftover time rests squared up.
        const k = Math.max(0.85, Math.min(1.15, cycleMs / SHUFFLE_CYCLE_MS));
        const T = (ms) => Math.round(ms * k);
        const half = Math.round(cw * 0.56);
        const L = hands.left, R = hands.right;

        // 1. CUT: hands pull the two halves apart; inner edges lift toward each other
        later(() => {
            cards.forEach((c, i) => {
                const left = i % 2 === 0;
                const j = Math.floor(i / 2);
                applyCard(c, {
                    x: left ? -half : half,
                    y: -j * 1.0,
                    rot: left ? -3 : 3,
                    ry: left ? -22 : 22,
                    z: j
                }, T(420), 'cubic-bezier(0.4, 0, 0.2, 1)');
            });
            applyHand(L, { x: -(half + cw * 0.34), y: ch * 0.12, rot: -10 }, T(420));
            applyHand(R, { x: (half + cw * 0.34), y: ch * 0.12, rot: 10 }, T(420));
            playCardSound();
        }, t0);

        // 2. RIFFLE: thumbs release cards alternately from each half into the centre, bottom-up
        const riffleStart = t0 + T(620);
        const riffleStep = T(56);
        const order = [];
        for (let i = 0; i < n / 2; i++) { order.push(i * 2); order.push(i * 2 + 1); }
        later(() => {
            // Hands lean in so the thumbs meet over the centre
            applyHand(L, { x: -(half + cw * 0.22), y: ch * 0.16, rot: -5 }, T(300));
            applyHand(R, { x: (half + cw * 0.22), y: ch * 0.16, rot: 5 }, T(300));
        }, riffleStart - T(120));
        order.forEach((ci, j) => {
            later(() => {
                applyCard(cards[ci], {
                    x: (Math.random() - 0.5) * 4,
                    y: -j * 0.5 + (Math.random() - 0.5) * 2,
                    rot: (Math.random() - 0.5) * 4,
                    ry: 0,
                    z: j
                }, T(220), 'cubic-bezier(0.2, 0.9, 0.3, 1)');
                // thumb flick: tiny nudge of the hand that just released a card
                const h = (ci % 2 === 0) ? L : R;
                applyHand(h, { y: h.__st.y - 3 }, T(60));
                later(() => applyHand(h, { y: ch * 0.16 }, T(90)), T(70));
                if (j % 4 === 0) playCardSound();
            }, riffleStart + j * riffleStep);
        });
        const riffleEnd = riffleStart + n * riffleStep + T(230);

        // 3. BRIDGE: hands push the ends together so the pack arches up along its
        //    length, then let go: the cards waterfall down from the top card.
        const bowStart = riffleEnd + T(80);
        later(() => {
            const sorted = cards.slice().sort((a, b) => a.__st.z - b.__st.z);
            sorted.forEach((c, j) => {
                const f = j / (sorted.length - 1);
                applyCard(c, {
                    ry: -62 + f * 10,
                    x: (f - 0.5) * cw * 0.55,
                    y: -4 - Math.sin(f * Math.PI) * 10 - f * 6,
                    rot: (f - 0.5) * 4
                }, T(420), 'cubic-bezier(0.3, 0.6, 0.3, 1)');
            });
            applyHand(L, { x: -(cw * 0.66), y: ch * 0.1, rot: -14 }, T(420));
            applyHand(R, { x: (cw * 0.66), y: ch * 0.1, rot: 14 }, T(420));
            playCardSound();
        }, bowStart);
        const cascadeStart = bowStart + T(600);
        later(() => {
            const sorted = cards.slice().sort((a, b) => b.__st.z - a.__st.z); // top card first
            sorted.forEach((c, j) => {
                later(() => {
                    applyCard(c, {
                        ry: 0,
                        x: (Math.random() - 0.5) * 4,
                        y: -c.__st.z * 0.5 + 1,
                        rot: (Math.random() - 0.5) * 3
                    }, T(240), 'cubic-bezier(0.5, 0.05, 0.3, 1)');
                    if (j % 5 === 0) playCardSound();
                }, j * T(40));
            });
            // hands ease outward as the pack settles
            applyHand(L, { x: -(half + cw * 0.26), y: ch * 0.12, rot: -8 }, T(n * 40 + 200));
            applyHand(R, { x: (half + cw * 0.26), y: ch * 0.12, rot: 8 }, T(n * 40 + 200));
        }, cascadeStart);
        const cascadeEnd = cascadeStart + n * T(40) + T(260);

        // 4. SQUARE UP: hands tap the pack neat from both sides
        later(() => {
            cards.forEach(c => applyCard(c, { x: 3, rot: c.__st.rot + 1 }, T(130), 'ease-out'));
            applyHand(L, { x: -(cw * 0.6), rot: -3 }, T(130));
            applyHand(R, { x: (cw * 0.68), rot: 3 }, T(130));
        }, cascadeEnd + T(40));
        later(() => {
            cards.forEach(c => applyCard(c, { x: 0, rot: 0, y: -c.__st.z * 0.5 }, T(170), 'ease-in-out'));
            applyHand(L, { x: -(cw * 0.62), y: ch * 0.12, rot: -8 }, T(170));
            applyHand(R, { x: (cw * 0.62), y: ch * 0.12, rot: 8 }, T(170));
            playCardSound();
        }, cascadeEnd + T(190));
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
        animatedUntil = lobby.dealingUntil || 0;
        document.body.classList.add('da-hide-cards');

        const remaining = windowRemaining(lobby);
        startedWithWindow = remaining > 0;
        const reduce = reducedMotion();
        const me = (lobby.players || []).find(p => p.isMe && !p.isBot);
        const order = dealingOrder(lobby);
        const dealMs = dealDurationFor(order, reduce);

        // Total budget: fit inside the server window, or the quick fallback.
        // Reduced motion: a short static "Shuffling…" (~2s) and a quick deal, then
        // the hand is shown while the server window runs out (no long blank wait).
        let total = startedWithWindow ? Math.max(1500, remaining - END_MARGIN_MS) : FALLBACK_TOTAL_MS;
        let shuffleMs = Math.max(reduce ? 300 : 900, total - dealMs - 350);
        if (reduce) {
            shuffleMs = Math.min(shuffleMs, REDUCED_SHUFFLE_MS);
            total = Math.min(total, shuffleMs + dealMs + 350);
        }

        // Hard stop so the overlay can never outlive the window by much
        later(cleanup, total + 1500);

        const l = layer();
        const origin = tableOrigin();

        const banner = document.createElement('div');
        banner.className = 'da-banner';
        banner.style.top = `${Math.max(8, origin.y - (origin.h || 126) * 0.85 - 36)}px`;
        banner.innerHTML = 'Shuffling…';
        l.appendChild(banner);
        requestAnimationFrame(() => { banner.style.opacity = '1'; });

        let stageObj = null;
        if (!reduce) {
            stageObj = buildShuffleStage(l, origin);
            // Two cycles for the default window (~8s); more if the window is longer.
            const cycles = Math.max(1, Math.min(5, Math.round(shuffleMs / SHUFFLE_CYCLE_MS)));
            const cycleMs = Math.floor(shuffleMs / cycles);
            for (let i = 0; i < cycles; i++) shuffleCycle(stageObj, 120 + i * cycleMs, cycleMs - 60);
            // hands leave just before the deal
            later(() => {
                Object.values(stageObj.hands).forEach(h => { h.style.opacity = '0'; });
            }, Math.max(0, shuffleMs - 260));
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
                        // reload / reconnect while the table is still dealing (not a window we already played)
                        const joinedMidDeal = remaining > 3000 && (lobby.dealingUntil || 0) !== animatedUntil;
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
