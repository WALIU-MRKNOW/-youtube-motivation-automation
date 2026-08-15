const target =
  (
    process.env.AUTOMATION_TARGET_URL ||
    process.env.PUBLIC_BASE_URL ||
    "https://youtube-motivation-automation-production.up.railway.app"
  ).replace(/\/$/, "");

const secret =
  process.env.AUTOMATION_SECRET;

if (!secret) {
  console.error(
    "AUTOMATION_SECRET is missing."
  );

  process.exit(1);
}

const payload = {
  durationSeconds:
    Number(
      process.env.AUTOMATION_DURATION_SECONDS
    ) || 30,

  privacyStatus:
    process.env.AUTOMATION_PRIVACY_STATUS ||
    "private"
};

if (process.env.AUTOMATION_TOPIC) {
  payload.topic =
    process.env.AUTOMATION_TOPIC;
}

try {
  const response =
    await fetch(
      `${target}/automation/run`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-automation-secret":
            secret
        },

        body:
          JSON.stringify(payload)
      }
    );

  const text =
    await response.text();

  console.log(
    `Automation response: ${response.status}`
  );

  console.log(text);

  process.exit(
    response.ok
      ? 0
      : 1
  );

} catch (error) {
  console.error(
    "Automation runner failed:",
    error.message
  );

  process.exit(1);
}
