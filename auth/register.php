<?php

require_once "../config/database.php";

header("Content-Type: application/json; charset=UTF-8");


if ($_SERVER["REQUEST_METHOD"] !== "POST") {

    echo json_encode([
        "success" => false,
        "message" => "Méthode non autorisée."
    ]);

    exit;
}


$accountType = trim($_POST["account_type"] ?? "");

$name = trim($_POST["name"] ?? "");

$email = trim($_POST["email"] ?? "");

$phone = trim($_POST["phone"] ?? "");

$password = $_POST["password"] ?? "";

$passwordConfirm = $_POST["password_confirm"] ?? "";

$terms = $_POST["terms"] ?? "";


/*
|--------------------------------------------------------------------------
| Vérification des champs
|--------------------------------------------------------------------------
*/

if (
    $accountType === "" ||
    $name === "" ||
    $email === "" ||
    $phone === "" ||
    $password === "" ||
    $passwordConfirm === ""
) {

    echo json_encode([
        "success" => false,
        "message" => "Veuillez remplir tous les champs."
    ]);

    exit;
}


/*
|--------------------------------------------------------------------------
| Conditions
|--------------------------------------------------------------------------
*/

if ($terms === "") {

    echo json_encode([
        "success" => false,
        "message" => "Vous devez accepter les conditions."
    ]);

    exit;
}


/*
|--------------------------------------------------------------------------
| Type de compte
|--------------------------------------------------------------------------
*/

$allowedTypes = [

    "proprietaire",
    "agence",
    "entreprise"

];


if (!in_array($accountType, $allowedTypes, true)) {

    echo json_encode([
        "success" => false,
        "message" => "Type de compte invalide."
    ]);

    exit;
}


/*
|--------------------------------------------------------------------------
| Email
|--------------------------------------------------------------------------
*/

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {

    echo json_encode([
        "success" => false,
        "message" => "Adresse email invalide."
    ]);

    exit;
}


/*
|--------------------------------------------------------------------------
| Mot de passe
|--------------------------------------------------------------------------
*/

if (strlen($password) < 8) {

    echo json_encode([
        "success" => false,
        "message" => "Le mot de passe doit contenir au moins 8 caractères."
    ]);

    exit;
}


if ($password !== $passwordConfirm) {

    echo json_encode([
        "success" => false,
        "message" => "Les mots de passe ne correspondent pas."
    ]);

    exit;
}


/*
|--------------------------------------------------------------------------
| Vérification email existant
|--------------------------------------------------------------------------
*/

$check = $pdo->prepare(
    "SELECT id FROM users WHERE email = ? LIMIT 1"
);

$check->execute([$email]);


if ($check->fetch()) {

    echo json_encode([
        "success" => false,
        "message" => "Cette adresse email est déjà utilisée."
    ]);

    exit;
}


/*
|--------------------------------------------------------------------------
| Hash du mot de passe
|--------------------------------------------------------------------------
*/

$passwordHash = password_hash(
    $password,
    PASSWORD_DEFAULT
);


/*
|--------------------------------------------------------------------------
| Création du compte
|--------------------------------------------------------------------------
*/

try {

    $sql = "
        INSERT INTO users
        (
            account_type,
            name,
            email,
            phone,
            password,
            role
        )

        VALUES
        (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
        )
    ";


    $stmt = $pdo->prepare($sql);


    $stmt->execute([

        $accountType,

        $name,

        $email,

        $phone,

        $passwordHash,

        $accountType

    ]);


    session_start();

    session_regenerate_id(true);

    $_SESSION["user_id"] = $pdo->lastInsertId();

    $_SESSION["name"] = $name;

    $_SESSION["email"] = $email;

    $_SESSION["account_type"] = $accountType;

    echo json_encode([

        "success" => true,

        "message" => "Compte créé avec succès."
        

    ]);

    exit;


} catch (PDOException $e) {

    /*
    | Ne jamais afficher directement $e->getMessage()
    | à l'utilisateur en production.
    */

    echo json_encode([

        "success" => false,

        "message" =>
            "Une erreur est survenue lors de la création du compte."

    ]);

    exit;
}