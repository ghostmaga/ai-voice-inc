import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import http, { request } from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEBHOOKURL = '';

// Create temp directory for media files
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Function to save media to temp file and get public URL
async function saveMediaToTemp(media, messageId) {
    try {
        const fileExtension = media.mimetype.split('/')[1] || 'bin';
        const fileName = `${messageId}_${Date.now()}.${fileExtension}`;
        const filePath = path.join(tempDir, fileName);
        
        // Convert base64 to buffer and save
        const buffer = Buffer.from(media.data, 'base64');
        fs.writeFileSync(filePath, buffer);
        
        // Return relative URL that can be served by Express
        return `/temp/${fileName}`;
    } catch (error) {
        console.error('Error saving media to temp:', error);
        return null;
    }
}

// Function to cleanup old temp files (older than 1 hour)
function cleanupTempFiles() {
    try {
        const files = fs.readdirSync(tempDir);
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        
        files.forEach(file => {
            const filePath = path.join(tempDir, file);
            const stats = fs.statSync(filePath);
            
            if (stats.mtime.getTime() < oneHourAgo) {
                fs.unlinkSync(filePath);
                console.log('Cleaned up old temp file:', file);
            }
        });
    } catch (error) {
        console.error('Error cleaning up temp files:', error);
    }
}

// Clean up temp files every hour
setInterval(cleanupTempFiles, 60 * 60 * 1000);

const app = express();
const server = http.createServer(app);
app.use(express.json());
import fetch from 'node-fetch';

let isConnected = false;

// Socket.IO for real-time communication
import { Server } from 'socket.io';
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Multer for file upload handling (not currently used)
const upload = multer({ storage: multer.memoryStorage() });

// Create WhatsApp client instance with local authentication
const client = new Client({
    puppeteer: {
        args: ['--no-sandbox'],
        headless: true
    },
    authStrategy: new LocalAuth({ dataPath: "." }) // Local authentication strategy
});

// Generate QR code to connect to WhatsApp Web
client.on('qr', (qr) => {
    isConnected = false;
    qrcode.generate(qr, { small: true });
    io.emit('qr', qr); // Emit QR code to frontend for scanning
});

// Client is ready and connected to WhatsApp Web
client.on('ready', () => {
    console.log('Client is ready!');
    isConnected = true;
    io.emit('ready'); // Emit "ready" event to frontend
});

// Initialize WhatsApp client
client.initialize();

// Set up CORS and express routes
app.use(cors());

// Serve temp files
app.use('/temp', express.static(tempDir));

app.get('/status', (req, res) => {
    res.json({ isConnected: isConnected }); // Return connection status
});

app.get('/', (req, res) => {
    res.sendFile('index.html', { root: __dirname }); // Serve the HTML file for frontend
});

app.get('/socket.io/socket.io.js', (req, res) => {
    const socketIOPath = path.join(__dirname, 'node_modules', 'socket.io-client', 'dist', 'socket.io.js');
    res.sendFile(socketIOPath); // Serve Socket.IO client
});

// Handle client disconnection
client.on('disconnected', (reason) => {
    console.log('Client disconnected');
    isConnected = false;
    io.emit('disconnected'); // Emit disconnection event

    // Try to reconnect by scanning the QR code again
    client.on('qr', (qr) => {
        isConnected = false;
        qrcode.generate(qr, { small: true });
        io.emit('qr', qr);
    });

    client.initialize(); // Reinitialize the client
});

