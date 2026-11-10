// public/js/celebSound.js - pick your own celebration sound (Settings) for HIT 31 and winning the match.
// Your pick is sent to the server (SET_CELEBRATION) and shows up in the lobby snapshot, so the whole table
// hears the celebrating player's chosen sound instead of the default Hype ('None' = silent for you only).
(function () {
    'use strict';
    if (window.__celebSoundLoaded) return;
    window.__celebSoundLoaded = true;

    var KEYS = { hit31: 'blitz31_cel31', win: 'blitz31_celwin', knock: 'blitz31_celknock' };
    var section = null, lastPaint = '';

    function get(k) { try { return localStorage.getItem(k) || 'default'; } catch (e) { return 'default'; } }
    function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function items() { return (typeof SOUNDBOARD_ITEMS !== 'undefined') ? SOUNDBOARD_ITEMS : {}; }
    function cueKind(kind) { return kind === 'knock' ? 'knock' : 'win'; }
    function myCue(kind) { var m = window.__myCues || {}; return m[cueKind(kind)] || null; }
    function allowed(id, kind) {
        if (id === 'rec') return !!window.__isPremium && !!myCue(kind);
        var it = items()[id];
        return !!it && (!it.premium || !!window.__isPremium);
    }
    // a saved premium pick falls back to default when the account is not premium
    function choice(kind) {
        var v = get(KEYS[kind]);
        if (kind === 'knock') return (window.__isPremium && v !== 'none' && allowed(v, kind)) ? v : 'default';
        if (v === 'default' || v === 'none') return v;
        return allowed(v, kind) ? v : 'default';
    }
    function options(sel, kind) {
        var it = items(), free = '', prem = '';
        if (window.__isPremium && myCue(kind)) prem += '<option value="rec"' + (sel === 'rec' ? ' selected' : '') + '>🎙️ My recording</option>';
        Object.keys(it).forEach(function (id) {
            var o = '<option value="' + id + '"' + (id === sel ? ' selected' : '') + '>' + it[id].emoji + ' ' + it[id].label + '</option>';
            if (!it[id].premium) free += o; else if (window.__isPremium) prem += o;
        });
        if (kind === 'knock') return '<option value="default"' + (sel === 'default' ? ' selected' : '') + '>Default (knock)</option>' + free +
            (prem ? '<optgroup label="💎 Premium">' + prem + '</optgroup>' : '');
        return '<option value="default"' + (sel === 'default' ? ' selected' : '') + '>Default (Hype)</option>' +
            '<option value="none"' + (sel === 'none' ? ' selected' : '') + '>🔇 None</option>' + free +
            (prem ? '<optgroup label="💎 Premium">' + prem + '</optgroup>' : '');
    }
    var SEL = 'flex:1;min-width:0;padding:6px;border-radius:6px;background:#0f172a;color:#f8fafc;border:1px solid rgba(251,191,36,0.5);font-size:0.85rem;';
    var BTN = 'padding:6px 10px;border-radius:6px;border:1px solid rgba(251,191,36,0.5);background:#1e293b;color:#fde68a;font-weight:700;cursor:pointer;';
    function row(kind, label) {
        return '<div style="margin:8px 0 4px;font-size:0.82rem;color:#cbd5e1;">' + label + '</div>' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
            '<select data-cs="' + kind + '" style="' + SEL + '">' + options(choice(kind), kind) + '</select>' +
            '<button type="button" data-cs-play="' + kind + '" style="' + BTN + '" aria-label="Preview">▶</button></div>';
    }
    function paint() {
        if (!section) return;
        var key = (window.__isPremium ? 'p' : 'f') + '|' + choice('hit31') + '|' + choice('win') + '|' + choice('knock');
        if (key === lastPaint && section.firstChild) return;
        lastPaint = key;
        section.innerHTML = '<div style="font-weight:800;color:#fbbf24;margin:14px 0 2px;">🎉 Celebration Sounds</div>' +
            row('hit31', 'When I hit 31') + row('win', 'When I win the match') +
            (window.__isPremium ? row('knock', '💎 My knock call') : '<div style="margin:8px 0 4px;font-size:0.82rem;color:#94a3b8;">🔒 My knock call (Premium)</div>') +
            '<div style="font-size:0.72rem;color:#94a3b8;margin-top:6px;">The whole table hears your picks.' +
            (window.__isPremium ? '' : ' 💎 Premium unlocks more sounds and a custom knock.') + '</div>' +
            '<div data-cs-rec></div><div data-cs-extra></div>';
        if (typeof window.__celebRecPaint === 'function') { try { window.__celebRecPaint(section.querySelector('[data-cs-rec]')); } catch (e) {} }
        if (typeof window.__celebExtraPaint === 'function') { try { window.__celebExtraPaint(section.querySelector('[data-cs-extra]')); } catch (e) {} }
    }
    function ensure() {
        if (section && document.body.contains(section)) return;
        var content = document.querySelector('#settings-modal .settings-content');
        if (!content) return;
        section = document.createElement('div');
        section.id = 'cs-section';
        content.appendChild(section);
        lastPaint = '';
        section.addEventListener('change', function (ev) {
            var s = ev.target.closest && ev.target.closest('select[data-cs]');
            if (!s) return;
            set(KEYS[s.getAttribute('data-cs')], s.value);
            syncPick(true);
            if (s.value === 'rec') playRec(myCue(s.getAttribute('data-cs')));
            else if (s.value !== 'default' && s.value !== 'none') play(s.value);
        });
        section.addEventListener('click', function (ev) {
            var b = ev.target.closest && ev.target.closest('[data-cs-play]');
            if (!b) return;
            var c = choice(b.getAttribute('data-cs-play'));
            if (c === 'none') return;
            if (c === 'default') { if (b.getAttribute('data-cs-play') === 'knock') { if (origSafe) origSafe('knock'); } else playDefault(); }
            else if (c === 'rec') playRec(myCue(b.getAttribute('data-cs-play')));
            else play(c);
        });
        paint();
    }
    function playRec(cue) { if (cue && typeof window.playRecordedCue === 'function') window.playRecordedCue(cue.token || cue, true); }
    function play(id) { if (typeof window.playSoundboardEffect === 'function') window.playSoundboardEffect(id); }
    var origSafe = null;
    function playDefault() { if (origSafe) origSafe('win'); else if (typeof window.safePlaySound === 'function') window.safePlaySound('win'); }

    // ---- hook: who is celebrating, and what kind -------------------------------------------
    var ctx = null;
    function isMe(name) {
        name = String(name || '').trim().toLowerCase();
        if (!name) return false;
        var h = (typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '') || '';
        var a = (typeof window.getAccountUsername === 'function' ? window.getAccountUsername() : '') || '';
        return name === String(h).trim().toLowerCase() || name === String(a).trim().toLowerCase();
    }
    function wrap() {
        var c = window.triggerWinnerCelebration, s = window.safePlaySound;
        if (typeof c !== 'function' || typeof s !== 'function') return false;
        if (!c.__csWrapped) {
            var wc = function (winnerName, subtitle) {
                var sub = String(subtitle || '');
                var kind = /31/.test(sub) ? 'hit31' : 'win', other = null;
                var snap = window.appGlobals && window.appGlobals.latestLobbySnapshot;
                var wn = String(winnerName || '').trim().toLowerCase();
                var wp = snap && (snap.players || []).find(function (q) { return String(q.username || '').trim().toLowerCase() === wn; });
                if (wp && wp.celebration && wp.celebration[kind] === 'rec' && wp.celebration.winCue) other = { cue: wp.celebration.winCue };
                else if (wp && wp.celebration && wp.celebration[kind] && wp.celebration[kind] !== 'default' && wp.celebration[kind] !== 'none' && items()[wp.celebration[kind]]) other = wp.celebration[kind];
                ctx = { kind: kind, mine: isMe(winnerName), other: other, t: Date.now() };
                return c.apply(this, arguments);
            };
            wc.__csWrapped = true; window.triggerWinnerCelebration = wc;
        }
        if (!s.__csWrapped) {
            origSafe = s;
            var ws = function (name) {
                if (name === 'win' && ctx && ctx.mine && Date.now() - ctx.t < 1500) {
                    var pick = choice(ctx.kind); ctx = null;
                    if (pick === 'none') return;
                    if (pick === 'rec') { playRec(myCue(ctx && ctx.kind || 'win')); return; }
                    if (pick !== 'default') { play(pick); return; }
                } else if (name === 'win' && ctx && !ctx.mine && ctx.other && Date.now() - ctx.t < 1500) {
                    var o = ctx.other; ctx = null;
                    if (o && o.cue) { if (typeof window.playRecordedCue === 'function' && window.playRecordedCue(o.cue, false)) return; return s.apply(this, arguments); }
                    play(o); return;   // the winner's pick, heard by the whole table
                }
                return s.apply(this, arguments);
            };
            ws.__csWrapped = true; window.safePlaySound = ws;
        } else if (!origSafe) origSafe = s;
        return true;
    }
    var tries = 0, t = setInterval(function () { if (wrap() || ++tries > 100) clearInterval(t); }, 200);
    // keep the server's copy of my picks current (also after reconnects / server restarts)
    var lastSent = 0;
    function syncPick(force) {
        var snap = window.appGlobals && window.appGlobals.latestLobbySnapshot;
        if (!snap) return;
        var me = (snap.players || []).find(function (q) { return q.isMe && !q.isBot; });
        if (!me) return;
        var ex = (typeof window.__celebExtraChoice === 'function') ? window.__celebExtraChoice() : { confetti: 'default', dance: 'default' };
        var want = { hit31: choice('hit31'), win: choice('win'), knock: choice('knock'), confetti: ex.confetti, dance: ex.dance };
        var have = me.celebration || {};
        var same = Object.keys(want).every(function (k) { return (have[k] || 'default') === want[k]; });
        if (!force && same) return;
        if (!force && Date.now() - lastSent < 4000) return;
        lastSent = Date.now();
        if (typeof window.sendSocket === 'function') window.sendSocket({ type: 'SET_CELEBRATION', hit31: want.hit31, win: want.win, knock: want.knock, confetti: want.confetti, dance: want.dance });
    }
    setInterval(function () { ensure(); paint(); syncPick(false); }, 1000);
    window.__celebChoice = choice;   // tests
    window.__celebSync = function () { syncPick(true); };
    window.__celebRepaint = function () { lastPaint = ''; paint(); };
})();
