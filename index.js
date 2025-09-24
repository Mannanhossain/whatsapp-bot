// const { Client, LocalAuth } = require('whatsapp-web.js');
// const express = require('express');
// const cors = require('cors');
// const bodyParser = require('body-parser');
// const fs = require('fs');
// const path = require('path');
// const QRCode = require('qrcode');

// const app = express();
// app.use(cors());
// app.use(bodyParser.json());

// let clients = {};
// let qrCodes = {};

// // Directory for persistent sessions on Railway
// const SESSION_DIR = path.join('/data', '.wwebjs_auth');

// // Make sure folder exists
// if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// // -------------------- Create Client --------------------
// function createClient(sessionName) {
//     if (clients[sessionName] && clients[sessionName].initialized) return clients[sessionName];

//     const client = new Client({
//         authStrategy: new LocalAuth({ 
//             clientId: sessionName, 
//             dataPath: SESSION_DIR // store session persistently
//         }),
//         puppeteer: {
//             headless: true,
//             args: ['--no-sandbox', '--disable-setuid-sandbox']
//         }
//     });

//     qrCodes[sessionName] = null;

//     client.on('qr', async (qr) => {
//         console.log(`QR for ${sessionName}:`, qr);
//         const qrImage = await QRCode.toDataURL(qr);
//         qrCodes[sessionName] = qrImage;
//     });

//     client.on('ready', () => {
//         console.log(`${sessionName} ready!`);
//         qrCodes[sessionName] = 'READY';
//     });

//     client.on('authenticated', () => console.log(`${sessionName} authenticated!`));

//     client.on('auth_failure', () => {
//         console.log(`${sessionName} authentication failed!`);
//         qrCodes[sessionName] = 'AUTH_FAILED';
//     });

//     client.on('disconnected', (reason) => {
//         console.log(`${sessionName} disconnected:`, reason);
//         delete clients[sessionName];
//         delete qrCodes[sessionName];
//     });

//     client.initialize();
//     client.initialized = true;
//     clients[sessionName] = client;

//     return client;
// }

// // -------------------- QR API --------------------
// app.get('/qr/:sessionName', (req, res) => {
//     const { sessionName } = req.params;

//     if (!qrCodes[sessionName]) {
//         createClient(sessionName);
//         return res.status(202).json({ status: 'generating', message: 'QR code being generated' });
//     }

//     if (qrCodes[sessionName] === 'READY') return res.json({ status: 'ready', message: 'Session is ready' });
//     if (qrCodes[sessionName] === 'AUTH_FAILED') return res.status(401).json({ status: 'auth_failed', message: 'Authentication failed' });

//     res.json({ status: 'qr_required', qr: qrCodes[sessionName], message: 'Scan QR code to continue' });
// });

// // -------------------- Send Message API --------------------
// app.post('/send', async (req, res) => {
//     const { sessionName, phone, message } = req.body;
//     if (!sessionName || !phone || !message) return res.status(400).json({ success: false, error: 'Missing parameters' });

//     if (!clients[sessionName]) {
//         createClient(sessionName);
//         return res.status(425).json({ success: false, error: 'Session not ready', qrUrl: `/qr/${sessionName}` });
//     }

//     try {
//         const client = clients[sessionName];
//         if (!client.info || !client.info.wid) return res.status(425).json({ success: false, error: 'Session not ready', qrUrl: `/qr/${sessionName}` });

//         const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
//         if (!chatId.match(/^\d+@c\.us$/)) return res.status(400).json({ success: false, error: 'Invalid phone number format' });

//         const sendResult = await client.sendMessage(chatId, message);
//         res.json({ success: true, messageId: sendResult.id._serialized, timestamp: sendResult.timestamp, message: 'Message sent successfully' });

//     } catch (err) {
//         console.error('Send message error:', err);
//         res.status(500).json({ success: false, error: 'Failed to send message: ' + err.message });
//     }
// });

// // -------------------- Session Status --------------------
// app.get('/status/:sessionName', (req, res) => {
//     const { sessionName } = req.params;
//     const client = clients[sessionName];

//     if (!client) return res.json({ status: 'not_initialized', message: 'Session not initialized' });
//     if (client.info && client.info.wid) return res.json({ status: 'ready', message: 'Session is ready' });

//     res.json({ status: 'authenticating', message: 'Waiting for authentication' });
// });

