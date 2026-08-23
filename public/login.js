(function () {
    const TOKEN_KEY = 'buquenque_auth_token';
    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        const opts = init ? Object.assign({}, init) : {};
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) {
            opts.headers = Object.assign({}, opts.headers, { Authorization: `Bearer ${token}` });
        }
        return originalFetch(input, opts);
    };
    window.buquenqueAuth = {
        setToken(token) { localStorage.setItem(TOKEN_KEY, token); },
        clearToken() { localStorage.removeItem(TOKEN_KEY); }
    };
})();

// Si ya hay una sesión activa, saltar directo al panel.
(async function checkExistingSession() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data && data.authenticated) {
            window.location.href = '/';
        }
    } catch (err) {
        // Silencioso: si falla, simplemente se queda en el login.
    }
})();

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submitBtn = document.getElementById('login-submit');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Entrando...';

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            if (data.token) window.buquenqueAuth.setToken(data.token);
            window.location.href = '/';
        } else {
            errorBox.textContent = data.message || 'No se pudo iniciar sesión.';
            errorBox.style.display = 'block';
        }
    } catch (err) {
        errorBox.textContent = 'Error de conexión. Intenta de nuevo.';
        errorBox.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-right-to-bracket"></i> Entrar';
    }
});
