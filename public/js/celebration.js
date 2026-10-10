// public/js/celebration.js

let celebrationAnimationId = null;

window.triggerWinnerCelebration = function(winnerName, customSubtitle = "TOURNAMENT CHAMPION!") {
    const overlay = document.getElementById('winner-celebration-overlay');
    const titleEl = document.getElementById('celebration-winner-title');
    const subtitleEl = document.getElementById('celebration-subtitle');
    const canvas = document.getElementById('celebration-canvas');
    if (!overlay || !canvas || !titleEl) return;

    titleEl.innerText = winnerName ? winnerName.toUpperCase() : "PLAYER";
    if (subtitleEl) {
        subtitleEl.innerText = customSubtitle;
    }

    overlay.style.display = 'flex';
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

    if (celebrationAnimationId) cancelAnimationFrame(celebrationAnimationId);

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
            overlay.style.display = 'none';
        }
    }

    render();

    // Auto-dismiss celebration overlay after 4.5 seconds
    setTimeout(() => {
        if (overlay) overlay.style.display = 'none';
        if (celebrationAnimationId) cancelAnimationFrame(celebrationAnimationId);
    }, 4500);
};

window.trigger31Celebration = function(winnerName) {
    window.triggerWinnerCelebration(winnerName, "HIT 31!");
};

// Fallback alias to catch hooks from your most recent ui.js version
window.launchConfetti = window.triggerWinnerCelebration;
