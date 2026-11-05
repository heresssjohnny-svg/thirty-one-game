#!/usr/bin/env node
// scripts/gen-vapid.js - creates the VAPID key pair that web push needs and appends it to .env.
// Run once on the server from the repo folder:   node scripts/gen-vapid.js
// It never overwrites existing keys and never prints the private key (only the public one).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '..', '.env');
let text = '';
try { text = fs.readFileSync(envPath, 'utf8'); } catch (e) {}

if (/^VAPID_PRIVATE_KEY=\S+/m.test(text)) {
    const m = text.match(/^VAPID_PUBLIC_KEY=(\S+)/m);
    console.log('VAPID keys already exist in .env - nothing changed.');
    if (m) console.log('Public key: ' + m[1]);
    process.exit(0);
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const pub = b64u(ecdh.getPublicKey());        // 65-byte uncompressed point
const priv = b64u(ecdh.getPrivateKey());      // 32-byte scalar

const emailMatch = text.match(/^SMTP_EMAIL=(\S+)/m);
const subject = emailMatch ? 'mailto:' + emailMatch[1] : '';

let add = (text && !text.endsWith('\n') ? '\n' : '') + '\n# Web push (scripts/gen-vapid.js)\n' +
    'VAPID_PUBLIC_KEY=' + pub + '\n' + 'VAPID_PRIVATE_KEY=' + priv + '\n';
if (subject && !/^VAPID_SUBJECT=/m.test(text)) add += 'VAPID_SUBJECT=' + subject + '\n';
fs.appendFileSync(envPath, add, { mode: 0o600 });

console.log('Added VAPID keys to .env. Restart the server (pm2 restart blitz31 --update-env).');
console.log('Public key: ' + pub);
if (!subject) console.log('Tip: add a line  VAPID_SUBJECT=mailto:you@example.com  to .env.');
