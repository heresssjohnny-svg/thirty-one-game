// public/js/premiumFlair.js - Premium "profile flair" that the whole table sees.
//   1. Avatar + seat frame      2. Name colour + title
//   3. Entrance effect when you sit down      4. Knock animation and 31 animation
// Picks live in localStorage (blitz31_flair), go to the server with SET_FLAIR (server/flair.js checks Premium) and
// come back for every player in the snapshot as players[].flair. A "✨ Profile" tab in the Premium panel edits them.
(function () {
    'use strict';
    if (window.__premiumFlairLoaded) return;
    window.__premiumFlairLoaded = true;

    var AVATARS = ['😎', '🤠', '🦈', '🦁', '🐺', '🦊', '🐼', '🐸', '🦉', '🦅', '🐉', '👑', '💀', '👽', '🤖', '🎩', '🧙', '🥷', '🤡', '👻', '🔥', '💎', '🃏', '🎲'];
    var FRAMES = [{ id: 'none', name: 'None', icon: '▫️', free: true }, { id: 'gold', name: 'Gold', icon: '🥇' }, { id: 'neon', name: 'Neon', icon: '💠' },
        { id: 'fire', name: 'Fire', icon: '🔥' }, { id: 'ice', name: 'Ice', icon: '❄️' }, { id: 'rainbow', name: 'Rainbow', icon: '🌈' }];
    var COLORS = [{ id: 'default', name: 'White', hex: '#f8fafc', free: true }, { id: 'gold', name: 'Gold', hex: '#fbbf24' }, { id: 'red', name: 'Red', hex: '#f87171' },
        { id: 'blue', name: 'Blue', hex: '#60a5fa' }, { id: 'green', name: 'Green', hex: '#4ade80' }, { id: 'pink', name: 'Pink', hex: '#f472b6' },
        { id: 'purple', name: 'Purple', hex: '#c084fc' }, { id: 'rainbow', name: 'Rainbow', hex: 'rainbow' }];
    var TITLES = [{ id: 'none', name: 'No title', free: true }, { id: 'shark', name: 'Card Shark' }, { id: 'king', name: '31 King' }, { id: 'queen', name: '31 Queen' },
        { id: 'highroller', name: 'High Roller' }, { id: 'bluff', name: 'Bluff Master' }, { id: 'lucky', name: 'Lucky Draw' }, { id: 'knock', name: 'Knock Boss' },
        { id: 'ice', name: 'Ice Cold' }, { id: 'dealer', name: 'The Dealer' }, { id: 'legend', name: 'Legend' }, { id: 'rookie', name: 'Rookie' },
        { id: 'boss', name: 'Big Boss' }, { id: 'closer', name: 'The Closer' }];
    var ENTRANCES = [{ id: 'none', name: 'None', icon: '🚪', free: true }, { id: 'spotlight', name: 'Spotlight', icon: '🔦' }, { id: 'thunder', name: 'Thunder', icon: '⚡' },
        { id: 'royal', name: 'Royal', icon: '👑' }, { id: 'money', name: 'Money', icon: '💵' }];
    var KNOCKFX = [{ id: 'default', name: 'Standard', icon: '✊', free: true }, { id: 'fist', name: 'Fist slam', icon: '👊' }, { id: 'lightning', name: 'Lightning', icon: '⚡' },
        { id: 'shockwave', name: 'Shockwave', icon: '🌀' }];
    var HITFX = [{ id: 'default', name: 'Standard', icon: '🎉', free: true }, { id: 'fire', name: 'On fire', icon: '🔥' }, { id: 'gold', name: 'Gold burst', icon: '🌟' },
        { id: 'storm', name: 'Storm', icon: '🌩️' }];
    var DEF = { avatar: '', frame: 'none', color: 'default', title: 'none', entrance: 'none', knockFx: 'default', hitFx: 'default' };
    var LS = 'blitz31_flair';

    function prem() { return !!window.__isPremium; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function low(s) { return String(s || '').trim().toLowerCase(); }
    function snap() { return window.appGlobals && window.appGlobals.latestLobbySnapshot; }
    function has(list, id) { return list.some(function (x) { return (x.id || x) === id; }); }
    function titleText(id) { var t = TITLES.filter(function (x) { return x.id === id; })[0]; return t && t.id !== 'none' ? t.name : ''; }
    function reduce() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

    function stored() {
        var o = {}; try { o = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) {}
        return {
            avatar: AVATARS.indexOf(o.avatar) >= 0 ? o.avatar : '',
            frame: has(FRAMES, o.frame) ? o.frame : 'none', color: has(COLORS, o.color) ? o.color : 'default',
            title: has(TITLES, o.title) ? o.title : 'none', entrance: has(ENTRANCES, o.entrance) ? o.entrance : 'none',
            knockFx: has(KNOCKFX, o.knockFx) ? o.knockFx : 'default', hitFx: has(HITFX, o.hitFx) ? o.hitFx : 'default'
        };
    }
    function save(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {} }
    function myFlair() { return prem() ? stored() : Object.assign({}, DEF); }
    function isPlain(f) { return !f || Object.keys(DEF).every(function (k) { return (f[k] || DEF[k]) === DEF[k]; }); }
    function flairOf(p) {
        if (!p || p.isBot) return null;
        if (p.isMe) { var m = myFlair(); return isPlain(m) ? null : m; }
        return isPlain(p.flair) ? null : Object.assign({}, DEF, p.flair);
    }
    function playerByName(name) { var s = snap(); return s && (s.players || []).find(function (p) { return p && low(p.username) === low(name); }); }

    // ---------- styles ----------
    (function css() {
        var st = document.createElement('style'); st.id = 'pfl-css';
        st.textContent =
            '.pfl-top{display:flex;flex-direction:column;align-items:center;pointer-events:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:-4px;z-index:1;}' +
            /* the top seat sits under the toolbar: put its avatar beside the name instead */
            '.seat-3 > .pfl-top{bottom:auto;top:-2px;left:auto;right:100%;transform:none;margin:0 3px 0 0;}' +
            '.pfl-av{width:24px;height:24px;border-radius:50%;background:#0b1220;border:2px solid rgba(212,175,55,.6);display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;box-shadow:0 2px 6px rgba(0,0,0,.6);}' +
            '.pfl-title{margin-top:-2px;padding:0 5px;border-radius:999px;background:linear-gradient(90deg,#78350f,#b45309);color:#fde68a;font-size:.5rem;font-weight:800;letter-spacing:.3px;white-space:nowrap;text-transform:uppercase;border:1px solid rgba(251,191,36,.6);}' +
            /* frames: on the avatar ring and the name pod */
            '.pfl-f-gold .pfl-av,.pfl-f-gold .seat-name-area{border-color:#fbbf24!important;box-shadow:0 0 8px 1px rgba(251,191,36,.75),0 2px 8px rgba(0,0,0,.65)!important;}' +
            '.pfl-f-neon .pfl-av,.pfl-f-neon .seat-name-area{border-color:#22d3ee!important;box-shadow:0 0 9px 2px rgba(34,211,238,.8),inset 0 0 6px rgba(34,211,238,.35)!important;animation:pflNeon 1.6s ease-in-out infinite;}' +
            '.pfl-f-fire .pfl-av,.pfl-f-fire .seat-name-area{border-color:#fb923c!important;animation:pflFire 1.1s ease-in-out infinite;}' +
            '.pfl-f-ice .pfl-av,.pfl-f-ice .seat-name-area{border-color:#bae6fd!important;box-shadow:0 0 8px 2px rgba(186,230,253,.7),inset 0 0 8px rgba(125,211,252,.35)!important;}' +
            '.pfl-f-rainbow .pfl-av,.pfl-f-rainbow .seat-name-area{animation:pflRainbow 3s linear infinite;border-color:#f43f5e!important;}' +
            '@keyframes pflNeon{50%{box-shadow:0 0 14px 4px rgba(34,211,238,.95),inset 0 0 8px rgba(34,211,238,.5);}}' +
            '@keyframes pflFire{0%,100%{box-shadow:0 -1px 8px 1px rgba(251,146,60,.8),0 0 3px rgba(239,68,68,.8);}50%{box-shadow:0 -3px 14px 3px rgba(250,204,21,.9),0 0 6px rgba(239,68,68,.9);}}' +
            '@keyframes pflRainbow{0%{border-color:#f43f5e;box-shadow:0 0 9px 2px rgba(244,63,94,.7);}25%{border-color:#facc15;box-shadow:0 0 9px 2px rgba(250,204,21,.7);}50%{border-color:#22c55e;box-shadow:0 0 9px 2px rgba(34,197,94,.7);}75%{border-color:#3b82f6;box-shadow:0 0 9px 2px rgba(59,130,246,.7);}100%{border-color:#f43f5e;box-shadow:0 0 9px 2px rgba(244,63,94,.7);}}' +
            /* name colours */
            '.pfl-c-gold .seat-name-area b{color:#fbbf24!important;}.pfl-c-red .seat-name-area b{color:#f87171!important;}.pfl-c-blue .seat-name-area b{color:#60a5fa!important;}' +
            '.pfl-c-green .seat-name-area b{color:#4ade80!important;}.pfl-c-pink .seat-name-area b{color:#f472b6!important;}.pfl-c-purple .seat-name-area b{color:#c084fc!important;}' +
            '.pfl-c-rainbow .seat-name-area b,.pfl-rb{background:linear-gradient(90deg,#f43f5e,#facc15,#22c55e,#3b82f6,#a855f7,#f43f5e);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent!important;-webkit-text-fill-color:transparent;animation:pflText 3s linear infinite;}' +
            '@keyframes pflText{to{background-position:200% 0;}}' +
            /* effects layer */
            '#pfl-fx{position:fixed;inset:0;z-index:9600;pointer-events:none;overflow:hidden;}' +
            '.pfl-flash{position:absolute;inset:0;background:#fff;opacity:0;animation:pflFlash .5s ease-out;}' +
            '@keyframes pflFlash{0%{opacity:.75;}30%{opacity:.1;}45%{opacity:.5;}100%{opacity:0;}}' +
            '.pfl-bolt{position:absolute;left:0;top:0;width:100%;height:100%;animation:pflBolt .7s ease-out forwards;filter:drop-shadow(0 0 6px #7dd3fc) drop-shadow(0 0 14px #38bdf8);}' +
            '@keyframes pflBolt{0%{opacity:1;}60%{opacity:1;}100%{opacity:0;}}' +
            '.pfl-ring{position:absolute;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:4px solid #fbbf24;opacity:0;animation:pflRing 1s ease-out forwards;}' +
            '@keyframes pflRing{0%{transform:scale(.3);opacity:.95;}100%{transform:scale(9);opacity:0;}}' +
            '.pfl-fist{position:absolute;font-size:120px;line-height:1;margin:-60px 0 0 -60px;width:120px;height:120px;text-align:center;animation:pflFist .9s cubic-bezier(.6,0,.9,.4) forwards;filter:drop-shadow(0 14px 14px rgba(0,0,0,.6));}' +
            '@keyframes pflFist{0%{transform:scale(3.4) translateY(-60px);opacity:0;}28%{transform:scale(1);opacity:1;}40%{transform:scale(1.12);}52%{transform:scale(1);}80%{opacity:1;}100%{transform:scale(.9);opacity:0;}}' +
            '.pfl-shake{animation:pflShake .45s linear;}' +
            '@keyframes pflShake{0%,100%{transform:translate(0,0);}20%{transform:translate(-7px,5px);}40%{transform:translate(6px,-4px);}60%{transform:translate(-4px,3px);}80%{transform:translate(3px,-2px);}}' +
            '.pfl-big{position:absolute;margin:0;transform:translate(-50%,-50%);font-weight:900;font-size:min(34vw,170px);line-height:1;letter-spacing:-4px;animation:pflBig 1.9s ease-out forwards;}' +
            '@keyframes pflBig{0%{transform:translate(-50%,-50%) scale(.2);opacity:0;}18%{transform:translate(-50%,-50%) scale(1.15);opacity:1;}30%{transform:translate(-50%,-50%) scale(1);}80%{opacity:1;}100%{transform:translate(-50%,-50%) scale(1.25);opacity:0;}}' +
            '.pfl-big.fire{background:linear-gradient(0deg,#b91c1c,#f97316 45%,#fde047);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;filter:drop-shadow(0 0 12px #f97316) drop-shadow(0 -6px 18px #ef4444);}' +
            '.pfl-big.gold{background:linear-gradient(180deg,#fef9c3,#fbbf24 50%,#b45309);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;filter:drop-shadow(0 0 14px #fbbf24);}' +
            '.pfl-big.storm{color:#e0f2fe;text-shadow:0 0 12px #38bdf8,0 0 30px #0ea5e9,0 0 4px #fff;}' +
            '.pfl-rays{position:absolute;width:150vmax;height:150vmax;margin:-75vmax 0 0 -75vmax;background:repeating-conic-gradient(rgba(251,191,36,.38) 0 9deg,transparent 9deg 18deg);border-radius:50%;-webkit-mask-image:radial-gradient(circle,#000 0,transparent 42%);mask-image:radial-gradient(circle,#000 0,transparent 42%);animation:pflRays 1.9s linear forwards;}' +
            '@keyframes pflRays{0%{transform:rotate(0) scale(.3);opacity:0;}15%{opacity:1;}80%{opacity:1;}100%{transform:rotate(70deg) scale(1);opacity:0;}}' +
            '.pfl-p{position:absolute;font-size:26px;line-height:1;will-change:transform,opacity;}' +
            '@keyframes pflRise{0%{transform:translateY(0) scale(.6);opacity:0;}15%{opacity:1;}100%{transform:translateY(-190px) scale(1.25);opacity:0;}}' +
            '@keyframes pflFall{0%{transform:translateY(-120px) rotate(0);opacity:0;}15%{opacity:1;}100%{transform:translateY(60px) rotate(200deg);opacity:0;}}' +
            '.pfl-spot{position:absolute;width:260px;height:260px;margin:-130px 0 0 -130px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.55) 0,rgba(253,230,138,.28) 35%,transparent 68%);animation:pflSpot 2.2s ease-in-out forwards;}' +
            '@keyframes pflSpot{0%{transform:scale(.2);opacity:0;}20%{transform:scale(1);opacity:1;}40%{transform:scale(.85);}60%{transform:scale(1);opacity:1;}100%{transform:scale(1.15);opacity:0;}}' +
            '.pfl-crown{position:absolute;font-size:40px;margin:-20px 0 0 -20px;animation:pflCrown 2s ease-out forwards;}' +
            '@keyframes pflCrown{0%{transform:translateY(-150px) rotate(-25deg);opacity:0;}35%{transform:translateY(-34px) rotate(0);opacity:1;}45%{transform:translateY(-44px);}55%{transform:translateY(-34px);}85%{opacity:1;}100%{transform:translateY(-34px);opacity:0;}}' +
            '.pfl-enter{position:absolute;left:50%;top:calc(58px + env(safe-area-inset-top));transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:6px 16px 6px 8px;border-radius:999px;background:linear-gradient(90deg,rgba(15,23,42,.96),rgba(30,41,59,.96));border:1.5px solid #fbbf24;box-shadow:0 6px 22px rgba(0,0,0,.6),0 0 16px rgba(251,191,36,.45);white-space:nowrap;max-width:92vw;animation:pflEnter 2.6s ease forwards;}' +
            '.pfl-enter .pfl-av{width:34px;height:34px;font-size:20px;}' +
            '.pfl-enter b{font-size:1rem;color:#f8fafc;}.pfl-enter small{display:block;font-size:.66rem;color:#fbbf24;font-weight:800;letter-spacing:.4px;text-transform:uppercase;}' +
            '@keyframes pflEnter{0%{transform:translateX(-50%) translateY(-70px) scale(.8);opacity:0;}14%{transform:translateX(-50%) translateY(0) scale(1.05);opacity:1;}22%{transform:translateX(-50%) scale(1);}82%{opacity:1;transform:translateX(-50%);}100%{transform:translateX(-50%) translateY(-30px);opacity:0;}}' +
            /* profile tab */
            '.pfl-prev{display:flex;justify-content:center;padding:58px 0 6px;}.pfl-prev .seat{position:relative;transform:none;top:auto;left:auto;}.pfl-prev .seat-name-area{max-width:none;font-size:.8rem;padding:4px 12px;}.pfl-prev .seat-name-area b{font-size:.9rem;}' +
            '.pfl-prev .pfl-av{width:40px;height:40px;font-size:24px;}.pfl-prev .pfl-title{font-size:.62rem;}' +
            '.pfl-avgrid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;}.pfl-avgrid button{aspect-ratio:1;border-radius:10px;border:1.5px solid #334155;background:#1e293b;font-size:1.25rem;cursor:pointer;padding:0;position:relative;}' +
            '.pfl-avgrid button.on{border-color:#fbbf24;box-shadow:0 0 0 2px rgba(251,191,36,.4);}.pfl-avgrid button.locked{opacity:.55;}' +
            '.pfl-chips{display:flex;flex-wrap:wrap;gap:6px;}.pfl-chips button{padding:6px 10px;border-radius:999px;border:1.5px solid #334155;background:#1e293b;color:#e2e8f0;font-weight:700;font-size:.78rem;cursor:pointer;}' +
            '.pfl-chips button.on{border-color:#fbbf24;box-shadow:0 0 0 2px rgba(251,191,36,.4);}.pfl-chips button.locked{opacity:.55;}' +
            '.pfl-try{margin-left:8px;padding:2px 9px;border-radius:999px;border:1px solid rgba(251,191,36,.5);background:#1e293b;color:#fde68a;font-weight:700;font-size:.7rem;cursor:pointer;}' +
            '@media (prefers-reduced-motion:reduce){.pfl-f-neon .pfl-av,.pfl-f-neon .seat-name-area,.pfl-f-fire .pfl-av,.pfl-f-fire .seat-name-area,.pfl-f-rainbow .pfl-av,.pfl-f-rainbow .seat-name-area,.pfl-c-rainbow .seat-name-area b,.pfl-rb{animation:none!important;}}';
        document.head.appendChild(st);
    })();

    // ---------- 1 + 2: avatar, frame, colour, title on the seats ----------
    function topHtml(f) {
        if (!f || (!f.avatar && f.title === 'none')) return '';
        return '<div class="pfl-top">' + (f.avatar ? '<div class="pfl-av">' + esc(f.avatar) + '</div>' : '') +
            (titleText(f.title) ? '<div class="pfl-title">' + esc(titleText(f.title)) + '</div>' : '') + '</div>';
    }
    function dress(seat, f) {
        var want = f ? [f.avatar, f.frame, f.color, f.title].join('|') : '';
        if (seat.getAttribute('data-pfl') === want) return;
        seat.setAttribute('data-pfl', want);
        [].slice.call(seat.classList).forEach(function (c) { if (c.indexOf('pfl-f-') === 0 || c.indexOf('pfl-c-') === 0) seat.classList.remove(c); });
        var old = seat.querySelector(':scope > .pfl-top'); if (old) old.remove();
        if (!f) return;
        if (f.frame !== 'none') seat.classList.add('pfl-f-' + f.frame);
        if (f.color !== 'default') seat.classList.add('pfl-c-' + f.color);
        var h = topHtml(f);
        if (h) seat.insertAdjacentHTML('afterbegin', h);
    }
    function decorate() {
        var s = snap(); if (!s) return;
        var by = {}; (s.players || []).forEach(function (p) { if (p) by[low(p.username)] = p; });
        document.querySelectorAll('.seat[data-player-username]').forEach(function (seat) {
            dress(seat, flairOf(by[low(seat.getAttribute('data-player-username'))]));
        });
    }

    // ---------- effects ----------
    function layer() {
        var l = document.getElementById('pfl-fx');
        if (!l) { l = document.createElement('div'); l.id = 'pfl-fx'; document.body.appendChild(l); }
        return l;
    }
    function add(html, ms) {
        var d = document.createElement('div'); d.innerHTML = html; var el = d.firstChild;
        layer().appendChild(el); setTimeout(function () { el.remove(); }, ms || 2200); return el;
    }
    function tableCenter() {
        var t = document.getElementById('table-oval-container') || document.querySelector('.table-container');
        if (!t) return { x: window.innerWidth / 2, y: window.innerHeight * 0.4 };
        var r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function seatPoint(name) {
        var el = null;
        document.querySelectorAll('.seat[data-player-username]').forEach(function (s) { if (low(s.getAttribute('data-player-username')) === low(name)) el = s; });
        if (!el) return tableCenter();
        var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function shake() {
        var t = document.getElementById('game-view') || document.getElementById('table-oval-container'); if (!t || reduce()) return;
        t.classList.remove('pfl-shake'); void t.offsetWidth; t.classList.add('pfl-shake');
        setTimeout(function () { t.classList.remove('pfl-shake'); }, 500);
    }
    function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
    function flash() { if (!reduce()) add('<div class="pfl-flash"></div>', 600); }
    function bolt(to, fromX) {
        var x = fromX == null ? to.x + (Math.random() - 0.5) * 120 : fromX, y = -10, pts = [x + ',' + y], steps = 7;
        for (var i = 1; i <= steps; i++) {
            var t = i / steps;
            pts.push((x + (to.x - x) * t + (i < steps ? (Math.random() - 0.5) * 46 : 0)).toFixed(1) + ',' + (y + (to.y - y) * t).toFixed(1));
        }
        add('<svg class="pfl-bolt" xmlns="http://www.w3.org/2000/svg"><polyline points="' + pts.join(' ') + '" fill="none" stroke="#e0f2fe" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>' +
            '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>', 800);
    }
    function rings(at, n, col) {
        for (var i = 0; i < n; i++) (function (i) {
            setTimeout(function () { add('<div class="pfl-ring" style="left:' + at.x + 'px;top:' + at.y + 'px;' + (col ? 'border-color:' + col + ';' : '') + '"></div>', 1100); }, i * 170);
        })(i);
    }
    function particles(chars, n, at, spread, anim, dur) {
        for (var i = 0; i < n; i++) {
            var x = at.x + (Math.random() - 0.5) * spread, y = at.y + (Math.random() - 0.5) * 30, d = (Math.random() * 0.6).toFixed(2);
            add('<div class="pfl-p" style="left:' + x + 'px;top:' + y + 'px;animation:' + anim + ' ' + dur + 'ms ease-out ' + d + 's both;">' + chars[i % chars.length] + '</div>', dur + 800);
        }
    }
    function sfx(file, vol) {
        try {
            if (localStorage.getItem('blitz31_sfx_enabled') === 'false') return;
            var t = document.getElementById('setting-sfx'); if (t && !t.checked) return;
            var v = (typeof window.getSfxVolume === 'function') ? window.getSfxVolume() : 1; if (v <= 0) return;
            var a = new Audio('/mp3s/' + file); a.volume = Math.max(0, Math.min(1, v * (vol || 0.6)));
            var p = a.play(); if (p && p.catch) p.catch(function () {});
        } catch (e) {}
    }

    // 4a. knock animations
    function knockFx(kind, name) {
        var c = tableCenter();
        if (kind === 'fist') {
            add('<div class="pfl-fist" style="left:' + c.x + 'px;top:' + c.y + 'px;">👊</div>', 1000);
            setTimeout(function () { rings(c, 2); shake(); buzz([60, 30, 90]); }, 250);
        } else if (kind === 'lightning') {
            flash(); bolt(c); setTimeout(function () { bolt(c); }, 120); rings(c, 1, '#7dd3fc'); shake(); buzz(80);
        } else if (kind === 'shockwave') {
            rings(seatPoint(name), 4); buzz(50);
        }
    }
    // 4b. 31 animations
    function hitFx(kind) {
        var c = tableCenter();
        if (kind === 'fire') {
            add('<div class="pfl-big fire" style="left:' + c.x + 'px;top:' + c.y + 'px;">31</div>', 2000);
            particles(['🔥'], 16, { x: c.x, y: c.y + 70 }, 260, 'pflRise', 1500);
        } else if (kind === 'gold') {
            add('<div class="pfl-rays" style="left:' + c.x + 'px;top:' + c.y + 'px;"></div>', 2000);
            add('<div class="pfl-big gold" style="left:' + c.x + 'px;top:' + c.y + 'px;">31</div>', 2000);
            particles(['✨', '⭐', '🌟'], 14, c, 300, 'pflRise', 1500);
        } else if (kind === 'storm') {
            flash(); bolt(c, c.x - 110); setTimeout(function () { flash(); bolt(c, c.x + 120); }, 220); setTimeout(function () { bolt(c); }, 420);
            add('<div class="pfl-big storm" style="left:' + c.x + 'px;top:' + c.y + 'px;">31</div>', 2000);
            shake();
        } else return;
        buzz([40, 30, 120]);
    }
    // 3. entrance
    function entranceFx(name, f) {
        var kind = f.entrance; if (!kind || kind === 'none') return;
        var at = seatPoint(name);
        var nameCls = f.color === 'rainbow' ? ' class="pfl-rb"' : '';
        var col = (COLORS.filter(function (x) { return x.id === f.color; })[0] || {}).hex;
        add('<div class="pfl-enter"><div class="pfl-av">' + esc(f.avatar || '⭐') + '</div><div><b' + nameCls + (col && col !== 'rainbow' ? ' style="color:' + col + '"' : '') + '>' + esc(name) + '</b>' +
            '<small>' + esc(titleText(f.title) ? titleText(f.title) + ' · ' : '') + 'has entered</small></div></div>', 2700);
        if (kind === 'spotlight') { add('<div class="pfl-spot" style="left:' + at.x + 'px;top:' + at.y + 'px;"></div>', 2300); sfx('Premium-whoosh.mp3', 0.5); }
        else if (kind === 'thunder') { flash(); bolt(at); setTimeout(function () { bolt(at); }, 140); rings(at, 1, '#7dd3fc'); sfx('Premium-boom.mp3', 0.45); }
        else if (kind === 'royal') { add('<div class="pfl-crown" style="left:' + at.x + 'px;top:' + at.y + 'px;">👑</div>', 2100); particles(['✨'], 8, at, 110, 'pflRise', 1300); sfx('Premium-tada.mp3', 0.45); }
        else if (kind === 'money') { particles(['💵', '💸', '💰'], 14, at, 150, 'pflFall', 1500); sfx('Cash.mp3', 0.5); }
    }
    window.__flairFx = { knock: knockFx, hit: hitFx, entrance: entranceFx };   // tests / previews

    // ---------- triggers ----------
    var curCode = null, seen = {}, lastKnock = null;
    function onSnap(s) {
        if (!s || !s.code) { curCode = null; seen = {}; lastKnock = null; return; }
        var now = Date.now(), present = {};
        var fresh = s.code !== curCode;
        if (fresh) { curCode = s.code; seen = {}; lastKnock = s.knockedBy || null; }
        (s.players || []).forEach(function (p) {
            if (!p || p.isBot) return;
            var k = low(p.username); present[k] = true;
            // players already seated when I arrive make no entrance; I do
            if (!seen[k]) seen[k] = { at: now, played: fresh && !p.isMe };
            var e = seen[k];
            if (!e.played) {
                if (now - e.at > 8000) e.played = true;
                else { var f = flairOf(p); if (f && f.entrance !== 'none') { e.played = true; entranceFx(p.username, f); } }
            }
        });
        Object.keys(seen).forEach(function (k) { if (!present[k]) delete seen[k]; });
        // knock
        var kb = s.knockedBy || null;
        if (kb && kb !== lastKnock) { var kf = flairOf(playerByName(kb)); if (kf && kf.knockFx !== 'default') knockFx(kf.knockFx, kb); }
        lastKnock = kb;
        decorate();
    }
    var wrapped = false;
    function wrap() {
        var o = window.updateUIFromLobby;
        if (wrapped || typeof o !== 'function') return;
        var w = function (s) { var r = o.apply(this, arguments); try { onSnap(s); } catch (e) {} return r; };
        window.updateUIFromLobby = w; wrapped = true;
    }
    var hitWrapped = false;
    function wrapHit() {
        var o = window.trigger31Celebration;
        if (hitWrapped || typeof o !== 'function') return;
        window.trigger31Celebration = function (name) {
            var r = o.apply(this, arguments);
            try { var f = flairOf(playerByName(name)); if (f && f.hitFx !== 'default') hitFx(f.hitFx); } catch (e) {}
            return r;
        };
        hitWrapped = true;
    }
    wrap(); wrapHit();
    var tries = setInterval(function () { wrap(); wrapHit(); if (wrapped && hitWrapped) clearInterval(tries); }, 400);

    // keep the server's copy current (also after reconnects / when Premium status arrives)
    var lastSent = 0;
    function sync(force) {
        var s = snap(); if (!s) return;
        var me = (s.players || []).find(function (p) { return p && p.isMe && !p.isBot; }); if (!me) return;
        var want = myFlair(), have = Object.assign({}, DEF, me.flair || {});
        var same = Object.keys(DEF).every(function (k) { return want[k] === have[k]; });
        if (same) return;
        if (!force && Date.now() - lastSent < 4000) return;
        lastSent = Date.now();
        if (typeof window.sendSocket === 'function') window.sendSocket(Object.assign({ type: 'SET_FLAIR' }, want));
    }
    setInterval(function () { sync(false); decorate(); }, 1000);

    // ---------- ✨ Profile tab ----------
    function chips(list, cur, attr, swatch) {
        return '<div class="pfl-chips">' + list.map(function (o) {
            var lk = !o.free && !prem();
            var sw = swatch ? '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px;background:' +
                (o.hex === 'rainbow' ? 'linear-gradient(90deg,#f43f5e,#facc15,#22c55e,#3b82f6)' : o.hex) + ';"></span>' : (o.icon ? o.icon + ' ' : '');
            return '<button type="button" class="' + (cur === o.id ? 'on' : '') + (lk ? ' locked' : '') + '" ' + attr + '="' + o.id + '">' + (lk ? '🔒 ' : '') + sw + esc(o.name) + '</button>';
        }).join('') + '</div>';
    }
    function render(el) {
        var f = prem() ? stored() : Object.assign({}, DEF);
        var name = (typeof window.getActiveUsername === 'function' && window.getActiveUsername()) || 'You';
        var cls = 'seat' + (f.frame !== 'none' ? ' pfl-f-' + f.frame : '') + (f.color !== 'default' ? ' pfl-c-' + f.color : '');
        el.innerHTML =
            (prem() ? '' : '<div class="ph-note" style="margin-top:0">🔒 Premium: stand out at the table. Everyone sees your avatar, frame, title and effects.</div>') +
            '<div class="pfl-prev"><div class="' + cls + '">' + topHtml(f) + '<div class="seat-name-area"><b>' + esc(name) + '</b><br>Lives: 3 | Wager: $5</div></div></div>' +
            '<div class="ph-h">Avatar</div><div class="pfl-avgrid">' +
            '<button type="button" data-pfl-avatar="" class="' + (!f.avatar ? 'on' : '') + '" title="No avatar">🚫</button>' +
            AVATARS.map(function (a) { return '<button type="button" data-pfl-avatar="' + a + '" class="' + (f.avatar === a ? 'on' : '') + (prem() ? '' : ' locked') + '">' + a + '</button>'; }).join('') + '</div>' +
            '<div class="ph-h">Seat frame</div>' + chips(FRAMES, f.frame, 'data-pfl-frame') +
            '<div class="ph-h">Name colour</div>' + chips(COLORS, f.color, 'data-pfl-color', true) +
            '<div class="ph-h">Title</div>' + chips(TITLES, f.title, 'data-pfl-title') +
            '<div class="ph-h">Entrance <button type="button" class="pfl-try" data-pfl-try="entrance">▶ Try</button></div>' + chips(ENTRANCES, f.entrance, 'data-pfl-entrance') +
            '<div class="ph-h">Knock animation <button type="button" class="pfl-try" data-pfl-try="knock">▶ Try</button></div>' + chips(KNOCKFX, f.knockFx, 'data-pfl-knockFx') +
            '<div class="ph-h">31 animation <button type="button" class="pfl-try" data-pfl-try="hit">▶ Try</button></div>' + chips(HITFX, f.hitFx, 'data-pfl-hitFx') +
            '<div class="ph-note">Everyone at your table sees these. The entrance plays when you sit down; knock and 31 animations play when you knock or hit 31.</div>';
        if (el.__pflBound) return;
        el.__pflBound = true;
        el.addEventListener('click', function (ev) {
            var t = ev.target.closest && ev.target.closest('button'); if (!t) return;
            var tr = t.getAttribute('data-pfl-try');
            if (tr) {
                var cur = prem() ? stored() : DEF;
                if (typeof window.closePremiumHub === 'function') window.closePremiumHub();
                var sm = document.getElementById('settings-modal'); if (sm) sm.style.display = 'none';
                var nm = (typeof window.getActiveUsername === 'function' && window.getActiveUsername()) || 'You';
                setTimeout(function () {
                    if (tr === 'entrance') entranceFx(nm, Object.assign({}, cur, { entrance: cur.entrance === 'none' ? 'spotlight' : cur.entrance }));
                    else if (tr === 'knock') knockFx(cur.knockFx === 'default' ? 'fist' : cur.knockFx, nm);
                    else hitFx(cur.hitFx === 'default' ? 'fire' : cur.hitFx);
                }, 250);
                return;
            }
            var keys = ['avatar', 'frame', 'color', 'title', 'entrance', 'knockFx', 'hitFx'], key = null, val = null;
            keys.forEach(function (k) { if (t.hasAttribute('data-pfl-' + k)) { key = k; val = t.getAttribute('data-pfl-' + k); } });
            if (!key) return;
            var isDefault = val === DEF[key];
            if (!prem() && !isDefault) { if (typeof window.showCenterNotification === 'function') window.showCenterNotification('🔒 Premium option'); return; }
            var o = stored(); o[key] = val; save(o);
            render(el); decorate(); sync(true);
        });
    }
    function addTab() {
        if (typeof window.__phAddTab !== 'function') return false;
        window.__phAddTab('profile', '✨ Profile', render, 8);
        return true;
    }
    if (!addTab()) { var tt = 0, ti = setInterval(function () { if (addTab() || ++tt > 60) clearInterval(ti); }, 250); }
})();
