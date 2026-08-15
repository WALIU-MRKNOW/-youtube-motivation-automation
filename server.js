import express from "express";
import { google } from "googleapis";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ----------------------------------------------------
// YouTube OAuth persistent storage
// ----------------------------------------------------

const TOKEN_PATH = "/app/data/youtube-token.json";
const LEGACY_TOKEN_FILE = "/app/data/tokens.json";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

let storedTokens = null;
let lastUpload = null;

function ensureTokenDirectory() {
  const dir = path.dirname(TOKEN_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeCredentialsFile() {
  try {
    ensureTokenDirectory();

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
      "Unable to persist YouTube credentials:",
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
      const legacyTokens = JSON.parse(
        fs.readFileSync(LEGACY_TOKEN_FILE, "utf8")
      );

      storedTokens = legacyTokens;
      oauth2Client.setCredentials(legacyTokens);

      writeCredentialsFile();

      console.log(
        "Loaded saved YouTube OAuth credentials"
      );

      return;
    }

    if (!fs.existsSync(TOKEN_PATH)) {
      console.log(
        "No saved YouTube OAuth credentials found."
      );
      return;
    }

    storedTokens = JSON.parse(
      fs.readFileSync(TOKEN_PATH, "utf8")
    );

    oauth2Client.setCredentials(storedTokens);

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

// ----------------------------------------------------
// Status helpers
// ----------------------------------------------------

function getSystemStatus() {
  return {
    connected: Boolean(storedTokens),
    openaiConfigured: Boolean(
      process.env.OPENAI_API_KEY
    ),
    pexelsConfigured: Boolean(
      process.env.PEXELS_API_KEY
    ),
    persistentStorage:
      fs.existsSync(path.dirname(TOKEN_PATH)),
    server: "running"
  };
}

async function checkFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------
// AI content generation
// ----------------------------------------------------

async function generateContent({
  topic,
  tone,
  durationSeconds
}) {
  const response =
    await openai.responses.create({
      model: "gpt-5-mini",

      instructions: `
You create high-retention original motivational YouTube Shorts.

Write concise, emotional, modern narration.

Never invent quotations from famous people.
Never reproduce copyrighted lyrics.
Never pretend a celebrity said something they did not say.

Also create exactly 4 short stock-video search phrases.
They should describe cinematic real-world footage available on a stock video platform.

Good search phrases:
- man running alone sunrise
- athlete training dark gym
- city night walking
- mountain sunrise silhouette

Avoid abstract phrases like:
- success
- motivation
- become stronger
      `,

      input: `
Create one motivational YouTube Short.

Topic:
${topic}

Tone:
${tone}

Target duration:
About ${durationSeconds} seconds.

Create:
- hook
- narration script
- YouTube title
- SEO description
- hashtags
- exactly 4 Pexels video search phrases that visually match the narration
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

              sceneQueries: {
                type: "array",
                items: {
                  type: "string"
                },
                minItems: 4,
                maxItems: 4
              }
            },

            required: [
              "hook",
              "script",
              "title",
              "description",
              "hashtags",
              "sceneQueries"
            ],

            additionalProperties: false
          }
        }
      }
    });

  return JSON.parse(
    response.output_text
  );
}

// ----------------------------------------------------
// OpenAI voice
// ----------------------------------------------------

async function generateVoice(
  text,
  outputPath
) {
  const speech =
    await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "onyx",

      input: text,

      instructions:
        "Speak with a confident cinematic motivational tone. " +
        "Use natural pauses and emotional emphasis. " +
        "Sound powerful but do not shout.",

      response_format: "mp3"
    });

  const buffer = Buffer.from(
    await speech.arrayBuffer()
  );

  await fs.promises.writeFile(
    outputPath,
    buffer
  );
}

// ----------------------------------------------------
// Pexels video search
// ----------------------------------------------------

function chooseBestPexelsFile(video) {
  const files = (video.video_files || [])
    .filter(file =>
      file.file_type === "video/mp4"
    )
    .filter(file =>
      file.width && file.height
    )
    .sort((a, b) => {
      const aPortrait =
        a.height > a.width ? 1 : 0;

      const bPortrait =
        b.height > b.width ? 1 : 0;

      if (aPortrait !== bPortrait) {
        return bPortrait - aPortrait;
      }

      const aArea =
        a.width * a.height;

      const bArea =
        b.width * b.height;

      return bArea - aArea;
    });

  return files[0] || null;
}

async function searchPexelsVideo(query) {
  if (!process.env.PEXELS_API_KEY) {
    throw new Error(
      "Pexels API is not configured."
    );
  }

  const url =
    new URL(
      "https://api.pexels.com/v1/videos/search"
    );

  url.searchParams.set(
    "query",
    query
  );

  url.searchParams.set(
    "orientation",
    "portrait"
 
