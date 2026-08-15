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

// ----------------------------------------------------
// OpenAI
// ----------------------------------------------------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ----------------------------------------------------
// YouTube OAuth
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
    fs.mkdirSync(dir, {
      recursive: true
    });
  }
}

function writeCredentialsFile() {
  try {
    ensureTokenDirectory();

    fs.writeFileSync(
      TOKEN_PATH,
      JSON.stringify(
        oauth2Client.credentials,
        null,
        2
      ),
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

  if (
    !storedTokens &&
    fs.existsSync(TOKEN_PATH)
  ) {
    try {
      storedTokens = JSON.parse(
        fs.readFileSync(
          TOKEN_PATH,
          "utf8"
        )
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

  oauth2Client.setCredentials(
    merged
  );

  writeCredentialsFile();
}

function loadTokens() {
  try {
    ensureTokenDirectory();

    if (
      !fs.existsSync(TOKEN_PATH) &&
      fs.existsSync(
        LEGACY_TOKEN_FILE
      )
    ) {
      const legacy =
        JSON.parse(
          fs.readFileSync(
            LEGACY_TOKEN_FILE,
            "utf8"
          )
        );

      storedTokens = legacy;

      oauth2Client.setCredentials(
        legacy
      );

      writeCredentialsFile();

      console.log(
        "Loaded saved YouTube OAuth credentials"
      );

      return;
    }

    if (
      !fs.existsSync(TOKEN_PATH)
    ) {
      console.log(
        "No saved YouTube OAuth credentials found."
      );

      return;
    }

    storedTokens =
      JSON.parse(
        fs.readFileSync(
          TOKEN_PATH,
          "utf8"
        )
      );

    oauth2Client.setCredentials(
      storedTokens
    );

    console.log(
      "Loaded saved YouTube OAuth credentials"
    );
  } catch (error) {
    console.error(
      "Unable to load YouTube credentials:",
      error.message
    );
  }
}

oauth2Client.on(
  "tokens",
  (tokens) => {
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
  }
);

loadTokens();

// ----------------------------------------------------
// Status
// ----------------------------------------------------

function getSystemStatus() {
  return {
    connected:
      Boolean(storedTokens),

    openaiConfigured:
      Boolean(
        process.env.OPENAI_API_KEY
      ),

    pexelsConfigured:
      Boolean(
        process.env.PEXELS_API_KEY
      ),

    persistentStorage:
      fs.existsSync(
        path.dirname(TOKEN_PATH)
      ),

    server:
      "running"
  };
}

async function checkFfmpeg() {
  try {
    await execFileAsync(
      "ffmpeg",
      ["-version"]
    );

    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------
// AI content
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

Write concise, emotional, cinematic narration.

Never invent quotations from famous people.
Never reproduce copyrighted lyrics.
Never pretend a celebrity said something they did not say.

The opening sentence must immediately grab attention.

Also create exactly four realistic stock-video search queries.

Each search query should describe a scene that could realistically exist as cinematic stock footage.

Good examples:
- man running alone sunrise
- athlete training dark gym
- person working late laptop
- mountain sunrise silhouette
- city walking alone night
- boxer training heavy bag

Avoid abstract searches such as:
- success
- motivation
- become powerful
- never give up
      `,

      input: `
Create one motivational YouTube Short.

TOPIC:
${topic}

TONE:
${tone}

TARGET LENGTH:
Approximately ${durationSeconds} seconds.

Return:
- hook
- narration script
- YouTube title
- SEO description
- hashtags
- exactly four cinematic stock-video search queries that visually follow the message
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

            additionalProperties:
              false
          }
        }
      }
    });

  return JSON.parse(
    response.output_text
  );
}

// ----------------------------------------------------
// Voice
// ----------------------------------------------------

async function generateVoice(
  text,
  outputPath
) {
  const speech =
    await openai.audio.speech.create({
      model:
        "gpt-4o-mini-tts",

      voice:
        "onyx",

      input:
        text,

      instructions:
        "Speak with a confident cinematic motivational tone. " +
        "Use natural pauses and emotional emphasis. " +
        "Sound powerful but do not shout.",

      response_format:
        "mp3"
    });

  const buffer =
    Buffer.from(
      await speech.arrayBuffer()
    );

  await fs.promises.writeFile(
    outputPath,
    buffer
  );
}

// ----------------------------------------------------
// Pexels
// ----------------------------------------------------

function choosePexelsFile(video) {
  const candidates =
    (video.video_files || [])
      .filter(
        file =>
          file.file_type ===
          "video/mp4"
      )
      .filter(
        file =>
          file.width &&
          file.height &&
          file.link
      );

  if (!candidates.length) {
    return null;
  }

  const portrait =
    candidates.filter(
      file =>
        file.height >
        file.width
    );

  const pool =
    portrait.length
      ? portrait
      : candidates;

  // Prefer something reasonably close to 720x1280
  pool.sort((a, b) => {
    const targetArea =
      720 * 1280;

    const aDifference =
      Math.abs(
        a.width *
          a.height -
          targetArea
      );

    const bDifference =
      Math.abs(
        b.width *
          b.height -
          targetArea
      );

    return (
      aDifference -
      bDifference
    );
  });

  return pool[0];
}

async function searchPexelsVideo(
  query,
  usedVideoIds
) {
  if (
    !process.env.PEXELS_API_KEY
  ) {
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
  );

  url.searchParams.set(
    "size",
    "small"
  );

  url.searchParams.set(
    "per_page",
    "12"
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          Authorization:
            process.env.PEXELS_API_KEY
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Pexels request failed (${response.status}).`
    );
  }

  const data =
    await response.json();

  const videos =
    (data.videos || [])
      .filter(
        video =>
          !usedVideoIds.has(
            video.id
          )
      )
      .filter(
        video =>
          Number(video.duration) >
          2
      );

  if (!videos.length) {
    return null;
  }

  // Pick randomly among a few top results
  const shortlist =
    videos.slice(0, 6);

  const video =
    shortlist[
      Math.floor(
        Math.random() *
          shortlist.length
      )
    ];

  const file =
    choosePexelsFile(
      video
    );

  if (!file) {
    return null;
  }

  usedVideoIds.add(
    video.id
  );

  return {
    id:
      video.id,

    downloadUrl:
      file.link,

    pexelsUrl:
      video.url,

    creator:
      video.user?.name ||
      "Pexels creator",

    creatorUrl:
      video.user?.url ||
      "https://www.pexels.com",

    width:
      file.width,

    height:
      file.height
  };
}

async function downloadFile(
  url,
  outputPath
) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Unable to download stock clip (${response.status}).`
    );
  }

  const data =
    Buffer.from(
      await response.arrayBuffer()
    );

  await fs.promises.writeFile(
    outputPath,
    data
  );
}

