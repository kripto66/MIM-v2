
        document.addEventListener("DOMContentLoaded", async () => {
            let currentUser = null;

            const profileForm = document.getElementById("profileForm");
            const profileSubmitBtn = document.getElementById("profileSubmitBtn");
            const usernameInput = document.getElementById("profileUsernameInput");
            const usernameStatus = document.getElementById("usernameStatus");

            const avatarImg = document.getElementById("avatarPreview");
            avatarImg.dataset.placeholder = avatarImg.src;

            function setAvatar(url) {
                if (url) {
                    avatarImg.src = url;
                    document.getElementById("avatarRemoveBtn").style.display = "";
                } else {
                    avatarImg.src = avatarImg.dataset.placeholder;
                    document.getElementById("avatarRemoveBtn").style.display = "none";
                }
            }

            document.getElementById("avatarInput").addEventListener("change", async (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) {
                    showTenantError("Photo trop lourde : 2 Mo maximum.");
                    e.target.value = "";
                    return;
                }
                if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
                    showTenantError("Format invalide : JPEG, PNG ou WebP uniquement.");
                    e.target.value = "";
                    return;
                }
                const reader = new FileReader();
                reader.onload = async () => {
                    try {
                        const res = await tenantRequest("/upload/avatar", {
                            method: "POST",
                            body: JSON.stringify({ dataUri: reader.result }),
                        });
                        setAvatar(res.avatar_url);
                        showTenantError("Photo de profil mise à jour.", true);
                    } catch (err) {
                        showTenantError(err.message);
                    }
                    e.target.value = "";
                };
                reader.readAsDataURL(file);
            });

            document.getElementById("avatarRemoveBtn").addEventListener("click", async () => {
                try {
                    await tenantRequest("/upload/avatar", { method: "DELETE" });
                    setAvatar(null);
                    showTenantError("Photo de profil supprimée.", true);
                } catch (err) {
                    showTenantError(err.message);
                }
            });

            function usernameValid(u) {
                return /^[a-z0-9._-]{3,30}$/.test(u);
            }

            async function checkUsernameAvailability() {
                const value = usernameInput.value.trim();
                if (!value) {
                    usernameStatus.textContent = "";
                    return;
                }
                if (!usernameValid(value)) {
                    usernameStatus.textContent = "Lettres minuscules, chiffres, . _ - (3 à 30 caractères).";
                    usernameStatus.className = "username-status username-taken";
                    return;
                }
                if (currentUser && value === currentUser.username) {
                    usernameStatus.textContent = "";
                    return;
                }
                try {
                    const { available } = await tenantRequest(
                        "/auth/username-available?username=" + encodeURIComponent(value)
                    );
                    if (available) {
                        usernameStatus.textContent = "Disponible";
                        usernameStatus.className = "username-status username-ok";
                    } else {
                        usernameStatus.textContent = "Ce nom d'utilisateur est déjà utilisé.";
                        usernameStatus.className = "username-status username-taken";
                    }
                } catch (err) {
                    usernameStatus.textContent = "";
                }
            }

            try {
                const { user } = await tenantRequest("/auth/me");
                currentUser = user;
                document.getElementById("profileNameInput").value = user.name || "";
                document.getElementById("profileUsernameInput").value = user.username || "";
                document.getElementById("profileEmail").value = user.email || "";
                document.getElementById("profilePhoneInput").value = user.phone || "";
                setAvatar(user.avatar_url || null);
            } catch (err) {
                showTenantError(err.message);
            }

            usernameInput.addEventListener("blur", checkUsernameAvailability);

            profileForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                if (profileSubmitBtn.disabled) return;

                clearFormErrors(profileForm);
                const message = document.getElementById("profileMessage");
                message.style.display = "none";

                const newUsername = usernameInput.value.trim();

                let hasErrors = false;
                if (!profileForm.name.value.trim()) {
                    formFieldError(profileForm, "name", "Le nom complet est obligatoire.");
                    hasErrors = true;
                }
                if (!newUsername) {
                    formFieldError(profileForm, "username", "Le username est obligatoire.");
                    hasErrors = true;
                } else if (!usernameValid(newUsername)) {
                    formFieldError(profileForm, "username", "Username invalide : lettres minuscules, chiffres, . _ - (3 à 30 caractères).");
                    hasErrors = true;
                }
                if (hasErrors) return;

                profileSubmitBtn.disabled = true;
                profileSubmitBtn.textContent = "Enregistrement...";

                try {
                    if (newUsername && currentUser && newUsername !== currentUser.username) {
                        await tenantRequest("/auth/update-username", {
                            method: "PUT",
                            body: JSON.stringify({ username: newUsername }),
                        });
                    }

                    await tenantRequest("/auth/update-profile", {
                        method: "PUT",
                        body: JSON.stringify({
                            name: document.getElementById("profileNameInput").value.trim(),
                            phone: document.getElementById("profilePhoneInput").value.trim(),
                        }),
                    });
                    message.textContent = "Profil mis à jour avec succès.";
                    message.className = "tenant-message success";
                    message.style.display = "block";
                    usernameStatus.textContent = "";
                    currentUser = { ...currentUser, username: newUsername };
                    loadTenantIdentity();
                } catch (err) {
                    applyServerErrors(profileForm, err.errors);
                    message.textContent = err.message;
                    message.className = "tenant-message danger";
                    message.style.display = "block";
                } finally {
                    profileSubmitBtn.disabled = false;
                    profileSubmitBtn.textContent = "Enregistrer les modifications";
                }
            });

            const passwordForm = document.getElementById("passwordForm");
            const passwordSubmitBtn = document.getElementById("passwordSubmitBtn");

            passwordForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                if (passwordSubmitBtn.disabled) return;

                clearFormErrors(passwordForm);
                const message = document.getElementById("passwordMessage");
                message.style.display = "none";

                const newPassword = passwordForm.password.value;
                const confirmPassword = passwordForm.password_confirm.value;

                let hasErrors = false;
                if (!passwordForm.current_password.value) {
                    formFieldError(passwordForm, "current_password", "Saisissez votre mot de passe actuel.");
                    hasErrors = true;
                }
                const pwRule = mimPasswordRuleMessage(newPassword);
                if (pwRule) {
                    formFieldError(passwordForm, "password", pwRule);
                    hasErrors = true;
                }
                if (!confirmPassword) {
                    formFieldError(passwordForm, "password_confirm", "Confirmez votre nouveau mot de passe.");
                    hasErrors = true;
                } else if (newPassword !== confirmPassword) {
                    formFieldError(passwordForm, "password_confirm", "Les mots de passe ne correspondent pas.");
                    hasErrors = true;
                }
                if (hasErrors) return;

                passwordSubmitBtn.disabled = true;
                passwordSubmitBtn.textContent = "Modification...";

                try {
                    await tenantRequest("/auth/change-password", {
                        method: "PUT",
                        body: JSON.stringify({
                            current_password: passwordForm.current_password.value,
                            password: newPassword,
                            password_confirm: confirmPassword,
                        }),
                    });
                    message.textContent = "Mot de passe modifié avec succès.";
                    message.className = "tenant-message success";
                    message.style.display = "block";
                    e.target.reset();
                } catch (err) {
                    applyServerErrors(passwordForm, err.errors);
                    message.textContent = err.message;
                    message.className = "tenant-message danger";
                    message.style.display = "block";
                } finally {
                    passwordSubmitBtn.disabled = false;
                    passwordSubmitBtn.textContent = "Changer le mot de passe";
                }
            });
        });
    