// // -------------------- Logout --------------------
// app.delete('/session/:sessionName', async (req, res) => {
//     const { sessionName } = req.params;
//     const client = clients[sessionName];

//     if (client) {
//         try { await client.logout(); await client.destroy(); } catch (err) { console.error(err); }
//         delete clients[sessionName];
//         delete qrCodes[sessionName];

//         const sessionPath = path.join(SESSION_DIR, sessionName);
//         if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
//     }

//     res.json({ success: true, message: 'Session cleared' });
// });

// // -------------------- Health --------------------
// app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), activeSessions: Object.keys(clients).length }));

// // -------------------- Start Server --------------------
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, '0.0.0.0', () => console.log(`WhatsApp API Server running on port ${PORT}`));
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();

// Enhanced CORS configuration
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS || '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting middleware
const requestCounts = new Map();
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute window
    
    if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
    }
    
    const requests = requestCounts.get(ip).filter(time => time > windowStart);
    requests.push(now);
    requestCounts.set(ip, requests);
    
    if (requests.length > 100) { // Limit to 100 requests per minute per IP
        return res.status(429).json({ 
            success: false, 
            error: 'Too many requests' 
        });
    }
    
    next();
});

let clients = {};
let qrCodes = {};

const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Enhanced sanitization function
function sanitizeSessionName(name) {
    if (!name || name === 'undefined' || name === 'null') return 'default';
    return name.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50); // Limit length
}

// Validate phone number format
function validatePhoneNumber(phone) {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length < 10 || cleaned.length > 15) return false;
    return `${cleaned}@c.us`;
}

// Create Client with enhanced error handling
function createClient(sessionName) {
    sessionName = sanitizeSessionName(sessionName);

    // Check if client already exists and is healthy
    if (clients[sessionName] && clients[sessionName].initialized) {
        const client = clients[sessionName];
        if (client.pupPage && !client.pupPage().isClosed()) {
            return client;
        } else {
            // Clean up broken client
            delete clients[sessionName];
            delete qrCodes[sessionName];
        }
    }

    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: sessionName,
            dataPath: SESSION_DIR
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });

    qrCodes[sessionName] = null;

    client.on('qr', async (qr) => {
        console.log(`QR for ${sessionName}:`, qr);
        try {
            const qrImage = await QRCode.toDataURL(qr);
            qrCodes[sessionName] = qrImage;
        } catch (err) {
            console.error('QR code generation error:', err);
            qrCodes[sessionName] = 'ERROR';
        }
    });

    client.on('ready', () => {
        console.log(`${sessionName} ready!`);
        qrCodes[sessionName] = 'READY';
    });

    client.on('authenticated', () => {
        console.log(`${sessionName} authenticated!`);
    });

    client.on('auth_failure', (msg) => {
        console.log(`${sessionName} authentication failed:`, msg);
        qrCodes[sessionName] = 'AUTH_FAILED';
    });

    client.on('disconnected', (reason) => {
        console.log(`${sessionName} disconnected:`, reason);
        cleanupSession(sessionName);
    });

    client.on('error', (error) => {
        console.error(`${sessionName} error:`, error);
        if (error.toString().includes('Session')) {
            cleanupSession(sessionName);
        }
    });

    client.initialized = true;
    clients[sessionName] = client;

    try {
        client.initialize();
    } catch (err) {
        console.error(`Failed to initialize client ${sessionName}:`, err);
        delete clients[sessionName];
        delete qrCodes[sessionName];
    }

    return client;
}

// Cleanup session function
function cleanupSession(sessionName) {
    const client = clients[sessionName];
    if (client) {
        try {
            client.destroy();
        } catch (err) {
            console.error('Error destroying client:', err);
        }
    }
    delete clients[sessionName];
    delete qrCodes[sessionName];
}

