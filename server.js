import express from "express";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

const TOKEN_DIR = process.env.TOKEN_DIR || "/app/data";
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.json");

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

let storedTokens = null;

/* -----------------------------
   Persistent token storage
----------------------------- */

function ensureTokenDirectory() {
  if (!fs.existsSync(TOKEN_DIR)) {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
  }
}

function saveTokens(tokens) {
  ensureTokenDirectory();

  // Keep the existing refresh token when Google only returns
  // a new access token.
  storedTokens = {
    ...(storedTokens || {}),
    ...tokens
  };

  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify(storedTokens),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );

  oauth2Client.setCredentials(storedTokens);
}

function loadTokens() {
  try {
    ensureTokenDirectory();

    if (!fs.existsSync(TOKEN_FILE)) {
      console.log("No saved YouTube OAuth credentials found.");
      return;
    }

    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    const tokens = JSON.parse(raw);

    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);

    console.log("Saved YouTube OAuth credentials loaded.");
  } catch (error) {
    console.error(
      "Unable to load saved YouTube credentials:",
      error.message
    );
  }
}

// Google can issue refreshed access tokens automatically.
// Save them without logging the token values.
oauth2Client.on("tokens", (tokens) => {
  try {
    saveTokens(tokens);
    console.log("YouTube OAuth credentials refreshed.");
  } catch (error) {
    console.error(
      "Unable to persist refreshed OAuth credentials:",
      error.message
    );
  }
});

loadTokens();

/* -----------------------------
   Routes
----------------------------- */

app.get("/", (req, res) => {
  res.send(`
    <h1>YouTube Motivation Automation</h1>
    <p>Server is running 🚀</p>

    <p>
      YouTube status:
      <strong>${storedTokens ? "Connected ✅" : "Not connected"}</strong>
    </p>

    <a href="/auth/google">Connect YouTube</a>
    <br><br>
    <a href="/status">Check Connection</a>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

app.get("/status", (req, res) => {
  res.json({
    connected: Boolean(storedTokens),
    persistentStorage: true,
    server: "running"
  });
});

/* -----------------------------
   Google OAuth
----------------------------- */

app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [
      "https://www.googleapis.com/auth/youtube.upload"
    ]
  });

  res.redirect(authUrl);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res
        .status(400)
        .send("Authorization code missing.");
    }

    const { tokens } = await oauth2Client.getToken(code);

    saveTokens(tokens);

    console.log(
      "YouTube OAuth connection successfully saved."
    );

    res.send(`
      <h1>✅ YouTube Connected</h1>
      <p>Your YouTube authorization has been saved persistently.</p>
      <p>You should not need to reconnect after every Railway restart.</p>
      <br>
      <a href="/status">Check connection status</a>
    `);
  } catch (error) {
    console.error(
      "OAuth callback failed:",
      error.message
    );

    res
      .status(500)
      .send("YouTube authorization failed.");
  }
});

/* -----------------------------
   Start server
----------------------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