async function fetchSceneVideos(
  sceneQueries,
  workDir
) {
  const clips = [];
  const usedVideoIds =
    new Set();

  for (
    let i = 0;
    i < sceneQueries.length;
    i++
  ) {
    const query =
      sceneQueries[i];

    try {
      console.log(
        `Searching Pexels: ${query}`
      );

      const result =
        await searchPexelsVideo(
          query,
          usedVideoIds
        );

      if (!result) {
        console.log(
          `No suitable Pexels clip found for: ${query}`
        );
        continue;
      }

      const filePath =
        path.join(
          workDir,
          `pexels-${i}.mp4`
        );

      console.log(
        `Downloading Pexels clip ${i + 1}...`
      );

      await downloadFile(
        result.downloadUrl,
        filePath
      );

      clips.push({
        ...result,
        query,
        filePath
      });
    } catch (error) {
      console.error(
        `Pexels scene failed (${query}):`,
        error.message
      );
    }
  }

  return clips;
}

// ----------------------------------------------------
// Audio duration
// ----------------------------------------------------

async function getAudioDuration(
  audioPath
) {
  const { stdout } =
    await execFileAsync(
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

  return Number(
    stdout.trim()
  );
}

// ----------------------------------------------------
// Captions
// ----------------------------------------------------

function escapeAssText(text) {
  return text
    .replace(
      /\\/g,
      "\\\\"
    )
    .replace(
      /{/g,
      "\\{"
    )
    .replace(
      /}/g,
      "\\}"
    )
    .replace(
      /\n/g,
      " "
    );
}

function secondsToAssTime(
  seconds
) {
  const hrs =
    Math.floor(
      seconds / 3600
    );

  const mins =
    Math.floor(
      (seconds % 3600) /
        60
    );

  const secs =
    seconds % 60;

  return `${hrs}:${String(
    mins
  ).padStart(
    2,
    "0"
  )}:${secs
    .toFixed(2)
    .padStart(
      5,
      "0"
    )}`;
}

function createAssCaptions(
  script,
  duration,
  outputPath
) {
  const words =
    script
      .trim()
      .split(/\s+/);

  const wordsPerCaption =
    4;

  const chunks =
    [];

  for (
    let i = 0;
    i < words.length;
    i += wordsPerCaption
  ) {
    chunks.push(
      words
        .slice(
          i,
          i +
            wordsPerCaption
        )
        .join(" ")
    );
  }

  const chunkDuration =
    duration /
    chunks.length;

  let events = "";

  chunks.forEach(
    (chunk, index) => {
      const start =
        index *
        chunkDuration;

      const end =
        Math.min(
          duration,
          (index + 1) *
            chunkDuration
        );

      events +=
        `Dialogue: 0,` +
        `${secondsToAssTime(start)},` +
        `${secondsToAssTime(end)},` +
        `Default,,0,0,0,,` +
        `${escapeAssText(chunk)}\n`;
    }
  );

  const ass = `
[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,DejaVu Sans,52,&H00FFFFFF,&H000000FF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,1,4,2,2,55,55,230,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${events}
`;

  fs.writeFileSync(
    outputPath,
    ass.trim()
  );
}

// ----------------------------------------------------
// Prepare individual stock clips
// ----------------------------------------------------

async function prepareSceneClip({
  inputPath,
  outputPath,
  duration
}) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-stream_loop",
      "-1",

      "-i",
      inputPath,

      "-t",
      duration.toFixed(2),

      "-an",

      "-vf",
      "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30",

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "28",

      "-threads",
      "2",

      "-pix_fmt",
      "yuv420p",

      outputPath
    ],
    {
      maxBuffer:
        10 *
        1024 *
        1024
    }
  );
}

