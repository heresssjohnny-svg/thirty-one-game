// server/seo.js - search/share basics: /og-image.png, /robots.txt and an index.html that knows its own origin.
//
// /og-image.png (1200x630) is drawn in code on first request (pixel font + a hand of A-K-10 of spades)
// and PNG-encoded with zlib, so there is no binary asset in the repo and no image library to install.
// index.html uses __ORIGIN__ in its og:/canonical URLs; serveIndex swaps in the real
// https://host the visitor used (Caddy sends X-Forwarded-Proto / Host), so no domain is hardcoded.
const fs = require('fs');
const zlib = require('zlib');
const express = require('express');

const router = express.Router();

// ---------------------------------------------------------------
// 1. Tiny raster toolkit
// ---------------------------------------------------------------
const W = 1200;
const H = 630;

const FONT = { // 5x7 pixel font, rows top to bottom
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePng(rgb) { // rgb: Buffer W*H*3
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W * 3 + 1)] = 0; // filter: none
        rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

function renderOgImage() {
    const px = Buffer.alloc(W * H * 3);
    const set = (x, y, c, a) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const i = (y * W + x) * 3;
        if (a === undefined || a >= 1) { px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; return; }
        px[i] = px[i] + (c[0] - px[i]) * a;
        px[i + 1] = px[i + 1] + (c[1] - px[i + 1]) * a;
        px[i + 2] = px[i + 2] + (c[2] - px[i + 2]) * a;
    };
    const rect = (x0, y0, x1, y1, c) => {
        for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) set(x, y, c);
    };
    const GOLD = [212, 175, 55];
    const FELT = [9, 48, 30];

    rect(0, 0, W, H, FELT);
    // double gold frame
    rect(18, 18, W - 18, 22, GOLD); rect(18, H - 22, W - 18, H - 18, GOLD);
    rect(18, 18, 22, H - 18, GOLD); rect(W - 22, 18, W - 18, H - 18, GOLD);
    const DIM = [120, 98, 30];
    rect(32, 32, W - 32, 34, DIM); rect(32, H - 34, W - 32, H - 32, DIM);
    rect(32, 32, 34, H - 32, DIM); rect(W - 34, 32, W - 32, H - 32, DIM);

    function text(str, x, y, s, c, gap) {
        let cx = x;
        for (const ch of str) {
            const g = FONT[ch] || FONT[' '];
            for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q] === '1') rect(cx + q * s, y + r * s, cx + (q + 1) * s, y + (r + 1) * s, c);
            cx += (5 + (gap === undefined ? 1 : gap)) * s;
        }
        return cx;
    }
    const textWidth = (str, s, gap) => str.length * (5 + (gap === undefined ? 1 : gap)) * s - (gap === undefined ? 1 : gap) * s;

    text('THE CLASSIC CARD GAME', 88, 88, 5, [167, 243, 208]);
    text('BLITZ', 84, 160, 17, [251, 191, 36]);
    text('31', 84, 330, 22, [255, 255, 255], 1);
    text('PLAY FREE WITH FRIENDS OR BOTS', 88, 548, 5, [226, 232, 240]);

    // --- cards: signed-distance rounded rect + spade, 3x3 supersampled, rotated about their centres
    function spadeCoverage(u, v) { // u,v in [-1,1], y up; heart flipped + stem
        const x = u * 1.25, y = -v * 1.25 + 0.15; // flipped heart
        const h = Math.pow(x * x + y * y - 1, 3) - x * x * y * y * y;
        if (h <= 0) return true;
        // stem: small triangle under the bowl
        return v < -0.4 && v > -1 && Math.abs(u) < 0.07 + (-0.4 - v) * 0.4;
    }
    function drawCard(cx, cy, angleDeg, rank) {
        const cw = 190, ch = 270, r = 18;
        const a = angleDeg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        const R = Math.ceil(Math.hypot(cw, ch) / 2) + 14;
        for (let py = Math.floor(cy - R); py < cy + R; py++) {
            for (let pxx = Math.floor(cx - R); pxx < cx + R; pxx++) {
                let cardCov = 0, shadowCov = 0, ink = 0, edge = 0;
                for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
                    const dx = pxx + (sx + 0.5) / 3 - cx, dy = pyy(py, sy) - cy;
                    // inverse-rotate into card space
                    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
                    const inRR = (x, y) => {
                        const qx = Math.abs(x) - (cw / 2 - r), qy = Math.abs(y) - (ch / 2 - r);
                        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
                    };
                    if (inRR(lx, ly)) {
                        cardCov++;
                        // spade in the centre
                        if (spadeCoverage(lx / 62, (ly - 18) / -62)) ink++;
                        // small spade under the rank
                        const sx2 = (lx + cw / 2 - 40) / 15, sy2 = (-(ly + ch / 2 - 96)) / 15;
                        if (spadeCoverage(sx2, sy2)) ink++;
                    } else if (inRR(lx - 5, ly - 7)) shadowCov++;
                    else if (inRR(lx, ly) === false && false) edge++;
                }
                if (shadowCov) set(pxx, py, [4, 22, 14], shadowCov / 9 * 0.7);
                if (cardCov) {
                    set(pxx, py, [250, 250, 245], cardCov / 9);
                    if (ink) set(pxx, py, [25, 25, 30], ink / 9);
                }
            }
        }
        // rank letters in the card's top-left corner (rotated roughly by drawing axis-aligned blocks is skipped:
        // draw each font pixel as a small rotated square)
        const s = 6, gap = 1;
        let ox = -cw / 2 + 22;
        for (const chr of rank) {
            const g = FONT[chr];
            for (let rr = 0; rr < 7; rr++) for (let q = 0; q < 5; q++) if (g[rr][q] === '1') {
                for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) {
                    const lx = ox + q * s + xx, ly = -ch / 2 + 20 + rr * s + yy;
                    const x = Math.round(cx + lx * cos - ly * sin), y = Math.round(cy + lx * sin + ly * cos);
                    set(x, y, [25, 25, 30]); set(x + 1, y, [25, 25, 30]);
                }
            }
            ox += (5 + gap) * s;
        }
    }
    function pyy(py, sy) { return py + (sy + 0.5) / 3; }
    drawCard(790, 340, -16, 'A');
    drawCard(905, 320, 0, 'K');
    drawCard(1020, 345, 15, '10');

    return encodePng(px);
}

let ogPng = null;
router.get('/og-image.png', (req, res) => {
    try {
        if (!ogPng) ogPng = renderOgImage();
        res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.send(ogPng);
    } catch (err) {
        console.error('[SEO] og-image render failed:', err.message);
        res.status(500).end();
    }
});

router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin.html\nDisallow: /auth/\n');
});

// ---------------------------------------------------------------
// 2. index.html with the visitor's own origin in the og:/canonical URLs
// ---------------------------------------------------------------
function originOf(req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    // Only echo a plain hostname[:port] back into the page
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return '';
    return (proto === 'http' ? 'http' : 'https') + '://' + host;
}

let cache = { file: null, mtime: 0, html: '' };

function serveIndex(req, res, indexPath) {
    try {
        const mtime = fs.statSync(indexPath).mtimeMs;
        if (cache.file !== indexPath || cache.mtime !== mtime) {
            cache = { file: indexPath, mtime, html: fs.readFileSync(indexPath, 'utf8') };
        }
        const origin = originOf(req);
        if (!origin) return res.sendFile(indexPath);
        res.type('html').send(cache.html.split('__ORIGIN__').join(origin));
    } catch (err) {
        res.sendFile(indexPath);
    }
}

module.exports = { router, serveIndex, renderOgImage };
