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

// ====================================================
// CONFIGURATION
// ====================================================

const TOKEN_PATH =
  "/app/data/youtube-token.json";

const LEGACY_TOKEN_FILE =
  "/app/data/tokens.json";

const HISTORY_PATH =
  "/app/data/short-history.json";

const MAX_HISTORY = 100;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const oauth2Client =
  new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

let storedTokens = null;
let lastUpload = null;
let shortHistory = [];
let activeJob = false;

// ====================================================
// PERSISTENT STORAGE
// ====================================================

function ensureDataDirectory() {
  const dir =
    path.dirname(TOKEN_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true
    });
  }
}

function writeJsonSecure(
  filePath,
  data
) {
  ensureDataDirectory();

  fs.writeFileSync(
    filePath,
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );
}

// ====================================================
// YOUTUBE TOKENS
// ====================================================

function writeCredentialsFile() {
  try {
    writeJsonSecure(
      TOKEN_PATH,
      oauth2Client.credentials
    );
  } catch (error) {
    console.error(
      "Unable to persist YouTube credentials:",
      error.message
    );
  }
}

function saveTokens(
  tokens = {}
) {
  ensureDataDirectory();

  if (
    !storedTokens &&
    fs.existsSync(TOKEN_PATH)
  ) {
    try {
      storedTokens =
        JSON.parse(
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
    ensureDataDirectory();

    if (
      !fs.existsSync(
        TOKEN_PATH
      ) &&
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

      storedTokens =
        legacy;

      oauth2Client
        .setCredentials(
          legacy
        );

      writeCredentialsFile();

      console.log(
        "Migrated legacy YouTube credentials."
      );

      return;
    }

    if (
      !fs.existsSync(
        TOKEN_PATH
      )
    ) {
      console.log(
        "No saved YouTube OAuth credentials."
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

    oauth2Client
      .setCredentials(
        storedTokens
      );

    console.log(
      "Loaded saved YouTube OAuth credentials."
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
  tokens => {
    try {
      saveTokens(tokens);

      console.log(
        "YouTube OAuth credentials refreshed."
      );
    } catch (error) {
      console.error(
        "Unable to save refreshed credentials:",
        error.message
      );
    }
  }
);

// ====================================================
// HISTORY
// ====================================================

function loadHistory() {
  try {
    ensureDataDirectory();

    if (
      !fs.existsSync(
        HISTORY_PATH
      )
    ) {
      shortHistory = [];
      return;
    }

    shortHistory =
      JSON.parse(
        fs.readFileSync(
          HISTORY_PATH,
          "utf8"
        )
      );

    if (
      !Array.isArray(
        shortHistory
      )
    ) {
      shortHistory = [];
    }

    if (
      shortHistory.length
    ) {
      lastUpload =
        shortHistory[0];
    }

  } catch (error) {
    console.error(
      "Unable to load history:",
      error.message
    );

    shortHistory = [];
  }
}

function saveHistory() {
  try {
    shortHistory =
      shortHistory.slice(
        0,
        MAX_HISTORY
      );

    writeJsonSecure(
      HISTORY_PATH,
      shortHistory
    );
  } catch (error) {
    console.error(
      "Unable to save history:",
      error.message
    );
  }
}

function addHistory(
  entry
) {
  shortHistory.unshift(
    entry
  );

  lastUpload = entry;

  saveHistory();
}

loadTokens();
loadHistory();

// ====================================================
// STATUS
// ====================================================

async function commandExists(
  command
) {
  try {
    await execFileAsync(
      command,
      ["-version"]
    );

    return true;
  } catch {
    return false;
  }
}

async function checkFfmpeg() {
  return commandExists(
    "ffmpeg"
  );
}

async function checkFfprobe() {
  return commandExists(
    "ffprobe"
  );
}

function getSystemStatus() {
  return {
    server:
      "running",

    connected:
      Boolean(
        storedTokens
      ),

    openaiConfigured:
      Boolean(
        process.env
          .OPENAI_API_KEY
      ),

    pexelsConfigured:
      Boolean(
        process.env
          .PEXELS_API_KEY
      ),

    musicConfigured:
      Boolean(
        process.env
          .BACKGROUND_MUSIC_URL
      ),

    automationConfigured:
      Boolean(
        process.env
          .AUTOMATION_SECRET
      ),

    persistentStorage:
      fs.existsSync(
        path.dirname(
          TOKEN_PATH
        )
      ),

    activeJob,

    jobs:
      shortHistory.length
  };
}

// ====================================================
// RETRY
// ====================================================

async function retry(
  fn,
  {
    attempts = 3,
    delayMs = 1000,
    label = "operation"
  } = {}
) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= attempts;
    attempt++
  ) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      console.error(
        `${label} failed (${attempt}/${attempts}):`,
        error.message
      );

      if (
        attempt <
        attempts
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              delayMs *
                attempt
            )
        );
      }
    }
  }

  throw lastError;
}

