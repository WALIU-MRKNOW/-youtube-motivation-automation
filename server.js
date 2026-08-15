import express from "express";
import { google } from "googleapis";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

let storedTokens = null;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

app.get("/", (req, res) => {
  res.send(`
    <h1>YouTube Motivation Automation</h1>
    <p>Server is running 🚀</p>
    <a href="/auth/google">Connect YouTube</a>
    <br><br>
    <a href="/status">Check Connection</a>
  `);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/status", (req, res) => {
  res.json({
    connected: Boolean(storedTokens),
    server: "running"
  });
});

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
      return res.status(400).send("Authorization code missing.");
    }

    const { tokens } = await oauth2Client.getToken(code);

    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);

    console.log("YouTube OAuth connection successful.");

    res.send(`
      <h1>✅ YouTube Connected</h1>
      <p>Your channel is connected.</p>
      <p>Next: upload a private test video.</p>
    `);
  } catch (error) {
    console.error("OAuth callback failed:", error.message);
    res.status(500).send("YouTube authorization failed.");
  }
});

app.get("/upload-test", async (req, res) => {
  try {
    if (!storedTokens) {
      return res.status(401).send(`
        <h1>YouTube is not connected</h1>
        <a href="/auth/google">Connect YouTube first</a>
      `);
    }

    const videoPath = "./test-video.mp4";

    if (!fs.existsSync(videoPath)) {
      return res.status(404).send(`
        <h1>test-video.mp4 is missing</h1>
        <p>Add a file named test-video.mp4 to the GitHub repository.</p>
      `);
    }

    oauth2Client.setCredentials(storedTokens);

    const youtube = google.youtube({
      version: "v3",
      auth: oauth2Client
    });

    const response = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: "Motivation Automation Test",
          description:
            "Private test upload from the YouTube Motivation Automation system.",
          tags: ["motivation", "discipline", "success"],
          categoryId: "22"
        },
        status: {
          privacyStatus: "private",
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        body: fs.createReadStream(videoPath)
      }
    });

    res.send(`
      <h1>✅ Upload successful</h1>
      <p>Video ID: ${response.data.id}</p>
      <p>The video was uploaded privately.</p>
    `);

  } catch (error) {
    console.error("Upload failed:", error.message);

    res.status(500).send(`
      <h1>Upload failed</h1>
      <p>${error.message}</p>
    `);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
