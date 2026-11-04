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
//   PILE     the discard pile looks like a real one: the last few discarded
//            cards lie under the top card at random (but stable) angles and
//            offsets, and the top card itself sits slightly askew. The server
//            only sends the top card, so the pile is tracked here from the
//            snapshots (reset each hand / when the deck is reshuffled).
//            Settings "Messy Discard Pile" off (localStorage blitz31_messy_pile =
//            'false') gives a neat pile instead: one straight card, nothing under it.
//   TICK     during the last 5 seconds of your own turn a soft tick plays once a
//            second (ui.js already vibrates on those seconds).
//   LOSER    when the reveal has finished, the name of whoever lost a life that
//            hand (or "is out" when it was their last) is shown in the middle of
//            the screen and Sad.mp3 plays (SFX toggle + volume respected).
//
// Skipped while the shuffle & deal overlay is running (body.da-hide-cards).
// Every flight keeps one size (the table's deck/discard card size) from start to
// finish: no growing or shrinking between the piles, the seats and your hand.
// A face-up flying card is a styled copy of the real card it lands on (or left),
// with every font size copied, so its lettering never changes size mid-flight.
// Honors the SFX toggle and prefers-reduced-motion (no flights/flips, just sounds).
// Players can turn the draw/discard flights off in Settings ("Card Draw
// Animation", localStorage blitz31_draw_anim = 'false'): sounds still play.

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
        .cm-card.cm-clone { background: transparent; border: none; padding: 0; }
        .cm-card.cm-clone > * { pointer-events: none; }
        .cm-hidden-card { visibility: hidden !important; }
        .cm-reveal-wait { visibility: hidden !important; }
        .cm-pile { position: absolute; z-index: -1; pointer-events: none; }
        .cm-pile .card-slot { position: absolute !important; left: 0; top: 0; cursor: default; }
        #cm-loser-banner {
            position: fixed; left: 50%; top: 50%; z-index: 9350; pointer-events: none;
            transform: translate(-50%, -50%) scale(0.85); opacity: 0;
            transition: opacity 220ms ease, transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1.3);
            background: rgba(15, 23, 42, 0.93); border: 2px solid #ef4444; border-radius: 16px;
            padding: 14px 26px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.7);
            max-width: 86vw;
        }
        #cm-loser-banner.cm-show { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        #cm-loser-banner .cm-loser-name {
            display: block; color: #fff; font-weight: 900; font-size: clamp(1.4rem, 6vw, 2.4rem);
            line-height: 1.15; overflow-wrap: anywhere;
        }
        #cm-loser-banner .cm-loser-sub {
            display: block; margin-top: 4px; color: #fca5a5; font-weight: 700;
            font-size: clamp(0.8rem, 3vw, 1rem); letter-spacing: 1px; text-transform: uppercase;
        }
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

    function drawAnimOn() {
        try { return localStorage.getItem('blitz31_draw_anim') !== 'false'; } catch (e) { return true; }
    }
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
        return area ? area.querySelector(':scope > .card-slot:not(#deck-pile)') : null;
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

    // ---- messy discard pile ---------------------------------------------
    const PILE_SHOW = 5;      // cards visible under the top card
    const PILE_KEEP = 12;     // cards remembered (lets pick-ups reveal the one below)
    let pile = [];            // [{val, suit}] bottom -> top
    let pileSalt = String(Math.random());

    function sameCard(a, b) { return !!a && !!b && a.val === b.val && normSuit(a.suit) === normSuit(b.suit); }
    function hash(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }
    // Stable position for the card at index i of this hand's pile. A card keeps
    // the same spot whether it is on top or covered, so picking up the top card
    // uncovers the one below exactly where it was lying.
    function messyPileOn() {
        try { return localStorage.getItem('blitz31_messy_pile') !== 'false'; } catch (e) { return true; }
    }
    function pileLook(card, i) {
        if (!messyPileOn()) return { rot: 0, dx: 0, dy: 0 };
        const h = hash(`${pileSalt}|${i}|${card.val}${normSuit(card.suit)}`);
        const r = (k) => ((h >>> (k * 8)) & 0xff) / 255 - 0.5;
        return { rot: r(0) * 44, dx: r(1) * 44, dy: r(2) * 30 };
    }
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
    function faceHtml(card) {
        const suit = normSuit(card.suit);
        const cls = isRed(suit) ? 'red-suit' : 'black-suit';
        const v = esc(card.val), su = esc(suit);
        return `<div class="card-slot playing-card ${cls}">
            <div class="card-corner top-left"><span class="corner-val">${v}</span><span class="corner-suit">${su}</span></div>
            <div class="card-center-pip">${su}</div>
            <div class="card-corner bottom-right"><span class="corner-val">${v}</span><span class="corner-suit">${su}</span></div>
        </div>`;
    }

    function updatePile(lobby, before, newHand) {
        const top = lobby.discardTop || null;
        const reshuffled = before && typeof lobby.deckCount === 'number' && typeof before.deckCount === 'number' && lobby.deckCount > before.deckCount + 1;
        if (!top) { pile = []; return; }
        if (!before || newHand || reshuffled || !pile.length) {
            pile = [top];
            if (newHand || !before) pileSalt = String(Math.random());
            return;
        }
        if (sameCard(pile[pile.length - 1], top)) return;
        if (pile.length >= 2 && sameCard(pile[pile.length - 2], top)) { pile.pop(); return; }  // picked up
        pile.push(top);
        if (pile.length > PILE_KEEP) pile = pile.slice(-PILE_KEEP);
    }

    function renderPile() {
        const area = document.getElementById('deck-center');
        if (!area) return;
        const old = area.querySelector(':scope > .cm-pile');
        if (old) old.remove();
        const slot = discardEl();
        if (!slot || !pile.length || slot.classList.contains('empty-slot')) return;

        const topIdx = pile.length - 1;
        const tl = pileLook(pile[topIdx], topIdx);
        slot.style.rotate = `${tl.rot.toFixed(1)}deg`;
        slot.style.translate = `${tl.dx.toFixed(1)}px ${tl.dy.toFixed(1)}px`;

        if (!messyPileOn()) { slot.style.rotate = ''; slot.style.translate = ''; return; }
        const under = pile.slice(Math.max(0, topIdx - PILE_SHOW), topIdx);
        if (!under.length) return;
        const box = document.createElement('div');
        box.className = 'cm-pile';
        box.style.left = `${slot.offsetLeft}px`;
        box.style.top = `${slot.offsetTop}px`;
        box.style.width = `${slot.offsetWidth}px`;
        box.style.height = `${slot.offsetHeight}px`;
        const first = topIdx - under.length;
        box.innerHTML = under.map(faceHtml).join('');
        Array.from(box.children).forEach((el, k) => {
            const lk = pileLook(under[k], first + k);
            el.style.rotate = `${lk.rot.toFixed(1)}deg`;
            el.style.translate = `${lk.dx.toFixed(1)}px ${lk.dy.toFixed(1)}px`;
            el.style.setProperty('box-shadow', '0 1px 3px rgba(0,0,0,0.3)', 'important');
        });
        area.insertBefore(box, slot);
    }

    // ---- card visual copies -------------------------------------------
    // A detached copy of a rendered card with its computed look written inline,
    // so it looks identical (same fonts, corners, pip) outside its table context.
    const COPY_PROPS = ['font-size', 'font-weight', 'font-family', 'font-style', 'line-height', 'letter-spacing',
        'color', 'text-align', 'white-space', 'display', 'flex-direction', 'align-items', 'justify-content', 'gap',
        'position', 'top', 'left', 'right', 'bottom', 'transform', 'padding', 'margin', 'width', 'height',
        'box-sizing', 'background', 'border', 'border-radius', 'opacity'];
    function copyStyles(src, dst) {
        const cs = getComputedStyle(src);
        COPY_PROPS.forEach(prop => dst.style.setProperty(prop, cs.getPropertyValue(prop)));
        const a = src.children, b = dst.children;
        for (let i = 0; i < a.length && i < b.length; i++) copyStyles(a[i], b[i]);
    }
    function visualOf(el) {
        if (!el || !el.classList || !el.classList.contains('playing-card')) return null;
        const copy = el.cloneNode(true);
        copy.removeAttribute('id');
        copy.removeAttribute('onclick');
        copy.querySelectorAll('[id],[onclick]').forEach(n => { n.removeAttribute('id'); n.removeAttribute('onclick'); });
        copyStyles(el, copy);
        copy.classList.remove('cm-hidden-card');
        Object.assign(copy.style, {
            position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', margin: '0',
            transform: 'none', rotate: 'none', translate: 'none', visibility: 'visible', boxShadow: 'none'
        });
        return copy;
    }
    let lastTopVisual = null;   // the discard top as it looked after the previous snapshot

    // ---- flights --------------------------------------------------------
    function fly(from, to, opts) {
        opts = opts || {};
        if (reducedMotion() || !drawAnimOn()) { if (opts.onLand) opts.onLand(); return; }
        const l = layer();
        const c = document.createElement('div');
        c.className = 'cm-card';
        if (opts.visual) {
            c.classList.add('cm-clone');
            c.appendChild(opts.visual);
        } else if (opts.face) {
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

    function animateDraw(p, isMe, me, lobby, prevDiscard, prevTopRot, prevTopVisual) {
        const prevVisual = prevTopVisual ? prevTopVisual.cloneNode(true) : null;
        const fromDiscard = /discard pile/i.test(lobby.phaseMessage || '') &&
            (lobby.phaseMessage || '').toLowerCase().includes(String(p.username).toLowerCase());
        const srcEl = fromDiscard ? discardEl() : deckEl();
        const from = srcEl ? center(srcEl) : null;
        if (!from) return;
        // the card's own size (the discard slot is tilted, so its bounding box is larger)
        const size = { w: srcEl.offsetWidth || 52, h: srcEl.offsetHeight || 74 };
        const face = fromDiscard && prevDiscard ? prevDiscard : null;
        const startRot = fromDiscard ? (prevTopRot || 0) : -6;

        if (isMe) {
            const els = myCardEls();
            const target = els.length ? els[els.length - 1] : null;
            if (!target) return;
            target.classList.add('cm-hidden-card');
            const to = center(target);
            const newCard = (me.cards && me.cards.length) ? me.cards[me.cards.length - 1] : null;
            fly(from, { x: to.x, y: to.y }, {
                visual: visualOf(target), face: face || newCard, size, fromRot: startRot,
                onLand: () => target.classList.remove('cm-hidden-card')
            });
            // Safety: never leave the real card hidden
            setTimeout(() => target.classList.remove('cm-hidden-card'), FLIGHT_MS + 600);
        } else {
            const to = seatPoint(p.username);
            if (!to) return;
            fly(from, to, { visual: fromDiscard ? prevVisual : null, face, size, fromRot: startRot, toRot: Math.random() * 20 - 10 });
        }
    }

    function animateDiscard(p, isMe, lobby) {
        const pileEl = discardEl();
        if (!pileEl) return;
        const to = center(pileEl);
        const size = { w: pileEl.offsetWidth || 52, h: pileEl.offsetHeight || 74 };
        const face = lobby.discardTop || null;

        let from = null;
        if (isMe) {
            if (lastTap && Date.now() - lastTap.at < TAP_MEMORY_MS && lastTap.point) {
                from = lastTap.point;
            } else {
                const hand = document.getElementById('my-cards-container');
                if (hand) from = center(hand);
            }
            lastTap = null;
        } else {
            from = seatPoint(p.username);
        }
        if (!from) return;

        pileEl.classList.add('cm-hidden-card');
        const landRot = pile.length ? pileLook(pile[pile.length - 1], pile.length - 1).rot : 0;
        fly(from, { x: to.x, y: to.y }, {
            visual: visualOf(pileEl), face, size, fromRot: Math.random() * 16 - 8, toRot: landRot,
            onLand: () => pileEl.classList.remove('cm-hidden-card')
        });
        setTimeout(() => pileEl.classList.remove('cm-hidden-card'), FLIGHT_MS + 600);
    }

    // ---- round-over loser banner + Sad.mp3 ------------------------------
    const LOSER_SHOW_MS = 3600;
    let loserTimers = [];
    let sadAudio = null;

    function hideLoserBanner() {
        loserTimers.forEach(clearTimeout);
        loserTimers = [];
        const b = document.getElementById('cm-loser-banner');
        if (b) b.remove();
    }
    function stopSad() {
        if (!sadAudio) return;
        try { sadAudio.pause(); sadAudio.currentTime = 0; } catch (e) {}
    }
    function playSad() {
        if (!sfxOn()) return;
        try {
            const vol = (typeof window.getSfxVolume === 'function') ? window.getSfxVolume() : 0.6;
            if (!(vol > 0)) return;
            if (!sadAudio) sadAudio = new Audio('/mp3s/Sad.mp3');
            sadAudio.pause();
            sadAudio.currentTime = 0;
            sadAudio.volume = Math.max(0, Math.min(1, vol));
            const pr = sadAudio.play();
            if (pr && pr.catch) pr.catch(() => {});
        } catch (e) {}
    }
    function joinNames(names) {
        if (names.length <= 1) return names[0] || '';
        return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
    }
    function showLoserBanner(losers) {
        hideLoserBanner();
        if (!losers.length) return;
        const out = losers.filter(p => p.out);
        let sub;
        if (losers.length === 1) sub = losers[0].out ? 'is out!' : 'lost a life';
        else if (out.length === losers.length) sub = 'are out!';
        else if (out.length) sub = `lost a life · ${joinNames(out.map(p => p.name))} ${out.length === 1 ? 'is' : 'are'} out!`;
        else sub = 'lost a life';
        const b = document.createElement('div');
        b.id = 'cm-loser-banner';
        b.innerHTML = `<span class="cm-loser-name">${esc(joinNames(losers.map(p => p.name)))}</span>` +
            `<span class="cm-loser-sub">${esc(sub)}</span>`;
        document.body.appendChild(b);
        requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add('cm-show')));
        playSad();
        loserTimers.push(setTimeout(() => b.classList.remove('cm-show'), LOSER_SHOW_MS));
        loserTimers.push(setTimeout(() => b.remove(), LOSER_SHOW_MS + 300));
    }
    // Players whose lives went down between the previous snapshot and this one
    function losersOf(lobby, prevPlayers) {
        return (lobby.players || []).filter(p => {
            const b = prevPlayers[String(p.username).toLowerCase()];
            return b && typeof b.lives === 'number' && typeof p.lives === 'number' && p.lives < b.lives;
        }).map(p => ({ name: p.username, out: p.lives <= 0 || !!p.eliminated }));
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
        hideLoserBanner();
        const bannerLosers = losersOf(lobby, prevPlayers);
        const players = (lobby.players || []).filter(p => Array.isArray(p.cards) && p.cards.length > 0);
        if (players.length < 2) {
            if (bannerLosers.length) loserTimers.push(setTimeout(() => showLoserBanner(bannerLosers), 300));
            return;
        }
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
                    // all cards are face up: show who lost
                    loserTimers.push(setTimeout(() => showLoserBanner(bannerLosers), REVEAL_FLIP_MS + 250));
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
        return { state: lobby.gameState, players, discardTop: lobby.discardTop || null, deckCount: lobby.deckCount };
    }

    function onSnapshot(lobby) {
        if (!lobby || !lobby.gameState) return;
        try { lobby.__receivedAt = Date.now(); } catch (e) {}
        latest = lobby;
        const cur = summarize(lobby);
        const before = prev;
        prev = cur;

        const inPlay = lobby.gameState === 'playing' || lobby.gameState === 'finalTurn';
        const wasInPlay = !!before && (before.state === 'playing' || before.state === 'finalTurn');

        // Messy discard pile (ui.js re-rendered the table, so re-apply every time)
        const prevTopRot = pile.length ? pileLook(pile[pile.length - 1], pile.length - 1).rot : 0;
        const prevTopVisual = lastTopVisual;
        updatePile(lobby, before, inPlay && !wasInPlay);
        renderPile();
        try { lastTopVisual = visualOf(discardEl()); } catch (e) { lastTopVisual = null; }
        if (!before) return;

        // Round over: staggered reveal, losers last
        if (lobby.gameState === 'roundOver') {
            if (before.state !== 'roundOver') startReveal(lobby, before.players);
            else applyRevealVisibility();   // ui.js re-rendered mid-reveal
            return;
        }
        if (reveal) clearReveal();
        hideLoserBanner();
        if (inPlay && !wasInPlay) stopSad();   // next hand started

        if (!inPlay || !wasInPlay || dealing()) return;

        const me = (lobby.players || []).find(p => p.isMe);
        (lobby.players || []).forEach(p => {
            const b = before.players[String(p.username).toLowerCase()];
            if (!b) return;
            const now = cardCountOf(p);
            const isMe = !!(me && me.username === p.username);
            if (now === b.count + 1) {
                cardSound();
                animateDraw(p, isMe, me, lobby, before.discardTop, prevTopRot, prevTopVisual);
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

    // Settings switch calls this so the pile changes look at once
    window.refreshDiscardPileLook = function () { try { renderPile(); lastTopVisual = visualOf(discardEl()); } catch (e) {} };

    let tries = 0;
    const t = setInterval(() => {
        const a = install() || (window.updateUIFromLobby && window.updateUIFromLobby.__cardMovesWrapped);
        const b = wrapDiscardTap() || (window.discardCard && window.discardCard.__cmWrapped);
        if ((a && b) || ++tries > 50) clearInterval(t);
    }, 100);
    install();
    wrapDiscardTap();
})();
