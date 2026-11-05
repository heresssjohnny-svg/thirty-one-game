// public/js/friends.js - the Friends card on the main menu (list, add by username, requests).
// Loaded last. Talks to /api/friends (server/friends.js). Guests have no friends, so the card stays hidden
// for them. Everything shown from the server is inserted with textContent.
(function () {
    'use strict';
    if (window.__friendsLoaded) return;
    window.__friendsLoaded = true;

    function $(id) { return document.getElementById(id); }
    function token() {
        try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; }
    }
    function call(method, path, body) {
        var t = token();
        if (!t) return Promise.resolve({ status: 401, json: null });
        var headers = { Authorization: 'Bearer ' + t };
        if (body) headers['Content-Type'] = 'application/json';
        return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; }); })
            .catch(function () { return { status: 0, json: null }; });
    }
    function el(tag, css, text) {
        var n = document.createElement(tag);
        if (css) n.style.cssText = css;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    var main = document.querySelector('#main-menu .menu-content');
    if (!main) return;

    var card = el('section');
    card.id = 'friends-card';
    card.className = 'menu-card casino-panel';
    card.style.display = 'none';
    var title = el('h3'); title.className = 'gold-text'; title.textContent = 'Friends';
    var intro = el('p', 'margin:0 0 10px;font-size:.78rem;color:#94a3b8;line-height:1.4;',
        'Friends can join your private tables. Anyone who joins through a table’s 🔗 Invite link becomes your friend automatically.');
    var addRow = el('div', 'display:flex;gap:6px;margin-bottom:6px;');
    var input = el('input'); input.type = 'text'; input.id = 'friend-add-input'; input.placeholder = 'Add a friend by username';
    input.maxLength = 40; input.autocomplete = 'off'; input.style.flex = '1';
    var addBtn = el('button', '', 'Add'); addBtn.type = 'button'; addBtn.id = 'friend-add-btn'; addBtn.className = 'secondary-btn';
    addRow.appendChild(input); addRow.appendChild(addBtn);
    var status = el('div', 'min-height:1.1em;margin-bottom:6px;font-size:.78rem;color:#fbbf24;');
    var body = el('div');
    card.appendChild(title); card.appendChild(intro); card.appendChild(addRow); card.appendChild(status); card.appendChild(body);
    main.appendChild(card);

    function say(msg, bad) { status.textContent = msg || ''; status.style.color = bad ? '#f87171' : '#fbbf24'; }

    function btn(label, onClick, css, id) {
        var b = el('button', 'padding:3px 10px;font-size:.74rem;' + (css || ''), label);
        b.type = 'button'; b.className = 'secondary-btn';
        if (id) b.dataset.act = id;
        b.addEventListener('click', onClick);
        return b;
    }
    function line(name, right) {
        var row = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 2px;' +
            'border-bottom:1px solid rgba(255,255,255,.06);font-size:.86rem;');
        row.appendChild(el('span', 'color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;', name));
        var box = el('span', 'display:flex;gap:6px;flex-shrink:0;');
        (right || []).forEach(function (n) { box.appendChild(n); });
        row.appendChild(box);
        return row;
    }
    function section(label) { return el('div', 'margin:8px 0 2px;font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;', label); }

    function removeBtn(name) {
        var armed = false;
        var b = btn('Remove', function () {
            if (!armed) { armed = true; b.textContent = 'Sure?'; setTimeout(function () { armed = false; b.textContent = 'Remove'; }, 3000); return; }
            call('DELETE', '/api/friends/' + encodeURIComponent(name)).then(apply);
        }, '', 'remove');
        return b;
    }

    function paint(d) {
        body.textContent = '';
        if (!d) return;
        if (d.incoming && d.incoming.length) {
            body.appendChild(section('Requests'));
            d.incoming.forEach(function (r) {
                body.appendChild(line(r.username, [
                    btn('Accept', function () { call('POST', '/api/friends/respond', { username: r.username, accept: true }).then(apply); }, 'color:#34d399;', 'accept'),
                    btn('Decline', function () { call('POST', '/api/friends/respond', { username: r.username, accept: false }).then(apply); }, '', 'decline')
                ]));
            });
        }
        body.appendChild(section('Your friends (' + (d.friends ? d.friends.length : 0) + ')'));
        if (d.friends && d.friends.length) {
            d.friends.forEach(function (f) { body.appendChild(line(f.username, [removeBtn(f.username)])); });
        } else {
            body.appendChild(el('p', 'margin:4px 0;font-size:.82rem;color:#94a3b8;', 'No friends yet. Add one by username or share a private table’s invite link.'));
        }
        if (d.outgoing && d.outgoing.length) {
            body.appendChild(section('Waiting for a reply'));
            d.outgoing.forEach(function (r) {
                body.appendChild(line(r.username, [btn('Cancel', function () { call('POST', '/api/friends/cancel', { username: r.username }).then(apply); }, '', 'cancel')]));
            });
        }
    }

    function apply(res) {
        if (!res || res.status === 401 || res.status === 0) { card.style.display = 'none'; return; }
        if (res.json && res.json.error) { say(res.json.error, true); return; }
        card.style.display = '';
        paint(res.json);
    }

    function load() { call('GET', '/api/friends').then(apply); }

    function add() {
        var name = input.value.trim();
        if (!name) return;
        addBtn.disabled = true;
        call('POST', '/api/friends/request', { username: name }).then(function (res) {
            addBtn.disabled = false;
            if (res.json && res.json.error) { say(res.json.error, true); return; }
            var s = res.json && res.json.status;
            say(s === 'accepted' ? 'You are now friends with ' + name + '.' :
                s === 'already_friends' ? name + ' is already your friend.' : 'Request sent to ' + name + '.');
            input.value = '';
            apply(res);
        });
    }
    addBtn.addEventListener('click', add);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });

    function menuVisible() {
        var m = $('main-menu');
        return !!m && m.style.display !== 'none' && m.getClientRects().length > 0;
    }
    var wasVisible = false, lastLoad = 0;
    setInterval(function () {
        var v = menuVisible(), now = Date.now();
        if (v && (!wasVisible || now - lastLoad > 30000)) { lastLoad = now; load(); }
        wasVisible = v;
    }, 1000);
    window.refreshBlitzFriends = load;
})();
