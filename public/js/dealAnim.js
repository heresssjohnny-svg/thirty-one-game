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
// shown while the server window runs out) and the SFX toggle. Players can turn
// the shuffle off in Settings (localStorage blitz31_shuffle_anim = 'false'):
// the hand is then shown at once with a "Dealing… Ns" countdown pill.
//
// SKIP: while the server's window is open, seated players get a "Skip" button.
// It sends SKIP_DEAL; the server (server/game/dealSkip.js) ends the window early
// once every connected human player has pressed it, and sends DEAL_SKIP_STATUS
// after each vote so the button can show the count (e.g. "Skip ⏭ 1/3").

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
    const SHUFFLE_CARDS = 24;           // visual thickness of the pack
    const REDUCED_SHUFFLE_MS = 2000;    // prefers-reduced-motion: static banner only

    let running = false;
    let lastState = null;
    let timers = [];
    let startedWithWindow = false;
    let animatedUntil = 0;              // dealingUntil of the window already animated

    // ---- styles -------------------------------------------------------
    // Card backs copy the table's deck: .card-slot.back in table.css
    const DECK_BG = 'linear-gradient(135deg, var(--pf-back-a, #1e3a8a) 0%, var(--pf-back-b, #0f172a) 100%)';
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
            border: 3px solid #fdfdfb;
            /* a thin dark edge per card reads as the side of the pack */
            box-shadow: 0 0 0 0.5px rgba(15,23,42,0.6), 0 1px 1.5px rgba(0,0,0,0.4);
            will-change: transform; backface-visibility: hidden;
            transition: transform 300ms cubic-bezier(0.3, 0.7, 0.3, 1);
        }
        /* printed back: fine diamond lattice inside a thin frame */
        .da-sc::after, .da-card:not(.da-face)::after {
            content: ''; position: absolute; left: 5%; top: 7%; width: 90%; height: 86%;
            border: 1px solid rgba(255,255,255,0.55); border-radius: 3px; box-sizing: border-box;
            background:
                repeating-linear-gradient(45deg, rgba(255,255,255,0.17) 0 1.5px, transparent 1.5px 6px),
                repeating-linear-gradient(-45deg, rgba(255,255,255,0.17) 0 1.5px, transparent 1.5px 6px);
        }
        /* light on a bent-up edge during the riffle */
        .da-sc::before {
            content: ''; position: absolute; inset: 0; border-radius: 3px; opacity: 0;
            transition: opacity 200ms ease; pointer-events: none;
        }
        .da-sc.da-bl::before { opacity: 1; background: linear-gradient(90deg, rgba(0,0,0,0.22), transparent 45%, rgba(255,255,255,0.32)); }
        .da-sc.da-br::before { opacity: 1; background: linear-gradient(270deg, rgba(0,0,0,0.22), transparent 45%, rgba(255,255,255,0.32)); }
        .da-shadow {
            position: absolute; left: 0; top: 0; z-index: 1; border-radius: 12px;
            background: radial-gradient(ellipse at center, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.35) 45%, transparent 72%);
            transform: translateY(7px); filter: blur(3px); will-change: transform, opacity;
        }
        .da-hand {
            position: absolute; left: 0; top: 0; will-change: transform, opacity;
            transform-origin: 50% 32.35%;   /* the knuckles, not the sleeve */
            transition: transform 320ms cubic-bezier(0.3, 0.7, 0.3, 1), opacity 220ms ease;
            filter: drop-shadow(0 7px 6px rgba(0,0,0,0.45));
        }
        .da-hand svg { display: block; width: 100%; height: 100%; overflow: visible; }
        .da-thumb { transform-origin: 36px 64px; }
        .da-fingers { transform-origin: 58px 52px; }
        .da-card {
            position: fixed; width: 44px; height: 62px; border-radius: 5px;
            background: ${DECK_BG};
            border: 2.5px solid #fdfdfb; box-shadow: 0 0 0 0.5px rgba(15,23,42,0.6), 0 3px 8px rgba(0,0,0,0.6);
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
        .da-skip {
            position: fixed; left: 50%; transform: translateX(-50%); pointer-events: auto;
            background: rgba(15, 23, 42, 0.92); color: #f8fafc; border: 1.5px solid #94a3b8;
            border-radius: 999px; padding: 7px 16px; font-weight: 800; font-size: 0.78rem;
            letter-spacing: 0.6px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.6);
            white-space: nowrap; z-index: 2; opacity: 0; transition: opacity 180ms ease, background 150ms ease;
            -webkit-tap-highlight-color: transparent; touch-action: manipulation;
        }
        .da-skip:active { transform: translateX(-50%) scale(0.96); }
        .da-skip.da-voted { background: rgba(4, 28, 18, 0.92); border-color: #d4af37; color: #fbbf24; cursor: default; }
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
        skipBtn = null;
        skipCtx = null;
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
    // Top-down view from the dealer's side. Cards lie horizontally (long edge
    // left-right). Two hands come in from below and hold the halves: fingers
    // reach over the far edge, thumbs sit on the inner corners where the
    // cards are released during the riffle. The hands are drawn with shaded
    // skin, knuckles, creases, nails, a shirt cuff and a jacket sleeve; the
    // thumb and the four fingers are separate groups so they can flick / curl.
    function fingerSvg(bx, by, len, w, ang, uid) {
        const wb = w / 2, wt = w * 0.41, tip = -len;
        const d = `M${-wb} 8 C${-wb} ${tip * 0.5} ${-wt - 0.6} ${tip * 0.8} ${-wt} ${tip + wt} A${wt} ${wt} 0 0 1 ${wt} ${tip + wt} C${wt + 0.6} ${tip * 0.8} ${wb} ${tip * 0.5} ${wb} 8 Z`;
        const nw = w * 0.56, nh = w * 0.6;
        const c1 = tip * 0.36, c2 = tip * 0.66;
        return `<g transform="translate(${bx} ${by}) rotate(${ang})">
            <path d="${d}" fill="url(#skinF-${uid})" stroke="#8f5f40" stroke-opacity="0.75" stroke-width="0.9"/>
            <path d="M${-wb * 0.7} ${c1} Q0 ${c1 - 1.8} ${wb * 0.7} ${c1} M${-wb * 0.55} ${c1 + 2.2} Q0 ${c1 + 0.8} ${wb * 0.55} ${c1 + 2.2}" fill="none" stroke="#9a6846" stroke-opacity="0.55" stroke-width="0.8" stroke-linecap="round"/>
            <path d="M${-wt * 0.8} ${c2} Q0 ${c2 - 1.4} ${wt * 0.8} ${c2}" fill="none" stroke="#9a6846" stroke-opacity="0.5" stroke-width="0.7" stroke-linecap="round"/>
            <rect x="${-nw / 2}" y="${tip + 1.6}" width="${nw}" height="${nh}" rx="${nw * 0.42}" fill="url(#nail-${uid})" stroke="#b98a72" stroke-opacity="0.6" stroke-width="0.5"/>
            <path d="M${-nw * 0.28} ${tip + nh + 0.6} Q0 ${tip + nh - 1.6} ${nw * 0.28} ${tip + nh + 0.6}" fill="none" stroke="#ffffff" stroke-opacity="0.45" stroke-width="0.6"/>
        </g>`;
    }

    function handSvg(side) {
        // Right hand (fingers pointing away, thumb toward the centre on the left);
        // the left hand is the mirror image.
        const uid = side;
        const flip = side === 'left' ? 'transform="scale(-1,1) translate(-100,0)"' : '';
        return `<svg viewBox="-10 -5 120 170" xmlns="http://www.w3.org/2000/svg" overflow="visible">
            <defs>
                <linearGradient id="skinF-${uid}" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0" stop-color="#bf8259"/><stop offset="0.28" stop-color="#e8b48c"/>
                    <stop offset="0.55" stop-color="#f3c9a6"/><stop offset="1" stop-color="#c78b62"/>
                </linearGradient>
                <radialGradient id="skinP-${uid}" cx="0.55" cy="0.3" r="0.85">
                    <stop offset="0" stop-color="#f4cba9"/><stop offset="0.55" stop-color="#e5b089"/><stop offset="1" stop-color="#b97c55"/>
                </radialGradient>
                <linearGradient id="nail-${uid}" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stop-color="#fdf1ea"/><stop offset="1" stop-color="#eec4b4"/>
                </linearGradient>
                <linearGradient id="sleeve-${uid}" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stop-color="#1f2937"/><stop offset="0.55" stop-color="#111827"/><stop offset="1" stop-color="#111827" stop-opacity="0"/>
                </linearGradient>
                <linearGradient id="cuff-${uid}" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0" stop-color="#cbd5e1"/><stop offset="0.35" stop-color="#ffffff"/><stop offset="1" stop-color="#d8dee8"/>
                </linearGradient>
            </defs>
            <g ${flip}>
                <path d="M20 134 L96 130 L104 165 L12 165 Z" fill="url(#sleeve-${uid})"/>
                <g class="da-fingers">
                    ${fingerSvg(37, 52, 40, 13, -5, uid)}
                    ${fingerSvg(51.5, 49, 46, 13.5, -1.5, uid)}
                    ${fingerSvg(66, 50, 42, 12.8, 2.5, uid)}
                    ${fingerSvg(79.5, 55, 33, 11.2, 7, uid)}
                </g>
                <path d="M29 53 Q30 46 37 46.5 Q44 44 51.5 44 Q59 43.5 66 45 Q74 45.5 80 50 Q88 53 89 62 C91 84 87 104 82 126 L38 126 C33 106 26 82 29 53 Z"
                      fill="url(#skinP-${uid})" stroke="#8f5f40" stroke-opacity="0.75" stroke-width="0.9" stroke-linejoin="round"/>
                <g fill="#f8d6b8" fill-opacity="0.55">
                    <ellipse cx="37.5" cy="52" rx="5" ry="3.6"/><ellipse cx="51.5" cy="49.5" rx="5.2" ry="3.8"/>
                    <ellipse cx="66" cy="50.5" rx="5" ry="3.6"/><ellipse cx="79" cy="55.5" rx="4.3" ry="3.2"/>
                </g>
                <g fill="none" stroke="#9a6846" stroke-opacity="0.45" stroke-width="0.8" stroke-linecap="round">
                    <path d="M33 56.5 Q37.5 59 42 56.5"/><path d="M47 54 Q51.5 56.5 56 54"/>
                    <path d="M61.5 55 Q66 57.5 70.5 55"/><path d="M75 59.5 Q79 61.5 83 59.5"/>
                </g>
                <g fill="none" stroke="#fbe3cd" stroke-opacity="0.35" stroke-width="1.6" stroke-linecap="round">
                    <path d="M39 60 Q44 86 52 112"/><path d="M52 58 Q55 86 58 112"/>
                    <path d="M66 59 Q65 86 64 112"/><path d="M78 63 Q74 88 70 112"/>
                </g>
                <path d="M84 70 C86 90 83 108 80 124" fill="none" stroke="#8f5f40" stroke-opacity="0.25" stroke-width="3" stroke-linecap="round"/>
                <g class="da-thumb">
                    <path d="M33 58 C24 60 12 68 5 80 C1 88 6 95 14 92 C23 88 33 78 40 70 Z"
                          fill="url(#skinP-${uid})" stroke="#8f5f40" stroke-opacity="0.75" stroke-width="0.9" stroke-linejoin="round"/>
                    <path d="M18 71 Q21 76 26 78" fill="none" stroke="#9a6846" stroke-opacity="0.5" stroke-width="0.8" stroke-linecap="round"/>
                    <path d="M5.5 81 C3 87 6.5 92.5 12.5 90.5 C15 88 13 82 9.5 79.5 Z" fill="url(#nail-${uid})" stroke="#b98a72" stroke-opacity="0.6" stroke-width="0.5"/>
                </g>
                <path d="M34 64 Q40 74 37 88" fill="none" stroke="#9a6846" stroke-opacity="0.3" stroke-width="1" stroke-linecap="round"/>
                <path d="M33 119 Q60 114 86 117 L89 134 Q60 130 30 136 Z" fill="url(#cuff-${uid})" stroke="#94a3b8" stroke-width="0.7" stroke-linejoin="round"/>
                <path d="M34 123.5 Q60 119 86.5 121.5" fill="none" stroke="#cbd5e1" stroke-width="0.6"/>
                <circle cx="82" cy="126.5" r="1.7" fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.5"/>
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

        // soft shadow of the pack on the felt
        const shadow = document.createElement('div');
        shadow.className = 'da-shadow';
        shadow.style.width = `${Math.round(cw * 1.16)}px`;
        shadow.style.height = `${Math.round(ch * 1.12)}px`;
        shadow.style.marginLeft = `${-Math.round(cw * 0.58)}px`;
        shadow.style.marginTop = `${-Math.round(ch * 0.5)}px`;
        stage.appendChild(shadow);

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

        // hands: the 100x100 hand sits in a 120x170 drawing (wrist, cuff and sleeve below)
        const hs = Math.round(ch * 1.7);
        const hands = {};
        ['left', 'right'].forEach(side => {
            const h = document.createElement('div');
            h.className = 'da-hand';
            h.style.width = `${Math.round(hs * 1.2)}px`;
            h.style.height = `${Math.round(hs * 1.7)}px`;
            h.style.marginLeft = `${-Math.round(hs * 0.6)}px`;
            h.style.marginTop = `${-Math.round(hs * 0.55)}px`;
            h.style.zIndex = '200';
            h.innerHTML = handSvg(side);
            h.__thumb = h.querySelector('.da-thumb');
            h.__fingers = h.querySelector('.da-fingers');
            const sign = side === 'left' ? -1 : 1;
            // start below the table edge of the stage and slide in
            h.__st = { x: sign * (cw * 0.7), y: ch * 1.5, rot: sign * 8 };
            stage.appendChild(h);
            hands[side] = h;
            applyHand(h, h.__st, 0);
            h.style.opacity = '0';
        });
        requestAnimationFrame(() => {
            ['left', 'right'].forEach(side => {
                const sign = side === 'left' ? -1 : 1;
                hands[side].style.opacity = '1';
                applyHand(hands[side], { x: sign * (cw * 0.56), y: -ch * 0.08, rot: sign * 8 }, 320);
            });
        });

        return { stage, cards, hands, shadow, cw, ch };
    }

    function applyCard(c, st, dur, ease) {
        Object.assign(c.__st, st);
        const s = c.__st;
        c.style.transition = dur ? `transform ${dur}ms ${ease || 'cubic-bezier(0.3, 0.7, 0.3, 1)'}` : 'none';
        c.style.transform = `translate(${s.x}px, ${s.y}px) rotateY(${s.ry}deg) rotate(${s.rot}deg)`;
        if (typeof s.z === 'number') c.style.zIndex = String(10 + s.z);
        // a lifted edge catches the light
        c.classList.toggle('da-bl', s.ry < -8);
        c.classList.toggle('da-br', s.ry > 8);
    }

    function applyHand(h, st, dur, ease) {
        Object.assign(h.__st, st);
        const s = h.__st;
        h.style.transition = dur ? `transform ${dur}ms ${ease || 'cubic-bezier(0.3, 0.7, 0.3, 1)'}, opacity 220ms ease` : 'none';
        // lifted toward the viewer so thumbs stay on top of the bent-up card edges
        h.style.transform = `translate3d(${s.x}px, ${s.y}px, 34px) rotate(${s.rot}deg)`;
    }
    // thumb: degrees of lift (rotates about its base); fingers: 1 = flat, <1 = curled over the pack
    function setThumb(h, deg, dur) {
        if (!h.__thumb) return;
        h.__thumb.style.transition = `transform ${dur || 120}ms ease-out`;
        h.__thumb.style.transform = `rotate(${deg}deg)`;
    }
    function setFingers(h, curl, dur) {
        if (!h.__fingers) return;
        h.__fingers.style.transition = `transform ${dur || 200}ms ease`;
        h.__fingers.style.transform = `scaleY(${curl})`;
    }
    function setShadow(sh, sx, op, dur) {
        if (!sh) return;
        sh.style.transition = `transform ${dur || 300}ms ease, opacity ${dur || 300}ms ease`;
        sh.style.transform = `translateY(7px) scaleX(${sx})`;
        sh.style.opacity = String(op);
    }

    // One dealer cycle: cut → riffle → bridge → square up.
    function shuffleCycle(stageObj, t0, cycleMs) {
        const { cards, hands, shadow, cw, ch } = stageObj;
        const n = cards.length;
        // Believable hand speed: at most ±15% stretch; leftover time rests squared up.
        const k = Math.max(0.85, Math.min(1.15, cycleMs / SHUFFLE_CYCLE_MS));
        const T = (ms) => Math.round(ms * k);
        const half = Math.round(cw * 0.56);
        const L = hands.left, R = hands.right;
        const HY = -ch * 0.08;              // hands rest over the pack: fingers reach its far edge

        // 1. CUT: hands pull the two halves apart; thumbs lift the inner edges toward each other
        later(() => {
            cards.forEach((c, i) => {
                const left = i % 2 === 0;
                const j = Math.floor(i / 2);
                applyCard(c, {
                    x: left ? -half : half,
                    y: -j * 1.1,
                    rot: left ? -3 : 3,
                    ry: left ? -(20 + j * 0.9) : (20 + j * 0.9),     // upper cards bend up more under the thumb
                    z: j
                }, T(420), 'cubic-bezier(0.4, 0, 0.2, 1)');
            });
            applyHand(L, { x: -(half + cw * 0.2), y: HY, rot: -10 }, T(420));
            applyHand(R, { x: (half + cw * 0.2), y: HY, rot: 10 }, T(420));
            setThumb(L, -9, T(380)); setThumb(R, -9, T(380));
            setFingers(L, 0.93, T(380)); setFingers(R, 0.93, T(380));
            setShadow(shadow, 2.15, 0.8, T(420));
            playCardSound();
        }, t0);

        // 2. RIFFLE: thumbs let cards spring down from each half into the centre, bottom-up,
        //    in uneven little clumps the way a real riffle falls
        const riffleStart = t0 + T(620);
        const riffleStep = T(44);
        const order = [];
        let li = 0, ri = 0, side = Math.random() < 0.5 ? 0 : 1;
        const per = n / 2;
        while (li < per || ri < per) {
            const take = Math.random() < 0.3 ? 2 : 1;
            for (let q = 0; q < take; q++) {
                if (side === 0 && li < per) order.push((li++) * 2);
                else if (side === 1 && ri < per) order.push((ri++) * 2 + 1);
            }
            side = 1 - side;
        }
        later(() => {
            // Hands lean in so the thumbs meet over the centre
            applyHand(L, { x: -(half + cw * 0.12), y: HY + ch * 0.04, rot: -5 }, T(300));
            applyHand(R, { x: (half + cw * 0.12), y: HY + ch * 0.04, rot: 5 }, T(300));
        }, riffleStart - T(120));
        order.forEach((ci, j) => {
            later(() => {
                applyCard(cards[ci], {
                    x: (Math.random() - 0.5) * 5,
                    y: -j * 0.5 + (Math.random() - 0.5) * 2,
                    rot: (Math.random() - 0.5) * 5,
                    ry: 0,
                    z: j
                }, T(170), 'cubic-bezier(0.45, 0, 0.9, 0.6)');      // snaps down, accelerating
                // the thumb that just let a card go eases down a notch and springs back
                const h = (ci % 2 === 0) ? L : R;
                const left = j / n;
                setThumb(h, -9 + left * 7 + 3, T(40));
                later(() => setThumb(h, -9 + left * 7, T(60)), T(45));
                if (j % 3 === 0) playCardSound();
            }, riffleStart + j * riffleStep);
        });
        const riffleEnd = riffleStart + n * riffleStep + T(230);
        later(() => { setShadow(shadow, 1.25, 1, T(260)); }, riffleStart + Math.round(n * riffleStep * 0.6));

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
            applyHand(L, { x: -(cw * 0.6), y: HY - ch * 0.02, rot: -14 }, T(420));
            applyHand(R, { x: (cw * 0.6), y: HY - ch * 0.02, rot: 14 }, T(420));
            setThumb(L, 6, T(380)); setThumb(R, 6, T(380));
            setFingers(L, 0.84, T(380)); setFingers(R, 0.84, T(380));      // fingers curl over the arch
            setShadow(shadow, 1.05, 0.7, T(420));
            playCardSound();
        }, bowStart);
        const cascadeStart = bowStart + T(520);
        const cascadeStep = T(30);
        later(() => {
            const sorted = cards.slice().sort((a, b) => b.__st.z - a.__st.z); // top card first
            sorted.forEach((c, j) => {
                later(() => {
                    applyCard(c, {
                        ry: 0,
                        x: (Math.random() - 0.5) * 4,
                        y: -c.__st.z * 0.5 + 1,
                        rot: (Math.random() - 0.5) * 3
                    }, T(220), 'cubic-bezier(0.5, 0.05, 0.3, 1)');
                    if (j % 4 === 0) playCardSound();
                }, j * cascadeStep);
            });
            // hands ease outward and the fingers open as the pack settles
            const d = n * cascadeStep + T(200);
            applyHand(L, { x: -(half + cw * 0.14), y: HY, rot: -8 }, d);
            applyHand(R, { x: (half + cw * 0.14), y: HY, rot: 8 }, d);
            setFingers(L, 1, d); setFingers(R, 1, d);
            setThumb(L, 0, d); setThumb(R, 0, d);
            setShadow(shadow, 1, 1, d);
        }, cascadeStart);
        const cascadeEnd = cascadeStart + n * cascadeStep + T(260);

        // 4. SQUARE UP: hands tap the pack neat from both sides
        later(() => {
            cards.forEach(c => applyCard(c, { x: 3, rot: c.__st.rot + 1 }, T(130), 'ease-out'));
            applyHand(L, { x: -(cw * 0.54), rot: -3 }, T(130));
            applyHand(R, { x: (cw * 0.62), rot: 3 }, T(130));
        }, cascadeEnd + T(40));
        later(() => {
            cards.forEach(c => applyCard(c, { x: 0, rot: 0, y: -c.__st.z * 0.5 }, T(170), 'ease-in-out'));
            applyHand(L, { x: -(cw * 0.56), y: HY, rot: -8 }, T(170));
            applyHand(R, { x: (cw * 0.56), y: HY, rot: 8 }, T(170));
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
        if (startedWithWindow) addSkipButton(l, lobby, origin.y + (origin.h || 126) * 0.62 + 10);

        let stageObj = null;
        if (!reduce) {
            stageObj = buildShuffleStage(l, origin);
            // Two cycles for the default window (~8s); more if the window is longer.
            const cycles = Math.max(1, Math.min(5, Math.round(shuffleMs / SHUFFLE_CYCLE_MS)));
            const cycleMs = Math.floor(shuffleMs / cycles);
            for (let i = 0; i < cycles; i++) shuffleCycle(stageObj, 120 + i * cycleMs, cycleMs - 60);
            // hands draw back toward the dealer just before the deal
            later(() => {
                Object.values(stageObj.hands).forEach(h => {
                    applyHand(h, { y: h.__st.y + stageObj.ch * 1.3 }, 260, 'ease-in');
                    h.style.opacity = '0';
                });
            }, Math.max(0, shuffleMs - 280));
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

    // ---- skip button (all seated players must agree) ------------------------
    let skipStatus = null;      // last DEAL_SKIP_STATUS for the current window
    let skipBtn = null;
    let skipCtx = null;         // { until, me }

    function paintSkip() {
        if (!skipBtn || !skipCtx) return;
        const st = (skipStatus && skipStatus.until === skipCtx.until) ? skipStatus : null;
        const n = st ? st.votes.length : 0;
        const needed = st ? st.needed : 0;
        const voted = !!(st && skipCtx.me && st.votes.some(v => String(v).toLowerCase() === skipCtx.me.toLowerCase())) || skipBtn.__clicked;
        const count = needed ? ` ${n}/${needed}` : '';
        skipBtn.textContent = voted ? `Waiting for others…${count}` : `Skip ⏭${count}`;
        skipBtn.classList.toggle('da-voted', voted);
        skipBtn.disabled = voted;
    }

    function addSkipButton(l, lobby, top) {
        const me = (lobby.players || []).find(p => p.isMe && !p.isBot && !p.eliminated);
        if (!me || !lobby.dealingUntil || windowRemaining(lobby) <= 1200) return;
        skipCtx = { until: lobby.dealingUntil, me: me.username };
        skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'da-skip';
        skipBtn.style.top = `${Math.round(top)}px`;
        skipBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (skipBtn.__clicked) return;
            skipBtn.__clicked = true;
            try { if (typeof window.sendSocket === 'function') window.sendSocket({ type: 'SKIP_DEAL' }); } catch (e) {}
            paintSkip();
        });
        l.appendChild(skipBtn);
        paintSkip();
        requestAnimationFrame(() => { if (skipBtn) skipBtn.style.opacity = '1'; });
        // "Always skip shuffle" setting: vote to skip as soon as the deal starts
        if (alwaysSkipOn()) {
            skipBtn.__clicked = true;
            try { if (typeof window.sendSocket === 'function') window.sendSocket({ type: 'SKIP_DEAL' }); } catch (e) {}
            paintSkip();
        }
    }

    function alwaysSkipOn() {
        try { return localStorage.getItem('blitz31_always_skip') === 'true'; } catch (e) { return false; }
    }

    // Listen to the game socket for DEAL_SKIP_STATUS (network.js ignores unknown types)
    let listenedWs = null;
    function onSocketMessage(ev) {
        let data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (!data || data.type !== 'DEAL_SKIP_STATUS') return;
        if (data.until) skipStatus = data;
        paintSkip();
    }
    function watchSocket() {
        const ws = (window.appGlobals && window.appGlobals.ws) || window.ws;
        if (ws && ws !== listenedWs && typeof ws.addEventListener === 'function') {
            ws.addEventListener('message', onSocketMessage);
            listenedWs = ws;
        }
    }
    setInterval(watchSocket, 500);
    window.__dealSkipStatus = (d) => onSocketMessage({ data: JSON.stringify(d) });   // console / tests

    // ---- shuffle animation turned off (Settings -> Shuffle Animation) ----
    // The server still holds the hand for its shuffle & deal window, so the
    // cards are shown straight away with a small "Dealing… Ns" countdown.
    function shuffleAnimOn() {
        try { return localStorage.getItem('blitz31_shuffle_anim') !== 'false'; } catch (e) { return true; }
    }

    function runQuietDeal(lobby) {
        if (running) return;
        const remaining = windowRemaining(lobby);
        animatedUntil = lobby.dealingUntil || 0;
        if (remaining <= 0) return;
        running = true;
        startedWithWindow = true;
        const l = layer();
        const origin = tableOrigin();
        const banner = document.createElement('div');
        banner.className = 'da-banner';
        banner.style.top = `${Math.max(8, origin.y - 22)}px`;   // over the deck (unusable while dealing)
        l.appendChild(banner);
        const endAt = Date.now() + remaining;
        const paint = () => {
            const secs = Math.max(1, Math.ceil((endAt - Date.now()) / 1000));
            banner.innerHTML = `Dealing…<small>Play starts in ${secs}s</small>`;
        };
        paint();
        requestAnimationFrame(() => { banner.style.opacity = '1'; });
        addSkipButton(l, lobby, origin.y + 30);
        for (let ms = 250; ms < remaining; ms += 250) later(paint, ms);
        later(cleanup, remaining + 300);
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
                        if (enteredPlaying || joinedMidDeal) {
                            if (shuffleAnimOn() && !alwaysSkipOn()) runShuffleAndDeal(lobby); else runQuietDeal(lobby);
                        }
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
