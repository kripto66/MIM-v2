<?php

require_once "../config/database.php";

header("Content-Type: text/html; charset=UTF-8");

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Location: ../PartPublic/forgot.html");
    exit;
}

$email = trim($_POST["email"] ?? "");

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    echo "Adresse email invalide. <a href='../PartPublic/forgot.html'>Réessayer</a>";
    exit;
}

$stmt = $pdo->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
$stmt->execute([$email]);
$user = $stmt->fetch(PDO::FETCH_ASSOC);

/*
| On affiche le même message que l'email existe ou non,
| pour ne pas révéler les emails enregistrés.
*/
if (!$user) {
    echo "<p>Si cette adresse est enregistrée, un lien de réinitialisation a été envoyé.</p>";
    echo "<a href='../PartPublic/connexion.html'>Retour à la connexion</a>";
    exit;
}

$token = bin2hex(random_bytes(32));
$expireAt = date("Y-m-d H:i:s", time() + 3600);

$stmt = $pdo->prepare(
    "INSERT INTO password_resets (user_id, token, expire_at) VALUES (?, ?, ?)"
);
$stmt->execute([$user["id"], $token, $expireAt]);

$resetUrl = "http://" . $_SERVER["HTTP_HOST"] .
    "/MIM2.1/MIM/auth/reset_password.php?token=" . $token;

/*
| NOTE LOCAL : XAMPP n'a pas de serveur mail configuré.
| En production, remplacer cet echo par un envoi d'email :
| mail($email, "Réinitialisation de votre mot de passe", "...");
*/
echo "<p>Un lien de réinitialisation a été envoyé.</p>";
echo "<p style='color:#666;font-size:14px'>Mode local : <a href='"
    . htmlspecialchars($resetUrl)
    . "'>cliquez ici pour réinitialiser</a></p>";
echo "<a href='../PartPublic/connexion.html'>Retour à la connexion</a>";
exit;
