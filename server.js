import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("YouTube Motivation Automation is running 🚀");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "youtube-motivation-automation"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
