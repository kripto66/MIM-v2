const API = mimApiBase();

const nextParam = new URLSearchParams(window.location.search).get('next');
let next = '../PartLocataires/LocaDash.html';
if (nextParam) {
    const isInternalPath = nextParam.startsWith('/') || nextParam.startsWith('./') || nextParam.startsWith('../');
    const hasScheme = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(nextParam);
    if (isInternalPath && !hasScheme && !nextParam.includes('\\')) {
        next = nextParam;
    }
}
const loginMessage = document.getElementById('loginMessage');
const usernameInput = document.getElementById('username');
const usernameStatus = document.getElementById('usernameStatus');
const usernameGroup = document.getElementById('usernameGroup');
const currentPasswordGroup = document.getElementById('currentPasswordGroup');
const currentPasswordInput = document.getElementById('current_password');
let currentUsername = '';

function usernameValid(u) {
    return /^[a-z0-9._-]{3,32}$/.test(u);
}

fetch(API + '/auth/me', { credentials: 'include' })
    .then((r) => r.json())
    .then((d) => {
        if (d.success && d.user && d.user.username) {
            currentUsername = d.user.username;
            usernameInput.value = currentUsername;
        } else {
            usernameGroup.style.display = 'none';
        }
        if (d.success && d.user) {
            currentPasswordGroup.style.display = d.user.must_change_password ? 'none' : 'block';
            if (!nextParam && d.user.account_type) {
                const zonePage = {
                    locataire: '../PartLocataires/LocaDash.html',
                    employe: '../PartEmployes/employe.html',
                    proprietaire: '../PartProprietaires/dashboard.html',
                }[d.user.account_type];
                if (zonePage) next = zonePage;
            }
        }
    })
    .catch(() => {
        usernameGroup.style.display = 'none';
    });

usernameInput.addEventListener('blur', async () => {
    const value = usernameInput.value.trim();
    if (!value || value === currentUsername) {
        usernameStatus.textContent = '';
        usernameStatus.className = '';
        return;
    }
    if (!usernameValid(value)) {
        usernameStatus.textContent = 'Lettres minuscules, chiffres, . _ - (3 à 32 caractères).';
        usernameStatus.className = 'username-status username-taken';
        return;
    }
    try {
        const resp = await fetch(API + '/auth/username-available?username=' + encodeURIComponent(value), {
            credentials: 'include',
        });
        const data = await resp.json();
        if (data.available) {
            usernameStatus.textContent = 'Disponible';
            usernameStatus.className = 'username-status username-ok';
        } else {
            usernameStatus.textContent = 'Ce nom d\'utilisateur est déjà utilisé.';
            usernameStatus.className = 'username-status username-taken';
        }
    } catch (err) {
        usernameStatus.textContent = '';
        usernameStatus.className = '';
    }
});

document.getElementById('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const message = document.getElementById('loginMessage');
    const button = form.querySelector('button[type="submit"]');

    clearFormErrors(form);
    message.textContent = '';
    message.className = '';

    const newUsername = usernameInput.value.trim();
    const pw = form.password.value;
    const confirm = form.password_confirm.value;
    const currentPassword = currentPasswordInput.value;

    let hasErrors = false;
    if (currentPasswordGroup.style.display !== 'none' && !currentPassword) {
        formFieldError(form, 'current_password', 'Veuillez saisir votre mot de passe actuel.');
        hasErrors = true;
    }
    if (newUsername && newUsername !== currentUsername) {
        if (!usernameValid(newUsername)) {
            formFieldError(form, 'username', 'Username invalide : lettres minuscules, chiffres, . _ - (3 à 32 caractères).');
            hasErrors = true;
        } else if (usernameStatus.className.includes('username-taken')) {
            formFieldError(form, 'username', 'Ce nom d\'utilisateur est déjà utilisé.');
            hasErrors = true;
        }
    }
    const pwRule = mimPasswordRuleMessage(pw);
    if (pwRule) {
        formFieldError(form, 'password', pwRule);
        hasErrors = true;
    }
    if (!confirm) {
        formFieldError(form, 'password_confirm', 'Veuillez confirmer votre mot de passe.');
        hasErrors = true;
    } else if (pw !== confirm) {
        formFieldError(form, 'password_confirm', 'Les mots de passe ne correspondent pas.');
        hasErrors = true;
    }
    if (hasErrors) return;

    button.disabled = true;
    button.textContent = 'Enregistrement...';

    try {
        const response = await fetch(API + '/auth/change-password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                password: form.password.value,
                password_confirm: form.password_confirm.value,
                current_password: currentPasswordGroup.style.display === 'none' ? undefined : currentPassword,
            })
        });

        const data = await response.json();

        if (!data.success) {
            message.textContent = data.message;
            message.className = 'error';
            applyServerErrors(form, data.errors);
            button.disabled = false;
            button.textContent = 'Enregistrer mes identifiants';
            return;
        }

        if (newUsername && newUsername !== currentUsername) {
            const usernameResp = await fetch(API + '/auth/update-username', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username: newUsername }),
            });
            const usernameData = await usernameResp.json();
            if (!usernameData.success) {
                message.textContent = usernameData.message || 'Mot de passe modifié, mais le username n\'a pas pu être enregistré.';
                message.className = 'error';
                applyServerErrors(form, usernameData.errors);
                button.disabled = false;
                button.textContent = 'Enregistrer mes identifiants';
                return;
            }
        }

        message.textContent = data.message;
        message.className = 'success';
        window.location.href = next;
    } catch (error) {
        console.error('Erreur:', error);
        message.textContent = 'Impossible de contacter le serveur.';
        message.className = 'error';
    }

    button.disabled = false;
    button.textContent = 'Enregistrer mes identifiants';
});
