const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs-extra");

const app = express();
app.use(cors({
    origin: true, // Allow all origins or specify your frontend URL
    credentials: true
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// -----------------------------
// Enhanced client storage with better state management
// -----------------------------
const clients = new Map();
const qrcodes = new Map();
const clientStatus = new Map(); // states: initializing, qr_pending, ready, disconnected, error

// -----------------------------
// Improved client configuration
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
                "--disable-gpu",
                "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ],
            executablePath: process.env.CHROMIUM_PATH || undefined // Set if using custom Chrome
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });
    clientStatus.set(userId, "initializing");

    client.on("qr", async (qr) => {
        console.log(`📲 QR received for ${userId}`);
        clientStatus.set(userId, "qr_pending");

        try {
            const qrImage = await QRCode.toDataURL(qr);
            qrcodes.set(userId, { 
                qr, 
                image: qrImage, 
                generatedAt: Date.now() 
            });
        } catch (err) {
            console.error("QR generation error:", err);
        }
    });

    client.on("ready", () => {
        console.log(`✅ Client ${userId} ready`);
        clientStatus.set(userId, "ready");
        qrcodes.delete(userId);
        
        // Clear any existing QR data
        if (qrcodes.has(userId)) {
            qrcodes.delete(userId);
        }
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
// Get or create client with better management
// -----------------------------
function getClient(userId) {
    // Return existing client if still connected
    if (clients.has(userId)) {
        const existingClient = clients.get(userId);
        const status = clientStatus.get(userId);
        
        if (status === "ready" || status === "initializing" || status === "qr_pending") {
            return existingClient;
        } else {
            // Clean up disconnected/errored clients
            cleanupClient(userId);
        }
    }

    const client = createClient(userId);
    clients.set(userId, client);
    
    // Initialize with error handling
    client.initialize().catch(err => {
        console.error(`❌ Initialization failed for ${userId}:`, err);
        clientStatus.set(userId, "error");
    });

    return client;
}

// -----------------------------
// Enhanced cleanup function
// -----------------------------
function cleanupClient(userId) {
    console.log(`🧹 Cleaning up client for ${userId}`);
    
    if (clients.has(userId)) {
        const client = clients.get(userId);
        try {
            client.destroy();
            console.log(`✅ Client ${userId} destroyed successfully`);
        } catch (err) {
            console.error(`❌ Error destroying client ${userId}:`, err);
        }
    }
    
    clients.delete(userId);
    qrcodes.delete(userId);
    clientStatus.delete(userId);
}

// -----------------------------
// Robust message sending function
// -----------------------------
async function safeSendMessage(client, number, message) {
    const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
    
    console.log(`📤 Attempting to send message to ${chatId}`);

    // Wait for client to be fully ready
    if (!client.info?.wid) {
        console.log(`⏳ Waiting for client to be ready...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        if (!client.info?.wid) {
            throw new Error("Client not fully initialized");
        }
    }

    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            console.log(`🔄 Send attempt ${attempt} for ${chatId}`);
            
            // Use direct sendMessage approach - more reliable
            const result = await client.sendMessage(chatId, message);
            
            console.log(`✅ Message sent successfully to ${chatId}`);
            return { 
                success: true, 
                id: result.id._serialized,
                timestamp: result.timestamp
            };
            
        } catch (err) {
            console.error(`❌ Send attempt ${attempt} failed:`, err.message);
            
            // Different strategies based on error type
            if (err.message.includes('not found')) {
                throw new Error(`Phone number ${number} not found on WhatsApp`);
            }
            
            if (err.message.includes('Evaluation failed')) {
                // Longer wait for evaluation errors
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                // Try to refresh page on evaluation errors (first few attempts)
                if (attempt <= 2) {
                    try {
                        console.log('🔄 Attempting page refresh...');
                        const page = await client.getPage();
                        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    } catch (refreshErr) {
                        console.log('⚠️ Page refresh failed, continuing...');
                    }
                }
            } else {
                // Standard wait for other errors
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            
            // Last attempt - rethrow the error
            if (attempt === 5) {
                throw new Error(`Failed to send message after 5 attempts: ${err.message}`);
            }
        }
    }
}

// -----------------------------
// Client health check
// -----------------------------
async function checkClientHealth(client) {
    try {
        // Simple health check - try to get the current page
        const page = await client.getPage();
        const title = await page.title();
        return title.includes('WhatsApp');
    } catch (error) {
        return false;
    }
}

// -----------------------------
// Routes
// -----------------------------

// QR page route
app.get("/qr/:userId", async (req, res) => {
    const { userId } = req.params;
    
    try {
        getClient(userId);

        // Wait for QR with timeout
        const maxAttempts = 30; // 15 seconds total
        let attempts = 0;
        
        while (!qrcodes.has(userId) && attempts < maxAttempts) {
            const status = clientStatus.get(userId);
            if (status === "ready") break;
            if (status === "error" || status === "auth_failure") {
                return res.status(500).send(`<h2>❌ Client error: ${status}</h2>`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }

        const qrData = qrcodes.get(userId);
        const status = clientStatus.get(userId) || "initializing";

        if (status === "ready") {
            return res.send(`
                <h2>✅ WhatsApp Client Ready for ${userId}</h2>
                <p>You can now send messages using the /send endpoint</p>
            `);
        }

        if (qrData) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>QR Code for ${userId}</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
                        .container { max-width: 400px; margin: 0 auto; }
                        .status { margin: 20px 0; padding: 10px; border-radius: 5px; }
                        .ready { background: #d4edda; color: #155724; }
                        .pending { background: #fff3cd; color: #856404; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>📱 Scan QR Code for ${userId}</h2>
                        <img src="${qrData.image}" width="300" alt="QR Code"/>
                        <div class="status ${status === 'ready' ? 'ready' : 'pending'}">
                            Status: ${status}
                        </div>
                        <p>Page auto-refreshes every 10 seconds</p>
                    </div>
                    <script>
                        setTimeout(() => location.reload(), 10000);
                    </script>
                </body>
                </html>
            `);
        }

        res.send(`
            <h2>⏳ Generating QR for ${userId}...</h2>
            <script>setTimeout(() => location.reload(), 3000)</script>
        `);
        
    } catch (error) {
        console.error(`Error in QR route for ${userId}:`, error);
        res.status(500).send(`<h2>❌ Error: ${error.message}</h2>`);
    }
});

// Status endpoint
app.get("/status/:userId", async (req, res) => {
    const { userId } = req.params;
    const status = clientStatus.get(userId) || "not_found";
    const hasQR = qrcodes.has(userId);
    const isReady = status === "ready";
    
    let health = "unknown";
    if (isReady && clients.has(userId)) {
        health = await checkClientHealth(clients.get(userId)) ? "healthy" : "unhealthy";
    }
    
    res.json({ 
        userId, 
        status, 
        hasQR, 
        isReady,
        health,
        timestamp: new Date().toISOString()
    });
});

// Send message endpoint
app.post("/send/:userId", async (req, res) => {
    const { userId } = req.params;
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({ 
            error: "Number and message are required",
            example: { "number": "1234567890", "message": "Hello World" }
        });
    }

    try {
        const client = getClient(userId);
        const status = clientStatus.get(userId);
        
        if (status !== "ready") {
            return res.status(400).json({ 
                error: "Client not ready", 
                status: status,
                suggestion: "Visit /qr/" + userId + " to authenticate"
            });
        }

        // Validate phone number format
        const cleanNumber = number.replace(/\D/g, '');
        if (cleanNumber.length < 10) {
            return res.status(400).json({ 
                error: "Invalid phone number format",
                suggestion: "Use format: 1234567890 (without country code) or 1234567890@c.us"
            });
        }

        const result = await safeSendMessage(client, cleanNumber, message);
        
        res.json({ 
            success: true, 
            messageId: result.id,
            number: cleanNumber,
            timestamp: result.timestamp,
            status: "delivered"
        });
        
    } catch (err) {
        console.error(`Send error for ${userId}:`, err);
        
        res.status(500).json({ 
            error: err.message,
            suggestion: "Try reloading the QR code at /qr/" + userId
        });
    }
});

