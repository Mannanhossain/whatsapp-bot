const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// -----------------------------
// WhatsApp client management
// -----------------------------
const clients = new Map();
const qrcodes = new Map();
const clientStatus = new Map(); // initializing, qr_pending, ready, disconnected, error

function createClient(userId) {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: userId,
            dataPath: path.join(__dirname, "sessions", userId),
        }),
        puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
    });

    clientStatus.set(userId, "initializing");

    client.on("qr", async (qr) => {
        clientStatus.set(userId, "qr_pending");
        const qrImage = await QRCode.toDataURL(qr);
        qrcodes.set(userId, { qr, image: qrImage, generatedAt: Date.now() });
        console.log(`📲 QR received for ${userId}`);
    });

    client.on("ready", () => {
        clientStatus.set(userId, "ready");
        qrcodes.delete(userId);
        console.log(`✅ WhatsApp client ready for ${userId}`);
    });

    client.on("auth_failure", (msg) => {
        console.error(`❌ Auth failure for ${userId}:`, msg);
        clientStatus.set(userId, "auth_failure");
    });

    client.on("disconnected", (reason) => {
        console.log(`⚠️ Client ${userId} disconnected:`, reason);
        clientStatus.set(userId, "disconnected");
    });

    client.initialize();
    clients.set(userId, client);
    return client;
}

function getClient(userId) {
    if (clients.has(userId)) return clients.get(userId);
    return createClient(userId);
}

// -----------------------------
// Send WhatsApp message
// -----------------------------
async function sendWhatsAppMessage(client, number, message) {
    let waNumber = number.replace(/\D/g, ""); // remove non-digits
    waNumber = "91" + waNumber + "@c.us"; // add country code +91
    const result = await client.sendMessage(waNumber, message);
    return { success: true, id: result.id._serialized };
}

// -----------------------------
// SMS sending function (simulate)
// -----------------------------
// On Android, use SmsManager to send SMS
async function sendSMS(number, message) {
    // Here, just log. Actual SMS is sent from Android app via SmsManager
    console.log(`📨 SMS to ${number}: ${message}`);
    return { success: true };
}

// -----------------------------
// Endpoint to send both WhatsApp & SMS
// -----------------------------
app.post("/send/:userId", async (req, res) => {
    const { userId } = req.params;
    const { number, message } = req.body;

    if (!number || !message) return res.status(400).json({ error: "Number and message required" });

    const client = getClient(userId);
    const status = clientStatus.get(userId);

    if (status !== "ready") return res.status(400).json({ error: "WhatsApp client not ready" });

    try {
        const [waResult, smsResult] = await Promise.all([
            sendWhatsAppMessage(client, number, message),
            sendSMS(number, message),
        ]);

        res.json({
            success: true,
            whatsapp: waResult,
            sms: smsResult,
        });
    } catch (err) {
        console.error("Send error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// -----------------------------
// QR page
// -----------------------------
app.get("/qr/:userId", (req, res) => {
    const userId = req.params.userId;
    getClient(userId);

    if (qrcodes.has(userId)) {
        const qrData = qrcodes.get(userId);
        return res.send(`
            <h2>Scan QR for ${userId}</h2>
            <img src="${qrData.image}" width="300" />
        `);
    }
    res.send("<h2>QR not generated yet, refresh in a few seconds...</h2>");
});

// -----------------------------
// Start server
// -----------------------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
