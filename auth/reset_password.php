<?php

require_once "../config/database.php";

$token = $_GET["token"] ?? "";

if ($token === "") {
    die("Lien invalide. <a href='../PartPublic/forgot.html'>Réessayer</a>");
}

$stmt = $pdo->prepare(
    "SELECT user_id FROM password_resets
     WHERE token = ? AND used = 0 AND expire_at > NOW() LIMIT 1"
);
$stmt->execute([$token]);
$reset = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$reset) {
    die("Ce lien est invalide ou a expiré. <a href='../PartPublic/forgot.html'>Réessayer</a>");
}

if ($_SERVER["REQUEST_METHOD"] === "POST") {

    $password = $_POST["password"] ?? "";
    $passwordConfirm = $_POST["password_confirm"] ?? "";

    if (strlen($password) < 8) {
        die("Le mot de passe doit contenir au moins 8 caractères.");
    }

    if ($password !== $passwordConfirm) {
        die("Les mots de passe ne correspondent pas.");
    }

    $hash = password_hash($password, PASSWORD_DEFAULT);

    $stmt = $pdo->prepare("UPDATE users SET password = ? WHERE id = ?");
    $stmt->execute([$hash, $reset["user_id"]]);

    $stmt = $pdo->prepare("UPDATE password_resets SET used = 1 WHERE token = ?");
    $stmt->execute([$token]);

    echo "<p>Votre mot de passe a été réinitialisé.</p>";
    echo "<a href='../PartPublic/connexion.html'>Se connecter</a>";
    exit;
}
?>

<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Réinitialiser le mot de passe — MIM</title>
</head>
<body>
    <h1>Nouveau mot de passe</h1>

    <form method="POST">

        <label for="password">Nouveau mot de passe</label>

        <input
            type="password"
            id="password"
            name="password"
            minlength="8"
            required
        >

        <br><br>

        <label for="password_confirm">Confirmer le mot de passe</label>

        <input
            type="password"
            id="password_confirm"
            name="password_confirm"
            minlength="8"
            required
        >

        <br><br>

        <button type="submit">
            Réinitialiser
        </button>

    </form>
</body>
</html>