// Restart client endpoint
app.post("/restart/:userId", async (req, res) => {
    const { userId } = req.params;
    
    try {
        console.log(`🔄 Restarting client for ${userId}`);
        cleanupClient(userId);
        
        // Wait for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Create new client
        getClient(userId);
        
        res.json({ 
            success: true, 
            message: `Client ${userId} restarted successfully` 
        });
    } catch (err) {
        res.status(500).json({ 
            error: err.message 
        });
    }
});

// List all clients endpoint
app.get("/clients", (req, res) => {
    const clientList = [];
    
    for (const [userId, status] of clientStatus) {
        clientList.push({
            userId,
            status,
            hasQR: qrcodes.has(userId),
            isReady: status === "ready"
        });
    }
    
    res.json({
        totalClients: clientList.length,
        clients: clientList
    });
});

// Cleanup endpoint
app.delete("/client/:userId", (req, res) => {
    const { userId } = req.params;
    cleanupClient(userId);
    res.json({ 
        success: true, 
        message: `Client ${userId} cleaned up` 
    });
});

// Root page
app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Bot Server</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; }
                .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
                code { background: #eee; padding: 2px 5px; }
            </style>
        </head>
        <body>
            <h1>🚀 WhatsApp Bot Server Running</h1>
            <p>Available endpoints:</p>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/qr/:userId</code> - Get QR code for authentication
            </div>
            
            <div class="endpoint">
                <strong>POST</strong> <code>/send/:userId</code> - Send message
                <br><small>Body: {"number": "1234567890", "message": "Hello"}</small>
            </div>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/status/:userId</code> - Check client status
            </div>
            
            <div class="endpoint">
                <strong>POST</strong> <code>/restart/:userId</code> - Restart client
            </div>
            
            <div class="endpoint">
                <strong>GET</strong> <code>/clients</code> - List all clients
            </div>
            
            <p>Examples:</p>
            <ul>
                <li><a href="/qr/user1">/qr/user1</a> - QR for user1</li>
                <li><a href="/status/user1">/status/user1</a> - Status for user1</li>
                <li><a href="/clients">/clients</a> - List all clients</li>
            </ul>
        </body>
        </html>
    `);
});

// -----------------------------
// Server startup
// -----------------------------
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📋 Available endpoints:`);
    console.log(`   GET  /qr/:userId     - Get QR code`);
    console.log(`   POST /send/:userId   - Send message`);
    console.log(`   GET  /status/:userId - Check status`);
    console.log(`   POST /restart/:userId - Restart client`);
    console.log(`   GET  /clients        - List all clients`);
});

// -----------------------------
// Graceful shutdown
// -----------------------------
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    // Cleanup all clients
    for (const userId of clients.keys()) {
        cleanupClient(userId);
    }
    
    setTimeout(() => {
        console.log('✅ Server shutdown complete');
        process.exit(0);
    }, 3000);
});
