// server/pwa.js - home-screen app icons, drawn in code (no binary assets in the repo).
//
//   /icon-192.png, /icon-512.png   "any" icons (felt, gold frame, BLITZ 31)
//   /icon-maskable-512.png         same art without the frame, all content inside the safe zone
//   /apple-touch-icon.png          180x180 for iOS "Add to Home Screen"
//
// Mounted by server/seo.js (router.use), so server.js needs no change.
const zlib = require('zlib');
const express = require('express');

const router = express.Router();

const FONT = { // 5x7 pixel font, rows top to bottom
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110']
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

function encodePng(rgb, size) {
    const stride = size * 3 + 1;
    const raw = Buffer.alloc(stride * size);
    for (let y = 0; y < size; y++) {
        raw[y * stride] = 0;
        rgb.copy(raw, y * stride + 1, y * size * 3, (y + 1) * size * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// Art is laid out on a 512 grid and scaled, so every size looks the same.
function renderIcon(size, maskable) {
    const px = Buffer.alloc(size * size * 3);
    const k = size / 512;
    const FELT = [9, 48, 30], FELT_HI = [14, 70, 44], GOLD = [251, 191, 36], DIM = [150, 118, 30], WHITE = [255, 255, 255];

    // felt with a soft lighter centre
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x / size - 0.5, y / size - 0.5) / 0.7071; // 0 centre .. 1 corner
            const t = Math.max(0, 1 - d * 1.25);
            const i = (y * size + x) * 3;
            px[i] = FELT[0] + (FELT_HI[0] - FELT[0]) * t;
            px[i + 1] = FELT[1] + (FELT_HI[1] - FELT[1]) * t;
            px[i + 2] = FELT[2] + (FELT_HI[2] - FELT[2]) * t;
        }
    }
    const rect = (x0, y0, x1, y1, c) => {
        x0 = Math.round(x0 * k); y0 = Math.round(y0 * k); x1 = Math.round(x1 * k); y1 = Math.round(y1 * k);
        for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
            for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
                const i = (y * size + x) * 3;
                px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
            }
        }
    };
    if (!maskable) { // the OS masks maskable icons itself, so a frame would be cut off there
        const f = 20, t = 8;
        rect(f, f, 512 - f, f + t, GOLD); rect(f, 512 - f - t, 512 - f, 512 - f, GOLD);
        rect(f, f, f + t, 512 - f, GOLD); rect(512 - f - t, f, 512 - f, 512 - f, GOLD);
        const g = f + t + 6;
        rect(g, g, 512 - g, g + 3, DIM); rect(g, 512 - g - 3, 512 - g, 512 - g, DIM);
        rect(g, g, g + 3, 512 - g, DIM); rect(512 - g - 3, g, 512 - g, 512 - g, DIM);
    }
    function text(str, x, y, u, c) {
        let cx = x;
        for (const ch of str) {
            const g = FONT[ch];
            for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q] === '1') rect(cx + q * u, y + r * u, cx + (q + 1) * u, y + (r + 1) * u, c);
            cx += 6 * u;
        }
    }
    // "31" big, BLITZ small underneath; everything stays inside the central 80% (maskable safe zone)
    const u1 = 26; // two glyphs + 1 gap = 11 units
    text('31', (512 - (11 * u1)) / 2, 118, u1, GOLD);
    const u2 = 6;
    text('BLITZ', (512 - (29 * u2)) / 2, 118 + 7 * u1 + 34, u2, WHITE);
    return encodePng(px, size);
}

const cache = {};
function serve(route, size, maskable) {
    router.get(route, (req, res) => {
        try {
            if (!cache[route]) cache[route] = renderIcon(size, maskable);
            res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
            res.send(cache[route]);
        } catch (err) {
            console.error('[PWA] icon render failed:', err.message);
            res.status(500).end();
        }
    });
}
serve('/icon-192.png', 192, false);
serve('/icon-512.png', 512, false);
serve('/icon-maskable-512.png', 512, true);
serve('/apple-touch-icon.png', 180, true); // iOS rounds the corners itself and wants no transparency

module.exports = { router, renderIcon };
