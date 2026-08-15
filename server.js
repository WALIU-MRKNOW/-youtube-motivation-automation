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
        fs.readFileSync(
          LEGACY_TOKEN_FILE,
          "utf8"
        )
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
// Helpers
// ----------------------------------------------------

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

async function checkFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function generateContent({
  topic,
  tone,
  durationSeconds
}) {
  const response = await openai.responses.create({
    model: "gpt-5-mini",

    instructions: `
You create highly engaging original motivational
YouTube Shorts.

Write concise, emotional, modern narration.

Never invent quotations from famous people.
Never reproduce copyrighted song lyrics.
Never pretend a celebrity said something they did not say.

The first sentence must immediately grab attention.
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
            }
          },

          required: [
            "hook",
            "script",
            "title",
            "description",
            "hashtags"
          ],

          additionalProperties: false
        }
      }
    }
  });

  return JSON.parse(response.output_text);
}

async function generateVoice(text, outputPath) {
  const speech = await openai.audio.speech.create({
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

async function getAudioDuration(audioPath) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath
    ]
  );

  return Number(stdout.trim());
}

function escapeAssText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\n/g, " ");
}

function secondsToAssTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor(
    (seconds % 3600) / 60
  );

  const secs = seconds % 60;

  return `${hrs}:${String(mins).padStart(
    2,
    "0"
  )}:${secs.toFixed(2).padStart(5, "0")}`;
}

function createAssCaptions(
  script,
  duration,
  outputPath
) {
  const words = script
    .trim()
    .split(/\s+/);

  const wordsPerCaption = 5;

  const chunks = [];

  for (
    let i = 0;
    i < words.length;
    i += wordsPerCaption
  ) {
    chunks.push(
      words.slice(i, i + wordsPerCaption).join(" ")
    );
  }

  const chunkDuration =
    duration / chunks.length;

  let events = "";

  chunks.forEach((chunk, index) => {
    const start =
      index * chunkDuration;

    const end =
      Math.min(
        duration,
        (index + 1) * chunkDuration
      );

    events +=
      `Dialogue: 0,` +
      `${secondsToAssTime(start)},` +
      `${secondsToAssTime(end)},` +
      `Default,,0,0,0,,` +
      `${escapeAssText(chunk)}\n`;
  });

  const ass = `
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,DejaVu Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,320,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${events}
`;

  fs.writeFileSync(
    outputPath,
    ass.trim()
  );
}

async function renderVideo({
  audioPath,
  subtitlePath,
  videoPath
}) {
  const subtitleFilter =
    `subtitles=${subtitlePath}`;

  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-f",
      "lavfi",

      "-i",
      "color=c=0x090909:s=1080x1920:r=30",

      "-i",
      audioPath,

      "-vf",
      subtitleFilter,

      "-c:v",
      "libx264",

      "-preset",
      "fast",

      "-crf",
      "23",

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "192k",

      "-shortest",

      "-movflags",
      "+faststart",

      videoPath
    ]
  );
}

async function uploadToYouTube({
  videoPath,
  title,
  description,
  hashtags
}) {
  if (!storedTokens) {
    throw new Error(
      "YouTube is not connected."
    );
  }

  oauth2Client.setCredentials(storedTokens);

  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client
  });

  const finalDescription =
    `${description}\n\n${hashtags.join(" ")}`;

  const result =
    await youtube.videos.insert({
      part: [
        "snippet",
        "status"
      ],

      requestBody: {
        snippet: {
          title:
            title.slice(0, 100),

          description:
            finalDescription.slice(
              0,
              5000
            ),

          tags: hashtags
            .map(tag =>
              tag.replace("#", "")
            )
            .slice(0, 15),

          categoryId: "22"
        },

        status: {
          privacyStatus: "private",
          selfDeclaredMadeForKids: false
        }
      },

      media: {
        body:
          fs.createReadStream(
            videoPath
          )
      }
    });

  return result.data.id;
}

// ----------------------------------------------------
// Main page — easy phone control
// ----------------------------------------------------

app.get("/", (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Motivation Automation</title>

<style>
body {
  font-family: Arial, sans-serif;
  max-width: 700px;
  margin: 40px auto;
  padding: 20px;
  background: #0b0b0b;
  color: white;
}

input, button {
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  margin-top: 12px;
  font-size: 16px;
}

button {
  background: white;
  color: black;
  font-weight: bold;
  border: 0;
  border-radius: 8px;
}

#result {
  white-space: pre-wrap;
  margin-top: 24px;
}
</style>
</head>

<body>

<h1>Motivation Shorts Engine 🚀</h1>

<p>
YouTube:
<strong>
${storedTokens ? "Connected ✅" : "Not connected"}
</strong>
</p>

<p>
OpenAI:
<strong>
${process.env.OPENAI_API_KEY ? "Configured ✅" : "Missing"}
</strong>
</p>

<input
  id="topic"
  placeholder="Topic"
  value="stop waiting for motivation"
/>

<button onclick="createShort()">
Generate Private YouTube Short
</button>

<p id="result"></p>

<script>

async function createShort() {

  const result =
    document.getElementById("result");

  result.textContent =
    "Generating script, voice and video...";

  try {

    const response = await fetch(
      "/create-short",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          topic:
            document.getElementById(
              "topic"
            ).value
        })
      }
    );

    const data =
      await response.json();

    result.textContent =
      JSON.stringify(
        data,
        null,
        2
      );

  } catch (error) {

    result.textContent =
      error.message;
  }
}

</script>

</body>
</html>
  `);
});

