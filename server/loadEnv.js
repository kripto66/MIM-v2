// ============================================================
// MIM - Chargement de la configuration
//
// `dotenv/config` lit uniquement `.env` du RÉPERTOIRE COURANT :
//   - `node server.js` (dossier server/)  -> lit server/.env
//   - `npm start` / `npm run dev` (racine MIM) -> lit MIM/.env,
//     qui ne contient que les clés Google : SUPABASE_URL était donc
//     undefined et le serveur plantait au démarrage
//     (« supabaseUrl is required »).
//
// On charge donc explicitement les DEUX fichiers, server/.env en
// premier car il porte la configuration serveur (dotenv n'écrase pas
// une variable déjà définie).
// Seul point d'entrée : ce module doit être importé avant tout fichier
// qui lit process.env.
// ============================================================

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();