// ====================================================
// TOPIC HELPERS
// ====================================================

function normalizeTopic(
  value
) {
  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /[^a-z0-9\s]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function recentlyUsedTopic(
  topic
) {
  const normalized =
    normalizeTopic(topic);

  if (!normalized) {
    return false;
  }

  return shortHistory
    .slice(0, 20)
    .some(
      item =>
        normalizeTopic(
          item.topic
        ) === normalized
    );
}

// ====================================================
// AI CONTENT
// ====================================================

async function generateTopic() {
  const recentTopics =
    shortHistory
      .slice(0, 15)
      .map(
        item =>
          item.topic
      )
      .filter(Boolean);

  const response =
    await openai.responses.create({
      model:
        "gpt-5-mini",

      instructions: `
Create ONE concise motivational topic for a YouTube Short.

The topic must be emotionally strong and specific.

Avoid generic wording.

Do not use famous quotations.

Do not repeat any recent topic supplied by the user.

Return only the topic text.
      `,

      input: `
Recent topics to avoid:

${recentTopics.length
  ? recentTopics.join("\n")
  : "None"}
      `
    });

  return response.output_text
    .trim()
    .slice(0, 150);
}

async function generateUniqueTopic() {
  for (
    let attempt = 0;
    attempt < 4;
    attempt++
  ) {
    const topic =
      await generateTopic();

    if (
      !recentlyUsedTopic(
        topic
      )
    ) {
      return topic;
    }
  }

  return (
    "Build discipline when nobody is watching " +
    Date.now()
  );
}

async function generateContent({
  topic,
  tone,
  durationSeconds
}) {
  const response =
    await openai.responses.create({
      model:
        "gpt-5-mini",

      instructions: `
You create high-retention original motivational YouTube Shorts.

The narration must sound natural when spoken aloud.

Use short sentences.
Build emotional momentum.
Avoid filler.
Avoid clichés when possible.

The first sentence must immediately grab attention.

Never invent quotations from famous people.
Never reproduce copyrighted song lyrics.
Never pretend a celebrity said something they did not say.

The title must be clickable without being deceptive.

The description should naturally explain the message.

Generate EXACTLY four realistic stock-footage search queries.

The stock queries must describe scenes that could realistically exist on a stock-video website.

Examples:

man running alone sunrise
athlete training dark gym
person working late laptop
man walking city at night
mountain sunrise silhouette
boxer training heavy bag
woman studying alone night

Do not create abstract stock queries such as:

success
motivation
become powerful
never give up
winning mindset
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
- YouTube Shorts title
- SEO-friendly description
- hashtags
- exactly four cinematic stock-video queries
      `,

      text: {
        format: {
          type:
            "json_schema",

          name:
            "motivational_short",

          strict:
            true,

          schema: {
            type:
              "object",

            properties: {
              hook: {
                type:
                  "string"
              },

              script: {
                type:
                  "string"
              },

              title: {
                type:
                  "string"
              },

              description: {
                type:
                  "string"
              },

              hashtags: {
                type:
                  "array",

                items: {
                  type:
                    "string"
                },

                minItems:
                  3,

                maxItems:
                  8
              },

              sceneQueries: {
                type:
                  "array",

                items: {
                  type:
                    "string"
                },

                minItems:
                  4,

                maxItems:
                  4
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

// ====================================================
// VOICE
// ====================================================

async function generateVoice(
  text,
  outputPath
) {
  const speech =
    await openai.audio.speech.create({
      model:
        "gpt-4o-mini-tts",

      voice:
        process.env
          .OPENAI_TTS_VOICE ||
        "onyx",

      input:
        text,

      instructions:
        "Speak with a confident cinematic motivational tone. " +
        "Use natural pauses and emotional emphasis. " +
        "Do not shout.",

      response_format:
        "mp3"
    });

  const buffer =
    Buffer.from(
      await speech
        .arrayBuffer()
    );

  await fs.promises
    .writeFile(
      outputPath,
      buffer
    );
}

// ====================================================
// PEXELS
// ====================================================

function choosePexelsFile(
  video
) {
  const candidates =
    (
      video.video_files ||
      []
    )
      .filter(
        file =>
          file.file_type ===
            "video/mp4" &&
          file.width &&
          file.height &&
          file.link
      );

  if (
    !candidates.length
  ) {
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

  const targetArea =
    720 * 1280;

  pool.sort(
    (a, b) =>
      Math.abs(
        a.width *
          a.height -
          targetArea
      ) -
      Math.abs(
        b.width *
          b.height -
          targetArea
      )
  );

  return pool[0];
}

async function searchPexelsVideo(
  query,
  usedVideoIds
) {
  if (
    !process.env
      .PEXELS_API_KEY
  ) {
    throw new Error(
      "Pexels API is not configured."
    );
  }

  const url =
    new URL(
      "https://api.pexels.com/videos/search"
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
    "medium"
  );

  url.searchParams.set(
    "per_page",
    "15"
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          Authorization:
            process.env
              .PEXELS_API_KEY
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
    (
      data.videos ||
      []
    )
      .filter(
        video =>
          !usedVideoIds
            .has(video.id)
      )
      .filter(
        video =>
          Number(
            video.duration
          ) >= 3
      );

  if (!videos.length) {
    return null;
  }

  const shortlist =
    videos.slice(0, 8);

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
      `Download failed (${response.status}).`
    );
  }

  const buffer =
    Buffer.from(
      await response
        .arrayBuffer()
    );

  await fs.promises
    .writeFile(
      outputPath,
      buffer
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
    i <
    sceneQueries.length;
    i++
  ) {
    const query =
      sceneQueries[i];

    try {
      console.log(
        `Searching Pexels: ${query}`
      );

      const result =
        await retry(
          () =>
            searchPexelsVideo(
              query,
              usedVideoIds
            ),
          {
            attempts:
              2,

            delayMs:
              700,

            label:
              `Pexels ${query}`
          }
        );

      if (!result) {
        continue;
      }

      const filePath =
        path.join(
          workDir,
          `pexels-${i}.mp4`
        );

      await retry(
        () =>
          downloadFile(
            result.downloadUrl,
            filePath
          ),
        {
          attempts:
            2,

          delayMs:
            700,

          label:
            "Pexels download"
        }
      );

      clips.push({
        ...result,
        query,
        filePath
      });

    } catch (error) {
      console.error(
        `Scene unavailable (${query}):`,
        error.message
      );
    }
  }

  return clips;
}

// ====================================================
// AUDIO / VIDEO HELPERS
// ====================================================

async function getMediaDuration(
  mediaPath
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

        mediaPath
      ]
    );

  const duration =
    Number(
      stdout.trim()
    );

  if (
    !Number.isFinite(
      duration
    )
  ) {
    throw new Error(
      "Unable to determine media duration."
    );
  }

  return duration;
}

// ====================================================
// CAPTIONS
// ====================================================

function escapeAssText(
  text
) {
  return String(text)
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
      (
        seconds %
        3600
      ) / 60
    );

  const secs =
    seconds % 60;

  return (
    `${hrs}:` +
    `${String(mins)
      .padStart(2, "0")}:` +
    `${secs
      .toFixed(2)
      .padStart(5, "0")}`
  );
}

function createAssCaptions(
  script,
  duration,
  outputPath
) {
  const words =
    String(script)
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  if (!words.length) {
    throw new Error(
      "Narration script is empty."
    );
  }

  const wordsPerCaption =
    4;

  const chunks = [];

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
          (
            index + 1
          ) *
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
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,DejaVu Sans,54,&H00FFFFFF,&H000000FF,&H00000000,&H70000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,240,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${events}
`;

  fs.writeFileSync(
    outputPath,
    ass.trim()
  );
}

// ====================================================
// STOCK CLIP PREPARATION
// ====================================================

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
      [
        "scale=720:1280:force_original_aspect_ratio=increase",
        "crop=720:1280",
        "fps=30",
        "eq=contrast=1.06:saturation=0.92:brightness=-0.02"
      ].join(","),

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
        20 *
        1024 *
        1024
    }
  );
}

// ====================================================
// STITCH CLIPS
// ====================================================

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
        20 *
        1024 *
        1024
    }
  );
}

// ====================================================
// OPTIONAL BACKGROUND MUSIC
// ====================================================

async function prepareBackgroundMusic(
  workDir
) {
  const url =
    process.env
      .BACKGROUND_MUSIC_URL;

  if (!url) {
    return null;
  }

  const musicPath =
    path.join(
      workDir,
      "background-music.mp3"
    );

  try {
    await retry(
      () =>
        downloadFile(
          url,
          musicPath
        ),
      {
        attempts:
          2,

        delayMs:
          1000,

        label:
          "Background music download"
      }
    );

    return musicPath;
  } catch (error) {
    console.error(
      "Background music unavailable:",
      error.message
    );

    return null;
  }
}

// ====================================================
// FINAL RENDER
// ====================================================

async function renderStockVideo({
  visualPath,
  audioPath,
  subtitlePath,
  musicPath,
  videoPath
}) {
  const args = [
    "-y",

    "-i",
    visualPath,

    "-i",
    audioPath
  ];

  if (musicPath) {
    args.push(
      "-stream_loop",
      "-1",

      "-i",
      musicPath
    );
  }

  args.push(
    "-map",
    "0:v:0"
  );

  if (musicPath) {
    args.push(
      "-filter_complex",

      "[1:a]volume=1.0[voice];" +
      "[2:a]volume=0.10[music];" +
      "[voice][music]amix=inputs=2:duration=first:dropout_transition=2[a]",

      "-map",
      "[a]"
    );
  } else {
    args.push(
      "-map",
      "1:a:0"
    );
  }

  args.push(
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
    "128k",

    "-ar",
    "44100",

    "-shortest",

    "-movflags",
    "+faststart",

    videoPath
  );

  await execFileAsync(
    "ffmpeg",
    args,
    {
      maxBuffer:
        20 *
        1024 *
        1024
    }
  );
}

async function renderFallbackVideo({
  audioPath,
  subtitlePath,
  musicPath,
  videoPath
}) {
  const args = [
    "-y",

    "-f",
    "lavfi",

    "-i",
    "color=c=0x090909:s=720x1280:r=30",

    "-i",
    audioPath
  ];

  if (musicPath) {
    args.push(
      "-stream_loop",
      "-1",

      "-i",
      musicPath
    );
  }

  if (musicPath) {
    args.push(
      "-filter_complex",

      "[1:a]volume=1.0[voice];" +
      "[2:a]volume=0.10[music];" +
      "[voice][music]amix=inputs=2:duration=first:dropout_transition=2[a]",

      "-map",
      "0:v:0",

      "-map",
      "[a]"
    );
  } else {
    args.push(
      "-map",
      "0:v:0",

      "-map",
      "1:a:0"
    );
  }

  args.push(
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
    "128k",

    "-ar",
    "44100",

    "-shortest",

    "-movflags",
    "+faststart",

    videoPath
  );

  await execFileAsync(
    "ffmpeg",
    args,
    {
      maxBuffer:
        20 *
        1024 *
        1024
    }
  );
}

// ====================================================
// YOUTUBE
// ====================================================

function sanitizeHashtag(
  value
) {
  const clean =
    String(value)
      .trim();

  if (!clean) {
    return "";
  }

  return clean.startsWith(
    "#"
  )
    ? clean
    : `#${clean.replace(
        /\s+/g,
        ""
      )}`;
}

async function uploadToYouTube({
  videoPath,
  title,
  description,
  hashtags,
  clips,
  privacyStatus
}) {
  if (!storedTokens) {
    throw new Error(
      "YouTube is not connected."
    );
  }

  oauth2Client
    .setCredentials(
      storedTokens
    );

  const youtube =
    google.youtube({
      version:
        "v3",

      auth:
        oauth2Client
    });

  const cleanedHashtags =
    hashtags
      .map(
        sanitizeHashtag
      )
      .filter(Boolean);

  let sourceCredits = "";

  if (
    clips?.length
  ) {
    const credits =
      clips.map(
        clip =>
          `${clip.creator} — ${clip.pexelsUrl}`
      );

    sourceCredits =
      `\n\nStock footage via Pexels:\n${credits.join(
        "\n"
      )}`;
  }

  const finalDescription =
    `${description}

${cleanedHashtags.join(" ")}
${sourceCredits}`.trim();

  const result =
    await youtube
      .videos
      .insert({
        part: [
          "snippet",
          "status"
        ],

        requestBody: {
          snippet: {
            title:
              String(title)
                .slice(
                  0,
                  100
                ),

            description:
              finalDescription
                .slice(
                  0,
                  5000
                ),

            tags:
              cleanedHashtags
                .map(
                  tag =>
                    tag
                      .replace(
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
            privacyStatus,

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

// ====================================================
// YOUTUBE ANALYTICS
// ====================================================

async function getVideoAnalytics(
  videoId
) {
  if (!storedTokens) {
    throw new Error(
      "YouTube is not connected."
    );
  }

  oauth2Client
    .setCredentials(
      storedTokens
    );

  const youtube =
    google.youtube({
      version:
        "v3",

      auth:
        oauth2Client
    });

  const result =
    await youtube
      .videos
      .list({
        part: [
          "snippet",
          "statistics",
          "status"
        ],

        id: [
          videoId
        ]
      });

  const video =
    result.data
      .items?.[0];

  if (!video) {
    return null;
  }

  return {
    videoId,

    title:
      video.snippet
        ?.title,

    publishedAt:
      video.snippet
        ?.publishedAt,

    privacyStatus:
      video.status
        ?.privacyStatus,

    views:
      Number(
        video.statistics
          ?.viewCount ||
          0
      ),

    likes:
      Number(
        video.statistics
          ?.likeCount ||
          0
      ),

    comments:
      Number(
        video.statistics
          ?.commentCount ||
          0
      )
  };
}

// ====================================================
// CORE SHORT CREATOR
// ====================================================

async function createShort({
  topic,
  tone =
    "powerful, cinematic and direct",
  durationSeconds =
    30,
  privacyStatus =
    "private"
} = {}) {
  if (activeJob) {
    throw new Error(
      "Another Short is already being generated."
    );
  }

  if (
    !process.env
      .OPENAI_API_KEY
  ) {
    throw new Error(
      "OpenAI API is not configured."
    );
  }

  if (!storedTokens) {
    throw new Error(
      "YouTube is not connected."
    );
  }

  if (
    !(await checkFfmpeg())
  ) {
    throw new Error(
      "FFmpeg is not installed."
    );
  }

  if (
    !(await checkFfprobe())
  ) {
    throw new Error(
      "FFprobe is not installed."
    );
  }

  const allowedPrivacy =
    [
      "private",
      "unlisted",
      "public"
    ];

  if (
    !allowedPrivacy
      .includes(
        privacyStatus
      )
  ) {
    privacyStatus =
      "private";
  }

  activeJob = true;

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
    await fs.promises
      .mkdir(
        workDir,
        {
          recursive:
            true
        }
      );

    const finalTopic =
      topic?.trim()
        ? String(topic)
            .trim()
            .slice(
              0,
              150
            )
        : await generateUniqueTopic();

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

    console.log(
      `JOB ${jobId}`
    );

    console.log(
      `Topic: ${finalTopic}`
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

    // --------------------------------
    // 1. Content
    // --------------------------------

    console.log(
      "1/8 Generating content..."
    );

    const content =
      await retry(
        () =>
          generateContent({
            topic:
              finalTopic,

            tone,

            durationSeconds:
              duration
          }),
        {
          attempts:
            2,

          delayMs:
            1000,

          label:
            "Content generation"
        }
      );

    // --------------------------------
    // 2. Voice
    // --------------------------------

    console.log(
      "2/8 Generating narration..."
    );

    await retry(
      () =>
        generateVoice(
          content.script,
          audioPath
        ),
      {
        attempts:
          2,

        delayMs:
          1000,

        label:
          "Voice generation"
      }
    );

    // --------------------------------
    // 3. Duration
    // --------------------------------

    const actualDuration =
      await getMediaDuration(
        audioPath
      );

    console.log(
      `Narration: ${actualDuration.toFixed(
        2
      )} seconds`
    );

    // --------------------------------
    // 4. Captions
    // --------------------------------

    console.log(
      "3/8 Creating captions..."
    );

    createAssCaptions(
      content.script,
      actualDuration,
      subtitlePath
    );

    // --------------------------------
    // 5. Stock footage
    // --------------------------------

    let clips = [];

    if (
      process.env
        .PEXELS_API_KEY
    ) {
      console.log(
        "4/8 Finding cinematic footage..."
      );

      clips =
        await fetchSceneVideos(
          content.sceneQueries,
          workDir
        );
    }

    // --------------------------------
    // 6. Background music
    // --------------------------------

    console.log(
      "5/8 Preparing background music..."
    );

    const musicPath =
      await prepareBackgroundMusic(
        workDir
      );

    // --------------------------------
    // 7. Video
    // --------------------------------

    let visualMode =
      "fallback";

    if (clips.length) {
      console.log(
        `Using ${clips.length} stock clip(s).`
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
        const preparedPath =
          path.join(
            workDir,
            `scene-${i}.mp4`
          );

        console.log(
          `6/8 Preparing scene ${i + 1}/${clips.length}...`
        );

        await prepareSceneClip({
          inputPath:
            clips[i]
              .filePath,

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
        "7/8 Stitching + rendering..."
      );

      await stitchSceneClips(
        prepared,
        visualPath,
        workDir
      );

      await renderStockVideo({
        visualPath,
        audioPath,
        subtitlePath,
        musicPath,
        videoPath
      });

      visualMode =
        "pexels";

    } else {
      console.log(
        "7/8 Rendering fallback video..."
      );

      await renderFallbackVideo({
        audioPath,
        subtitlePath,
        musicPath,
        videoPath
      });
    }

    // --------------------------------
    // 8. Upload
    // --------------------------------

    console.log(
      `8/8 Uploading to YouTube as ${privacyStatus}...`
    );

    const youtubeVideoId =
      await retry(
        () =>
          uploadToYouTube({
            videoPath,

            title:
              content.title,

            description:
              content.description,

            hashtags:
              content.hashtags,

            clips,

            privacyStatus
          }),
        {
          attempts:
            2,

          delayMs:
            1500,

          label:
            "YouTube upload"
        }
      );

    const entry = {
      jobId,

      videoId:
        youtubeVideoId,

      topic:
        finalTopic,

      title:
        content.title,

      createdAt:
        new Date()
          .toISOString(),

      privacyStatus,

      visualMode,

      stockClips:
        clips.length,

      music:
        Boolean(
          musicPath
        )
    };

    addHistory(entry);

    console.log(
      `SUCCESS: ${youtubeVideoId}`
    );

    return {
      success:
        true,

      youtubeVideoId,

      youtubeUrl:
        `https://www.youtube.com/watch?v=${youtubeVideoId}`,

      topic:
        finalTopic,

      privacyStatus,

      visualMode,

      stockClipsUsed:
        clips.length,

      musicUsed:
        Boolean(
          musicPath
        ),

      durationSeconds:
        actualDuration,

      content
    };

  } finally {
    activeJob = false;

    fs.promises
      .rm(
        workDir,
        {
          recursive:
            true,

          force:
            true
        }
      )
      .catch(
        () => {}
      );
  }
}

// ====================================================
// HOMEPAGE
// ====================================================

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
Automatic Shorts Engine
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Arial,
    sans-serif;

  max-width:
    720px;

  margin:
    0 auto;

  padding:
    32px 20px 60px;

  background:
    #080808;

  color:
    white;
}

h1 {
  margin-bottom:
    8px;
}

.subtitle {
  color:
    #aaa;

  margin-top:
    0;
}

.card {
  background:
    #121212;

  border:
    1px solid #282828;

  border-radius:
    16px;

  padding:
    18px;

  margin-top:
    18px;
}

.status {
  line-height:
    2;
}

.ok {
  color:
    #70ff9d;
}

.bad {
  color:
    #ff7979;
}

label {
  display:
    block;

  margin-top:
    14px;

  margin-bottom:
    6px;

  color:
    #bbb;
}

input,
select,
button {
  width:
    100%;

  padding:
    15px;

  font-size:
    16px;

  border-radius:
    10px;
}

input,
select {
  background:
    #181818;

  color:
    white;

  border:
    1px solid #444;
}

button {
  margin-top:
    18px;

  border:
    none;

  background:
    white;

  color:
    black;

  font-weight:
    800;

  cursor:
    pointer;
}

button:disabled {
  opacity:
    .45;
}

pre {
  white-space:
    pre-wrap;

  overflow-wrap:
    anywhere;

  font-size:
    13px;

  line-height:
    1.5;
}

a {
  color:
    white;
}

</style>

</head>

<body>

<h1>
Automatic Shorts Engine 🎥⚡
</h1>

<p class="subtitle">
AI → Voice → Stock footage → Captions → Music → YouTube
</p>

<div class="card status">

<strong>
System
</strong>

<br>

YouTube:
<span class="${
  storedTokens
    ? "ok"
    : "bad"
}">
${
  storedTokens
    ? "Connected ✅"
    : "Not connected ❌"
}
</span>