// Listen for incoming messages
client.on('message', async (message) => {

    let contacts = (await client.getContacts()).filter(contact => contact.isUser === true);
    
    if (!message.fromMe && message.from.endsWith('@c.us')) {
        
        let phoneNumber = message.from.replace('@c.us', '');
        console.log(`ЛС: ${phoneNumber}. Message: ${message.body}`);
        
        let contact = contacts.find(contact => contact.number === phoneNumber);
        let contactName = contact ? contact.name : null;

        let requestBody = {
            phoneNumber: phoneNumber,
            // name: contactName,
            message: message
        };

    } else if (!message.fromMe && !message.from.endsWith('@c.us')) {

        let requestBody = {
            chatId: message.from,
            messageType: message.type,
        };

        let video_with_caption = false;
        if (message.type === 'video' && message._data.caption !== undefined) {
            video_with_caption = true;
        }

        try {

            let contactById = contacts.find(contact => contact.id._serialized === message.author);
            let contactName = contactById ? contactById.name : null;
            let contactByName = contacts.find(contact => contact.name === contactName && contact.id.server === 'c.us');
            let phoneNumber = contactByName ? contactByName.number : null;

            requestBody.phoneNumber = phoneNumber;
            requestBody.contactFound = !!phoneNumber;
            requestBody.name = contactName;

        } catch (error) {
            console.error('Error getting contact:', error);
        }

        try {
            if (message.type === 'chat') {
                requestBody.messageText = message.body;
                requestBody.type = 'text';
            } else if (message.type === 'image') {

                try {
                    const media = await message.downloadMedia();
                    if (media) {

                        const tempFileUrl = await saveMediaToTemp(media, message.id._serialized);
                        const mimeType = media.mimetype;
                        const filename = media.filename || `image_${Date.now()}.${mimeType.split('/')[1]}`;

                        // Caption handling: some whatsapp-web.js versions put caption into message.body
                        const caption = (message.caption !== undefined && message.caption !== null) ? message.caption : (message.body || null);

                        // Provide both a human-readable messageText and explicit caption field
                        requestBody.messageText = caption || null;
                        requestBody.caption = caption ? true : false;
                        requestBody.type = caption ? 'image_with_caption' : 'image';
                        requestBody.mediaType = 'image';
                        requestBody.mediaData = {
                            url: tempFileUrl ? `http://localhost:3333${tempFileUrl}` : null,
                            mimetype: mimeType,
                            filename: filename,
                            size: Math.round(Buffer.from(media.data, 'base64').length / 1024) // Size in KB
                        };
                        
                        console.log(`Image saved: ${filename}, size: ${requestBody.mediaData.size}KB, url: ${requestBody.mediaData.url}, caption: ${caption}`);
                    }
                } catch (downloadError) {
                    console.error('Error downloading media:', downloadError);
                    requestBody.messageText = 'Error downloading image';
                }

            } else if (video_with_caption) {
                const caption = message._data.caption ? message._data.caption : (message.body || null);

                // Provide both a human-readable messageText and explicit caption field
                requestBody.messageText = caption || null;
                requestBody.caption = caption ? true : false;
                requestBody.type = caption ? 'video_with_caption' : 'video';
                requestBody.mediaType = 'video';
                console.log('Video message received, caption:', caption);
            } else {
                requestBody.messageText = `Unsupported message type: ${message.type}`;
                console.log('Unsupported message type:', message.type);
            }

            requestBody.message = message;

            // Send a POST request to the webhook with the message data
            if (message.type === 'chat' || message.type === 'image' || video_with_caption) {
                const response = await fetch(WEBHOOKURL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody),
                });

                console.log('Message successfully sent to webhook.');
                if (response.ok) {
                    let webhookResponse = null;
                    try {
                        const text = await response.text();
                        if (text) {
                            webhookResponse = JSON.parse(text);
                            console.log('Webhook response:', webhookResponse);
                        } else {
                            console.log('Webhook response: (empty response)');
                        }
                    } catch (jsonError) {
                        console.error('Error parsing webhook response as JSON:', jsonError);
                    }
                    // Check if webhook requests message deletion
                    if (webhookResponse && webhookResponse.deleteMessage === true) {
                        try {
                            await message.delete(true); // true = delete for everyone
                            console.log('Message deleted successfully');
                        } catch (deleteError) {
                            console.error('Error deleting message:', deleteError);
                        }
                    }
                } else {
                    console.error('Error sending message to webhook:', response.status, response.statusText);
                    const errorText = await response.text();
                    console.error('Error details:', errorText);
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    }
});

// Start the server on port 3333
server.listen(3333, () => {
    console.log('Server running on port 3333');
});
