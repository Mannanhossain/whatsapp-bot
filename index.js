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
const clientStatus = new Map();

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
      headless: "new", // Works better on Railway
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,800",
        "--disable-extensions",
        "--disable-notifications",
        "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ],
      ignoreHTTPSErrors: true,
    },
  });

  clientStatus.set(userId, "initializing");

  client.on("qr", async (qr) => {
    console.log(`📲 QR received for ${userId}`);
    clientStatus.set(userId, "qr_pending");
    try {
      const qrImage = await QRCode.toDataURL(qr);
      qrcodes.set(userId, qrImage);
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

  client.initialize(); // Must initialize after events attached
  return client;
}

// -----------------------------
// Get or create client
// -----------------------------
function getClient(userId) {
  if (clients.has(userId)) {
    const existingClient = clients.get(userId);
    const status = clientStatus.get(userId);
    if (["ready", "initializing", "qr_pending"].includes(status)) return existingClient;
    cleanupClient(userId);
  }
  const client = createClient(userId);
  clients.set(userId, client);
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
      console.log(`✅ Client ${userId} destroyed`);
    } catch (err) {
      console.error(`❌ Error destroying client ${userId}:`, err);
    }
  }
  clients.delete(userId);
  qrcodes.delete(userId);
  clientStatus.delete(userId);
}

// -----------------------------
// Send message
// -----------------------------
async function safeSendMessage(client, number, message) {
  const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
  if (!client.info?.wid) await new Promise(r => setTimeout(r, 5000));
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const result = await client.sendMessage(chatId, message);
      return { success: true, id: result.id._serialized, timestamp: result.timestamp };
    } catch (err) {
      console.error(`❌ Attempt ${attempt} failed:`, err.message);
      if (attempt === 5) throw new Error(`Failed to send after 5 attempts: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// -----------------------------
// Routes
// -----------------------------

// QR Route
app.get("/qr/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    getClient(userId);

    let attempts = 0;
    while (!qrcodes.has(userId) && attempts < 40) {
      const status = clientStatus.get(userId);
      if (status === "ready") break;
      if (["error", "auth_failure"].includes(status)) return res.status(500).send(`❌ Client error: ${status}`);
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    const qrData = qrcodes.get(userId);
    const status = clientStatus.get(userId);

    if (status === "ready") return res.send(`<h2>✅ Client Ready for ${userId}</h2>`);

    if (qrData) return res.send(`
      <html>
        <body style="text-align:center; font-family:Arial">
          <h2>📱 Scan QR Code for ${userId}</h2>
          <img src="${qrData}" width="300"/>
          <p>Status: ${status}</p>
          <script>setTimeout(()=>location.reload(),10000)</script>
        </body>
      </html>
    `);

    res.send(`<h2>⏳ Generating QR for ${userId}...</h2><script>setTimeout(()=>location.reload(),3000)</script>`);
  } catch (err) {
    res.status(500).send(`<h2>❌ Error: ${err.message}</h2>`);
  }
});

// Send message
app.post("/send/:userId", async (req, res) => {
  const { userId } = req.params;
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: "Number and message required" });

  try {
    const client = getClient(userId);
    if (clientStatus.get(userId) !== "ready") return res.status(400).json({ error: "Client not ready" });

    const cleanNumber = number.replace(/\D/g, '');
    const result = await safeSendMessage(client, cleanNumber, message);
    res.json({ success: true, messageId: result.id, number: cleanNumber, timestamp: result.timestamp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status
app.get("/status/:userId", (req, res) => {
  const { userId } = req.params;
  res.json({ userId, status: clientStatus.get(userId) || "not_found", hasQR: qrcodes.has(userId) });
});

// Restart
app.post("/restart/:userId", (req, res) => {
  const { userId } = req.params;
  cleanupClient(userId);
  getClient(userId);
  res.json({ success: true, message: `Client ${userId} restarted` });
});

// List clients
app.get("/clients", (req, res) => {
  const clientList = [];
  for (const [userId, status] of clientStatus) clientList.push({ userId, status, hasQR: qrcodes.has(userId) });
  res.json({ total: clientList.length, clients: clientList });
});

// Cleanup client
app.delete("/client/:userId", (req, res) => {
  const { userId } = req.params;
  cleanupClient(userId);
  res.json({ success: true, message: `Client ${userId} cleaned up` });
});

// Root
app.get("/", (req, res) => res.send("<h1>🚀 WhatsApp Bot Server Running</h1>"));

// -----------------------------
// Start server
// -----------------------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// -----------------------------
// Graceful shutdown
// -----------------------------
process.on("SIGINT", () => {
  console.log("🛑 Shutting down...");
  for (const userId of clients.keys()) cleanupClient(userId);
  setTimeout(() => process.exit(0), 3000);
});