// ----------------------------------------------------
// Stitch scenes
// ----------------------------------------------------

async function stitchSceneClips(
  scenePaths,
  outputPath,
  workDir
) {
  const listPath =
    path.join(
      workDir,
      "scene-list.txt"
    );

  const contents =
    scenePaths
      .map(
        file =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");

  fs.writeFileSync(
    listPath,
    contents
  );

  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-f",
      "concat",

      "-safe",
      "0",

      "-i",
      listPath,

      "-c",
      "copy",

      outputPath
    ],
    {
      maxBuffer:
        10 *
        1024 *
        1024
    }
  );
}

// ----------------------------------------------------
// Cinematic final render
// ----------------------------------------------------

async function renderStockVideo({
  visualPath,
  audioPath,
  subtitlePath,
  videoPath
}) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-i",
      visualPath,

      "-i",
      audioPath,

      "-map",
      "0:v:0",

      "-map",
      "1:a:0",

      "-vf",
      `subtitles=${subtitlePath}`,

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "26",

      "-threads",
      "2",

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "96k",

      "-shortest",

      "-movflags",
      "+faststart",

      videoPath
    ],
    {
      maxBuffer:
        10 *
        1024 *
        1024
    }
  );
}

// ----------------------------------------------------
// Fallback black-background renderer
// ----------------------------------------------------

async function renderFallbackVideo({
  audioPath,
  subtitlePath,
  videoPath
}) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-f",
      "lavfi",

      "-i",
      "color=c=0x090909:s=720x1280:r=30",

      "-i",
      audioPath,

      "-vf",
      `subtitles=${subtitlePath}`,

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "26",

      "-threads",
      "2",

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "96k",

      "-shortest",

      "-movflags",
      "+faststart",

      videoPath
    ],
    {
      maxBuffer:
        10 *
        1024 *
        1024
    }
  );
}

// ----------------------------------------------------
// YouTube upload
// ----------------------------------------------------

