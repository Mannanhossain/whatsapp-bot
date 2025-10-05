const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs-extra");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// -----------------------------
// In-memory storage per user
// -----------------------------
let clients = new Map();
let qrcodes = new Map();
let clientStatus = new Map(); // initializing, qr_pending, ready, disconnected

// -----------------------------
// Start or get WhatsApp client
// -----------------------------
function getClient(userId) {
  // Return existing client if still active
  if (clients.has(userId) && !["disconnected", "error"].includes(clientStatus.get(userId))) {
    return clients.get(userId);
  }

  console.log(`🔄 Starting WhatsApp client for ${userId}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId, dataPath: path.join(__dirname, "sessions", userId) }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu"
      ]
    }
  });

  clientStatus.set(userId, "initializing");

  client.on("qr", async (qr) => {
    console.log(`📲 QR received for ${userId}`);
    clientStatus.set(userId, "qr_pending");

    try {
      const qrImage = await QRCode.toDataURL(qr);
      qrcodes.set(userId, { qr, image: qrImage, generatedAt: Date.now() });
    } catch (err) {
      console.error("QR generation error:", err);
    }
  });

  client.on("ready", () => {
    console.log(`✅ Client ${userId} ready`);
    clientStatus.set(userId, "ready");
    qrcodes.delete(userId);
  });

  client.on("auth_failure", () => {
    console.error(`❌ Auth failure for ${userId}`);
    clientStatus.set(userId, "auth_failure");
    cleanupClient(userId);
  });

  client.on("disconnected", () => {
    console.log(`⚠️ Client ${userId} disconnected`);
    clientStatus.set(userId, "disconnected");
    cleanupClient(userId);
  });

  client.on("error", (err) => {
    console.error(`💥 Error for ${userId}:`, err);
    clientStatus.set(userId, "error");
  });

  client.initialize();
  clients.set(userId, client);
  return client;
}

// -----------------------------
// Cleanup client
// -----------------------------
function cleanupClient(userId) {
  if (clients.has(userId)) {
    try { clients.get(userId).destroy(); } catch (err) { console.error(err); }
  }
  clients.delete(userId);
  qrcodes.delete(userId);
  clientStatus.delete(userId);
}

// -----------------------------
// Send message safely
// -----------------------------
async function safeSendMessage(client, number, message) {
  const chatId = number.includes("@c.us") ? number : `${number}@c.us`;

  for (let i = 0; i < 3; i++) {
    try {
      if (client.info?.wid) {
        return await client.sendMessage(chatId, message);
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`Send attempt ${i + 1} failed:`, err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw new Error("Failed to send message after 3 retries");
}

// -----------------------------
// QR page route
// -----------------------------
app.get("/qr/:userId", async (req, res) => {
  const { userId } = req.params;
  getClient(userId);

  // Wait a short time for QR to appear
  let attempts = 0;
  while (!qrcodes.has(userId) && attempts < 20) {
    await new Promise(r => setTimeout(r, 500));
    attempts++;
  }

  const qrData = qrcodes.get(userId);
  const status = clientStatus.get(userId) || "initializing";

  if (status === "ready") {
    return res.send(`<h2>✅ WhatsApp Client Ready for ${userId}</h2>`);
  }

  if (qrData) {
    return res.send(`
      <h2>📱 QR for ${userId}</h2>
      <img src="${qrData.image}" width="300"/>
      <p>Status: ${status} (Page auto-refreshes every 10s)</p>
      <script>setTimeout(()=>location.reload(),10000)</script>
    `);
  }

  res.send(`<h2>⏳ Waiting QR for ${userId}...</h2><script>setTimeout(()=>location.reload(),3000)</script>`);
});

// -----------------------------
// Status endpoint
// -----------------------------
app.get("/status/:userId", (req, res) => {
  const { userId } = req.params;
  const status = clientStatus.get(userId) || "not_found";
  res.json({ userId, status, hasQR: qrcodes.has(userId), isReady: status === "ready" });
});

// -----------------------------
// Send message endpoint
// -----------------------------
app.post("/send/:userId", async (req, res) => {
  const { userId } = req.params;
  const { number, message } = req.body;

  if (!number || !message) return res.status(400).json({ error: "Number and message required" });

  try {
    const client = getClient(userId);
    if (clientStatus.get(userId) !== "ready") return res.status(400).json({ error: "Client not ready", status: clientStatus.get(userId) });

    const sent = await safeSendMessage(client, number, message);
    res.json({ success: true, messageId: sent.id._serialized, number });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// Root page
// -----------------------------
app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 WhatsApp Bot Server Running</h1>
    <p>Use <a href="/qr/user1">/qr/user1</a> to get QR for user1</p>
    <p>Use /qr/:userId for multiple users (user2, user3, etc.)</p>
  `);
});

// -----------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
