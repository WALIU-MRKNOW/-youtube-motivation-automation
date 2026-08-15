import express from "express";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// Persist tokens to the Railway persistent volume
const TOKEN_PATH = '/app/data/youtube-token.json';
const LEGACY_TOKEN_FILE = path.join('/app/data', 'tokens.json');

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
  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeCredentialsFile() {
  // Write the COMPLETE credentials object from the oauth2 client
  // Do NOT log or expose token values.
  ensureTokenDirectory();
  try {
    fs.writeFileSync(
      TOKEN_PATH,
      JSON.stringify(oauth2Client.credentials, null, 2),
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );
  } catch (err) {
    console.error('Unable to persist YouTube OAuth credentials:', err.message);
  }
}

function saveTokens(tokens) {
  ensureTokenDirectory();

  // Load existing credentials if we don't have them in memory
  if (!storedTokens) {
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
        storedTokens = JSON.parse(raw);
      }
    } catch (err) {
      // ignore parse errors; we'll overwrite below
      storedTokens = storedTokens || {};
    }
  }

  // Merge incoming tokens with existing credentials.
  // Preserve refresh_token when Google only returns a new access token.
  const merged = {
    ...(storedTokens || {}),
    ...(tokens || {})
  };

  storedTokens = merged;

  // Apply to oauth client and persist the COMPLETE credentials object
  oauth2Client.setCredentials(merged);
  writeCredentialsFile();
}

function loadTokens() {
  try {
    ensureTokenDirectory();

    // Prefer the canonical TOKEN_PATH. If not present, check legacy file and migrate.
    if (!fs.existsSync(TOKEN_PATH) && fs.existsSync(LEGACY_TOKEN_FILE)) {
      try {
        const rawLegacy = fs.readFileSync(LEGACY_TOKEN_FILE, 'utf8');
        const legacy = JSON.parse(rawLegacy);
        // set credentials and write to the canonical path
        oauth2Client.setCredentials(legacy);
        storedTokens = legacy;
        writeCredentialsFile();
        console.log('Loaded saved YouTube OAuth credentials');
        return;
      } catch (err) {
        // If migration fails, continue and try canonical path below
      }
    }

    if (!fs.existsSync(TOKEN_PATH)) {
      console.log('No saved YouTube OAuth credentials found.');
      return;
    }

    const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
    const tokens = JSON.parse(raw);

    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);

    console.log('Loaded saved YouTube OAuth credentials');
  } catch (error) {
    // Do not log secrets
    console.error('Unable to load saved YouTube credentials:', error.message);
  }
}

// Listen for Google's token events and persist changes.
// Do not expose token values in logs.
oauth2Client.on('tokens', (tokens) => {
  try {
    // tokens may include only access_token/expiry_date
    saveTokens(tokens);
    console.log('YouTube OAuth credentials refreshed.');
  } catch (error) {
    console.error('Unable to persist refreshed OAuth credentials:', error.message);
  }
});

loadTokens();

/* -----------------------------
   Routes
----------------------------- */

app.get('/', (req, res) => {
  res.send(`
    <h1>YouTube Motivation Automation</h1>
    <p>Server is running 🚀</p>

    <p>
      YouTube status:
      <strong>${storedTokens ? 'Connected ✅' : 'Not connected'}</strong>
    </p>

    <a href="/auth/google">Connect YouTube</a>
    <br><br>
    <a href="/status">Check Connection</a>
  `);
});

app.get('/health', (req, res) => {
  // persistentStorage is true if the storage directory exists and is writable
  const persistentStorage = fs.existsSync(path.dirname(TOKEN_PATH));
  res.json({
    connected: Boolean(storedTokens),
    persistentStorage: Boolean(persistentStorage),
    server: 'running'
  });
});

app.get('/status', (req, res) => {
  const persistentStorage = fs.existsSync(path.dirname(TOKEN_PATH));
  res.json({
    connected: Boolean(storedTokens),
    persistentStorage: Boolean(persistentStorage),
    server: 'running'
  });
});

/* -----------------------------
   Google OAuth
----------------------------- */

app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [
      'https://www.googleapis.com/auth/youtube.upload'
    ]
  });

  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res
        .status(400)
        .send('Authorization code missing.');
    }

    const { tokens } = await oauth2Client.getToken(code);

    // Save the returned tokens (merge with any existing refresh_token)
    saveTokens(tokens);

    // Ensure the COMPLETE credentials object is persisted
    writeCredentialsFile();

    console.log('YouTube OAuth connection successfully saved.');

    res.send(`
      <h1>✅ YouTube Connected</h1>
      <p>Your YouTube authorization has been saved persistently.</p>
      <p>You should not need to reconnect after every Railway restart.</p>
      <br>
      <a href="/status">Check connection status</a>
    `);
  } catch (error) {
    console.error('OAuth callback failed:', error.message);

    res
      .status(500)
      .send('YouTube authorization failed.');
  }
});

/* -----------------------------
   Start server
----------------------------- */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