// Enhanced QR API with better error handling
app.get('/qr/:sessionName', (req, res) => {
    try {
        const rawName = req.params.sessionName;
        const sessionName = sanitizeSessionName(rawName);

        if (!sessionName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid session name' 
            });
        }

        if (!qrCodes[sessionName]) {
            createClient(sessionName);
            return res.status(202).json({ 
                status: 'generating', 
                message: 'QR code being generated' 
            });
        }

        if (qrCodes[sessionName] === 'READY') {
            return res.json({ 
                status: 'ready', 
                message: 'Session is ready' 
            });
        }

        if (qrCodes[sessionName] === 'AUTH_FAILED') {
            return res.status(401).json({ 
                status: 'auth_failed', 
                message: 'Authentication failed' 
            });
        }

        if (qrCodes[sessionName] === 'ERROR') {
            return res.status(500).json({ 
                status: 'error', 
                message: 'QR generation error' 
            });
        }

        res.json({ 
            status: 'qr_required', 
            qr: qrCodes[sessionName], 
            message: 'Scan QR code to continue' 
        });

    } catch (error) {
        console.error('QR endpoint error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Enhanced Send Message API
app.post('/send', async (req, res) => {
    try {
        let { sessionName, phone, message } = req.body;

        // Validate required parameters
        if (!sessionName || !phone || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing parameters: sessionName, phone, and message are required' 
            });
        }

        sessionName = sanitizeSessionName(sessionName);
        
        // Validate message length
        if (message.length > 4096) {
            return res.status(400).json({ 
                success: false, 
                error: 'Message too long (max 4096 characters)' 
            });
        }

        // Initialize client if not exists
        if (!clients[sessionName]) {
            createClient(sessionName);
            return res.status(425).json({ 
                success: false, 
                error: 'Session not ready', 
                qrUrl: `/qr/${encodeURIComponent(sessionName)}` 
            });
        }

        const client = clients[sessionName];

        // Check if client is ready
        if (!client.info || !client.info.wid) {
            return res.status(425).json({ 
                success: false, 
                error: 'Session not ready', 
                qrUrl: `/qr/${encodeURIComponent(sessionName)}` 
            });
        }

        // Validate and format phone number
        const chatId = validatePhoneNumber(phone);
        if (!chatId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid phone number format' 
            });
        }

        // Send message with timeout
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Send message timeout')), 30000);
        });

        const sendPromise = client.sendMessage(chatId, message);
        const sendResult = await Promise.race([sendPromise, timeoutPromise]);

        res.json({ 
            success: true, 
            messageId: sendResult.id._serialized, 
            timestamp: sendResult.timestamp, 
            message: 'Message sent successfully' 
        });

    } catch (err) {
        console.error('Send message error:', err);
        
        if (err.message.includes('timeout')) {
            return res.status(408).json({ 
                success: false, 
                error: 'Message sending timeout' 
            });
        }
        
        if (err.message.includes('not found')) {
            return res.status(404).json({ 
                success: false, 
                error: 'Phone number not found on WhatsApp' 
            });
        }

        res.status(500).json({ 
            success: false, 
            error: 'Failed to send message: ' + err.message 
        });
    }
});

// Session Status endpoint
app.get('/status/:sessionName', (req, res) => {
    try {
        const rawName = req.params.sessionName;
        const sessionName = sanitizeSessionName(rawName);
        const client = clients[sessionName];

        if (!client) {
            return res.json({ 
                status: 'not_initialized', 
                message: 'Session not initialized' 
            });
        }

        if (client.info && client.info.wid) {
            return res.json({ 
                status: 'ready', 
                message: 'Session is ready' 
            });
        }

        res.json({ 
            status: 'authenticating', 
            message: 'Waiting for authentication' 
        });

    } catch (error) {
        console.error('Status endpoint error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Logout endpoint
app.delete('/session/:sessionName', async (req, res) => {
    try {
        const rawName = req.params.sessionName;
        const sessionName = sanitizeSessionName(rawName);
        
        await cleanupSession(sessionName);
        
        // Remove session files
        const sessionPath = path.join(SESSION_DIR, sessionName);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        res.json({ 
            success: true, 
            message: 'Session cleared successfully' 
        });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to clear session' 
        });
    }
});

// Health endpoint with detailed info
app.get('/health', (req, res) => {
    const sessionStatuses = {};
    Object.keys(clients).forEach(sessionName => {
        const client = clients[sessionName];
        sessionStatuses[sessionName] = client.info && client.info.wid ? 'ready' : 'authenticating';
    });

    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        activeSessions: Object.keys(clients).length,
        sessions: sessionStatuses,
        memory: process.memoryUsage()
    });
});

// 404 handler for undefined routes
app.use('*', (req, res) => {
    res.status(404).json({ 
        success: false, 
        error: `Cannot ${req.method} ${req.originalUrl}` 
    });
});

// Global error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp API Server running on port ${PORT}`);
    console.log(`Session directory: ${SESSION_DIR}`);
});
