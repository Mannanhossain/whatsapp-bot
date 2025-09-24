// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

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

  client.on('ready', () => console.log(`WhatsApp client ready for user: ${userId}`));
  client.on('auth_failure', () => console.log(`Auth failed for user: ${userId}`));
  client.on('disconnected', (reason) => console.log(`Client ${userId} disconnected: ${reason}`));

  client.initialize();
  clients[userId] = client;
  return client;
}

// Get QR code for a user to scan
app.get('/qr/:userId', async (req, res) => {
  const { userId } = req.params;

  const client = getClient(userId);

  client.on('qr', (qr) => {
    res.json({ qr });
  });
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

    // Wait until client is ready
    if (!client.info || !client.info.wid) {
      return res.status(400).json({ success: false, message: "Client not ready. Scan QR first." });
    }

    const msg = await client.sendMessage(chatId, message);

    return res.json({
      success: true,
      messageId: msg.id._serialized,
      timestamp: Math.floor(Date.now() / 1000),
      message: "Message sent successfully"
    });

  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({ success: false, message: error.toString() });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
