// public/js/premium.js - Premium cosmetics: extra soundboard sounds, felt colours, card backs.
//  - asks the server who has Premium (/api/premium/me; admin accounts get everything)
//  - synthesizes the premium soundboard sounds with Web Audio (no audio files)
//  - adds a "Table Style" section to Settings (felt colour + card back; locked ones show 🔒)
// Felt and card back are drawn on your own screen only. The premium sounds are checked on the server.
(function () {
    'use strict';
    if (window.__premiumLoaded) return;
    window.__premiumLoaded = true;

    window.__isPremium = false;
    window.__isAdminAccount = false;

    var FELTS = [
        { id: 'classic',  name: 'Classic green', free: true },
        { id: 'midnight', name: 'Midnight blue', a: '#1d3b72', b: '#0f2147', c: '#080f26', rail: '#0b1635' },
        { id: 'burgundy', name: 'Burgundy',      a: '#7a1f3d', b: '#45102a', c: '#220817', rail: '#2a0a18' },
        { id: 'charcoal', name: 'Charcoal',      a: '#3b4252', b: '#1f232d', c: '#0f1218', rail: '#12151c' },
        { id: 'purple',   name: 'Royal purple',  a: '#5b2a86', b: '#33164f', c: '#190a2a', rail: '#1d0c30' },
        { id: 'teal',     name: 'Teal',          a: '#0f766e', b: '#0a4a45', c: '#052624', rail: '#062b28' },
        { id: 'casino',   name: 'Casino red',    a: '#b4232a', b: '#7a1218', c: '#3a070b', rail: '#c9a227' },
        { id: 'wood',     name: 'Green & wood',  a: '#1f7a4a', b: '#0f4d2c', c: '#062915', rail: '#7a4a22' },
        { id: 'galaxy',   name: 'Galaxy',        a: '#3b2a8f', b: '#1a1450', c: '#05031a', rail: '#6d5bd0' },
        { id: 'ocean',    name: 'Ocean',         a: '#0e7490', b: '#0b4a63', c: '#05202d', rail: '#0b3a4e' },
        { id: 'sunset',   name: 'Sunset',        a: '#c2410c', b: '#7c2d12', c: '#2d0f06', rail: '#431407' },
        { id: 'halloween',name: 'Halloween',     a: '#ea580c', b: '#3b1a05', c: '#0a0502', rail: '#111111' },
        { id: 'holiday',  name: 'Holiday',       a: '#166534', b: '#0b3d20', c: '#04170c', rail: '#b91c1c' }
    ];
    var BACKS = [
        { id: 'classic', name: 'Classic blue', free: true },
        { id: 'crimson', name: 'Crimson',      a: '#b91c1c', b: '#450a0a' },
        { id: 'emerald', name: 'Emerald',      a: '#047857', b: '#022c22' },
        { id: 'gold',    name: 'Gold',         a: '#b45309', b: '#451a03' },
        { id: 'black',   name: 'Black',        a: '#374151', b: '#030712' },
        { id: 'purple',  name: 'Purple',       a: '#6d28d9', b: '#2e1065' },
        { id: 'lattice', name: 'Red lattice',  a: '#991b1b', b: '#450a0a', pattern: 'lattice' },
        { id: 'stripes', name: 'Navy stripes', a: '#1e3a8a', b: '#172554', pattern: 'stripes' },
        { id: 'dots',    name: 'Teal dots',    a: '#0f766e', b: '#042f2e', pattern: 'dots' },
        { id: 'holo',    name: 'Holo shimmer', a: '#7c3aed', b: '#0e7490', pattern: 'holo' },
        { id: 'pumpkin', name: 'Pumpkin',      a: '#ea580c', b: '#1c0a02', pattern: 'stripes' },
        { id: 'candy',   name: 'Candy cane',   a: '#dc2626', b: '#7f1d1d', pattern: 'candy' }
    ];
    // Card face styles (classic is free)
    var FACES = [
        { id: 'classic', name: 'Classic', free: true },
        { id: 'big',     name: 'Big index' },
        { id: 'four',    name: 'Four-colour' },
        { id: 'retro',   name: 'Retro' }
    ];
    // Table themes = felt + card back + face in one tap
    var THEMES = [
        { id: 'classic',   name: 'Classic',   free: true, felt: 'classic', back: 'classic', face: 'classic', icon: '🃏' },
        { id: 'vegas',     name: 'Vegas',     felt: 'casino',   back: 'gold',    face: 'big',     icon: '🎰' },
        { id: 'speakeasy', name: 'Speakeasy', felt: 'charcoal', back: 'black',   face: 'retro',   icon: '🥃' },
        { id: 'neon',      name: 'Neon',      felt: 'galaxy',   back: 'holo',    face: 'four',    icon: '🌌' },
        { id: 'riverboat', name: 'Riverboat', felt: 'wood',     back: 'lattice', face: 'retro',   icon: '🛶' },
        { id: 'spooky',    name: 'Spooky',    felt: 'halloween',back: 'pumpkin', face: 'classic', icon: '🎃' },
        { id: 'holiday',   name: 'Holiday',   felt: 'holiday',  back: 'candy',   face: 'classic', icon: '🎄' }
    ];

    function find(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return list[0]; }
    function getPref(k) { try { return localStorage.getItem(k) || 'classic'; } catch (e) { return 'classic'; } }
    function setPref(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function token() {
        try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; }
    }

    // ---------- table style ----------
    function applyStyle() {
        var root = document.documentElement, body = document.body;
        var felt = find(FELTS, getPref('blitz31_felt'));
        var back = find(BACKS, getPref('blitz31_back'));
        if (!felt.free && !window.__isPremium) felt = FELTS[0];
        if (!back.free && !window.__isPremium) back = BACKS[0];
        if (felt.free) {
            body.removeAttribute('data-pf-felt');
        } else {
            root.style.setProperty('--pf-felt-a', felt.a);
            root.style.setProperty('--pf-felt-b', felt.b);
            root.style.setProperty('--pf-felt-c', felt.c);
            root.style.setProperty('--pf-rail', felt.rail);
            body.setAttribute('data-pf-felt', felt.id);
        }
        if (back.free) {
            body.removeAttribute('data-pf-back');
            root.style.removeProperty('--pf-back-a');
            root.style.removeProperty('--pf-back-b');
        } else {
            root.style.setProperty('--pf-back-a', back.a);
            root.style.setProperty('--pf-back-b', back.b);
            body.setAttribute('data-pf-back', back.id);
        }
        if (back.pattern) body.setAttribute('data-pf-pattern', back.pattern); else body.removeAttribute('data-pf-pattern');
        var face = find(FACES, getPref('blitz31_face'));
        if (!face.free && !window.__isPremium) face = FACES[0];
        if (face.free) body.removeAttribute('data-pf-face'); else body.setAttribute('data-pf-face', face.id);
        paintSwatches();
    }

    var section = null;
    function swatchHtml(kind, o) {
        var locked = !o.free && !window.__isPremium;
        var bg = kind === 'felt'
            ? (o.free ? 'radial-gradient(circle,#115e3b,#031c10)' : 'radial-gradient(circle,' + o.a + ',' + o.c + ')')
            : (o.free ? 'linear-gradient(135deg,#1e3a8a,#0f172a)' : 'linear-gradient(135deg,' + o.a + ',' + o.b + ')');
        var cur = getPref(kind === 'felt' ? 'blitz31_felt' : 'blitz31_back') === o.id;
        return '<button type="button" class="pf-swatch' + (cur ? ' pf-on' : '') + (locked ? ' pf-locked' : '') +
            '" data-kind="' + kind + '" data-id="' + o.id + '" title="' + o.name + (locked ? ' (Premium)' : '') +
            '" style="background:' + bg + '"><span class="pf-lock">' + (locked ? '🔒' : '') + '</span></button>';
    }
    function paintSwatches() {
        if (!section) return;
        var fe = section.querySelector('[data-row="felt"]'), ba = section.querySelector('[data-row="back"]');
        if (fe) fe.innerHTML = FELTS.map(function (o) { return swatchHtml('felt', o); }).join('');
        if (ba) ba.innerHTML = BACKS.map(function (o) { return swatchHtml('back', o); }).join('');
        var note = section.querySelector('.pf-note');
        if (note) {
            note.textContent = window.__isAdminAccount ? '💎 Admin account: all Premium options unlocked.'
                : (window.__isPremium ? '💎 Premium unlocked.' : '🔒 Extra colours, card backs and soundboard sounds are Premium.');
        }
    }
    function ensureSection() {
        if (section && document.body.contains(section)) return true;
        var content = document.querySelector('#settings-modal .settings-content');
        if (!content) return false;
        section = document.createElement('div');
        section.id = 'pf-style-section';
        section.innerHTML = '<div class="pf-title">Table Style</div>' +
            '<div class="pf-label">Felt</div><div class="pf-row" data-row="felt"></div>' +
            '<div class="pf-label">Card back</div><div class="pf-row" data-row="back"></div>' +
            '<div class="pf-note"></div>';
        content.appendChild(section);
        section.addEventListener('click', function (ev) {
            var b = ev.target.closest && ev.target.closest('.pf-swatch');
            if (!b) return;
            var kind = b.getAttribute('data-kind'), id = b.getAttribute('data-id');
            var o = find(kind === 'felt' ? FELTS : BACKS, id);
            if (!o.free && !window.__isPremium) {
                if (typeof window.showCenterNotification === 'function') window.showCenterNotification('🔒 Premium option');
                return;
            }
            setPref(kind === 'felt' ? 'blitz31_felt' : 'blitz31_back', id);
            applyStyle();
        });
        paintSwatches();
        return true;
    }

    window.__pfApi = {
        FELTS: FELTS, BACKS: BACKS, FACES: FACES, THEMES: THEMES,
        get: getPref, set: function (k, v) { setPref(k, v); applyStyle(); },
        applyTheme: function (id) {
            var t = find(THEMES, id);
            if (!t.free && !window.__isPremium) return false;
            setPref('blitz31_felt', t.felt); setPref('blitz31_back', t.back); setPref('blitz31_face', t.face);
            applyStyle(); return true;
        },
        apply: function () { applyStyle(); }
    };

    // ---------- who has Premium ----------
    var lastTok = null;
    function refresh() {
        var t = token();
        if (!t) { lastTok = null; setStatus(false, false); return; }
        if (t === lastTok && arguments[0] !== true) return;
        lastTok = t;
        fetch('/api/premium/me', { headers: { Authorization: 'Bearer ' + t } })
            .then(function (r) { return r.ok ? r.json() : { premium: false, admin: false }; })
            .then(function (d) { setStatus(!!d.premium, !!d.admin); })
            .catch(function () { lastTok = null; });
    }
    function setStatus(prem, admin) {
        var changed = (window.__isPremium !== prem) || (window.__isAdminAccount !== admin);
        window.__isPremium = prem;
        window.__isAdminAccount = admin;
        if (changed) {
            // rebuild the soundboard popover so lock icons match
            var pop = document.getElementById('soundboard-popover-menu');
            if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
        }
        applyStyle();
    }

    // ---------- synthesized sounds ----------
    function ctxGet() {
        try {
            var c = (typeof window.getAudioContext === 'function') ? window.getAudioContext() : null;
            if (!c) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; window.__pfCtx = window.__pfCtx || new AC(); c = window.__pfCtx; }
            if (c.state === 'suspended' && c.resume) c.resume();
            return c;
        } catch (e) { return null; }
    }
    function noiseBuf(c, secs) {
        var n = Math.max(1, Math.floor(c.sampleRate * secs)), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        return b;
    }
    var SYN = {
        tone: function (c, out, t, f, dur, type, g, f2) {
            var o = c.createOscillator(), v = c.createGain();
            o.type = type || 'sine';
            o.frequency.setValueAtTime(f, t);
            if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
            v.gain.setValueAtTime(0.0001, t);
            v.gain.exponentialRampToValueAtTime(g, t + 0.012);
            v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            o.connect(v); v.connect(out); o.start(t); o.stop(t + dur + 0.05);
        },
        noise: function (c, out, t, dur, g, ftype, f1, f2) {
            var s = c.createBufferSource(), fl = c.createBiquadFilter(), v = c.createGain();
            s.buffer = noiseBuf(c, dur + 0.05);
            fl.type = ftype; fl.frequency.setValueAtTime(f1, t);
            if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
            v.gain.setValueAtTime(0.0001, t);
            v.gain.exponentialRampToValueAtTime(g, t + Math.min(0.03, dur / 3));
            v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            s.connect(fl); fl.connect(v); v.connect(out); s.start(t); s.stop(t + dur + 0.05);
        }
    };
    var SOUNDS = {
        tada: function (c, o, t) {
            SYN.tone(c, o, t, 523, 0.14, 'triangle', 0.5); SYN.tone(c, o, t + 0.13, 659, 0.14, 'triangle', 0.5);
            SYN.tone(c, o, t + 0.26, 784, 0.14, 'triangle', 0.5);
            [1047, 784, 659].forEach(function (f) { SYN.tone(c, o, t + 0.4, f, 0.9, 'triangle', 0.4); });
        },
        drumroll: function (c, o, t) {
            for (var i = 0; i < 26; i++) SYN.noise(c, o, t + i * 0.045, 0.05, 0.25 + i * 0.012, 'bandpass', 220);
            SYN.noise(c, o, t + 1.2, 0.9, 0.5, 'highpass', 5000);
            SYN.tone(c, o, t + 1.2, 90, 0.25, 'sine', 0.8, 45);
        },
        boom: function (c, o, t) {
            SYN.tone(c, o, t, 130, 1.0, 'sine', 0.95, 28);
            SYN.noise(c, o, t, 0.8, 0.8, 'lowpass', 600, 80);
        },
        whoosh: function (c, o, t) { SYN.noise(c, o, t, 0.9, 0.7, 'bandpass', 250, 3500); SYN.noise(c, o, t + 0.45, 0.5, 0.4, 'bandpass', 3500, 300); },
        doorbell: function (c, o, t) {
            SYN.tone(c, o, t, 659, 0.7, 'sine', 0.6); SYN.tone(c, o, t, 1318, 0.5, 'sine', 0.15);
            SYN.tone(c, o, t + 0.5, 523, 1.1, 'sine', 0.6); SYN.tone(c, o, t + 0.5, 1046, 0.8, 'sine', 0.15);
        },
        charge: function (c, o, t) {
            [[392, 0, .12], [523, .14, .12], [659, .28, .12], [784, .42, .26], [659, .72, .12], [784, .86, .55]].forEach(function (n) {
                SYN.tone(c, o, t + n[1], n[0], n[2], 'square', 0.22);
            });
        },
        laser: function (c, o, t) {
            SYN.tone(c, o, t, 1700, 0.28, 'sawtooth', 0.3, 160); SYN.tone(c, o, t + 0.22, 1500, 0.28, 'sawtooth', 0.3, 140);
        },
        powerup: function (c, o, t) {
            [262, 330, 392, 523, 659, 784, 1047, 1319].forEach(function (f, i) { SYN.tone(c, o, t + i * 0.07, f, 0.12, 'square', 0.2); });
            SYN.tone(c, o, t + 0.6, 1568, 0.45, 'triangle', 0.3);
        }
    };
    window.playSynthSound = function (id, vol) {
        var fn = SOUNDS[id]; if (!fn) return;
        var c = ctxGet(); if (!c) return;
        var master = c.createGain();
        master.gain.value = Math.min(1, Math.max(0, vol == null ? 1 : vol)) * 0.9;
        master.connect(c.destination);
        try { fn(c, master, c.currentTime + 0.02); } catch (e) {}
    };

    // ---------- start ----------
    function boot() {
        applyStyle();
        refresh(true);
        var orig = window.openSettingsModal;
        if (typeof orig === 'function' && !orig.__pfWrapped) {
            var w = function () {
                var r = orig.apply(this, arguments);
                try { ensureSection(); refresh(true); } catch (e) {}
                return r;
            };
            w.__pfWrapped = true;
            window.openSettingsModal = w;
        }
        ensureSection();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    setInterval(function () { refresh(); ensureSection(); }, 3000);
    window.__premiumRefresh = function () { refresh(true); };
})();
