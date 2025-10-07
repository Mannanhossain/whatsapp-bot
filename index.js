const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// -----------------------------
// Client storage
// -----------------------------
const clients = new Map();
const qrcodes = new Map();
const clientStatus = new Map(); // states: initializing, qr_pending, ready, disconnected, error

// -----------------------------
// Create client
// -----------------------------
function createClient(userId) {
    console.log(`🔄 Creating WhatsApp client for ${userId}`);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: userId,
            dataPath: path.join(__dirname, "sessions", userId)
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

    client.on("authenticated", () => console.log(`🔑 Client ${userId} authenticated`));
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
        if (["ready", "initializing", "qr_pending"].includes(status)) return existingClient;
        cleanupClient(userId);
    }

    const client = createClient(userId);
    clients.set(userId, client);
    client.initialize().catch(err => {
        console.error(`❌ Initialization failed for ${userId}:`, err);
        clientStatus.set(userId, "error");
    });
    return client;
}

// -----------------------------
// Cleanup client
// -----------------------------
function cleanupClient(userId) {
    if (clients.has(userId)) {
        const client = clients.get(userId);
        try { client.destroy(); } catch {}
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

    if (!client.info?.wid) await new Promise(r => setTimeout(r, 5000));
    if (!client.info?.wid) throw new Error("Client not fully initialized");

    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const result = await client.sendMessage(chatId, message);
            return { success: true, id: result.id._serialized, timestamp: result.timestamp };
        } catch (err) {
            await new Promise(r => setTimeout(r, 3000));
            if (attempt === 5) throw new Error(`Failed to send message: ${err.message}`);
        }
    }
}

// -----------------------------
// Routes
// -----------------------------
app.get("/qr/:userId", async (req, res) => {
    const { userId } = req.params;
    getClient(userId);

    const maxAttempts = 30; let attempts = 0;
    while (!qrcodes.has(userId) && attempts < maxAttempts) {
        const status = clientStatus.get(userId);
        if (status === "ready") break;
        if (["error","auth_failure"].includes(status)) return res.status(500).send(`<h2>❌ Client error: ${status}</h2>`);
        await new Promise(r => setTimeout(r, 500));
        attempts++;
    }

    const qrData = qrcodes.get(userId);
    const status = clientStatus.get(userId) || "initializing";

    if (status === "ready") return res.send(`<h2>✅ Client ready for ${userId}</h2>`);

    if (qrData) return res.send(`
        <html><body style="text-align:center;">
        <h2>📱 Scan QR for ${userId}</h2>
        <img src="${qrData.image}" width="300" /><p>Status: ${status}</p>
        <script>setTimeout(()=>location.reload(),10000)</script>
        </body></html>
    `);

    res.send(`<h2>⏳ Generating QR for ${userId}...</h2><script>setTimeout(()=>location.reload(),3000)</script>`);
});

app.get("/status/:userId", async (req,res) => {
    const { userId } = req.params;
    const status = clientStatus.get(userId) || "not_found";
    res.json({ userId, status, hasQR: qrcodes.has(userId), isReady: status==="ready" });
});

app.post("/send/:userId", async (req,res) => {
    const { userId } = req.params;
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({error:"Number & message required"});

    try {
        const client = getClient(userId);
        const status = clientStatus.get(userId);
        if (status !== "ready") return res.status(400).json({error:"Client not ready"});

        const cleanNumber = number.replace(/\D/g,'');
        const result = await safeSendMessage(client, cleanNumber, message);
        res.json({ success:true, messageId: result.id, number: cleanNumber, timestamp: result.timestamp });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/restart/:userId", async (req,res) => {
    const { userId } = req.params;
    cleanupClient(userId);
    getClient(userId);
    res.json({ success:true, message:`Client ${userId} restarted` });
});

app.get("/clients", (req,res)=>{
    const list = [];
    for(const [userId,status] of clientStatus) list.push({userId,status,hasQR:qrcodes.has(userId),isReady:status==="ready"});
    res.json({totalClients:list.length, clients:list});
});

app.delete("/client/:userId",(req,res)=>{ cleanupClient(req.params.userId); res.json({success:true}) });

app.get("/", (req,res)=>res.send(`<h1>🚀 WhatsApp Bot Server Running</h1><p>Use /qr/:userId to start</p>`));

// -----------------------------
// Start server
// -----------------------------
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));

// -----------------------------
// Graceful shutdown
// -----------------------------
process.on('SIGINT',()=>{
    for(const userId of clients.keys()) cleanupClient(userId);
    setTimeout(()=>process.exit(0),3000);
});
