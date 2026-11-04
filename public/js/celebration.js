// public/js/celebration.js - Self-Healing Center Banner, 2D Confetti Physics Engine & Corner Dancers

let celebrationAnimationId = null;
let celebrationTimeoutId = null;

function ensureCelebrationElements() {
    let canvas = document.getElementById('celebration-canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'celebration-canvas';
        document.body.appendChild(canvas);
    }
    canvas.style.cssText = 'display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 100000;';

    let overlay = document.getElementById('winner-celebration-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'winner-celebration-overlay';
        overlay.style.cssText = `
            display: none;
            position: fixed;
            inset: 0;
            z-index: 99999;
            pointer-events: none;
            align-items: center;
            justify-content: center;
            flex-direction: column;
            background: rgba(0, 0, 0, 0.35);
        `;
        overlay.innerHTML = `
            <div style="
                background: radial-gradient(circle at 50% 50%, rgba(6, 78, 59, 0.96) 0%, rgba(2, 44, 34, 0.98) 100%);
                border: 3px solid #fbbf24;
                border-radius: 16px;
                padding: 24px 36px;
                text-align: center;
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.85), 0 0 25px rgba(251, 191, 36, 0.4);
                transform: translateY(-10%);
                max-width: 90vw;
            ">
                <div style="font-size: 2.2rem; margin-bottom: 4px;">🏆</div>
                <h2 id="celebration-winner-title" style="
                    margin: 0;
                    font-size: 2rem;
                    font-weight: 900;
                    color: #fbbf24;
                    text-shadow: 0 2px 10px rgba(0, 0, 0, 0.8);
                    letter-spacing: 1px;
                ">PLAYER</h2>
                <p id="celebration-subtitle" style="
                    margin: 8px 0 0;
                    font-size: 1.1rem;
                    font-weight: 800;
                    color: #ffffff;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                ">TOURNAMENT CHAMPION!</p>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    const titleEl = document.getElementById('celebration-winner-title');
    const subtitleEl = document.getElementById('celebration-subtitle');

    return { overlay, titleEl, subtitleEl, canvas };
}

// -------------------------------------------------------------
// CORNER DANCERS: four cartoon suit mascots (♥ ♠ ♦ ♣ shirts) squat with
// their backs to the table and shake their hips in the four corners for as
// long as the celebration is on screen. Pure SVG + CSS, no assets.
// prefers-reduced-motion: they still appear, but stand still.
// -------------------------------------------------------------
const DANCER_LOOKS = [
    { corner: 'tl', suit: '♥', shirt: '#dc2626', shorts: '#1e3a8a', skin: '#f1c27d', hair: '#3b2314', shoe: '#111827', delay: 0 },
    { corner: 'tr', suit: '♠', shirt: '#111827', shorts: '#d97706', skin: '#8d5524', hair: '#111111', shoe: '#f8fafc', delay: -0.09 },
    { corner: 'bl', suit: '♦', shirt: '#ea580c', shorts: '#065f46', skin: '#c68642', hair: '#0f0f0f', shoe: '#1f2937', delay: -0.05 },
    { corner: 'br', suit: '♣', shirt: '#15803d', shorts: '#7c3aed', skin: '#e0ac69', hair: '#b45309', shoe: '#111827', delay: -0.13 }
];

function ensureDancerStyles() {
    if (document.getElementById('celebration-dancer-styles')) return;
    const st = document.createElement('style');
    st.id = 'celebration-dancer-styles';
    st.textContent = `
        .cel-dancer {
            position: fixed; z-index: 100001; pointer-events: none;
            width: clamp(78px, 17vw, 130px); height: auto; aspect-ratio: 100 / 132;
            animation: cel-pop-in 380ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
            filter: drop-shadow(0 4px 6px rgba(0,0,0,0.45));
        }
        .cel-dancer.leaving { animation: cel-pop-out 260ms ease-in both; }
        .cel-dancer svg { display: block; width: 100%; height: 100%; overflow: visible; }
        .cel-dancer.tl { top: calc(env(safe-area-inset-top, 0px) + 6px); left: 4px; }
        .cel-dancer.tr { top: calc(env(safe-area-inset-top, 0px) + 6px); right: 4px; }
        .cel-dancer.bl { bottom: calc(env(safe-area-inset-bottom, 0px) + 6px); left: 4px; }
        .cel-dancer.br { bottom: calc(env(safe-area-inset-bottom, 0px) + 6px); right: 4px; }
        .cel-dancer.tr svg, .cel-dancer.br svg { transform: scaleX(-1); }   /* look back toward the middle */

        .cel-dancer .tw-hips  { transform-box: view-box; transform-origin: 50px 70px; animation: tw-hips 0.19s ease-in-out infinite alternate; }
        .cel-dancer .tw-upper { transform-box: view-box; transform-origin: 50px 72px; animation: tw-upper 0.38s ease-in-out infinite alternate; }
        .cel-dancer .tw-arm-l { transform-box: view-box; transform-origin: 37px 47px; animation: tw-arm 0.38s ease-in-out infinite alternate; }
        .cel-dancer .tw-arm-r { transform-box: view-box; transform-origin: 63px 47px; animation: tw-arm 0.38s ease-in-out infinite alternate-reverse; }
        .cel-dancer .tw-knees { transform-box: view-box; transform-origin: 50px 124px; animation: tw-knees 0.38s ease-in-out infinite alternate; }

        @keyframes tw-hips  { 0% { transform: translateY(1px) rotate(-9deg); } 100% { transform: translateY(-5px) rotate(9deg); } }
        @keyframes tw-upper { 0% { transform: translateY(0) rotate(-3deg); }   100% { transform: translateY(3px) rotate(3deg); } }
        @keyframes tw-arm   { 0% { transform: rotate(-14deg); }                100% { transform: rotate(16deg); } }
        @keyframes tw-knees { 0% { transform: scaleY(1); }                     100% { transform: scaleY(0.96); } }
        @keyframes cel-pop-in  { 0% { transform: scale(0.2) translateY(30px); opacity: 0; } 100% { transform: none; opacity: 1; } }
        @keyframes cel-pop-out { 0% { transform: none; opacity: 1; } 100% { transform: scale(0.3) translateY(20px); opacity: 0; } }

        @media (prefers-reduced-motion: reduce) {
            .cel-dancer, .cel-dancer * { animation: none !important; }
        }
    `;
    document.head.appendChild(st);
}

function dancerSvg(d) {
    const delay = `animation-delay:${d.delay}s`;
    return `
    <svg viewBox="0 0 100 132" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <ellipse cx="50" cy="127" rx="30" ry="4" fill="rgba(0,0,0,0.35)"/>
        <g class="tw-knees" style="${delay}">
            <path d="M42 80 L30 101 L37 121" fill="none" stroke="${d.skin}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M58 80 L70 101 L63 121" fill="none" stroke="${d.skin}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
            <ellipse cx="33" cy="123" rx="8" ry="4" fill="${d.shoe}"/>
            <ellipse cx="67" cy="123" rx="8" ry="4" fill="${d.shoe}"/>
        </g>
        <g class="tw-upper" style="${delay}">
            <g class="tw-arm-l" style="${delay}">
                <path d="M38 48 L27 36 L22 22" fill="none" stroke="${d.skin}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="22" cy="20" r="4.5" fill="${d.skin}"/>
            </g>
            <g class="tw-arm-r" style="${delay}">
                <path d="M62 48 L73 36 L78 22" fill="none" stroke="${d.skin}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="78" cy="20" r="4.5" fill="${d.skin}"/>
            </g>
            <rect x="35" y="41" width="30" height="31" rx="11" fill="${d.shirt}"/>
            <text x="50" y="63" text-anchor="middle" font-size="16" font-weight="900" fill="#ffffff" font-family="Arial, sans-serif">${d.suit}</text>
            <rect x="46" y="35" width="8" height="7" rx="2" fill="${d.skin}"/>
            <circle cx="50" cy="25" r="13" fill="${d.skin}"/>
            <path d="M37 24 Q38 10 50 11 Q62 10 63 22 Q56 16 47 18 Q41 19 37 24 Z" fill="${d.hair}"/>
            <circle cx="60" cy="24" r="1.8" fill="#111"/>
            <path d="M56 30 Q60 33 63 29" fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round"/>
            <ellipse cx="62.5" cy="27.5" rx="2" ry="1.2" fill="rgba(239,68,68,0.45)"/>
        </g>
        <g class="tw-hips" style="${delay}">
            <circle cx="42" cy="78" r="12" fill="${d.shorts}"/>
            <circle cx="58" cy="78" r="12" fill="${d.shorts}"/>
            <rect x="34" y="66" width="32" height="8" rx="3" fill="${d.shorts}"/>
            <path d="M50 70 L50 86" stroke="rgba(0,0,0,0.25)" stroke-width="1.5" stroke-linecap="round"/>
        </g>
    </svg>`;
}

function showCelebrationDancers() {
    try {
        ensureDancerStyles();
        hideCelebrationDancers(true);
        DANCER_LOOKS.forEach(d => {
            const el = document.createElement('div');
            el.className = `cel-dancer ${d.corner}`;
            el.setAttribute('data-cel-dancer', '1');
            el.innerHTML = dancerSvg(d);
            document.body.appendChild(el);
        });
    } catch (e) {}
}

function hideCelebrationDancers(immediate) {
    document.querySelectorAll('[data-cel-dancer]').forEach(el => {
        if (immediate) { el.remove(); return; }
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 280);
    });
}
window.showCelebrationDancers = showCelebrationDancers;
window.hideCelebrationDancers = hideCelebrationDancers;

window.triggerWinnerCelebration = function(winnerName, customSubtitle = "TOURNAMENT CHAMPION!") {
    const { overlay, titleEl, subtitleEl, canvas } = ensureCelebrationElements();
    if (!overlay || !canvas || !titleEl) return;

    if (titleEl) {
        titleEl.innerText = winnerName ? String(winnerName).toUpperCase() : "PLAYER";
    }
    if (subtitleEl) {
        subtitleEl.innerText = customSubtitle || "TOURNAMENT CHAMPION!";
    }

    overlay.style.display = 'flex';
    canvas.style.display = 'block';
    showCelebrationDancers();
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const ctx = canvas.getContext('2d');
    const particles = [];
    const colors = ['#facc15', '#38bdf8', '#ef4444', '#10b981', '#a855f7', '#f43f5e', '#ffffff'];

    for (let i = 0; i < 160; i++) {
        particles.push({
            x: canvas.width / 2,
            y: canvas.height / 2,
            vx: (Math.random() - 0.5) * 16,
            vy: (Math.random() - 0.5) * 16 - 3,
            size: Math.random() * 8 + 4,
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 8,
            gravity: 0.18,
            opacity: 1
        });
    }

    if (celebrationAnimationId) {
        cancelAnimationFrame(celebrationAnimationId);
        celebrationAnimationId = null;
    }
    if (celebrationTimeoutId) {
        clearTimeout(celebrationTimeoutId);
        celebrationTimeoutId = null;
    }

    function stopCelebration() {
        if (celebrationAnimationId) {
            cancelAnimationFrame(celebrationAnimationId);
            celebrationAnimationId = null;
        }
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (overlay) overlay.style.display = 'none';
        if (canvas) canvas.style.display = 'none';
        hideCelebrationDancers();
    }

    function render() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let active = 0;

        particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += p.gravity;
            p.rotation += p.rotSpeed;
            p.opacity -= 0.0035;

            if (p.opacity > 0) {
                active++;
                ctx.save();
                ctx.globalAlpha = Math.max(0, p.opacity);
                ctx.translate(p.x, p.y);
                ctx.rotate((p.rotation * Math.PI) / 180);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
                ctx.restore();
            }
        });

        if (active > 0) {
            celebrationAnimationId = requestAnimationFrame(render);
        } else {
            stopCelebration();
        }
    }

    render();

    // Auto-dismiss celebration overlay and canvas after 4.5 seconds
    celebrationTimeoutId = setTimeout(stopCelebration, 4500);
};

window.trigger31Celebration = function(winnerName) {
    window.triggerWinnerCelebration(winnerName, "⚡ HIT 31! ⚡");
};

// Fallback aliases for all UI hooks
window.launchConfetti = window.triggerWinnerCelebration;
window.startCelebration = window.triggerWinnerCelebration;
window.triggerCelebration = window.triggerWinnerCelebration;
