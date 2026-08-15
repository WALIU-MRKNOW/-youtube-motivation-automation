import express from "express";
import { google } from "googleapis";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ------------------------------------
// OpenAI
// ------------------------------------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ------------------------------------
// YouTube OAuth persistent storage
// ------------------------------------

const TOKEN_PATH = "/app/data/youtube-token.json";
const LEGACY_TOKEN_FILE = path.join("/app/data", "tokens.json");

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

let storedTokens = null;

function ensureTokenDirectory() {
  const dir = path.dirname(TOKEN_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeCredentialsFile() {
  ensureTokenDirectory();

  try {
    fs.writeFileSync(
      TOKEN_PATH,
      JSON.stringify(oauth2Client.credentials, null, 2),
      {
        encoding: "utf8",
        mode: 0o600
      }
    );
  } catch (error) {
    console.error(
      "Unable to persist YouTube OAuth credentials:",
      error.message
    );
  }
}

function saveTokens(tokens = {}) {
  ensureTokenDirectory();

  if (!storedTokens && fs.existsSync(TOKEN_PATH)) {
    try {
      storedTokens = JSON.parse(
        fs.readFileSync(TOKEN_PATH, "utf8")
      );
    } catch {
      storedTokens = {};
    }
  }

  const merged = {
    ...(storedTokens || {}),
    ...tokens
  };

  storedTokens = merged;

  oauth2Client.setCredentials(merged);
  writeCredentialsFile();
}

function loadTokens() {
  try {
    ensureTokenDirectory();

    if (
      !fs.existsSync(TOKEN_PATH) &&
      fs.existsSync(LEGACY_TOKEN_FILE)
    ) {
      try {
        const legacy = JSON.parse(
          fs.readFileSync(LEGACY_TOKEN_FILE, "utf8")
        );

        storedTokens = legacy;
        oauth2Client.setCredentials(legacy);
        writeCredentialsFile();

        console.log(
          "Loaded saved YouTube OAuth credentials"
        );

        return;
      } catch {
        // Continue normally
      }
    }

    if (!fs.existsSync(TOKEN_PATH)) {
      console.log(
        "No saved YouTube OAuth credentials found."
      );

      return;
    }

    const savedTokens = JSON.parse(
      fs.readFileSync(TOKEN_PATH, "utf8")
    );

    storedTokens = savedTokens;
    oauth2Client.setCredentials(savedTokens);

    console.log(
      "Loaded saved YouTube OAuth credentials"
    );

  } catch (error) {
    console.error(
      "Unable to load saved YouTube credentials:",
      error.message
    );
  }
}

oauth2Client.on("tokens", (tokens) => {
  try {
    saveTokens(tokens);

    console.log(
      "YouTube OAuth credentials refreshed."
    );

  } catch (error) {
    console.error(
      "Unable to persist refreshed OAuth credentials:",
      error.message
    );
  }
});

loadTokens();

// ------------------------------------
// System status
// ------------------------------------

function getSystemStatus() {
  return {
    connected: Boolean(storedTokens),
    openaiConfigured: Boolean(
      process.env.OPENAI_API_KEY
    ),
    persistentStorage:
      fs.existsSync(path.dirname(TOKEN_PATH)),
    server: "running"
  };
}

// ------------------------------------
// Main routes
// ------------------------------------

app.get("/", (req, res) => {
  res.send(`
    <h1>YouTube Motivation Automation</h1>

    <p>Server is running 🚀</p>

    <p>
      YouTube:
      <strong>
        ${storedTokens ? "Connected ✅" : "Not connected"}
      </strong>
    </p>

    <p>
      OpenAI:
      <strong>
        ${
          process.env.OPENAI_API_KEY
            ? "Configured ✅"
            : "Missing"
        }
      </strong>
    </p>

    <br>

    <a href="/auth/google">
      Connect YouTube
    </a>

    <br><br>

    <a href="/status">
      Check System Status
    </a>

    <br><br>

    <a href="/test-voice">
      Test AI Voice
    </a>
  `);
});

app.get("/health", (req, res) => {
  res.json(getSystemStatus());
});

app.get("/status", (req, res) => {
  res.json(getSystemStatus());
});

// ------------------------------------
// AI motivational script generator
// ------------------------------------

app.post("/generate-script", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "OpenAI API is not configured."
      });
    }

    const {
      topic = "discipline and consistency",
      tone = "powerful, direct, cinematic",
      durationSeconds = 30
    } = req.body || {};

    const duration = Math.min(
      Math.max(Number(durationSeconds) || 30, 15),
      60
    );

    const response = await openai.responses.create({
      model: "gpt-5-mini",

      instructions: `
You create original motivational YouTube Shorts.

Writing must be:
- concise
- emotional
- modern
- natural when narrated
- attention-grabbing immediately

Never invent famous quotes.
Never reproduce copyrighted lyrics.
Never pretend celebrities said something they did not say.
      `,

      input: `
Create one motivational YouTube Short package.

Topic:
${topic}

Tone:
${tone}

Target narration:
Approximately ${duration} seconds.

Include:
- hook
- script
- title
- description
- hashtags
- visual suggestions
      `,

      text: {
        format: {
          type: "json_schema",
          name: "motivational_short",
          strict: true,

          schema: {
            type: "object",

            properties: {
              hook: {
                type: "string"
              },

              script: {
                type: "string"
              },

              title: {
                type: "string"
              },

              description: {
                type: "string"
              },

              hashtags: {
                type: "array",
                items: {
                  type: "string"
                },
                minItems: 3,
                maxItems: 8
              },

              visualDirection: {
                type: "array",
                items: {
                  type: "string"
                },
                minItems: 3,
                maxItems: 6
              }
            },

            required: [
              "hook",
              "script",
              "title",
              "description",
              "hashtags",
              "visualDirection"
            ],

            additionalProperties: false
          }
        }
      }
    });

    const content = JSON.parse(
      response.output_text
    );

    return res.json({
      success: true,
      topic,
      tone,
      durationSeconds: duration,
      content
    });

  } catch (error) {
    console.error(
      "Script generation failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error:
        "Unable to generate motivational content."
    });
  }
});

