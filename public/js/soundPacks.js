// public/js/soundPacks.js - Premium sound packs + spoken alerts (🔊 Sounds tab in the Premium panel).
//  - A pack swaps the "your turn" and "knock" sounds on YOUR device (files in /mp3s/packs/<pack>-<cue>.mp3).
//    It works by changing the src of the <audio id="sound-yourturn|sound-knock"> elements, so all the
//    existing timing/dedupe logic (audioCues.js) stays in charge. A player's custom knock call still wins.
//  - Voice alerts speak "Your turn!" / "<name> knocked!" with the browser's speech voice in a chosen style.
(function () {
    'use strict';
    if (window.__soundPacksLoaded) return;
    window.__soundPacksLoaded = true;

    var PACKS = [
        { id: 'classic', name: 'Classic', icon: '🃏', free: true },
        { id: 'arcade', name: 'Arcade', icon: '👾' },
        { id: 'casino', name: 'Casino', icon: '🎰' },
        { id: 'sports', name: 'Sports', icon: '🏟️' },
        { id: 'holiday', name: 'Holiday', icon: '🔔' },
        { id: 'spooky', name: 'Spooky', icon: '👻' }
    ];
    var VOICES = [
        { id: 'off', name: 'Off', icon: '🔇', free: true },
        { id: 'announcer', name: 'Announcer', icon: '🎙️', rate: 0.95, pitch: 0.6 },
        { id: 'robot', name: 'Robot', icon: '🤖', rate: 0.9, pitch: 0.05 },
        { id: 'chipmunk', name: 'Chipmunk', icon: '🐿️', rate: 1.25, pitch: 2 },
        { id: 'calm', name: 'Calm', icon: '😌', rate: 0.85, pitch: 1, volume: 0.75 }
    ];
    var CUES = ['yourturn', 'knock'];
    var orig = {};

    function prem() { return !!window.__isPremium; }
    function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function find(list, id) { return list.filter(function (x) { return x.id === id; })[0] || list[0]; }
    function pack() { var p = find(PACKS, lsGet('blitz31_pack', 'classic')); return (!p.free && !prem()) ? PACKS[0] : p; }
    function voice() { var v = find(VOICES, lsGet('blitz31_voice', 'off')); return (!v.free && !prem()) ? VOICES[0] : v; }
    function voiceOnly() { return prem() && voice().id !== 'off' && lsGet('blitz31_voice_only', '0') === '1'; }
    function snap() { return window.appGlobals && window.appGlobals.latestLobbySnapshot; }

    var applied = '';
    function apply() {
        var p = pack(), key = p.id + '|' + (voiceOnly() ? 1 : 0);
        CUES.forEach(function (c) {
            var el = document.getElementById('sound-' + c);
            if (!el) return;
            if (!orig[c]) orig[c] = el.getAttribute('src');
            var want = p.free ? orig[c] : '/mp3s/packs/' + p.id + '-' + c + '.mp3';
            if (el.getAttribute('src') !== want) { el.setAttribute('src', want); try { el.load(); } catch (e) {} }
            el.muted = voiceOnly();
            if (!el.__spHooked) {
                el.__spHooked = true;
                el.addEventListener('play', function () { onCue(c, el); });
            }
        });
        applied = key;
    }

    // ---------- speech ----------
    function speak(text) {
        var v = voice();
        if (v.id === 'off' || !('speechSynthesis' in window)) return;
        try {
            var u = new SpeechSynthesisUtterance(text);
            u.rate = v.rate || 1; u.pitch = v.pitch == null ? 1 : v.pitch;
            var sfx = (typeof window.getSfxVolume === 'function') ? window.getSfxVolume() : 1;
            u.volume = Math.max(0, Math.min(1, (v.volume || 1) * sfx));
            var en = (speechSynthesis.getVoices() || []).filter(function (x) { return /^en/i.test(x.lang); });
            if (en.length) u.voice = en[0];
            speechSynthesis.cancel();
            speechSynthesis.speak(u);
        } catch (e) {}
    }
    function phrase(cue) {
        var s = snap() || {};
        if (cue === 'yourturn') return s.gameState === 'finalTurn' ? 'Your final turn!' : 'Your turn!';
        var who = s.knockedBy, me = (s.players || []).find(function (p) { return p.isMe; });
        if (!who || (me && me.username === who)) return 'Knock knock!';
        return String(who).slice(0, 24) + ' knocked!';
    }
    function onCue(cue, el) {
        el.muted = voiceOnly();
        if (voice().id === 'off') return;
        setTimeout(function () { speak(phrase(cue)); }, voiceOnly() ? 0 : 350);
    }

    // ---------- 🔊 Sounds tab ----------
    function tiles(list, cur, attr, withPlay) {
        return '<div class="ph-grid">' + list.map(function (o) {
            var lk = !o.free && !prem();
            return '<button type="button" class="ph-tile' + (cur === o.id ? ' on' : '') + (lk ? ' locked' : '') + '" ' + attr + '="' + o.id + '">' +
                (lk ? '<span class="ph-lk">🔒</span>' : '') + '<span class="ph-ico">' + o.icon + '</span>' + o.name + '</button>';
        }).join('') + '</div>';
    }
    var BTN = 'padding:6px 10px;border-radius:8px;border:1px solid rgba(251,191,36,0.5);background:#1e293b;color:#fde68a;font-weight:700;cursor:pointer;margin:6px 6px 0 0;';
    function render(el) {
        var p = pack(), v = voice();
        el.innerHTML = '<div class="ph-h">Sound pack</div>' + tiles(PACKS, p.id, 'data-sp-pack') +
            '<div><button type="button" data-sp-try="yourturn" style="' + BTN + '">▶ Your turn</button><button type="button" data-sp-try="knock" style="' + BTN + '">▶ Knock</button></div>' +
            '<div class="ph-note">Changes the "your turn" and knock sounds on your device. A player\'s own knock call still plays when they knock.</div>' +
            '<div class="ph-h">Voice alerts</div>' + tiles(VOICES, v.id, 'data-sp-voice') +
            (prem() && v.id !== 'off' ? '<label style="display:flex;gap:8px;align-items:center;margin-top:8px;color:#cbd5e1;font-size:0.8rem;"><input type="checkbox" data-sp-only' + (voiceOnly() ? ' checked' : '') + '> Voice only (no sound effect)</label>' : '') +
            '<div class="ph-note">Says "Your turn!" and "&lt;name&gt; knocked!". Uses your phone\'s built-in voice.</div>';
        if (!el.__spBound) {
            el.__spBound = true;
            el.addEventListener('click', function (ev) {
                var t = ev.target.closest && ev.target.closest('[data-sp-pack],[data-sp-voice],[data-sp-try]');
                if (!t) return;
                if (t.hasAttribute('data-sp-try')) {
                    var c = t.getAttribute('data-sp-try'), a = document.getElementById('sound-' + c);
                    if (a) { a.volume = (typeof window.getSfxVolume === 'function') ? window.getSfxVolume() : 1; try { a.currentTime = 0; } catch (e) {} var pr = a.play(); if (pr && pr.catch) pr.catch(function () {}); }
                    return;
                }
                var isP = t.hasAttribute('data-sp-pack'), id = t.getAttribute(isP ? 'data-sp-pack' : 'data-sp-voice');
                var o = find(isP ? PACKS : VOICES, id);
                if (!o.free && !prem()) { if (typeof window.showCenterNotification === 'function') window.showCenterNotification('🔒 Premium option'); return; }
                lsSet(isP ? 'blitz31_pack' : 'blitz31_voice', id);
                apply(); render(el);
                if (!isP && id !== 'off') speak('Your turn!');
            });
            el.addEventListener('change', function (ev) {
                if (ev.target && ev.target.hasAttribute && ev.target.hasAttribute('data-sp-only')) { lsSet('blitz31_voice_only', ev.target.checked ? '1' : '0'); apply(); }
            });
        }
    }
    function addTab() {
        if (typeof window.__phAddTab !== 'function') return false;
        window.__phAddTab('sounds', '🔊 Sounds', render, 30);
        return true;
    }
    var tries = 0, t = setInterval(function () { if (addTab() || ++tries > 100) clearInterval(t); }, 200);
    // keep elements in sync with premium status / prefs
    setInterval(function () { var p = pack(); if (applied !== p.id + '|' + (voiceOnly() ? 1 : 0)) apply(); }, 1000);
    try { if ('speechSynthesis' in window) speechSynthesis.getVoices(); } catch (e) {}
    window.__spState = function () { return { pack: pack().id, voice: voice().id, voiceOnly: voiceOnly() }; };
})();