async function uploadToYouTube({
  videoPath,
  title,
  description,
  hashtags,
  clips
}) {
  if (!storedTokens) {
    throw new Error(
      "YouTube is not connected."
    );
  }

  oauth2Client.setCredentials(
    storedTokens
  );

  const youtube =
    google.youtube({
      version: "v3",
      auth: oauth2Client
    });

  let sourceCredits = "";

  if (
    clips &&
    clips.length
  ) {
    const credits =
      clips.map(
        clip =>
          `${clip.creator} — ${clip.pexelsUrl}`
      );

    sourceCredits =
      `\n\nFootage provided by Pexels:\n${credits.join(
        "\n"
      )}`;
  }

  const finalDescription =
    `${description}

${hashtags.join(" ")}
${sourceCredits}`.trim();

  const result =
    await youtube.videos.insert({
      part: [
        "snippet",
        "status"
      ],

      requestBody: {
        snippet: {
          title:
            title.slice(
              0,
              100
            ),

          description:
            finalDescription.slice(
              0,
              5000
            ),

          tags:
            hashtags
              .map(
                tag =>
                  tag.replace(
                    "#",
                    ""
                  )
              )
              .slice(
                0,
                15
              ),

          categoryId:
            "22"
        },

        status: {
          privacyStatus:
            "private",

          selfDeclaredMadeForKids:
            false
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
// Homepage
// ----------------------------------------------------

app.get(
  "/",
  (req, res) => {
    res.send(`
<!doctype html>

<html>
<head>

<meta
name="viewport"
content="width=device-width,initial-scale=1"
/>

<title>
Motivation Shorts Engine
</title>

<style>

body {
  font-family: Arial, sans-serif;
  max-width: 700px;
  margin: 40px auto;
  padding: 20px;
  background: #090909;
  color: white;
}

.status {
  line-height: 1.8;
}

input,
button {
  width: 100%;
  box-sizing: border-box;
  padding: 15px;
  margin-top: 14px;
  font-size: 16px;
  border-radius: 9px;
}

input {
  background: #171717;
  border: 1px solid #444;
  color: white;
}

button {
  background: white;
  color: black;
  font-weight: bold;
  border: none;
}

button:disabled {
  opacity: .5;
}

#result {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-top: 24px;
}

</style>

</head>

<body>

<h1>
Cinematic Shorts Engine 🎥⚡
</h1>

<div class="status">

YouTube:
<strong>
${storedTokens
  ? "Connected ✅"
  : "Not connected"}
</strong>

<br>

OpenAI:
<strong>
${process.env.OPENAI_API_KEY
  ? "Configured ✅"
  : "Missing"}
</strong>

<br>

Pexels:
<strong>
${process.env.PEXELS_API_KEY
  ? "Configured ✅"
  : "Missing"}
</strong>

</div>

<input
id="topic"
value="Nobody is coming to save you"
placeholder="Motivational topic"
/>

<button
id="generateButton"
onclick="createShort()"
>
Generate Cinematic Private Short
</button>

<pre id="result"></pre>

<script>

async function createShort() {

  const result =
    document.getElementById(
      "result"
    );

  const button =
    document.getElementById(
      "generateButton"
    );

  button.disabled = true;

  result.textContent =
    "Creating script → voice → finding cinematic footage → captions → rendering → YouTube upload...";

  try {

    const response =
      await fetch(
        "/create-short",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              topic:
                document
                .getElementById(
                  "topic"
                )
                .value
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

  } finally {

    button.disabled =
      false;
  }
}

</script>

</body>
</html>
    `);
  }
);

// ----------------------------------------------------
// Status endpoints
// ----------------------------------------------------

app.get(
  "/status",
  async (req, res) => {
    res.json({
      ...getSystemStatus(),

      ffmpeg:
        await checkFfmpeg()
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json(
      getSystemStatus()
    );
  }
);

app.get(
  "/last-upload",
  (req, res) => {
    res.json({
      lastUpload
    });
  }
);

// ----------------------------------------------------
// Pexels test — FREE test before generating
// ----------------------------------------------------

app.get(
  "/test-pexels",
  async (req, res) => {
    try {
      const query =
        String(
          req.query.q ||
          "athlete training"
        ).slice(
          0,
          100
        );

      const result =
        await searchPexelsVideo(
          query,
          new Set()
        );

      return res.json({
        success:
          Boolean(result),

        query,

        result:
          result
            ? {
                id:
                  result.id,

                creator:
                  result.creator,

                pexelsUrl:
                  result.pexelsUrl,

                width:
                  result.width,

                height:
                  result.height
              }
            : null
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error.message
        });
    }
  }
);

// ----------------------------------------------------
// FULL CINEMATIC SHORT PIPELINE
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
        return res
          .status(500)
          .json({
            success: false,
            error:
              "OpenAI API is not configured."
          });
      }

      if (!storedTokens) {
        return res
          .status(401)
          .json({
            success:
              false,

            error:
              "YouTube is not connected."
          });
      }

      if (
        !(await checkFfmpeg())
      ) {
        return res
          .status(500)
          .json({
            success:
              false,

            error:
              "FFmpeg is not installed."
          });
      }

      const {
        topic =
          "discipline and consistency",

        tone =
          "powerful, cinematic and direct",

        durationSeconds =
          30
      } = req.body || {};

      const duration =
        Math.min(
          Math.max(
            Number(
              durationSeconds
            ) || 30,
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

      const visualPath =
        path.join(
          workDir,
          "visuals.mp4"
        );

      const videoPath =
        path.join(
          workDir,
          "short.mp4"
        );

      console.log(
        "1/7 Generating content..."
      );

      const content =
        await generateContent({
          topic,
          tone,
          durationSeconds:
            duration
        });

      console.log(
        "2/7 Generating narration..."
      );

      await generateVoice(
        content.script,
        audioPath
      );

      const actualDuration =
        await getAudioDuration(
          audioPath
        );

      console.log(
        `Narration duration: ${actualDuration.toFixed(
          2
        )} seconds`
      );

      console.log(
        "3/7 Creating captions..."
      );

      createAssCaptions(
        content.script,
        actualDuration,
        subtitlePath
      );

      let clips = [];

      if (
        process.env.PEXELS_API_KEY
      ) {
        console.log(
          "4/7 Finding Pexels footage..."
        );

        clips =
          await fetchSceneVideos(
            content.sceneQueries,
            workDir
          );
      }

      let visualMode =
        "fallback";

      if (clips.length) {
        console.log(
          `Found ${clips.length} usable cinematic clip(s).`
        );

        const sceneDuration =
          actualDuration /
          clips.length;

        const prepared =
          [];

        for (
          let i = 0;
          i < clips.length;
          i++
        ) {
          console.log(
            `Preparing scene ${i + 1}/${clips.length}...`
          );

          const preparedPath =
            path.join(
              workDir,
              `scene-${i}.mp4`
            );

          await prepareSceneClip({
            inputPath:
              clips[i].filePath,

            outputPath:
              preparedPath,

            duration:
              sceneDuration
          });

          prepared.push(
            preparedPath
          );
        }

        console.log(
          "5/7 Stitching cinematic scenes..."
        );

        await stitchSceneClips(
          prepared,
          visualPath,
          workDir
        );

        console.log(
          "6/7 Rendering captions + narration..."
        );

        await renderStockVideo({
          visualPath,
          audioPath,
          subtitlePath,
          videoPath
        });

        visualMode =
          "pexels";
      } else {
        console.log(
          "No usable stock clips. Using fallback visual."
        );

        console.log(
          "6/7 Rendering fallback..."
        );

        await renderFallbackVideo({
          audioPath,
          subtitlePath,
          videoPath
        });
      }

      console.log(
        "7/7 Uploading privately to YouTube..."
      );

      const youtubeVideoId =
        await uploadToYouTube({
          videoPath,

          title:
            content.title,

          description:
            content.description,

          hashtags:
            content.hashtags,

          clips
        });

      lastUpload = {
        videoId:
          youtubeVideoId,

        title:
          content.title,

        createdAt:
          new Date()
            .toISOString(),

        privacyStatus:
          "private",

        visualMode,

        stockClips:
          clips.length
      };

      console.log(
        "Cinematic private Short uploaded successfully."
      );

      return res.json({
        success:
          true,

        youtubeVideoId,

        privacyStatus:
          "private",

        visualMode,

        stockClipsUsed:
          clips.length,

        content
      });
    } catch (error) {
      console.error(
        "Create short failed:",
        error.message
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error.message ||
            "Unable to create Short."
        });
    } finally {
      fs.promises
        .rm(
          workDir,
          {
            recursive: true,
            force: true
          }
        )
        .catch(
          () => {}
        );
    }
  }
);

// ----------------------------------------------------
// Voice test
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

      const buffer =
        Buffer.from(
          await speech.arrayBuffer()
        );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      return res.send(
        buffer
      );
    } catch (error) {
      return res
        .status(500)
        .json({
          success:
            false,

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

    res.redirect(
      authUrl
    );
  }
);

app.get(
  "/auth/google/callback",
  async (req, res) => {
    try {
      const { code } =
        req.query;

      if (!code) {
        return res
          .status(400)
          .send(
            "Authorization code missing."
          );
      }

      const { tokens } =
        await oauth2Client.getToken(
          code
        );

      saveTokens(
        tokens
      );

      console.log(
        "YouTube OAuth connection successfully saved."
      );

      return res.send(`
        <h1>
          ✅ YouTube Connected
        </h1>

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
// Start
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
