// public/js/tableWager.js - Table type, Free wager option and seat tidy-ups
//
// TABLE TYPE  The room creator picks the table type in the waiting room
//             (Table Type dropdown, added to the config bar by this module):
//               mixed - "Free or Wager": each player picks Free or $5/$10/$20
//               free  - "Free Only": wager-free table, everyone plays for $0
//               paid  - "Wager Only": Free is not available
//             Everyone else sees the same dropdown, greyed out. The server
//             (server/game/wagerModes.js + lobbyManager.wagerOf) enforces it.
// FREE WAGER  Free is wager 0. A Free player plays for fun: the payout is the
//             lower of the winner's and loser's wagers, so nothing is owed to or
//             from them. ui.js / network.js send `parseInt(value) || 5` (0 -> $5)
//             and print seats as `$${p.wager || 5}`, so this module replaces
//             window.updateWager and relabels Free seats "Wager: Free"; the pot
//             shows "Pot: Free" when nobody is playing for money.
// READY ICON  The ✅ / ❌ ready marks on the seats only show in the waiting room.

(function () {
    if (window.__tableWagerInstalled) return;
    window.__tableWagerInstalled = true;

    const MODE_OPTIONS = [
        { value: 'mixed', label: 'Free or Wager' },
        { value: 'free', label: 'Free Only' },
        { value: 'paid', label: 'Wager Only' }
    ];

    function send(msg) {
        if (typeof window.sendSocket === 'function') return window.sendSocket(msg);
        if (typeof window.initSocketAndSend === 'function') return window.initSocketAndSend(msg);
    }

    window.updateWager = function () {
        const sel = document.getElementById('config-wager');
        if (!sel) return;
        const wager = sel.value === '0' ? 0 : (parseInt(sel.value, 10) || 5);
        send({ type: 'UPDATE_WAGER', wager });
    };

    window.updateTableType = function () {
        const sel = document.getElementById('config-table-type');
        if (sel) send({ type: 'SET_WAGER_MODE', mode: sel.value });
    };

    function isFree(p) { return !!p && (p.wager === 0 || p.wager === '0'); }
    function lower(s) { return String(s || '').trim().toLowerCase(); }

    // ---- Table Type dropdown (built once, next to Table Wager) ----------
    function ensureTableTypeControl() {
        let sel = document.getElementById('config-table-type');
        if (sel) return sel;
        const wagerSel = document.getElementById('config-wager');
        const wagerItem = wagerSel ? wagerSel.closest('.config-item') : null;
        if (!wagerItem || !wagerItem.parentNode) return null;
        const item = document.createElement('div');
        item.className = 'config-item';
        item.id = 'config-table-type-item';
        item.innerHTML = '<label>Table Type:</label><select id="config-table-type" onchange="window.updateTableType()">' +
            MODE_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('') + '</select>';
        wagerItem.parentNode.insertBefore(item, wagerItem);
        return document.getElementById('config-table-type');
    }

    // ---- Table Wager dropdown follows the table type ---------------------
    let freeOption = null;
    function applyModeToWagerSelect(mode, me) {
        const sel = document.getElementById('config-wager');
        if (!sel) return;
        if (!freeOption) freeOption = Array.from(sel.options).find(o => o.value === '0') || null;
        const hasFree = Array.from(sel.options).some(o => o.value === '0');

        if (mode === 'paid') {
            if (hasFree) { const o = Array.from(sel.options).find(x => x.value === '0'); if (o) o.remove(); }
        } else if (!hasFree && freeOption) {
            sel.insertBefore(freeOption, sel.options[0] || null);
        }

        sel.disabled = (mode === 'free');
        if (document.activeElement === sel) return;
        let want;
        if (mode === 'free') want = '0';
        else if (me) want = isFree(me) ? '0' : String(Number(me.wager) || 5);
        if (want && Array.from(sel.options).some(o => o.value === want) && sel.value !== want) sel.value = want;
    }

    // ---- seats ----------------------------------------------------------
    function seatsFor(username) {
        const want = lower(username);
        return Array.from(document.querySelectorAll('[data-player-username]'))
            .filter(seat => lower(seat.getAttribute('data-player-username')) === want);
    }

    function labelFreeSeat(username) {
        seatsFor(username).forEach(seat => {
            const walker = document.createTreeWalker(seat, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (/Wager: \$[\d.]+/.test(node.nodeValue)) {
                    node.nodeValue = node.nodeValue.replace(/Wager: \$[\d.]+/, 'Wager: Free');
                }
            }
        });
    }

    // ✅ / ❌ ready marks: waiting room only
    function hideReadyMarks() {
        document.querySelectorAll('[data-player-username] .seat-name-area > span:first-child').forEach(span => {
            const t = (span.textContent || '').trim();
            if (t === '✅' || t === '❌') span.style.display = 'none';
        });
    }

    function afterRender(lobby) {
        if (!lobby || !Array.isArray(lobby.players)) return;
        const mode = lobby.wagerMode || 'mixed';
        const me = lobby.players.find(p => p.isMe);

        lobby.players.forEach(p => { if (isFree(p)) labelFreeSeat(p.username); });
        if (lobby.potTotal === 0) {
            const pot = document.getElementById('pot-total-banner');
            if (pot) pot.innerText = 'Pot: Free';
        }
        if (lobby.gameState && lobby.gameState !== 'lobby') hideReadyMarks();

        const typeSel = ensureTableTypeControl();
        if (typeSel) {
            const myName = lower(me && me.username) || lower(typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '');
            const iAmHost = !!window.__isAdminAccount || (!!myName && myName === lower(lobby.host));
            typeSel.disabled = !iAmHost;
            typeSel.title = iAmHost ? 'Choose what players can wager at this table' : 'Only the room creator can change the table type';
            if (document.activeElement !== typeSel && typeSel.value !== mode) typeSel.value = mode;
        }
        applyModeToWagerSelect(mode, me);
    }

    function install() {
        const original = window.updateUIFromLobby;
        if (typeof original !== 'function' || original.__tableWagerWrapped) return false;
        const wrapped = function (lobby) {
            const result = original.apply(this, arguments);
            try { afterRender(lobby); } catch (e) { console.warn('[TableWager] skipped:', e); }
            return result;
        };
        wrapped.__tableWagerWrapped = true;
        window.updateUIFromLobby = wrapped;
        window.renderLobbyState = wrapped;
        return true;
    }

    if (!install()) {
        let tries = 0;
        const t = setInterval(() => { if (install() || ++tries > 50) clearInterval(t); }, 100);
    }
})();
