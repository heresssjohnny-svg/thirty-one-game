// public/js/tutorial.js - short "How to play" for new players + coach tips in their first games.
//  - Shown once to anyone who hasn't seen it (localStorage blitz31_tut_seen) when the main menu appears,
//    except accounts that already have games played. Also "📖 How to play" on the main menu and in Settings.
//  - Last slide: "🤖 Practice vs bots" creates a private, always-free practice table (CREATE_LOBBY practice:true)
//    with 2 bots; or "Got it".
//  - Coach tips (bottom bubble) for the first 3 rounds after the tutorial: what to do on your turn, when you
//    can knock, what happens at the showdown. "Hide tips" turns them off for good.
(function () {
    'use strict';
    if (window.__tutorialLoaded) return;
    window.__tutorialLoaded = true;

    var SEEN = 'blitz31_tut_seen', COACH = 'blitz31_coach_rounds';
    function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
    function token() { try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; } }
    function visible(el) { return !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'); }
    function menuShown() { return visible(document.getElementById('main-menu')); }
    function snap() { return window.appGlobals && window.appGlobals.latestLobbySnapshot; }

    function card(v, s) {
        var red = s === '♥' || s === '♦';
        return '<span class="tu-card' + (red ? ' r' : '') + '"><b>' + v + '</b><i>' + s + '</i></span>';
    }
    var SLIDES = [
        { t: 'Get as close to 31 as you can', b: 'Your score is the total of your cards <b>in one suit</b>. Aces count 11, K / Q / J count 10, number cards count their number.',
          x: card('A', '♠') + card('K', '♠') + card('9', '♠') + '<div class="tu-eq">= 30 ♠</div>' },
        { t: 'Only one suit counts', b: 'Mixed suits don\'t add up — only your best suit does. Three of a kind (like 7-7-7) is worth <b>30½</b>.',
          x: card('A', '♥') + card('K', '♠') + card('Q', '♠') + '<div class="tu-eq">= 20 ♠ (the ♥ doesn\'t count)</div>' },
        { t: 'Your turn: draw, then discard', b: 'Take the top card of the <b>deck</b> or the face-up <b>discard pile</b>, then throw one card away. Tap cards, or drag them. You can\'t throw back the card you just picked up from the discard pile.',
          x: '<span class="tu-card back"></span><span class="tu-arrow">→ 🫳 →</span>' + card('5', '♦') },
        { t: 'Knock when you think you\'re ahead', b: 'At the start of your turn (before drawing) tap <b>Knock</b> if you have 21 or more (25 or more when it\'s just two of you). Everyone else gets one last turn.',
          x: '<div class="tu-big">✊ KNOCK</div>' },
        { t: 'Lowest hand loses a life', b: 'After the last turns, the lowest score loses a life. Hit <b>31</b> at any time and the round ends at once — everyone else loses a life! After someone knocks you can also <b>Muck</b>: you lose the life, but nobody sees your cards.',
          x: '<div class="tu-big">⚡ 31!</div>' },
        { t: 'Last one standing wins', b: 'Everyone starts with a few lives (usually 2). Lose them all and you\'re out. The last player left wins the match. Ready to try it?',
          x: '<div class="tu-big">🏆</div>', last: true }
    ];

    var box = null, idx = 0;
    function render() {
        var s = SLIDES[idx];
        box.querySelector('.tu-body').innerHTML =
            '<div class="tu-step">' + (idx + 1) + ' / ' + SLIDES.length + '</div>' +
            '<div class="tu-x">' + s.x + '</div><h3>' + s.t + '</h3><p>' + s.b + '</p>' +
            '<div class="tu-dots">' + SLIDES.map(function (_, i) { return '<span' + (i === idx ? ' class="on"' : '') + '></span>'; }).join('') + '</div>' +
            '<div class="tu-btns">' +
            (idx > 0 ? '<button type="button" data-tu="back" class="tu-ghost">Back</button>' : '<button type="button" data-tu="skip" class="tu-ghost">Skip</button>') +
            (s.last ? '<button type="button" data-tu="done" class="tu-ghost">Got it</button><button type="button" data-tu="practice" class="tu-main">🤖 Practice vs bots</button>'
                    : '<button type="button" data-tu="next" class="tu-main">Next</button>') +
            '</div>';
    }
    function open(startAt) {
        if (!box) {
            box = document.createElement('div');
            box.id = 'tu-modal';
            box.innerHTML = '<div class="tu-sheet" role="dialog" aria-label="How to play"><button type="button" class="tu-close" data-tu="skip" aria-label="Close">✕</button><div class="tu-body"></div></div>';
            document.body.appendChild(box);
            box.addEventListener('click', function (ev) {
                var b = ev.target.closest && ev.target.closest('[data-tu]'); if (!b) return;
                var a = b.getAttribute('data-tu');
                if (a === 'next') { idx = Math.min(SLIDES.length - 1, idx + 1); render(); }
                else if (a === 'back') { idx = Math.max(0, idx - 1); render(); }
                else if (a === 'skip' || a === 'done') { close(); }
                else if (a === 'practice') { close(); startPractice(); }
            });
            // swipe
            var x0 = null;
            box.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
            box.addEventListener('touchend', function (e) {
                if (x0 == null) return; var dx = e.changedTouches[0].clientX - x0; x0 = null;
                if (dx < -50 && idx < SLIDES.length - 1) { idx++; render(); } else if (dx > 50 && idx > 0) { idx--; render(); }
            });
        }
        idx = startAt || 0; render();
        box.classList.add('open');
        ls(SEEN, '1');
    }
    function close() { if (box) box.classList.remove('open'); if (ls(COACH) == null) ls(COACH, '0'); }
    window.openTutorial = open;

    // ---- practice table vs 2 bots
    var practicePending = false, botsFor = null;
    function startPractice() {
        if (typeof window.initSocketAndSend !== 'function') return;
        var me = (window.userSession && window.userSession.username) || (document.getElementById('username-input') || {}).value || 'Player';
        practicePending = true;
        if (ls(COACH) == null || ls(COACH) === 'off') ls(COACH, '0');
        window.initSocketAndSend({ type: 'CREATE_LOBBY', username: me, accountUsername: me, lobbyName: 'Practice – ' + me, isPrivate: true, practice: true });
    }
    setInterval(function () {
        if (!practicePending) return;
        var s = snap();
        if (s && s.code && botsFor !== s.code && /^Practice/.test(s.name || '')) {
            botsFor = s.code; practicePending = false;
            var bots = (s.players || []).filter(function (p) { return p.isBot; }).length;
            for (var i = bots; i < 2; i++) window.initSocketAndSend({ type: 'ADD_BOT' });
            tip('🤖 Two bots joined. Tap <b>Ready</b> to start your practice game.');
        }
    }, 400);

    // ---- auto-show once for new players
    var checked = false;
    setInterval(function () {
        if (checked || ls(SEEN) || !menuShown()) return;
        checked = true;
        if (!token()) { open(0); return; }
        fetch('/api/stats/me', { headers: { Authorization: 'Bearer ' + token() } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { if (d && Number(d.games) > 0) { ls(SEEN, '1'); return; } if (menuShown()) open(0); })
            .catch(function () { if (menuShown()) open(0); });
    }, 1200);

    // ---- "How to play" entry points
    setInterval(function () {
        var hdr = document.querySelector('#main-menu .header-actions');
        if (hdr && !document.getElementById('tu-menu-btn')) {
            var b = document.createElement('button');
            b.id = 'tu-menu-btn'; b.type = 'button'; b.className = 'icon-btn'; b.title = 'How to play'; b.textContent = '📖';
            b.onclick = function () { open(0); };
            hdr.insertBefore(b, hdr.lastElementChild);
        }
        var content = document.querySelector('#settings-modal .settings-content');
        if (content && !document.getElementById('tu-settings-row')) {
            var r = document.createElement('div');
            r.id = 'tu-settings-row'; r.style.cssText = 'margin-top:10px;';
            r.innerHTML = '<button type="button" style="width:100%;padding:10px 12px;border-radius:10px;cursor:pointer;font-weight:800;font-size:.9rem;color:#fde68a;background:#1e293b;border:1px solid rgba(251,191,36,.6);">📖 How to play</button>' +
                '<label style="display:flex;gap:8px;align-items:center;margin-top:8px;color:#cbd5e1;font-size:.82rem;"><input type="checkbox" id="tu-coach-toggle"> Show tips during games</label>';
            r.querySelector('button').onclick = function () { var sm = document.getElementById('settings-modal'); if (sm) sm.style.display = 'none'; open(0); };
            r.querySelector('#tu-coach-toggle').onchange = function (e) { ls(COACH, e.target.checked ? '0' : 'off'); if (!e.target.checked) hideTip(); };
            content.appendChild(r);
        }
        var t = document.getElementById('tu-coach-toggle');
        if (t) t.checked = coachOn();
    }, 1000);

    // ---- coach tips during the first rounds
    function coachOn() { var v = ls(COACH); return v != null && v !== 'off' && Number(v) < 3; }
    var tipEl = null, lastTip = '';
    function tip(html) {
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.id = 'tu-tip';
            tipEl.innerHTML = '<span class="tu-tip-t"></span><button type="button" aria-label="Hide tips">Hide tips</button>';
            tipEl.querySelector('button').onclick = function () { ls(COACH, 'off'); hideTip(); };
            document.body.appendChild(tipEl);
        }
        if (html === lastTip && tipEl.classList.contains('on')) return;
        lastTip = html;
        tipEl.querySelector('.tu-tip-t').innerHTML = html;
        tipEl.classList.add('on');
        placeTip();
    }
    // sit under the hand (or just above the "My Hand" row if there's no room) so it never covers the cards
    function placeTip() {
        if (!tipEl) return;
        var hand = document.getElementById('my-cards-container');
        var r = hand && hand.getClientRects().length ? hand.getBoundingClientRect() : null;
        if (!r) { tipEl.style.top = ''; tipEl.style.bottom = ''; return; }
        var h = tipEl.offsetHeight || 48;
        if (r.bottom + 10 + h < window.innerHeight - 6) { tipEl.style.top = Math.round(r.bottom + 10) + 'px'; tipEl.style.bottom = 'auto'; }   // under the hand
        else { tipEl.style.top = 'auto'; tipEl.style.bottom = Math.max(8, Math.round(window.innerHeight - r.top + 44)) + 'px'; }      // no room: above it
    }
    window.addEventListener('resize', placeTip);
    function hideTip() { lastTip = ''; if (tipEl) tipEl.classList.remove('on'); }
    function pts(v) { return v === 'A' ? 11 : (['K', 'Q', 'J'].indexOf(v) >= 0 ? 10 : (parseInt(v, 10) || 0)); }
    function bestScore(cards) {
        if (!cards || cards.length < 3) return 0;
        var c = cards.slice(0, 3);
        if (c[0].val === c[1].val && c[1].val === c[2].val) return 30.5;
        var by = {}; c.forEach(function (x) { by[x.suit] = (by[x.suit] || 0) + pts(x.val); });
        return Math.max.apply(null, Object.keys(by).map(function (k) { return by[k]; }));
    }
    var lastState = null;
    setInterval(function () {
        placeTip();
        var s = snap(), gv = document.getElementById('game-view');
        if (!coachOn() || !s || !visible(gv)) { hideTip(); lastState = s && s.gameState; return; }
        var me = (s.players || []).find(function (p) { return p.isMe; });
        if (!me) { hideTip(); return; }
        // count finished rounds
        if ((s.gameState === 'roundOver' || s.gameState === 'tournamentEnd') && lastState !== s.gameState && lastState && lastState !== 'roundOver') {
            ls(COACH, String(Number(ls(COACH) || 0) + 1));
        }
        lastState = s.gameState;
        if (document.body.classList.contains('da-hide-cards')) { tip('🃏 Dealing… each player gets 3 cards.'); return; }
        var mine = s.currentTurnUser === me.username, n = (me.cards || []).length, sc = bestScore(me.cards);
        if (s.gameState === 'lobby') {
            var bots = (s.players || []).filter(function (p) { return p.isBot; }).length;
            if (!me.ready) return tip('👋 Tap <b>Ready</b> when you\'re set.' + (bots ? '' : ' Want to practice? Add bots from the table menu.'));
            return hideTip();
        }
        if (s.gameState === 'dealerDraw') return tip('🎴 Everyone picks a card — the lowest card deals first.');
        if (s.gameState === 'roundOver') return tip('📉 Round over: the lowest hand lost a life. A new hand starts in a moment.');
        if (s.gameState === 'tournamentEnd') return tip('🏆 Match over! Tap <b>Play again</b> for another round.');
        if (me.eliminated) return tip('👀 You\'re out of lives — watch the rest of the match.');
        if (s.gameState === 'finalTurn' && s.knockedBy && s.knockedBy !== me.username && mine) {
            return tip('✊ <b>' + s.knockedBy + '</b> knocked — this is your <b>last turn</b>. Draw and discard to beat them' + (n >= 4 ? '' : ', or Muck if your hand is hopeless') + '.');
        }
        if (!mine) return tip('⏳ Waiting for <b>' + s.currentTurnUser + '</b>. Your score now: <b>' + sc + '</b>.');
        if (n >= 4) return tip('🗑️ Now <b>discard</b>: tap (or drag to the pile) the card that doesn\'t fit your best suit.');
        if (s.canKnock && s.gameState === 'playing' && sc >= 21) return tip('💡 You have <b>' + sc + '</b>. Draw a card — or <b>Knock</b> now if you think nobody can beat it.');
        return tip('👉 Your turn: <b>draw</b> — tap the deck, or the face-up card if it helps your suit. You have <b>' + sc + '</b>.');
    }, 700);

    window.__tutorial = { open: open, coachOn: coachOn, bestScore: bestScore };
})();
