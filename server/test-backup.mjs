import "dotenv/config";
import { gitAutoBackup } from "./utils/gitBackup.js";
console.log("GIT_REPO_PATH =", process.env.GIT_REPO_PATH ? "ok" : "MISSING");
const result = await gitAutoBackup("Sauvegarde de test : chaque geste est sauvegardé");
console.log(JSON.stringify(result));
