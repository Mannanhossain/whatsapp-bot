const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs-extra");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// In-memory data
let clients = new Map();
let qrcodes = new Map();
let clientStatus = new Map();

const PORT = process.env.PORT || 3000;

/* ---------------------- Helper: Start WhatsApp Client ---------------------- */
async function startClient(userId) {
  if (clients.has(userId)) return clients.get(userId);

  console.log(`[INFO] Starting WhatsApp client for ${userId}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });

  clients.set(userId, client);
  clientStatus.set(userId, "initializing");

  client.on("qr", async (qr) => {
    console.log(`[QR] New QR for ${userId}`);
    const qrImage = await QRCode.toDataURL(qr);
    qrcodes.set(userId, qrImage);
    clientStatus.set(userId, "qr");
  });

  client.on("ready", () => {
    console.log(`[READY] WhatsApp client ready for ${userId}`);
    clientStatus.set(userId, "ready");
    qrcodes.delete(userId);
  });

  client.on("disconnected", (reason) => {
    console.log(`[DISCONNECTED] ${userId} - ${reason}`);
    clientStatus.set(userId, "disconnected");
    clients.delete(userId);
  });

  client.initialize();
  return client;
}

/* ---------------------- Routes ---------------------- */

// ✅ Get QR or Ready status
app.get("/qr/:userId", async (req, res) => {
  const { userId } = req.params;
  let status = clientStatus.get(userId) || "initializing";

  if (!clients.has(userId)) {
    await startClient(userId);
    status = "qr_pending";
  }

  const qrImage = qrcodes.get(userId);
  const isReady = clientStatus.get(userId) === "ready";

  if (isReady) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;margin-top:80px;">
      <h2>✅ WhatsApp Client Ready</h2>
      <p>User ID: <b>${userId}</b></p>
      <p>No QR needed — already connected.</p>
      </body></html>
    `);
  }

  if (qrImage) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;margin-top:50px;">
      <h2>📱 Scan QR to Connect WhatsApp</h2>
      <p>User ID: <b>${userId}</b></p>
      <img src="${qrImage}" style="width:300px;height:300px;"/>
      </body></html>
    `);
  } else {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;margin-top:80px;">
      <h3>⏳ Waiting for QR generation...</h3>
      </body></html>
    `);
  }
});

// ✅ Send WhatsApp message
app.post("/send/:userId", async (req, res) => {
  const { userId } = req.params;
  const { number, message } = req.body;

  try {
    if (!clients.has(userId))
      return res.json({ success: false, message: "Client not initialized" });

    const client = clients.get(userId);
    if (clientStatus.get(userId) !== "ready")
      return res.json({ success: false, message: "Client not ready. Scan QR first." });

    const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
    await client.sendMessage(chatId, message);
    res.json({ success: true, message: `Message sent to ${number}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ Reset WhatsApp session (force new QR)
app.post("/reset/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    console.log(`[RESET] Resetting session for ${userId}`);

    // Destroy active client
    if (clients.has(userId)) {
      const client = clients.get(userId);
      await client.destroy();
      clients.delete(userId);
      qrcodes.delete(userId);
      clientStatus.delete(userId);
    }

    // Remove local session folder
    const sessionDir = path.join(__dirname, ".wwebjs_auth", `session-${userId}`);
    if (fs.existsSync(sessionDir)) await fs.remove(sessionDir);

    res.json({ success: true, message: "Session reset successfully. Scan QR again." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ Default route
app.get("/", (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;margin-top:80px;">
    <h2>🚀 WhatsApp Bot Server Running</h2>
    <p>Use <code>/qr/{userId}</code> to view QR</p>
    </body></html>
  `);
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
