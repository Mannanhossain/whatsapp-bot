const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// -----------------------------
// WhatsApp client management
// -----------------------------
const clients = new Map();
const qrcodes = new Map();
const clientStatus = new Map();

function createClient(userId) {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId, dataPath: path.join(__dirname, "sessions", userId) }),
        puppeteer: { headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] }
    });

    clientStatus.set(userId, "initializing");

    client.on("qr", async (qr) => {
        clientStatus.set(userId, "qr_pending");
        const qrImage = await QRCode.toDataURL(qr);
        qrcodes.set(userId, { qr, image: qrImage, generatedAt: Date.now() });
    });

    client.on("ready", () => {
        clientStatus.set(userId, "ready");
        qrcodes.delete(userId);
    });

    client.on("authenticated", () => console.log(`Client ${userId} authenticated`));
    client.on("auth_failure", () => { clientStatus.set(userId, "auth_failure"); cleanupClient(userId); });
    client.on("disconnected", () => { clientStatus.set(userId, "disconnected"); cleanupClient(userId); });
    client.on("error", (err) => { console.error(`Error for ${userId}:`, err); clientStatus.set(userId, "error"); });

    return client;
}

function getClient(userId) {
    if (clients.has(userId)) {
        const client = clients.get(userId);
        const status = clientStatus.get(userId);
        if (["ready","initializing","qr_pending"].includes(status)) return client;
        cleanupClient(userId);
    }
    const client = createClient(userId);
    clients.set(userId, client);
    client.initialize().catch(err => { console.error(`Init failed for ${userId}:`, err); clientStatus.set(userId,"error"); });
    return client;
}

function cleanupClient(userId) {
    if (clients.has(userId)) {
        try { clients.get(userId).destroy(); } catch {}
        clients.delete(userId);
        qrcodes.delete(userId);
        clientStatus.delete(userId);
    }
}

async function safeSendMessage(client, number, message) {
    const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
    if (!client.info?.wid) await new Promise(r => setTimeout(r,5000));
    return await client.sendMessage(chatId, message);
}

// -----------------------------
// SMS trigger function (Flutter API endpoint)
// -----------------------------
async function sendSMSviaFlutter(number, message) {
    try {
        const response = await axios.post("http://<flutter-device-ip>:<port>/sendSMS", { number, message });
        return response.data;
    } catch (err) {
        console.error("SMS send failed:", err.message);
        return { success: false, error: err.message };
    }
}

// -----------------------------
// Routes
// -----------------------------

// Missed call endpoint
app.post("/send/missedcall/:userId", async (req,res) => {
    const { userId } = req.params;
    const { number, message } = req.body;

    if (!number || !message) return res.status(400).json({ error: "Number and message required" });

    try {
        const client = getClient(userId);
        if (clientStatus.get(userId) !== "ready") return res.status(400).json({ error: "WhatsApp client not ready" });

        // Send WhatsApp
        const waResult = await safeSendMessage(client, number, message);

        // Trigger SMS via Flutter
        const smsResult = await sendSMSviaFlutter(number, message);

        res.json({
            success: true,
            whatsapp: { id: waResult.id._serialized, number, status: "sent" },
            sms: smsResult
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------
// Start server
// -----------------------------
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
