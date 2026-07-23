(function() {
    var COLORS = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff6bff', '#ffb347', '#00d2d3'];

    function spawn(e) {
        for (var i = 0; i < 25; i++) {
            var el = document.createElement('div');
            el.className = 'fun-confetti';
            el.style.left = (e.clientX + (Math.random() - 0.5) * 40) + 'px';
            el.style.top = (e.clientY + (Math.random() - 0.5) * 40) + 'px';
            el.style.background = COLORS[Math.floor(Math.random() * COLORS.length)];
            el.style.setProperty('--dx', (Math.random() - 0.5) * 250 + 'px');
            el.style.setProperty('--dy', (Math.random() * -250 - 80) + 'px');
            el.style.setProperty('--r', Math.random() * 720 + 'deg');
            el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
            document.body.appendChild(el);
            setTimeout(function() { el.remove(); }, 1200);
        }
    }

    function start() {
        document.addEventListener('click', spawn);
    }

    function cleanup() {
        document.removeEventListener('click', spawn);
    }

    window.__funEffectsCleanup = window.__funEffectsCleanup || [];
    window.__funEffectsCleanup.push(cleanup);
    start();
})();
