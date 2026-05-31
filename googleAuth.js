// core/googleAuth.js
// Einmalig ausführen um den Refresh Token zu bekommen:
// node core/googleAuth.js

import { google } from "googleapis";
import http from "http";
import { URL } from "url";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "http://localhost:3001/oauth2callback"
);

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent", // Erzwingt Refresh Token
});

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Google OAuth Setup");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("\n1. Öffne diese URL im Browser:\n");
console.log(authUrl);
console.log("\n2. Logge dich ein und erteile die Kalender-Berechtigung");
console.log("3. Der Refresh Token wird hier angezeigt\n");

// Lokaler Server fängt den OAuth Callback ab
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) return;

  const qs = new URL(req.url, "http://localhost:3001").searchParams;
  const code = qs.get("code");

  if (!code) {
    res.writeHead(400);
    res.end("Fehler: Kein Code erhalten");
    return;
  }

  const { tokens } = await oauth2Client.getToken(code);

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h2>✅ Authentifizierung erfolgreich! Schau in dein Terminal.</h2>");

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ Refresh Token erhalten!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("\nFüge folgendes in deine .env ein:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  server.close();
  process.exit(0);
});

server.listen(3001, () => {
  console.log("Warte auf OAuth Callback auf Port 3001...\n");
});