// ------------------------------------
// AI voice generator
// ------------------------------------

app.post("/generate-voice", async (req, res) => {
  try {
    const {
      text,
      voice = "onyx"
    } = req.body || {};

    if (!text) {
      return res.status(400).json({
        success: false,
        error: "Text is required."
      });
    }

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      instructions:
        "Speak with a confident cinematic motivational tone. Use natural pauses and emotional emphasis without shouting.",
      response_format: "mp3"
    });

    const audioBuffer = Buffer.from(
      await speech.arrayBuffer()
    );

    res.setHeader(
      "Content-Type",
      "audio/mpeg"
    );

    res.setHeader(
      "Content-Disposition",
      'inline; filename="motivation-voice.mp3"'
    );

    return res.send(audioBuffer);

  } catch (error) {
    console.error(
      "Voice generation failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error: "Unable to generate voiceover."
    });
  }
});

// ------------------------------------
// Easy Safari voice test
// ------------------------------------

app.get("/test-voice", async (req, res) => {
  try {
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "onyx",

      input:
        "Stop waiting to feel motivated. Discipline begins when the feeling disappears. Do the work today that your future self will thank you for.",

      instructions:
        "Speak with a confident cinematic motivational tone. Use natural pauses and emotional emphasis without shouting.",

      response_format: "mp3"
    });

    const audioBuffer = Buffer.from(
      await speech.arrayBuffer()
    );

    res.setHeader(
      "Content-Type",
      "audio/mpeg"
    );

    res.setHeader(
      "Content-Disposition",
      'inline; filename="motivation-test.mp3"'
    );

    return res.send(audioBuffer);

  } catch (error) {
    console.error(
      "Test voice generation failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error: "Unable to generate test voice."
    });
  }
});

// ------------------------------------
// Google OAuth
// ------------------------------------

app.get("/auth/google", (req, res) => {
  const authUrl =
    oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,

      scope: [
        "https://www.googleapis.com/auth/youtube.upload"
      ]
    });

  res.redirect(authUrl);
});

app.get(
  "/auth/google/callback",
  async (req, res) => {
    try {
      const { code } = req.query;

      if (!code) {
        return res
          .status(400)
          .send(
            "Authorization code missing."
          );
      }

      const { tokens } =
        await oauth2Client.getToken(code);

      saveTokens(tokens);

      console.log(
        "YouTube OAuth connection successfully saved."
      );

      return res.send(`
        <h1>✅ YouTube Connected</h1>

        <p>
          Your YouTube authorization has been saved.
        </p>

        <br>

        <a href="/status">
          Check system status
        </a>
      `);

    } catch (error) {
      console.error(
        "OAuth callback failed:",
        error.message
      );

      return res
        .status(500)
        .send(
          "YouTube authorization failed."
        );
    }
  }
);

// ------------------------------------
// Start Railway server
// ------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);
