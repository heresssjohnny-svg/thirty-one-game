// public/js/celebration.js - Self-Healing Center Banner & 2D Confetti Physics Engine

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
