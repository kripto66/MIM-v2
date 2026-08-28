const API = mimApiBase();

const loginMessage = document.getElementById('loginMessage');

const oauthError = new URLSearchParams(window.location.search).get('oauth_error');
if (oauthError) {
    const messages = {
        missing: 'Connexion Google interrompue. Veuillez réessayer.',
        expired: 'La session de connexion Google a expiré. Veuillez réessayer.',
        exchange: 'Impossible de finaliser la connexion Google.',
        server: 'Une erreur est survenue lors de la connexion Google.',
    };
    loginMessage.textContent = messages[oauthError] || 'La connexion Google a échoué.';
    loginMessage.className = 'error';
}

const loginError = new URLSearchParams(window.location.search).get('error');
if (loginError && MIM.MESSAGES[loginError]) {
    loginMessage.textContent = MIM.MESSAGES[loginError];
    loginMessage.className = 'error';
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const message = document.getElementById('loginMessage');
    const button = form.querySelector('button[type="submit"]');

    clearFormErrors(form);
    message.textContent = '';
    message.className = '';

    let hasErrors = false;
    if (!form.identifier.value.trim()) {
        formFieldError(form, 'identifier', 'Veuillez saisir votre username ou votre email.');
        hasErrors = true;
    }
    if (!form.password.value) {
        formFieldError(form, 'password', 'Veuillez saisir votre mot de passe.');
        hasErrors = true;
    }
    if (hasErrors) return;

    button.disabled = true;
    button.textContent = 'Connexion...';

    try {
        const response = await fetch(API + '/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                identifier: form.identifier.value,
                password: form.password.value
            })
        });

        const { ok, error, data } = await MIM.parse(response);

        if (ok) {
            message.textContent = data.message;
            message.className = 'success';
            if (data.mfaRequired) {
                window.location.href = '../' + data.redirect;
            } else if (data.mustChangePassword) {
                const next = data.redirect ? '../' + data.redirect : '../PartLocataires/LocaDash.html';
                window.location.href = 'change-password.html?next=' + encodeURIComponent(next);
            } else {
                window.location.href = '../' + data.redirect;
            }
        } else {
            message.textContent = MIM.userMessage(error);
            message.className = 'error';
            applyServerErrors(form, error.errors);
        }
    } catch (error) {
        console.error('Erreur:', error);
        message.textContent = 'Impossible de contacter le serveur.';
        message.className = 'error';
    }

    button.disabled = false;
    button.textContent = 'Se connecter';
});
