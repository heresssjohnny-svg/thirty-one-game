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
    { corner: 'tl', suit: '♥', suitCol: '#dc2626', shirt: '#ef4444', shirtD: '#b91c1c', shorts: '#1d4ed8', shortsD: '#1e3a8a', skin: '#f6c89f', skinD: '#e0a676', hair: '#4a2c17', hairStyle: 'bun',   shoe: '#f8fafc', shoeD: '#ef4444', delay: 0 },
    { corner: 'tr', suit: '♠', suitCol: '#111827', shirt: '#334155', shirtD: '#1e293b', shorts: '#f59e0b', shortsD: '#b45309', skin: '#8d5524', skinD: '#6b3e18', hair: '#111111', hairStyle: 'afro',  shoe: '#facc15', shoeD: '#111827', delay: -0.09 },
    { corner: 'bl', suit: '♦', suitCol: '#ea580c', shirt: '#fb923c', shirtD: '#c2410c', shorts: '#059669', shortsD: '#065f46', skin: '#c68642', skinD: '#a26a2f', hair: '#1c1917', hairStyle: 'spiky', shoe: '#38bdf8', shoeD: '#0f172a', delay: -0.05 },
    { corner: 'br', suit: '♣', suitCol: '#15803d', shirt: '#22c55e', shirtD: '#15803d', shorts: '#8b5cf6', shortsD: '#5b21b6', skin: '#f1c27d', skinD: '#d4a05a', hair: '#b45309', hairStyle: 'side',  shoe: '#f472b6', shoeD: '#111827', delay: -0.13 }
];
const DL_INK = '#1c1917';

function ensureDancerStyles() {
    if (document.getElementById('celebration-dancer-styles')) return;
    const st = document.createElement('style');
    st.id = 'celebration-dancer-styles';
    st.textContent = `
        .cel-dancer {
            position: fixed; z-index: 100001; pointer-events: none;
            width: clamp(80px, 18vw, 136px); height: auto; aspect-ratio: 100 / 140;
            animation: cel-pop-in 380ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
            filter: drop-shadow(0 5px 6px rgba(0,0,0,0.45));
        }
        .cel-dancer.leaving { animation: cel-pop-out 260ms ease-in both; }
        .cel-dancer svg { display: block; width: 100%; height: 100%; overflow: visible; }
        .cel-dancer.tl { top: calc(env(safe-area-inset-top, 0px) + 6px); left: 4px; }
        .cel-dancer.tr { top: calc(env(safe-area-inset-top, 0px) + 6px); right: 4px; }
        .cel-dancer.bl { bottom: calc(env(safe-area-inset-bottom, 0px) + 6px); left: 4px; }
        .cel-dancer.br { bottom: calc(env(safe-area-inset-bottom, 0px) + 6px); right: 4px; }
        .cel-dancer.tr svg, .cel-dancer.br svg { transform: scaleX(-1); }   /* look back toward the middle */

        .cel-dancer .tw-body, .cel-dancer .tw-hips, .cel-dancer .tw-upper, .cel-dancer .tw-arm-l, .cel-dancer .tw-arm-r,
        .cel-dancer .tw-knees, .cel-dancer .dl-head, .cel-dancer .dl-leg-l, .cel-dancer .dl-leg-r, .cel-dancer .dl-fore-l, .cel-dancer .dl-fore-r { transform-box: view-box; }
        .cel-dancer .tw-body  { transform-origin: 50px 134px; }
        .cel-dancer .tw-hips  { transform-origin: 50px 86px; }
        .cel-dancer .tw-upper { transform-origin: 50px 86px; }
        .cel-dancer .tw-arm-l { transform-origin: 36px 60px; }
        .cel-dancer .tw-arm-r { transform-origin: 64px 60px; }
        .cel-dancer .dl-fore-l { transform-origin: 27px 50px; }
        .cel-dancer .dl-fore-r { transform-origin: 73px 50px; }
        .cel-dancer .dl-head  { transform-origin: 50px 50px; }
        .cel-dancer .tw-knees { transform-origin: 50px 134px; }
        .cel-dancer .dl-leg-l { transform-origin: 44px 92px; }
        .cel-dancer .dl-leg-r { transform-origin: 56px 92px; }

        /* default dance: the twerk crew */
        .cel-dancer .tw-hips  { animation: tw-hips 0.19s ease-in-out infinite alternate; }
        .cel-dancer .tw-upper { animation: tw-upper 0.38s ease-in-out infinite alternate; }
        .cel-dancer .tw-arm-l { animation: tw-arm 0.38s ease-in-out infinite alternate; }
        .cel-dancer .tw-arm-r { animation: tw-arm 0.38s ease-in-out infinite alternate-reverse; }
        .cel-dancer .tw-knees { animation: tw-knees 0.38s ease-in-out infinite alternate; }
        .cel-dancer .dl-head  { animation: dl-nod 0.38s ease-in-out infinite alternate; }

        @keyframes tw-hips  { 0% { transform: translateY(1px) rotate(-10deg); } 100% { transform: translateY(-5px) rotate(10deg); } }
        @keyframes tw-upper { 0% { transform: translateY(0) rotate(-3deg); }   100% { transform: translateY(3px) rotate(3deg); } }
        @keyframes tw-arm   { 0% { transform: rotate(-14deg); }                100% { transform: rotate(16deg); } }
        @keyframes tw-knees { 0% { transform: scaleY(1); }                     100% { transform: scaleY(0.95); } }
        @keyframes dl-nod   { 0% { transform: rotate(-5deg); }                 100% { transform: rotate(6deg) translateY(1px); } }
        @keyframes cel-pop-in  { 0% { transform: scale(0.2) translateY(30px); opacity: 0; } 100% { transform: none; opacity: 1; } }
        @keyframes cel-pop-out { 0% { transform: none; opacity: 1; } 100% { transform: scale(0.3) translateY(20px); opacity: 0; } }

        @media (prefers-reduced-motion: reduce) {
            .cel-dancer, .cel-dancer * { animation: none !important; }
        }
    `;
    document.head.appendChild(st);
}

