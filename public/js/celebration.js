// public/js/celebration.js
let celebrationAnimationId = null;
let celebrationParticles = [];

function triggerWinnerCelebration(winnerName) {
    const overlay = document.getElementById('winner-celebration-overlay');
    const title = document.getElementById('celebration-winner-title');
    const canvas = document.getElementById('celebration-canvas');
    if (!overlay || !canvas || !title) return;

    title.innerText = `${winnerName} Wins!`;
    overlay.style.display = 'flex';

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    celebrationParticles = [];
    const colors = ['#facc15', '#ef4444', '#38bdf8', '#10b981', '#ec4899', '#a855f7', '#fb923c'];

    // Spawn initial confetti batch
    for (let i = 0; i < 110; i++) {
        celebrationParticles.push({
            type: 'confetti',
            x: Math.random() * canvas.width,
            y: Math.random() * -canvas.height,
            w: Math.random() * 8 + 6,
            h: Math.random() * 5 + 4,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: Math.random() * 3 - 1.5,
            vy: Math.random() * 3 + 2.5,
            rot: Math.random() * 360,
            vRot: Math.random() * 6 - 3
        });
    }

    function spawnFireworkBurst() {
        const cx = Math.random() * (canvas.width * 0.8) + (canvas.width * 0.1);
        const cy = Math.random() * (canvas.height * 0.5) + (canvas.height * 0.15);
        const color = colors[Math.floor(Math.random() * colors.length)];
        for (let i = 0; i < 45; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 5 + 2;
            celebrationParticles.push({
                type: 'firework',
                x: cx,
                y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                alpha: 1.0,
                color: color,
                radius: Math.random() * 2.5 + 1.5
            });
        }
    }

    // Launch firework bursts
    for (let b = 0; b < 3; b++) spawnFireworkBurst();
    const burstTimer = setInterval(() => {
        if (overlay.style.display === 'flex') spawnFireworkBurst();
    }, 700);

    if (typeof playCelebrationFanfare === 'function') {
        playCelebrationFanfare();
    }

    function renderCelebration() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        for (let i = celebrationParticles.length - 1; i >= 0; i--) {
            const p = celebrationParticles[i];
            if (p.type === 'confetti') {
                p.x += p.vx;
                p.y += p.vy;
                p.rot += p.vRot;
                if (p.y > canvas.height) {
                    p.y = -10;
                    p.x = Math.random() * canvas.width;
                }
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate((p.rot * Math.PI) / 180);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            } else if (p.type === 'firework') {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.08;
                p.vx *= 0.98;
                p.alpha -= 0.016;

                if (p.alpha <= 0) {
                    celebrationParticles.splice(i, 1);
                    continue;
                }

                ctx.save();
                ctx.globalAlpha = p.alpha;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }

        celebrationAnimationId = requestAnimationFrame(renderCelebration);
    }

    if (celebrationAnimationId) cancelAnimationFrame(celebrationAnimationId);
    celebrationAnimationId = requestAnimationFrame(renderCelebration);

    setTimeout(() => {
        clearInterval(burstTimer);
        overlay.style.display = 'none';
        if (celebrationAnimationId) cancelAnimationFrame(celebrationAnimationId);
    }, 6000);
}