<br>

OpenAI:
<span class="${
  process.env
    .OPENAI_API_KEY
    ? "ok"
    : "bad"
}">
${
  process.env
    .OPENAI_API_KEY
    ? "Configured ✅"
    : "Missing ❌"
}
</span>

<br>

Pexels:
<span class="${
  process.env
    .PEXELS_API_KEY
    ? "ok"
    : "bad"
}">
${
  process.env
    .PEXELS_API_KEY
    ? "Configured ✅"
    : "Missing ❌"
}
</span>

<br>

Music:
<span class="${
  process.env
    .BACKGROUND_MUSIC_URL
    ? "ok"
    : ""
}">
${
  process.env
    .BACKGROUND_MUSIC_URL
    ? "Configured ✅"
    : "Optional"
}
</span>

<br>

Automation:
<span class="${
  process.env
    .AUTOMATION_SECRET
    ? "ok"
    : ""
}">
${
  process.env
    .AUTOMATION_SECRET
    ? "Ready ✅"
    : "Not configured"
}
</span>

<br>

Completed jobs:
<strong>
${shortHistory.length}
</strong>

</div>

<div class="card">

<label>
Topic
</label>

<input
id="topic"
placeholder="Leave blank for AI to choose a topic"
/>

<label>
Duration
</label>

