const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// In-memory storage
let clients = new Map();
let qrcodes = new Map();
let clientStatus = new Map(); // Track client status

const API_SECRET = "mySuperSecret123!";

// ---------------------
// Middleware
// ---------------------
function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Authorization header required" });

  const token = authHeader.split(" ")[1];
  if (token !== API_SECRET) return res.status(401).json({ error: "Invalid token" });

  next();
}

// ---------------------
// Create or get client
// ---------------------
function getClient(userId) {
  if (clients.has(userId)) {
    const client = clients.get(userId);
    const status = clientStatus.get(userId);
    if (status !== "disconnected" && status !== "error") return client;
  }

  console.log(`🔄 Creating NEW WhatsApp client for: ${userId}`);

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
    console.log(`📲 QR RECEIVED for ${userId}`);
    clientStatus.set(userId, "qr_pending");
    try {
      const imageUrl = await QRCode.toDataURL(qr);
      qrcodes.set(userId, { qr, image: imageUrl, generatedAt: Date.now() });
    } catch (err) {
      console.error("QR image generation error:", err);
    }
  });

  client.on("ready", () => {
    console.log(`✅ Client ${userId} is READY`);
    clientStatus.set(userId, "ready");
    qrcodes.delete(userId);
  });

  client.on("authenticated", () => {
    console.log(`🔐 Client ${userId} authenticated`);
    clientStatus.set(userId, "authenticated");
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ Auth failed for ${userId}:`, msg);
    clientStatus.set(userId, "auth_failure");
    cleanupClient(userId);
  });

  client.on("disconnected", (reason) => {
    console.log(`⚠️ Client ${userId} disconnected:`, reason);
    clientStatus.set(userId, "disconnected");
    cleanupClient(userId);
  });

  client.on("error", (error) => {
    console.error(`💥 Error for ${userId}:`, error);
    clientStatus.set(userId, "error");
  });

  client.initialize();
  clients.set(userId, client);

  return client;
}

// Cleanup
function cleanupClient(userId) {
  if (clients.has(userId)) {
    const client = clients.get(userId);
    try { client.destroy(); } catch (err) { console.error("Error destroying client:", err); }
  }
  clients.delete(userId);
  qrcodes.delete(userId);
  clientStatus.delete(userId);
}

// Cleanup expired QR codes
setInterval(() => {
  const now = Date.now();
  const QR_EXPIRY = 10 * 60 * 1000;
  for (const [userId, qrData] of qrcodes.entries()) {
    if (now - qrData.generatedAt > QR_EXPIRY) {
      console.log(`⌛ QR expired for: ${userId}`);
      cleanupClient(userId);
    }
  }
}, 60000);

// ---------------------
// Retry-safe message sending
// ---------------------
async function safeSendMessage(client, number, message) {
  const formattedNumber = number.includes("@c.us") ? number : `${number}@c.us`;

  for (let i = 0; i < 3; i++) {
    try {
      if (client.info?.wid) {
        return await client.sendMessage(formattedNumber, message);
      } else {
        console.log("Client not ready yet, waiting 2s...");
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error(`Send attempt ${i + 1} failed:`, err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error("Failed to send message after 3 retries");
}

// ---------------------
// Routes with original UI
// ---------------------
app.get("/qr/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    getClient(userId);

    if (qrcodes.has(userId)) {
      const qrData = qrcodes.get(userId);
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>WhatsApp QR - ${userId}</title>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial; max-width: 600px; margin: 0 auto; padding: 20px; text-align: center; background: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .qr-container { margin: 20px 0; }
            .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
            .status.ready { background: #d4edda; color: #155724; }
            .status.pending { background: #fff3cd; color: #856404; }
            .auto-refresh { color: #666; font-size: 14px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📱 WhatsApp QR Code</h1>
            <div class="status pending">
              <strong>User:</strong> ${userId} | 
              <strong>Status:</strong> QR Pending - Scan below
            </div>
            <div class="qr-container">
              <img src="${qrData.image}" alt="QR Code" width="300" height="300" />
            </div>
            <div>
              <h3>Instructions:</h3>
              <ol style="text-align: left; display: inline-block;">
                <li>Open WhatsApp on your phone</li>
                <li>Tap ⋮ (Menu) → Linked Devices</li>
                <li>Tap "Link a Device"</li>
                <li>Scan the QR code above</li>
              </ol>
            </div>
            <div class="auto-refresh">
              🔄 Page will auto-refresh every 10 seconds
            </div>
            <script>setTimeout(() => location.reload(), 10000)</script>
          </div>
        </body>
        </html>
      `);
    } else {
      const status = clientStatus.get(userId) || 'unknown';
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>WhatsApp Status - ${userId}</title>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial; text-align: center; padding: 50px; }
            .status { padding: 20px; border-radius: 5px; margin: 20px 0; }
            .ready { background: #d4edda; color: #155724; }
            .pending { background: #fff3cd; color: #856404; }
          </style>
        </head>
        <body>
          <h1>WhatsApp Client Status</h1>
          <div class="status ${status === 'ready' ? 'ready' : 'pending'}">
            <h2>${status === 'ready' ? '✅ Client is READY - No QR needed' : '⏳ Please wait... QR generating'}</h2>
            <p><strong>User:</strong> ${userId}</p>
            <p><strong>Status:</strong> ${status}</p>
          </div>
          <p><a href="/qr/${userId}">Refresh page</a></p>
          <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('QR page error:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ Error</h1>
          <p>Failed to load QR code: ${error.message}</p>
          <p><a href="/qr/${userId}">Try again</a></p>
        </body>
      </html>
    `);
  }
});

// Status endpoint
app.get("/status/:userId", (req, res) => {
  const { userId } = req.params;
  const status = clientStatus.get(userId) || 'not_found';
  res.json({ userId, status, hasQR: qrcodes.has(userId), isReady: status === 'ready', timestamp: new Date().toISOString() });
});

// Send message endpoint
app.post("/send/:userId", authenticate, async (req, res) => {
  const { userId } = req.params;
  const { number, message } = req.body;

  if (!number || !message) return res.status(400).json({ success: false, error: "Number and message required" });

  try {
    const client = getClient(userId);
    const status = clientStatus.get(userId);

    if (status !== 'ready') return res.status(400).json({ success: false, error: "Client not ready", status, qrUrl: `/qr/${userId}` });

    const sentMessage = await safeSendMessage(client, number, message);

    res.json({ success: true, message: `Message sent to ${number}`, messageId: sentMessage.id._serialized });
  } catch (err) {
    console.error("❌ Error sending message:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Root endpoint
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Bot Server</title>
      <style>
        body { font-family: Arial; max-width: 800px; margin: 0 auto; padding: 20px; }
        .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-left: 4px solid #007cba; }
      </style>
    </head>
    <body>
      <h1>🚀 WhatsApp Bot Server Running</h1>
      <p><strong>Port:</strong> ${PORT}</p>
      <h2>Endpoints:</h2>
      <div class="endpoint"><strong>GET /qr/:userId</strong> - Get QR code for authentication</div>
      <div class="endpoint"><strong>GET /status/:userId</strong> - Check client status</div>
      <div class="endpoint"><strong>POST /send/:userId</strong> - Send message (requires Authorization header)</div>
      <h2>Quick Start:</h2>
      <ol>
        <li>Visit <a href="/qr/user123">/qr/user123</a> to authenticate</li>
        <li>Check status at <a href="/status/user123">/status/user123</a></li>
        <li>Send messages to /send/user123 with Authorization header</li>
      </ol>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔑 API Secret: ${API_SECRET}`);
  console.log(`📱 QR Example: http://localhost:${PORT}/qr/user123`);
});

