const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// -----------------------------
// Client storage
// -----------------------------
const clients = new Map();
const qrcodes = new Map();
const clientStatus = new Map(); // initializing, qr_pending, ready, disconnected, error

// -----------------------------
// Create WhatsApp client
// -----------------------------
function createClient(userId) {
  console.log(`🔄 Creating WhatsApp client for ${userId}`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: userId,
      dataPath: path.join(__dirname, "sessions", userId),
    }),
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
        "--disable-gpu",
        "--disable-extensions",
        "--disable-notifications",
        "--disable-infobars",
        "--window-size=1280,800",
        "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ],
      ignoreHTTPSErrors: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
    },
    webVersionCache: {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2435.9.html",
    },
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

  client.on("authenticated", () => {
    console.log(`🔑 Client ${userId} authenticated`);
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ Auth failure for ${userId}:`, msg);
    clientStatus.set(userId, "auth_failure");
    cleanupClient(userId);
  });

  client.on("disconnected", (reason) => {
    console.log(`⚠️ Client ${userId} disconnected:`, reason);
    clientStatus.set(userId, "disconnected");
    cleanupClient(userId);
  });

  client.on("error", (err) => {
    console.error(`💥 Error for ${userId}:`, err);
    clientStatus.set(userId, "error");
  });

  return client;
}

// -----------------------------
// Get or create client
// -----------------------------
function getClient(userId) {
  if (clients.has(userId)) {
    const existingClient = clients.get(userId);
    const status = clientStatus.get(userId);

    if (status === "ready" || status === "initializing" || status === "qr_pending") {
      return existingClient;
    } else {
      cleanupClient(userId);
    }
  }

  const client = createClient(userId);
  clients.set(userId, client);

  client.initialize().catch((err) => {
    console.error(`❌ Initialization failed for ${userId}:`, err);
    clientStatus.set(userId, "error");
  });

  return client;
}

// -----------------------------
// Cleanup client
// -----------------------------
function cleanupClient(userId) {
  console.log(`🧹 Cleaning up client for ${userId}`);
  if (clients.has(userId)) {
    try {
      clients.get(userId).destroy();
    } catch (err) {
      console.error(`❌ Error destroying client ${userId}:`, err);
    }
  }
  clients.delete(userId);
  qrcodes.delete(userId);
  clientStatus.delete(userId);
}

// -----------------------------
// Safe send message
// -----------------------------
async function safeSendMessage(client, number, message) {
  const chatId = number.includes("@c.us") ? number : `${number}@c.us`;

  // Wait for client to be ready
  let tries = 0;
  while ((!client.info || !client.info.wid) && tries < 5) {
    console.log("⏳ Waiting for WhatsApp client to initialize...");
    await new Promise((res) => setTimeout(res, 2000));
    tries++;
  }
  if (!client.info?.wid) throw new Error("❌ WhatsApp client not ready");

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`🔄 Send attempt ${attempt} for ${chatId}`);
      const result = await client.sendMessage(chatId, message);
      console.log(`✅ Message sent successfully to ${chatId}`);
      return { success: true, id: result.id._serialized, timestamp: result.timestamp };
    } catch (err) {
      console.error(`❌ Send attempt ${attempt} failed:`, err.message);
      await new Promise((res) => setTimeout(res, 3000));
      if (attempt === 5) throw new Error(`Failed after 5 attempts: ${err.message}`);
    }
  }
}

// -----------------------------
// Routes
// -----------------------------

// QR route
app.get("/qr/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    getClient(userId);

    const maxAttempts = 30;
    let attempts = 0;

    while (!qrcodes.has(userId) && attempts < maxAttempts) {
      const status = clientStatus.get(userId);
      if (status === "ready") break;
      if (status === "error" || status === "auth_failure")
        return res.status(500).send(`<h2>❌ Client error: ${status}</h2>`);
      await new Promise((res) => setTimeout(res, 500));
      attempts++;
    }

    const qrData = qrcodes.get(userId);
    const status = clientStatus.get(userId) || "initializing";

    if (status === "ready") {
      return res.send(`<h2>✅ WhatsApp Client Ready for ${userId}</h2><p>Use /send endpoint</p>`);
    }

    if (qrData) {
      return res.send(`
        <html>
          <head><title>QR Code for ${userId}</title></head>
          <body>
            <h2>📱 Scan QR Code for ${userId}</h2>
            <img src="${qrData.image}" width="300" alt="QR Code"/>
            <p>Status: ${status}</p>
            <script>setTimeout(()=>location.reload(),10000)</script>
          </body>
        </html>`);
    }

    res.send(`<h2>⏳ Generating QR for ${userId}...</h2><script>setTimeout(()=>location.reload(),3000)</script>`);
  } catch (err) {
    res.status(500).send(`<h2>❌ Error: ${err.message}</h2>`);
  }
});

// Send message
app.post("/send/:userId", async (req, res) => {
  const { userId } = req.params;
  const { number, message } = req.body;

  if (!number || !message)
    return res.status(400).json({ error: "Number and message required" });

  try {
    const client = getClient(userId);
    const status = clientStatus.get(userId);

    if (status !== "ready") {
      return res.status(400).json({ error: "Client not ready", status });
    }

    const cleanNumber = number.replace(/\D/g, "");
    if (cleanNumber.length < 10)
      return res.status(400).json({ error: "Invalid phone number" });

    const result = await safeSendMessage(client, cleanNumber, message);
    res.json({ success: true, messageId: result.id, number: cleanNumber, timestamp: result.timestamp });
  } catch (err) {
    console.error(`Send error for ${userId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Status
app.get("/status/:userId", (req, res) => {
  const { userId } = req.params;
  const status = clientStatus.get(userId) || "not_found";
  res.json({ userId, status, hasQR: qrcodes.has(userId) });
});

// Restart
app.post("/restart/:userId", (req, res) => {
  const { userId } = req.params;
  cleanupClient(userId);
  getClient(userId);
  res.json({ success: true, message: `Client ${userId} restarted` });
});

// Root
app.get("/", (req, res) => res.send("<h2>🚀 WhatsApp Bot Running</h2>"));

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

// Graceful shutdown
process.on("SIGINT", () => {
  for (const userId of clients.keys()) cleanupClient(userId);
  setTimeout(() => process.exit(0), 2000);
});
