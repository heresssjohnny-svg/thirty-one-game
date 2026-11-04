// public/js/tableWager.js - "Free" table wager option
//
// The Table Wager dropdown has a Free option (value 0). A Free player plays for
// fun: the server's payout is the lower of the winner's and loser's wagers, so
// nothing is owed to or from anyone on a Free wager.
//
// ui.js / network.js send `parseInt(value) || 5`, which turns 0 into $5, and
// ui.js prints seat wagers as `$${p.wager || 5}`. This module (loaded last):
//   - replaces window.updateWager so Free really sends 0
//   - after every render: labels Free seats "Wager: Free", shows "Pot: Free"
//     when nobody is playing for money, and keeps the dropdown on your wager

(function () {
    if (window.__tableWagerInstalled) return;
    window.__tableWagerInstalled = true;

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

    function isFree(p) { return !!p && (p.wager === 0 || p.wager === '0'); }

    function labelFreeSeat(username) {
        const want = String(username || '').toLowerCase();
        document.querySelectorAll('[data-player-username]').forEach(seat => {
            if ((seat.getAttribute('data-player-username') || '').toLowerCase() !== want) return;
            const walker = document.createTreeWalker(seat, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (/Wager: \$[\d.]+/.test(node.nodeValue)) {
                    node.nodeValue = node.nodeValue.replace(/Wager: \$[\d.]+/, 'Wager: Free');
                }
            }
        });
    }

    function afterRender(lobby) {
        if (!lobby || !Array.isArray(lobby.players)) return;
        lobby.players.forEach(p => { if (isFree(p)) labelFreeSeat(p.username); });

        if (lobby.potTotal === 0) {
            const pot = document.getElementById('pot-total-banner');
            if (pot) pot.innerText = 'Pot: Free';
        }

        const sel = document.getElementById('config-wager');
        const me = lobby.players.find(p => p.isMe);
        if (sel && me && document.activeElement !== sel) {
            const want = isFree(me) ? '0' : String(Number(me.wager) || 5);
            if (Array.from(sel.options).some(o => o.value === want) && sel.value !== want) sel.value = want;
        }
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