<select
id="duration"
>
<option value="20">
20 seconds
</option>

<option
value="30"
selected
>
30 seconds
</option>

<option value="45">
45 seconds
</option>

<option value="60">
60 seconds
</option>
</select>

<label>
YouTube visibility
</label>

<select
id="privacy"
>
<option
value="private"
selected
>
Private
</option>

<option value="unlisted">
Unlisted
</option>

<option value="public">
Public
</option>
</select>

<button
id="generateButton"
onclick="createVideo()"
>
Generate YouTube Short
</button>

</div>

<div class="card">

<strong>
Result
</strong>

<pre id="result">
Ready.
</pre>

</div>

<script>

async function createVideo() {

  const button =
    document.getElementById(
      "generateButton"
    );

  const result =
    document.getElementById(
      "result"
    );

  button.disabled =
    true;

  result.textContent =
    "Generating content → narration → stock footage → captions → music → video → YouTube...";

  try {

    const topic =
      document
        .getElementById(
          "topic"
        )
        .value
        .trim();

    const durationSeconds =
      Number(
        document
          .getElementById(
            "duration"
          )
          .value
      );

    const privacyStatus =
      document
        .getElementById(
          "privacy"
        )
        .value;

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
                topic || undefined,

              durationSeconds,

              privacyStatus
            })
        }
      );

    const data =
      await response
        .json();

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