function dlHair(d) {
    const o = `stroke="${DL_INK}" stroke-width="2" stroke-linejoin="round"`;
    if (d.hairStyle === 'afro') return `<circle cx="50" cy="26" r="21" fill="${d.hair}" ${o}/><circle cx="34" cy="31" r="8" fill="${d.hair}"/><circle cx="66" cy="31" r="8" fill="${d.hair}"/>`;
    if (d.hairStyle === 'bun') return `<circle cx="50" cy="10" r="7" fill="${d.hair}" ${o}/><path d="M33 33 Q32 14 50 14 Q68 14 67 33 Q60 22 50 22 Q40 22 33 33 Z" fill="${d.hair}" ${o}/>`;
    if (d.hairStyle === 'spiky') return `<path d="M33 31 L31 18 L38 22 L39 11 L45 19 L50 8 L55 19 L61 11 L62 22 L69 18 L67 31 Q58 21 50 22 Q42 21 33 31 Z" fill="${d.hair}" ${o}/>`;
    return `<path d="M33 32 Q31 13 51 13 Q70 13 67 30 Q60 18 44 22 Q37 24 33 32 Z" fill="${d.hair}" ${o}/><path d="M44 22 Q52 26 58 19" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2" stroke-linecap="round"/>`;
}
function dlLimb(path, fill, w) {
    return `<path d="${path}" fill="none" stroke="${DL_INK}" stroke-width="${w + 3}" stroke-linecap="round" stroke-linejoin="round"/>` +
           `<path d="${path}" fill="none" stroke="${fill}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function dancerSvg(d) {
    const delay = `animation-delay:${d.delay}s`;
    const ink = `stroke="${DL_INK}" stroke-width="2"`;
    const shoe = (cx) => `<g><path d="M${cx - 10} 133 Q${cx - 10} 124 ${cx} 124 Q${cx + 11} 124 ${cx + 11} 133 Z" fill="${d.shoe}" ${ink} stroke-linejoin="round"/>` +
        `<rect x="${cx - 10}" y="131" width="21" height="4" rx="2" fill="#ffffff" ${ink}/><path d="M${cx - 4} 126 L${cx + 4} 126" stroke="${d.shoeD}" stroke-width="2" stroke-linecap="round"/></g>`;
    return `
    <svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <ellipse cx="50" cy="137" rx="28" ry="3.5" fill="rgba(0,0,0,0.35)"/>
        <g class="tw-body" style="${delay}">
        <g class="tw-knees" style="${delay}">
            <g class="dl-leg-l" style="${delay}">${dlLimb('M44 92 L37 110 L39 126', d.skin, 7)}<path d="M36 119 L42 119" stroke="#fff" stroke-width="3"/>${shoe(38)}</g>
            <g class="dl-leg-r" style="${delay}">${dlLimb('M56 92 L63 110 L61 126', d.skin, 7)}<path d="M58 119 L64 119" stroke="#fff" stroke-width="3"/>${shoe(62)}</g>
        </g>
        <g class="tw-upper" style="${delay}">
            <g class="tw-arm-l" style="${delay}">
                ${dlLimb('M36 60 L27 50', d.shirt, 9)}
                <g class="dl-fore-l" style="${delay}">${dlLimb('M27 50 L22 35', d.skin, 6.5)}<circle cx="21.5" cy="32" r="4.6" fill="${d.skin}" ${ink}/></g>
            </g>
            <g class="tw-arm-r" style="${delay}">
                ${dlLimb('M64 60 L73 50', d.shirt, 9)}
                <g class="dl-fore-r" style="${delay}">${dlLimb('M73 50 L78 35', d.skin, 6.5)}<circle cx="78.5" cy="32" r="4.6" fill="${d.skin}" ${ink}/></g>
            </g>
            <path d="M36 62 Q36 53 46 53 L54 53 Q64 53 64 62 L65 82 Q50 87 35 82 Z" fill="${d.shirt}" ${ink} stroke-linejoin="round"/>
            <path d="M58 55 Q63 58 63 68 L64 81 Q60 83 57 83 Z" fill="${d.shirtD}" opacity="0.55"/>
            <circle cx="50" cy="68" r="8" fill="#ffffff" ${ink}/>
            <text x="50" y="72.5" text-anchor="middle" font-size="12" font-weight="900" fill="${d.suitCol}" font-family="Arial, sans-serif">${d.suit}</text>
            <g class="dl-head" style="${delay}">
                <rect x="45.5" y="45" width="9" height="9" rx="3" fill="${d.skinD}" ${ink}/>
                <circle cx="33.5" cy="33" r="4" fill="${d.skin}" ${ink}/>
                <circle cx="66.5" cy="33" r="4" fill="${d.skin}" ${ink}/>
                <circle cx="50" cy="31" r="17" fill="${d.skin}" ${ink}/>
                <path d="M60 22 Q67 30 64 41 Q58 46 52 47 Q62 40 60 22 Z" fill="${d.skinD}" opacity="0.35"/>
                ${dlHair(d)}
                <ellipse cx="44" cy="32" rx="3.2" ry="4" fill="#fff" ${ink} stroke-width="1.3"/>
                <ellipse cx="57" cy="32" rx="3.2" ry="4" fill="#fff" ${ink} stroke-width="1.3"/>
                <circle cx="45" cy="33" r="1.8" fill="${DL_INK}"/><circle cx="58" cy="33" r="1.8" fill="${DL_INK}"/>
                <circle cx="45.6" cy="32.2" r="0.6" fill="#fff"/><circle cx="58.6" cy="32.2" r="0.6" fill="#fff"/>
                <path d="M40.5 26.5 Q44 24.5 47 26.3 M54 26.3 Q57 24.5 60.5 26.5" fill="none" stroke="${DL_INK}" stroke-width="1.6" stroke-linecap="round"/>
                <ellipse cx="40" cy="38.5" rx="3" ry="1.8" fill="rgba(244,63,94,0.4)"/><ellipse cx="61" cy="38.5" rx="3" ry="1.8" fill="rgba(244,63,94,0.4)"/>
                <path d="M44 39 Q50.5 46 57 39 Z" fill="#7f1d1d" ${ink} stroke-width="1.4" stroke-linejoin="round"/>
                <path d="M47.5 42.3 Q50.5 44.4 53.5 42.3" fill="#f87171"/>
            </g>
        </g>
        <g class="tw-hips" style="${delay}">
            <path d="M34 80 L66 80 L67.5 88 Q69 102 57.5 101 Q51 100 50 94 Q49 100 42.5 101 Q31 102 32.5 88 Z" fill="${d.shorts}" ${ink} stroke-linejoin="round"/>
            <path d="M34 82 L66 82" stroke="${d.shortsD}" stroke-width="3"/>
            <path d="M58 86 Q64 88 64 94" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2" stroke-linecap="round"/>
        </g>
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
