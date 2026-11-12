// public/js/recordedCues.js - Premium: record your own knock call and winner cue (max 4 s) in the Celebrate tab.
// Upload: POST /api/cues/<knock|win>; playback for everyone: GET /api/cue/<token> (token comes in players[].celebration).
// Settings switch "Play other players' recordings" (blitz31_other_cues, default on) mutes everyone else's recordings.
(function () {
    'use strict';
    if (window.__recordedCuesLoaded) return;
    window.__recordedCuesLoaded = true;

    var MAX_MS = 4000;
    function token() { try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; } }
    function prem() { return !!window.__isPremium; }
    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function note(m) { if (typeof window.showCenterNotification === 'function') window.showCenterNotification(m); }
    function othersOn() { return lsGet('blitz31_other_cues', '1') !== '0'; }
    function vol() { return (typeof window.getSfxVolume === 'function') ? window.getSfxVolume() : 1; }
    function sfxOn() { var c = document.getElementById('setting-sfx'); return !c || c.checked; }

    // ---------- my cues ----------
    window.__myCues = window.__myCues || { knock: null, win: null };
    function loadMine(cb) {
        if (!token()) return cb && cb();
        fetch('/api/cues/mine', { headers: { Authorization: 'Bearer ' + token() } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (j) window.__myCues = { knock: j.knock || null, win: j.win || null }; cb && cb(); })
            .catch(function () { cb && cb(); });
    }

    // ---------- playback (cached blob URLs) ----------
    var cache = {}, pending = {};
    function fetchCue(tok) {
        if (cache[tok]) return Promise.resolve(cache[tok]);
        if (pending[tok]) return pending[tok];
        pending[tok] = fetch('/api/cue/' + encodeURIComponent(tok), { headers: { Authorization: 'Bearer ' + token() } })
            .then(function (r) { if (!r.ok) throw new Error('cue'); return r.blob(); })
            .then(function (b) { cache[tok] = URL.createObjectURL(b); delete pending[tok]; return cache[tok]; })
            .catch(function (e) { delete pending[tok]; throw e; });
        return pending[tok];
    }
    // returns true when it will play (so the caller skips the default sound)
    // fallbackId: an <audio> element to play instead if this phone can't play the recording
    function playFallback(fallbackId) {
        var el = fallbackId && document.getElementById(fallbackId);
        if (!el) return;
        try { el.currentTime = 0; el.volume = Math.max(0, Math.min(1, vol())); var p = el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    }
    window.playRecordedCue = function (tok, mine, fallbackId) {
        if (!tok || !/^[a-f0-9]{24}$/.test(String(tok))) return false;
        if (!mine && !othersOn()) return false;
        if (!sfxOn()) return true;
        fetchCue(tok).then(function (url) {
            var a = new Audio(url); a.volume = Math.max(0, Math.min(1, vol()));
            a.onerror = function () { playFallback(fallbackId); };
            var p = a.play(); if (p && p.catch) p.catch(function (e) { if (e && e.name !== 'NotAllowedError') playFallback(fallbackId); });
        }).catch(function () { playFallback(fallbackId); });
        return true;
    };

    // ---------- convert any recording to WAV (plays on every phone and browser) ----------
    // Decode -> mono 22.05 kHz -> trim silence -> normalise -> 16-bit WAV. 4 s ≈ 176 KB.
    function encodeWav(samples, rate) {
        var n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        function str(o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
        v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (var i = 0; i < n; i++) { var x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true); }
        return new Blob([buf], { type: 'audio/wav' });
    }
    function toWav(blob) {
        var AC = window.AudioContext || window.webkitAudioContext, OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!AC || !OAC) return Promise.reject(new Error('no audio'));
        var RATE = 22050;
        return blob.arrayBuffer().then(function (ab) {
            var ctx = new AC();
            return new Promise(function (res, rej) { ctx.decodeAudioData(ab, res, rej); }).then(function (decoded) { try { ctx.close(); } catch (e) {} return decoded; });
        }).then(function (decoded) {
            var len = Math.min(Math.ceil(decoded.duration * RATE), RATE * 4.2);
            var off = new OAC(1, Math.max(1, len), RATE);
            var src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
            return off.startRendering();
        }).then(function (rendered) {
            var d = rendered.getChannelData(0), start = 0, end = d.length - 1, TH = 0.02;
            while (start < d.length && Math.abs(d[start]) < TH) start++;
            while (end > start && Math.abs(d[end]) < TH) end--;
            start = Math.max(0, start - Math.round(RATE * 0.05)); end = Math.min(d.length - 1, end + Math.round(RATE * 0.15));
            var out = d.slice(start, end + 1);
            if (out.length < RATE * 0.1) out = d;   // nothing loud: keep it all
            var peak = 0; for (var i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
            var g = peak > 0.01 ? Math.min(4, 0.89 / peak) : 1;
            if (g !== 1) for (var k = 0; k < out.length; k++) out[k] *= g;
            var fade = Math.min(out.length, Math.round(RATE * 0.03));
            for (var f = 0; f < fade; f++) out[out.length - 1 - f] *= f / fade;
            return encodeWav(out, RATE);
        });
    }
    window.__cueToWav = toWav;   // tests
    // preload the recordings of everyone at my table so they play instantly
    setInterval(function () {
        var s = window.appGlobals && window.appGlobals.latestLobbySnapshot;
        if (!s || !othersOn()) return;
        (s.players || []).forEach(function (p) {
            var c = p.celebration || {};
            [c.knockCue, c.winCue].forEach(function (t) { if (t && /^[a-f0-9]{24}$/.test(t) && !cache[t] && !pending[t]) fetchCue(t).catch(function () {}); });
        });
    }, 3000);

    // ---------- recorder UI (inside the Celebrate tab) ----------
    var rec = null;   // {kind, mr, chunks, timer, started}
    var draft = {};   // kind -> {blob, url, mime}
    function pickMime() {
        var list = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/aac'];
        if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
        for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
        return '';
    }
    var BTN = 'padding:6px 10px;border-radius:8px;border:1px solid rgba(251,191,36,0.5);background:#1e293b;color:#fde68a;font-weight:700;cursor:pointer;font-size:0.78rem;';
    function rowHtml(kind, label) {
        var mine = (window.__myCues || {})[kind], d = draft[kind], live = rec && rec.kind === kind;
        var h = '<div class="rc-row" style="margin:8px 0;padding:8px;border-radius:10px;background:#111c33;border:1px solid rgba(148,163,184,0.25);">' +
            '<div style="font-size:0.8rem;color:#e2e8f0;font-weight:700;margin-bottom:6px;">' + label +
            (mine ? ' <span style="color:#34d399;font-weight:600;">· saved</span>' : '') + '</div><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">';
        if (live) h += '<button type="button" data-rc-stop="' + kind + '" style="' + BTN + 'background:#7f1d1d;color:#fff;border-color:#fca5a5;">■ Stop <span data-rc-left></span></button>';
        else if (d) h += '<button type="button" data-rc-play-draft="' + kind + '" style="' + BTN + '">▶ Listen</button>' +
            '<button type="button" data-rc-save="' + kind + '" style="' + BTN + 'background:#065f46;color:#fff;border-color:#6ee7b7;">✓ Use it</button>' +
            '<button type="button" data-rc-redo="' + kind + '" style="' + BTN + '">↺ Redo</button>';
        else {
            h += '<button type="button" data-rc-rec="' + kind + '" style="' + BTN + '">● Record</button>';
            if (mine) h += '<button type="button" data-rc-play="' + kind + '" style="' + BTN + '">▶ Play</button><button type="button" data-rc-del="' + kind + '" style="' + BTN + 'color:#fca5a5;">🗑</button>';
        }
        return h + '</div></div>';
    }
    var host = null;
    window.__celebRecPaint = function (el) {
        if (!el) return;
        host = el;
        if (!prem()) { el.innerHTML = '<div style="margin:8px 0 4px;font-size:0.8rem;color:#94a3b8;">🔒 Record your own knock call and winner cue (Premium)</div>'; return; }
        var can = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
        el.innerHTML = '<div class="ph-h" style="margin-top:12px">🎙️ Record your own (4 s max)</div>' +
            (can ? rowHtml('knock', '✊ Knock call') + rowHtml('win', '🏆 Winner cue (31 & match win)') : '<div class="ph-note">This browser can\'t record audio. Try the installed app or Chrome/Safari.</div>') +
            '<label style="display:flex;gap:8px;align-items:center;margin-top:6px;color:#cbd5e1;font-size:0.78rem;"><input type="checkbox" data-rc-others' + (othersOn() ? ' checked' : '') + '> Play other players\' recordings</label>' +
            '<div class="ph-note">Everyone at your table hears your recording. Keep it friendly.</div>';
        if (!el.__rcBound) {
            el.__rcBound = true;
            el.addEventListener('click', onClick);
            el.addEventListener('change', function (ev) { if (ev.target.hasAttribute && ev.target.hasAttribute('data-rc-others')) lsSet('blitz31_other_cues', ev.target.checked ? '1' : '0'); });
        }
    };
    function repaint() {
        if (typeof window.__celebRepaint === 'function') window.__celebRepaint();
        else if (host) window.__celebRecPaint(host);
    }
    function start(kind) {
        if (rec) return;
        var mime = pickMime();
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
            var mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
            rec = { kind: kind, mr: mr, chunks: [], started: Date.now(), stream: stream };
            mr.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
            mr.onstop = function () {
                var r = rec; rec = null;
                stream.getTracks().forEach(function (t) { t.stop(); });
                clearInterval(r.timer);
                var type = (mr.mimeType || mime || 'audio/webm').split(';')[0];
                var blob = new Blob(r.chunks, { type: type });
                if (blob.size < 200) { note('Nothing was recorded'); repaint(); return; }
                var keep = function (b, m) {
                    if (draft[kind] && draft[kind].url) URL.revokeObjectURL(draft[kind].url);
                    draft[kind] = { blob: b, url: URL.createObjectURL(b), mime: m };
                    repaint();
                };
                toWav(blob).then(function (w) { keep(w, 'audio/wav'); }).catch(function () { keep(blob, type); });
            };
            mr.start(250);
            rec.timer = setInterval(function () {
                var left = Math.max(0, MAX_MS - (Date.now() - rec.started));
                var l = host && host.querySelector('[data-rc-left]'); if (l) l.textContent = (left / 1000).toFixed(1) + 's';
                if (left <= 0 && mr.state === 'recording') mr.stop();
            }, 100);
            repaint();
        }).catch(function () { note('🎙️ Microphone permission is needed to record'); });
    }
    function onClick(ev) {
        var t = ev.target.closest && ev.target.closest('button'); if (!t) return;
        var k;
        if ((k = t.getAttribute('data-rc-rec'))) return start(k);
        if ((k = t.getAttribute('data-rc-stop'))) { if (rec && rec.mr.state === 'recording') rec.mr.stop(); return; }
        if ((k = t.getAttribute('data-rc-play-draft'))) { var a = new Audio(draft[k].url); a.volume = vol(); a.play().catch(function () {}); return; }
        if ((k = t.getAttribute('data-rc-redo'))) { URL.revokeObjectURL(draft[k].url); delete draft[k]; start(k); return; }
        if ((k = t.getAttribute('data-rc-play'))) { var m = window.__myCues[k]; if (m) window.playRecordedCue(m.token, true); return; }
        if ((k = t.getAttribute('data-rc-del'))) {
            var kd = k;
            fetch('/api/cues/' + kd, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token() } }).then(function () {
                window.__myCues[kd] = null;
                var key = kd === 'knock' ? 'blitz31_celknock' : 'blitz31_celwin';
                if (lsGet(key, '') === 'rec') lsSet(key, 'default');
                if (kd === 'win' && lsGet('blitz31_cel31', '') === 'rec') lsSet('blitz31_cel31', 'default');
                repaint(); if (typeof window.__celebSync === 'function') window.__celebSync();
            });
            return;
        }
        if ((k = t.getAttribute('data-rc-save'))) {
            var ks = k, d = draft[ks];
            t.disabled = true; t.textContent = 'Saving…';
            fetch('/api/cues/' + ks, { method: 'POST', headers: { Authorization: 'Bearer ' + token(), 'Content-Type': d.mime }, body: d.blob })
                .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
                .then(function (x) {
                    if (!x.ok) { note('⚠️ ' + ((x.j && x.j.error) || 'Could not save')); t.disabled = false; t.textContent = '✓ Use it'; return; }
                    window.__myCues[ks] = { token: x.j.token, mime: x.j.mime };
                    cache[x.j.token] = d.url; delete draft[ks];
                    lsSet(ks === 'knock' ? 'blitz31_celknock' : 'blitz31_celwin', 'rec');
                    note('🎙️ Saved — the table will hear it');
                    repaint(); if (typeof window.__celebSync === 'function') window.__celebSync();
                })
                .catch(function () { note('⚠️ Could not save, check your connection'); t.disabled = false; t.textContent = '✓ Use it'; });
        }
    }

    // keep my cue list fresh (login, premium changes)
    var lastTok = null;
    setInterval(function () { var t = token(); if (t && t !== lastTok && prem()) { lastTok = t; loadMine(repaint); } if (!prem()) lastTok = null; }, 2000);
    window.__loadMyCues = loadMine;

    // Recordings saved before conversion (webm/ogg/mp4 from one kind of phone): convert once and re-save as WAV
    var upgrading = false;
    function upgradeOld() {
        if (upgrading || !prem() || !token()) return;
        var m = window.__myCues || {};
        ['knock', 'win'].forEach(function (kind) {
            var c = m[kind];
            if (!c || !c.token || /wav/.test(c.mime || '') || c.__tried) return;
            c.__tried = true; upgrading = true;
            fetchCue(c.token).then(function (url) { return fetch(url).then(function (r) { return r.blob(); }); })
                .then(toWav)
                .then(function (w) {
                    return fetch('/api/cues/' + kind, { method: 'POST', headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'audio/wav' }, body: w })
                        .then(function (r) { return r.ok ? r.json() : null; })
                        .then(function (j) {
                            if (j && j.token) { window.__myCues[kind] = { token: j.token, mime: 'audio/wav' }; if (typeof window.__celebSync === 'function') window.__celebSync(); }
                        });
                })
                .catch(function () {})
                .then(function () { upgrading = false; });
        });
    }
    setInterval(upgradeOld, 5000);
})();
