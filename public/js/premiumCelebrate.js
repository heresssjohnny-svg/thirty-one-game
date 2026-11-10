// public/js/premiumCelebrate.js - Premium celebrations:
//   confetti styles + dance styles (shown to the whole table when YOU celebrate),
//   custom knock call (the table hears your pick when you knock),
//   throwable emotes (🍅 at a player; everyone at the table sees it fly).
// Picks travel with SET_CELEBRATION (celebSound.js) and come back in players[].celebration.
(function () {
    'use strict';
    if (window.__premiumCelebrateLoaded) return;
    window.__premiumCelebrateLoaded = true;

    var CONFETTI = [
        { id: 'default', name: 'Classic', icon: '🎊', free: true },
        { id: 'cash', name: 'Cash rain', icon: '💵' },
        { id: 'coins', name: 'Gold coins', icon: '🪙' },
        { id: 'suits', name: 'Card suits', icon: '♠️' },
        { id: 'fireworks', name: 'Fireworks', icon: '🎆' },
        { id: 'hearts', name: 'Hearts', icon: '💖' }
    ];
    var DANCES = [
        { id: 'default', name: 'Twerk crew', icon: '🍑', free: true },
        { id: 'disco', name: 'Disco', icon: '🕺' },
        { id: 'robot', name: 'Robot', icon: '🤖' },
        { id: 'none', name: 'No dancers', icon: '🚫' }
    ];
    var EMOTES = ['🍅', '🥚', '💩', '🌹', '💋', '🔥', '❄️', '💣', '🎯', '🥧', '👟', '💎'];

    function prem() { return !!window.__isPremium; }
    function lsGet(k) { try { return localStorage.getItem(k) || 'default'; } catch (e) { return 'default'; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function valid(list, id) { return list.some(function (x) { return x.id === id; }); }
    function snap() { return window.appGlobals && window.appGlobals.latestLobbySnapshot; }
    function lower(s) { return String(s || '').trim().toLowerCase(); }
    function myNames() {
        var h = (typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '') || '';
        var a = (typeof window.getAccountUsername === 'function' ? window.getAccountUsername() : '') || '';
        var s = snap(), m = s && (s.players || []).find(function (p) { return p.isMe; });
        return [lower(h), lower(a), lower(m && m.username)].filter(Boolean);
    }
    function isMe(name) { return myNames().indexOf(lower(name)) >= 0; }
    function playerByName(name) { var s = snap(); return s && (s.players || []).find(function (p) { return lower(p.username) === lower(name); }); }
    function locked() { if (typeof window.showCenterNotification === 'function') window.showCenterNotification('🔒 Premium option'); }

    function myChoice() {
        var c = lsGet('blitz31_confetti'), d = lsGet('blitz31_dance');
        if (!prem() || !valid(CONFETTI, c)) c = 'default';
        if (!prem() || !valid(DANCES, d)) d = 'default';
        return { confetti: c, dance: d };
    }
    window.__celebExtraChoice = myChoice;

    // ---------- picker inside the Celebrate tab ----------
    function tiles(list, cur, attr) {
        return '<div class="ph-grid">' + list.map(function (o) {
            var lk = !o.free && !prem();
            return '<button type="button" class="ph-tile' + (cur === o.id ? ' on' : '') + (lk ? ' locked' : '') + '" ' + attr + '="' + o.id + '">' +
                (lk ? '<span class="ph-lk">🔒</span>' : '') + '<span class="ph-ico">' + o.icon + '</span>' + o.name + '</button>';
        }).join('') + '</div>';
    }
    window.__celebExtraPaint = function (el) {
        if (!el) return;
        var c = myChoice();
        el.innerHTML = '<div class="ph-h" style="margin-top:14px">Confetti</div>' + tiles(CONFETTI, c.confetti, 'data-pc-confetti') +
            '<div class="ph-h">Victory dancers</div>' + tiles(DANCES, c.dance, 'data-pc-dance') +
            '<div class="ph-note">Shown to everyone at the table when you hit 31 or win. ▶ to preview:</div>' +
            '<button type="button" data-pc-preview style="margin-top:6px;padding:6px 12px;border-radius:8px;border:1px solid rgba(251,191,36,0.5);background:#1e293b;color:#fde68a;font-weight:700;cursor:pointer;">▶ Preview celebration</button>';
        if (!el.__pcBound) {
            el.__pcBound = true;
            el.addEventListener('click', function (ev) {
                var t = ev.target.closest && ev.target.closest('[data-pc-confetti],[data-pc-dance],[data-pc-preview]');
                if (!t) return;
                if (t.hasAttribute('data-pc-preview')) { preview(); return; }
                var isC = t.hasAttribute('data-pc-confetti'), id = t.getAttribute(isC ? 'data-pc-confetti' : 'data-pc-dance');
                var o = (isC ? CONFETTI : DANCES).filter(function (x) { return x.id === id; })[0];
                if (!o) return;
                if (!o.free && !prem()) { locked(); return; }
                lsSet(isC ? 'blitz31_confetti' : 'blitz31_dance', id);
                if (typeof window.__celebRepaint === 'function') window.__celebRepaint();
                if (typeof window.__celebSync === 'function') window.__celebSync();
            });
        }
    };
    function preview() {
        if (typeof window.closePremiumHub === 'function') window.closePremiumHub();
        var sm = document.getElementById('settings-modal'); if (sm) sm.style.display = 'none';
        var n = (typeof window.getActiveUsername === 'function' && window.getActiveUsername()) || 'You';
        if (typeof window.triggerWinnerCelebration === 'function') window.triggerWinnerCelebration(n, 'PREVIEW');
    }

    // ---------- celebrations: whose style? ----------
    function styleFor(name) {
        if (isMe(name)) return myChoice();
        var p = playerByName(name), c = (p && p.celebration) || {};
        return {
            confetti: valid(CONFETTI, c.confetti) ? c.confetti : 'default',
            dance: valid(DANCES, c.dance) ? c.dance : 'default'
        };
    }

    // ---------- confetti engines ----------
    var cv = null, raf = null, stopAt = 0;
    function canvas() {
        if (!cv || !document.body.contains(cv)) {
            cv = document.createElement('canvas');
            cv.id = 'pc-canvas';
            cv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:100000;display:none;';
            document.body.appendChild(cv);
        }
        cv.width = window.innerWidth; cv.height = window.innerHeight;
        return cv;
    }
    function stopFx() { if (raf) cancelAnimationFrame(raf); raf = null; if (cv) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); cv.style.display = 'none'; } }
    function rnd(a, b) { return a + Math.random() * (b - a); }
    function runFx(kind) {
        stopFx();
        var c = canvas(), g = c.getContext('2d'), W = c.width, H = c.height, parts = [], t0 = performance.now(), rockets = [];
        c.style.display = 'block'; stopAt = t0 + 4300;
        function emojiP(ch, n, fromTop) {
            for (var i = 0; i < n; i++) parts.push({ ch: ch[i % ch.length], x: rnd(0, W), y: fromTop ? rnd(-H * 0.6, -20) : H / 2, vx: fromTop ? rnd(-0.6, 0.6) : rnd(-9, 9), vy: fromTop ? rnd(2, 4.5) : rnd(-13, -3), g: fromTop ? 0.02 : 0.22, r: rnd(0, 6.28), vr: rnd(-0.08, 0.08), s: rnd(22, 36), sway: rnd(0, 6.28), a: 1 });
        }
        if (kind === 'cash') emojiP(['💵', '💵', '💸', '💰'], 70, true);
        if (kind === 'hearts') { for (var i = 0; i < 60; i++) parts.push({ ch: ['💖', '❤️', '💕', '💗'][i % 4], x: rnd(0, W), y: H + rnd(10, H * 0.5), vx: rnd(-0.5, 0.5), vy: rnd(-4.5, -2.2), g: -0.005, r: 0, vr: rnd(-0.03, 0.03), s: rnd(20, 34), sway: rnd(0, 6.28), a: 1 }); }
        if (kind === 'suits') { for (var j = 0; j < 140; j++) { var su = ['♠', '♥', '♦', '♣'][j % 4]; parts.push({ txt: su, col: (su === '♥' || su === '♦') ? '#ef4444' : '#f8fafc', x: W / 2, y: H / 2, vx: rnd(-10, 10), vy: rnd(-14, -2), g: 0.24, r: rnd(0, 6.28), vr: rnd(-0.15, 0.15), s: rnd(18, 34), a: 1 }); } }
        if (kind === 'coins') { for (var k = 0; k < 90; k++) parts.push({ coin: true, x: rnd(0, W), y: rnd(-H * 0.7, -20), vx: rnd(-0.8, 0.8), vy: rnd(2.5, 5), g: 0.05, spin: rnd(0, 6.28), vs: rnd(0.12, 0.3), s: rnd(10, 16), a: 1 }); }
        var launched = 0;
        function rocket() { rockets.push({ x: rnd(W * 0.15, W * 0.85), y: H + 10, vy: rnd(-13, -10), top: rnd(H * 0.15, H * 0.45), col: ['#facc15', '#38bdf8', '#f43f5e', '#a855f7', '#22c55e', '#ffffff'][launched % 6] }); launched++; }
        function burst(x, y, col) { for (var i = 0; i < 70; i++) { var ang = rnd(0, 6.28), sp = rnd(1.5, 6.5); parts.push({ spark: true, col: col, x: x, y: y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, g: 0.06, a: 1, fade: rnd(0.008, 0.016) }); } }
        function frame(now) {
            g.clearRect(0, 0, W, H);
            var el = now - t0;
            if (kind === 'fireworks' && launched < 8 && el > launched * 420) rocket();
            rockets = rockets.filter(function (r) {
                r.y += r.vy; r.vy += 0.12;
                g.fillStyle = r.col; g.beginPath(); g.arc(r.x, r.y, 3, 0, 6.28); g.fill();
                if (r.y <= r.top || r.vy >= -1) { burst(r.x, r.y, r.col); return false; }
                return true;
            });
            var fade = now > stopAt - 900;
            parts.forEach(function (p) {
                p.x += p.vx + (p.sway != null ? Math.sin((now / 400) + p.sway) * 0.8 : 0); p.y += p.vy; p.vy += p.g;
                if (p.vr) p.r += p.vr;
                if (p.spark) p.a -= p.fade; else if (fade) p.a -= 0.025;
                if (p.a <= 0) return;
                g.save(); g.globalAlpha = Math.max(0, p.a); g.translate(p.x, p.y);
                if (p.spark) { g.fillStyle = p.col; g.fillRect(-1.5, -1.5, 3, 3); }
                else if (p.coin) {
                    p.spin += p.vs; var w = Math.abs(Math.cos(p.spin)) * p.s;
                    g.fillStyle = '#d4a017'; g.beginPath(); g.ellipse(0, 0, Math.max(1, w), p.s, 0, 0, 6.28); g.fill();
                    g.fillStyle = '#facc15'; g.beginPath(); g.ellipse(0, 0, Math.max(0.5, w * 0.72), p.s * 0.72, 0, 0, 6.28); g.fill();
                } else {
                    g.rotate(p.r || 0); g.font = p.s + 'px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
                    if (p.txt) { g.fillStyle = p.col; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2; g.strokeText(p.txt, 0, 0); g.fillText(p.txt, 0, 0); }
                    else g.fillText(p.ch, 0, 0);
                }
                g.restore();
            });
            if (now < stopAt) raf = requestAnimationFrame(frame); else stopFx();
        }
        raf = requestAnimationFrame(frame);
    }

    function wrapCelebration() {
        var orig = window.triggerWinnerCelebration;
        if (typeof orig !== 'function') return false;
        if (orig.__pcWrapped) return true;
        var w = function (winnerName) {
            var st = styleFor(winnerName);
            if (st.dance === 'default') document.body.removeAttribute('data-cel-dance'); else document.body.setAttribute('data-cel-dance', st.dance);
            var r = orig.apply(this, arguments);
            var base = document.getElementById('celebration-canvas');
            if (st.confetti !== 'default') {
                if (base) base.style.visibility = 'hidden';
                runFx(st.confetti);
            } else { if (base) base.style.visibility = ''; stopFx(); }
            if (st.dance === 'none' && typeof window.hideCelebrationDancers === 'function') window.hideCelebrationDancers(true);
            return r;
        };
        // keep any flags set by other wrappers (celebSound wraps first)
        Object.keys(orig).forEach(function (k) { try { w[k] = orig[k]; } catch (e) {} });
        w.__pcWrapped = true;
        window.triggerWinnerCelebration = w;
        return true;
    }

    // ---------- custom knock call ----------
    var lastKnockCall = 0;
    function knockPick() {
        var s = snap(); if (!s) return null;
        var who = s.knockedBy || null;
        var id = null;
        if (!who || isMe(who)) {
            id = (typeof window.__celebChoice === 'function') ? window.__celebChoice('knock') : null;
            if (id === 'rec') { var mc = (window.__myCues || {}).knock; return mc ? { cue: mc.token, mine: true } : null; }
        } else {
            var p = playerByName(who); id = p && p.celebration && p.celebration.knock;
            if (id === 'rec') return (p.celebration.knockCue) ? { cue: p.celebration.knockCue, mine: false } : null;
        }
        if (!id || id === 'default' || id === 'none') return null;
        return (typeof SOUNDBOARD_ITEMS !== 'undefined' && SOUNDBOARD_ITEMS[id]) ? id : null;
    }
    function wrapKnock() {
        var sp = window.safePlaySound;
        if (typeof sp !== 'function' || !sp.__cueWrapped && !sp.__csWrapped) return false;
        if (sp.__pkWrapped) return true;
        var w = function (name) {
            if (name === 'knock') {
                var id = knockPick();
                if (id) {
                    var now = Date.now();
                    if (now - lastKnockCall < 2500) return;
                    lastKnockCall = now;
                    if (id.cue) {
                        if (typeof window.playRecordedCue === 'function' && window.playRecordedCue(id.cue, id.mine)) return;
                        lastKnockCall = 0; return sp.apply(this, arguments);   // recordings muted / unavailable -> normal knock
                    }
                    if (typeof window.playSoundboardEffect === 'function') window.playSoundboardEffect(id);
                    return;
                }
            }
            return sp.apply(this, arguments);
        };
        Object.keys(sp).forEach(function (k) { try { w[k] = sp[k]; } catch (e) {} });
        w.__pkWrapped = true;
        window.safePlaySound = w;
        window.playSound = w;
        window.triggerAudioCue = w;
        window.speakKnockedCue = function () { w('knock'); };
        return true;
    }

    // ---------- emotes ----------
    var aim = null, aimTimer = null;
    function seatEl(name) {
        var els = document.querySelectorAll('[data-player-username]');
        for (var i = 0; i < els.length; i++) if (lower(els[i].getAttribute('data-player-username')) === lower(name) && els[i].offsetParent) return els[i];
        return null;
    }
    function pointFor(name) {
        var el = seatEl(name);
        if (!el && isMe(name)) el = document.getElementById('my-cards-container');
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, el: el };
    }
    function animateEmote(d) {
        var a = pointFor(d.from) || { x: window.innerWidth / 2, y: window.innerHeight };
        var b = pointFor(d.to); if (!b) return;
        var e = document.createElement('div');
        e.className = 'pc-emote'; e.textContent = d.emote;
        document.body.appendChild(e);
        var mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 120;
        var kf = [];
        for (var i = 0; i <= 10; i++) {
            var t = i / 10, x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x, y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * b.y;
            kf.push({ transform: 'translate(' + (x - 20) + 'px,' + (y - 20) + 'px) rotate(' + (t * 540) + 'deg) scale(' + (0.8 + t * 0.5) + ')', offset: t });
        }
        var anim = e.animate ? e.animate(kf, { duration: 750, easing: 'ease-in', fill: 'forwards' }) : null;
        var land = function () {
            e.classList.add('pc-splat');
            e.style.transform = 'translate(' + (b.x - 20) + 'px,' + (b.y - 20) + 'px)';
            if (b.el) { b.el.classList.remove('pc-hit'); void b.el.offsetWidth; b.el.classList.add('pc-hit'); setTimeout(function () { b.el && b.el.classList.remove('pc-hit'); }, 600); }
            setTimeout(function () { e.remove(); }, 900);
        };
        if (anim) anim.onfinish = land; else setTimeout(land, 750);
        if (typeof window.playSoundboardEffect === 'function' && Math.random() < 0) window.playSoundboardEffect('whoosh');
    }
    window.__emoteThrown = animateEmote;   // tests

    function stopAim() {
        aim = null; document.body.classList.remove('pc-aiming');
        var b = document.getElementById('pc-aim-banner'); if (b) b.remove();
        if (aimTimer) clearTimeout(aimTimer); aimTimer = null;
    }
    function startAim(emote) {
        aim = emote;
        document.body.classList.add('pc-aiming');
        var b = document.getElementById('pc-aim-banner') || document.createElement('div');
        b.id = 'pc-aim-banner';
        b.innerHTML = '<span>' + emote + ' Tap a player to throw</span><button type="button" id="pc-aim-cancel">Cancel</button>';
        document.body.appendChild(b);
        if (aimTimer) clearTimeout(aimTimer);
        aimTimer = setTimeout(stopAim, 10000);
    }
    document.addEventListener('click', function (ev) {
        if (!aim) return;
        if (ev.target.closest && ev.target.closest('#pc-aim-cancel')) { stopAim(); return; }
        var seat = ev.target.closest && ev.target.closest('[data-player-username]');
        ev.stopPropagation(); ev.preventDefault();
        if (!seat) return;
        var to = seat.getAttribute('data-player-username');
        if (isMe(to)) return;
        if (typeof window.sendSocket === 'function') window.sendSocket({ type: 'THROW_EMOTE', to: to, emote: aim });
        stopAim();
    }, true);

    function openEmotePicker() {
        var pop = document.getElementById('pc-emote-pop');
        if (pop) { pop.remove(); return; }
        pop = document.createElement('div');
        pop.id = 'pc-emote-pop';
        pop.innerHTML = '<div class="pc-ep-h">💎 Throw at a player</div><div class="pc-ep-g">' +
            EMOTES.map(function (e) { return '<button type="button" data-pc-emote="' + e + '">' + e + '</button>'; }).join('') + '</div>';
        document.body.appendChild(pop);
        pop.addEventListener('click', function (ev) {
            var b = ev.target.closest && ev.target.closest('[data-pc-emote]');
            if (!b) return;
            ev.stopPropagation();
            pop.remove();
            startAim(b.getAttribute('data-pc-emote'));
        });
    }
    window.openEmotePicker = openEmotePicker;
    // a 🎯 button at the end of the 😀 reactions bar (Premium only; hidden otherwise)
    function ensureThrowButton() {
        var pop = document.getElementById('reaction-popover-menu');
        if (!pop) return;
        var btn = document.getElementById('pc-throw-btn');
        if (!prem()) { if (btn) btn.remove(); return; }
        if (btn) return;
        btn = document.createElement('button');
        btn.type = 'button'; btn.id = 'pc-throw-btn'; btn.title = 'Throw at a player'; btn.textContent = '🎯';
        btn.onclick = function (ev) { ev.stopPropagation(); pop.style.display = 'none'; openEmotePicker(); };
        pop.appendChild(btn);
    }
    document.addEventListener('click', function (ev) {
        var p = document.getElementById('pc-emote-pop');
        if (p && !p.contains(ev.target) && !(ev.target.closest && ev.target.closest('#pc-throw-btn'))) p.remove();
    });

    // socket listener (network.js ignores unknown message types)
    var hooked = null;
    function watchSocket() {
        var ws = window.appGlobals && window.appGlobals.ws;
        if (!ws || ws === hooked) return;
        hooked = ws;
        ws.addEventListener('message', function (ev) {
            var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
            if (d && d.type === 'EMOTE_THROWN') { var s = snap(); if (!s || !d.code || s.code === d.code) animateEmote(d); }
        });
    }

    var tries = 0, t = setInterval(function () {
        var a = wrapCelebration(), b = wrapKnock();
        if ((a && b) || ++tries > 150) clearInterval(t);
    }, 200);
    setInterval(function () { watchSocket(); ensureThrowButton(); }, 500);
})();
