let celebrationCanvas = null;
let celebrationCtx = null;
let celebrationParticles = [];
let celebrationAnimationId = null;

function initCelebrationCanvas() {
    if (!celebrationCanvas) {
        celebrationCanvas = document.createElement('canvas');
        celebrationCanvas.id = 'celebration-canvas';
        celebrationCanvas.style.position = 'fixed';
        celebrationCanvas.style.top = '0';
        celebrationCanvas.style.left = '0';
        celebrationCanvas.style.width = '100vw';
        celebrationCanvas.style.height = '100vh';
        celebrationCanvas.style.pointerEvents = 'none';
        celebrationCanvas.style.zIndex = '5000';
        document.body.appendChild(celebrationCanvas);
        celebrationCtx = celebrationCanvas.getContext('2d');
        window.addEventListener('resize', resizeCelebrationCanvas);
    }
    resizeCelebrationCanvas();
}

function resizeCelebrationCanvas() {
    if (celebrationCanvas) {
        celebrationCanvas.width = window.innerWidth;
        celebrationCanvas.height = window.innerHeight;
    }
}

function triggerCelebration(durationMs = 4000) {
    initCelebrationCanvas();
    celebrationParticles = [];
    const colors = ['#facc15', '#38bdf8', '#ef4444', '#10b981', '#a855f7', '#fb923c'];

    for (let i = 0; i < 150; i++) {
        celebrationParticles.push({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
            vx: (Math.random() - 0.5) * 16,
            vy: (Math.random() - 0.7) * 18,
            size: Math.random() * 8 + 4,
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: Math.random() * 360,
            vRot: (Math.random() - 0.5) * 10,
            opacity: 1,
            decay: Math.random() * 0.015 + 0.005
        });
    }

    if (celebrationAnimationId) cancelAnimationFrame(celebrationAnimationId);
    const startTime = Date.now();

    function renderFrame() {
        celebrationCtx.clearRect(0, 0, celebrationCanvas.width, celebrationCanvas.height);
        let stillAlive = false;

        celebrationParticles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.35;
            p.rotation += p.vRot;
            p.opacity -= p.decay;

            if (p.opacity > 0) {
                stillAlive = true;
                celebrationCtx.save();
                celebrationCtx.globalAlpha = Math.max(0, p.opacity);
                celebrationCtx.translate(p.x, p.y);
                celebrationCtx.rotate((p.rotation * Math.PI) / 180);
                celebrationCtx.fillStyle = p.color;
                celebrationCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p