// ====================================================
// STATUS ROUTES
// ====================================================

app.get(
  "/health",
  (req, res) => {
    res.json(
      getSystemStatus()
    );
  }
);

app.get(
  "/status",
  async (req, res) => {
    res.json({
      ...getSystemStatus(),

      ffmpeg:
        await checkFfmpeg(),

      ffprobe:
        await checkFfprobe(),

      lastUpload
    });
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

app.get(
  "/history",
  (req, res) => {
    res.json({
      count:
        shortHistory.length,

      history:
        shortHistory
    });
  }
);

// ====================================================
// ANALYTICS
// ====================================================

app.get(
  "/analytics/:videoId",
  async (req, res) => {
    try {
      const data =
        await getVideoAnalytics(
          req.params.videoId
        );

      if (!data) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              "Video not found."
          });
      }

      return res.json({
        success:
          true,

        data
      });

    } catch (error) {
      console.error(
        "Analytics failed:",
        error.message
      );

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

// ====================================================
// PEXELS TEST
// ====================================================

app.get(
  "/test-pexels",
  async (req, res) => {
    try {
      const query =
        String(
          req.query.q ||
            "athlete training"
        )
          .trim()
          .slice(
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

// ====================================================
// VOICE TEST
// ====================================================

app.get(
  "/test-voice",
  async (req, res) => {
    try {
      const speech =
        await openai.audio
          .speech
          .create({
            model:
              "gpt-4o-mini-tts",

            voice:
              process.env
                .OPENAI_TTS_VOICE ||
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
          await speech
            .arrayBuffer()
        );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      return res.send(
        buffer
      );

    } catch (error) {
      console.error(
        "Voice test failed:",
        error.message
      );

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

// ====================================================
// MANUAL CREATE
// ====================================================

app.post(
  "/create-short",
  async (req, res) => {
    try {
      const result =
        await createShort({
          topic:
            req.body
              ?.topic,

          tone:
            req.body
              ?.tone,

          durationSeconds:
            req.body
              ?.durationSeconds,

          privacyStatus:
            req.body
              ?.privacyStatus ||
            "private"
        });

      return res.json(
        result
      );

    } catch (error) {
      console.error(
        "Create short failed:",
        error.message
      );

      const status =
        error.message
          .includes(
            "already being generated"
          )
          ? 409
          : 500;

      return res
        .status(status)
        .json({
          success:
            false,

          error:
            error.message ||
            "Unable to create Short."
        });
    }
  }
);

// ====================================================
// AUTOMATION ENDPOINT
// ====================================================

app.post(
  "/automation/run",
  async (req, res) => {
    try {
      const secret =
        req.headers[
          "x-automation-secret"
        ];

      if (
        !process.env
          .AUTOMATION_SECRET
      ) {
        return res
          .status(503)
          .json({
            success:
              false,

            error:
              "Automation is not configured."
          });
      }

      if (
        secret !==
        process.env
          .AUTOMATION_SECRET
      ) {
        return res
          .status(401)
          .json({
            success:
              false,

            error:
              "Unauthorized."
          });
      }

      const result =
        await createShort({
          topic:
            req.body
              ?.topic,

          tone:
            req.body
              ?.tone ||
            "powerful, cinematic and direct",

          durationSeconds:
            req.body
              ?.durationSeconds ||
            30,

          privacyStatus:
            req.body
              ?.privacyStatus ||
            process.env
              .AUTOMATION_PRIVACY_STATUS ||
            "private"
        });

      return res.json(
        result
      );

    } catch (error) {
      console.error(
        "Automation failed:",
        error.message
      );

      const status =
        error.message
          .includes(
            "already being generated"
          )
          ? 409
          : 500;

      return res
        .status(status)
        .json({
          success:
            false,

          error:
            error.message
        });
    }
  }
);

// ====================================================
// GOOGLE OAUTH
// ====================================================

app.get(
  "/auth/google",
  (req, res) => {
    const authUrl =
      oauth2Client
        .generateAuthUrl({
          access_type:
            "offline",

          prompt:
            "consent",

          include_granted_scopes:
            true,

          scope: [
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/youtube.readonly"
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
        await oauth2Client
          .getToken(
            code
          );

      saveTokens(
        tokens
      );

      console.log(
        "YouTube OAuth connection successfully saved."
      );

      return res.send(`
<!doctype html>
<html>
<head>
<meta
name="viewport"
content="width=device-width,initial-scale=1"
/>
<title>YouTube Connected</title>
</head>

<body
style="
font-family:Arial;
padding:40px;
background:#090909;
color:white;
"
>

<h1>
✅ YouTube Connected
</h1>

<p>
Your authorization has been saved successfully.
</p>

<p>
The automatic Shorts engine can now upload videos.
</p>

<a
href="/"
style="color:white;"
>
Return to automation
</a>

</body>
</html>
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

// ====================================================
// 404
// ====================================================

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        success:
          false,

        error:
          "Route not found."
      });
  }
);

// ====================================================
// START
// ====================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Automatic Shorts Engine running on port ${PORT}`
    );

    console.log(
      "YouTube:",
      storedTokens
        ? "connected"
        : "not connected"
    );

    console.log(
      "OpenAI:",
      process.env
        .OPENAI_API_KEY
        ? "configured"
        : "missing"
    );

    console.log(
      "Pexels:",
      process.env
        .PEXELS_API_KEY
        ? "configured"
        : "missing"
    );

    console.log(
      "Automation:",
      process.env
        .AUTOMATION_SECRET
        ? "configured"
        : "missing"
    );
  }
);
