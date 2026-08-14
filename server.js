import express from "express";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 8080;

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
  `);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
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

    console.log("YouTube OAuth connection successful.");

    // Do NOT print tokens to logs.
    oauth2Client.setCredentials(tokens);

    res.send(`
      <h1>✅ YouTube Connected</h1>
      <p>Your YouTube account authorized the automation successfully.</p>
      <p>You can close this page.</p>
    `);
  } catch (error) {
    console.error("OAuth callback failed:", error.message);
    res.status(500).send("YouTube authorization failed.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
