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
app.use(cors());
app.use(bodyParser.json());

let clients = {};
let qrCodes = {};

// -------------------- Session folder --------------------
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// -------------------- Helper: sanitize session name --------------------
function sanitizeSessionName(name) {
    if (!name) return 'default';
    return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

// -------------------- Create Client --------------------
function createClient(sessionName) {
    sessionName = sanitizeSessionName(sessionName);

    if (clients[sessionName] && clients[sessionName].initialized) return clients[sessionName];

    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: sessionName,
            dataPath: SESSION_DIR
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
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
        }
    });

    client.on('ready', () => {
        console.log(`${sessionName} ready!`);
        qrCodes[sessionName] = 'READY';
    });

    client.on('authenticated', () => console.log(`${sessionName} authenticated!`));

    client.on('auth_failure', () => {
        console.log(`${sessionName} authentication failed!`);
        qrCodes[sessionName] = 'AUTH_FAILED';
    });

    client.on('disconnected', (reason) => {
        console.log(`${sessionName} disconnected:`, reason);
        delete clients[sessionName];
        delete qrCodes[sessionName];
    });

    client.initialize();
    client.initialized = true;
    clients[sessionName] = client;

    return client;
}

// -------------------- QR API --------------------
app.get('/qr/:sessionName', (req, res) => {
    const rawName = req.params.sessionName;
    const sessionName = sanitizeSessionName(rawName);

    if (!qrCodes[sessionName]) {
        createClient(sessionName);
        return res.status(202).json({ status: 'generating', message: 'QR code being generated' });
    }

    if (qrCodes[sessionName] === 'READY') return res.json({ status: 'ready', message: 'Session is ready' });
    if (qrCodes[sessionName] === 'AUTH_FAILED') return res.status(401).json({ status: 'auth_failed', message: 'Authentication failed' });

    res.json({ status: 'qr_required', qr: qrCodes[sessionName], message: 'Scan QR code to continue' });
});

// -------------------- Send Message API --------------------
app.post('/send', async (req, res) => {
    let { sessionName, phone, message } = req.body;

    sessionName = sanitizeSessionName(sessionName);

    if (!sessionName || !phone || !message) return res.status(400).json({ success: false, error: 'Missing parameters' });

    if (!clients[sessionName]) {
        createClient(sessionName);
        return res.status(425).json({ success: false, error: 'Session not ready', qrUrl: `/qr/${sessionName}` });
    }

    try {
        const client = clients[sessionName];

        if (!client.info || !client.info.wid) return res.status(425).json({ success: false, error: 'Session not ready', qrUrl: `/qr/${sessionName}` });

        const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
        if (!chatId.match(/^\d+@c\.us$/)) return res.status(400).json({ success: false, error: 'Invalid phone number format' });

        const sendResult = await client.sendMessage(chatId, message);
        res.json({ success: true, messageId: sendResult.id._serialized, timestamp: sendResult.timestamp, message: 'Message sent successfully' });

    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ success: false, error: 'Failed to send message: ' + err.message });
    }
});

// -------------------- Session Status --------------------
app.get('/status/:sessionName', (req, res) => {
    const rawName = req.params.sessionName;
    const sessionName = sanitizeSessionName(rawName);
    const client = clients[sessionName];

    if (!client) return res.json({ status: 'not_initialized', message: 'Session not initialized' });
    if (client.info && client.info.wid) return res.json({ status: 'ready', message: 'Session is ready' });

    res.json({ status: 'authenticating', message: 'Waiting for authentication' });
});

// -------------------- Logout --------------------
app.delete('/session/:sessionName', async (req, res) => {
    const rawName = req.params.sessionName;
    const sessionName = sanitizeSessionName(rawName);
    const client = clients[sessionName];

    if (client) {
        try { await client.logout(); await client.destroy(); } catch (err) { console.error(err); }
        delete clients[sessionName];
        delete qrCodes[sessionName];

        const sessionPath = path.join(SESSION_DIR, sessionName);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    res.json({ success: true, message: 'Session cleared' });
});

// -------------------- Health --------------------
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), activeSessions: Object.keys(clients).length }));

// -------------------- Start Server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`WhatsApp API Server running on port ${PORT}`));