// ----------------------------------------------------
// Status
// ----------------------------------------------------

app.get("/status", async (req, res) => {
  res.json({
    ...getSystemStatus(),
    ffmpeg: await checkFfmpeg()
  });
});

app.get("/health", (req, res) => {
  res.json(getSystemStatus());
});

app.get("/last-upload", (req, res) => {
  res.json({
    lastUpload
  });
});

// ----------------------------------------------------
// FULL SHORT PIPELINE
// ----------------------------------------------------

app.post(
  "/create-short",
  async (req, res) => {

    const jobId =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    const workDir =
      path.join(
        os.tmpdir(),
        `short-${jobId}`
      );

    try {

      if (
        !process.env.OPENAI_API_KEY
      ) {
        return res.status(500).json({
          success: false,
          error:
            "OpenAI API is not configured."
        });
      }

      if (!storedTokens) {
        return res.status(401).json({
          success: false,
          error:
            "YouTube is not connected."
        });
      }

      if (!(await checkFfmpeg())) {
        return res.status(500).json({
          success: false,
          error:
            "FFmpeg is not installed."
        });
      }

      const {
        topic =
          "discipline and consistency",

        tone =
          "powerful, cinematic and direct",

        durationSeconds = 30
      } = req.body || {};

      const duration =
        Math.min(
          Math.max(
            Number(durationSeconds) ||
              30,
            15
          ),
          60
        );

      await fs.promises.mkdir(
        workDir,
        {
          recursive: true
        }
      );

      const audioPath =
        path.join(
          workDir,
          "voice.mp3"
        );

      const subtitlePath =
        path.join(
          workDir,
          "captions.ass"
        );

      const videoPath =
        path.join(
          workDir,
          "short.mp4"
        );

      // 1. Generate content
      const content =
        await generateContent({
          topic,
          tone,
          durationSeconds: duration
        });

      // 2. Generate voice
      await generateVoice(
        content.script,
        audioPath
      );

      // 3. Get actual narration length
      const actualDuration =
        await getAudioDuration(
          audioPath
        );

      // 4. Generate captions
      createAssCaptions(
        content.script,
        actualDuration,
        subtitlePath
      );

      // 5. Render vertical MP4
      await renderVideo({
        audioPath,
        subtitlePath,
        videoPath
      });

      // 6. Upload privately
      const youtubeVideoId =
        await uploadToYouTube({
          videoPath,

          title:
            content.title,

          description:
            content.description,

          hashtags:
            content.hashtags
        });

      lastUpload = {
        videoId:
          youtubeVideoId,

        title:
          content.title,

        createdAt:
          new Date().toISOString(),

        privacyStatus:
          "private"
      };

      return res.json({
        success: true,

        youtubeVideoId,

        privacyStatus:
          "private",

        content
      });

    } catch (error) {

      console.error(
        "Create short failed:",
        error.message
      );

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Unable to create Short."
      });

    } finally {

      fs.promises.rm(
        workDir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }
);

// ----------------------------------------------------
// Existing voice test
// ----------------------------------------------------

app.get(
  "/test-voice",
  async (req, res) => {

    try {

      const speech =
        await openai.audio.speech.create({
          model:
            "gpt-4o-mini-tts",

          voice:
            "onyx",

          input:
            "Discipline begins when motivation disappears.",

          instructions:
            "Speak with a confident cinematic motivational tone.",

          response_format:
            "mp3"
        });

      const audioBuffer =
        Buffer.from(
          await speech.arrayBuffer()
        );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      return res.send(
        audioBuffer
      );

    } catch (error) {

      return res.status(500).json({
        success: false,
        error:
          "Unable to generate test voice."
      });
    }
  }
);

// ----------------------------------------------------
// Google OAuth
// ----------------------------------------------------

app.get(
  "/auth/google",
  (req, res) => {

    const authUrl =
      oauth2Client.generateAuthUrl({
        access_type:
          "offline",

        prompt:
          "consent",

        include_granted_scopes:
          true,

        scope: [
          "https://www.googleapis.com/auth/youtube.upload"
        ]
      });

    res.redirect(authUrl);
  }
);

app.get(
  "/auth/google/callback",
  async (req, res) => {

    try {

      const {
        code
      } = req.query;

      if (!code) {
        return res
          .status(400)
          .send(
            "Authorization code missing."
          );
      }

      const {
        tokens
      } =
        await oauth2Client.getToken(
          code
        );

      saveTokens(tokens);

      console.log(
        "YouTube OAuth connection successfully saved."
      );

      return res.send(`
        <h1>✅ YouTube Connected</h1>

        <p>
        Your YouTube authorization is saved.
        </p>

        <a href="/">
        Return to automation
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

// ----------------------------------------------------
// Start server
// ----------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server running on port ${PORT}`
    );
  }
);
