const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SECRET_KEY = process.env.SECRET_KEY || "mysecretkey";

// Map to store client instances
const clients = {};

// Root route
app.get('/', (req, res) => {
  res.send('Multi-user WhatsApp bot is running!');
});

// Generate or get WhatsApp client for a user
function getClient(userId) {
  if (clients[userId]) return clients[userId];

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: { headless: true }
  });

  // Track ready status
  client.isReady = false;
  client.messageQueue = [];

  client.on('ready', async () => {
    console.log(`WhatsApp client ready for user: ${userId}`);
    client.isReady = true;

    // Send any queued messages
    while (client.messageQueue.length > 0) {
      const { chatId, message, resolve, reject } = client.messageQueue.shift();
      try {
        const msg = await client.sendMessage(chatId, message);
        resolve(msg);
      } catch (err) {
        reject(err);
      }
    }
  });

  client.on('auth_failure', () => console.log(`Auth failed for user: ${userId}`));
  client.on('disconnected', (reason) => {
    console.log(`Client ${userId} disconnected: ${reason}`);
    client.isReady = false;
    client.initialize(); // reconnect automatically
  });

  client.initialize();
  clients[userId] = client;
  return client;
}

// Get QR code for a user to scan
app.get('/qr/:userId', async (req, res) => {
  const { userId } = req.params;
  const client = getClient(userId);

  // Use once to prevent multiple responses
  client.once('qr', (qr) => {
    res.json({ qr });
  });

  // If already ready, no QR needed
  if (client.isReady) {
    res.json({ message: "Client already authenticated and ready!" });
  }
});

// Send WhatsApp message
app.post('/send-message', async (req, res) => {
  try {
    // Authorization
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_KEY}`) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const { userId, number, message } = req.body;
    if (!userId || !number || !message) {
      return res.status(400).json({ success: false, message: "userId, number, and message required" });
    }

    const client = getClient(userId);
    const chatId = number.includes('@c.us') ? number : `${number}@c.us`;

    // If client is ready, send immediately
    if (client.isReady) {
      const msg = await client.sendMessage(chatId, message);
      return res.json({
        success: true,
        messageId: msg.id._serialized,
        timestamp: Math.floor(Date.now() / 1000),
        message: "Message sent successfully"
      });
    } else {
      // Queue message until client is ready
      const msgPromise = new Promise((resolve, reject) => {
        client.messageQueue.push({ chatId, message, resolve, reject });
      });

      const msg = await msgPromise;
      return res.json({
        success: true,
        messageId: msg.id._serialized,
        timestamp: Math.floor(Date.now() / 1000),
        message: "Message sent successfully (queued)"
      });
    }

  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({ success: false, message: error.toString() });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
