<?php

session_start();

require_once "../config/database.php";

header("Content-Type: application/json; charset=UTF-8");


if ($_SERVER["REQUEST_METHOD"] !== "POST") {

    echo json_encode([
        "success" => false,
        "message" => "Méthode non autorisée."
    ]);

    exit;
}


$email = trim($_POST["email"] ?? "");

$password = $_POST["password"] ?? "";


/*
|--------------------------------------------------------------------------
| Vérification des champs
|--------------------------------------------------------------------------
*/

if ($email === "" || $password === "") {

    echo json_encode([
        "success" => false,
        "message" => "Veuillez remplir tous les champs."
    ]);

    exit;
}


if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {

    echo json_encode([
        "success" => false,
        "message" => "Adresse email invalide."
    ]);

    exit;
}


/*
|--------------------------------------------------------------------------
| Recherche de l'utilisateur
|--------------------------------------------------------------------------
*/

try {

    $stmt = $pdo->prepare(
        "SELECT id, name, email, password, account_type
         FROM users
         WHERE email = ?
         LIMIT 1"
    );

    $stmt->execute([$email]);

    $user = $stmt->fetch(PDO::FETCH_ASSOC);


    /*
    |----------------------------------------------------------------------
    | Identifiants invalides
    |----------------------------------------------------------------------
    | On renvoie volontairement le même message que l'email existe ou
    | non, pour ne pas révéler quels emails sont enregistrés.
    */

    if (!$user || !password_verify($password, $user["password"])) {

        echo json_encode([
            "success" => false,
            "message" => "Email ou mot de passe incorrect."
        ]);

        exit;
    }


    /*
    |----------------------------------------------------------------------
    | Connexion réussie
    |----------------------------------------------------------------------
    */

    session_regenerate_id(true);

    $_SESSION["user_id"] = $user["id"];

    $_SESSION["name"] = $user["name"];

    $_SESSION["email"] = $user["email"];

    $_SESSION["account_type"] = $user["account_type"];


    echo json_encode([

        "success" => true,

        "message" => "Connexion réussie.",

        "redirect" => "dashboard.html",

        "account_type" => $user["account_type"]

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
            "Une erreur est survenue lors de la connexion."

    ]);

    exit;
}
