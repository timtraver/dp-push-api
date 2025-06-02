import config from './config.json' with { type: "json" };
import express from 'express';
import { Pool } from 'pg';
import { Expo } from 'expo-server-sdk';
import fs from 'fs';
import cors from 'cors';
import crypto from 'crypto';
import { createServer } from 'node:https';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

const apiFQDN = config.apiFQDN;
const apiIpAddress = config.apiIpAddress;
const apiPort = config.apiPort;
const httpsKeyPath = config.httpsKeyPath;
const httpsCertPath = config.httpsCertPath;
const sharedHash = config.sharedHash;
const pgCertPath = config.pgCertPath;
const pgConnectionString = config.pgConnectionString;

const privateKey = fs.readFileSync(httpsKeyPath, 'utf8');
const certificate = fs.readFileSync(httpsCertPath, 'utf8');
const credentials = {
    key: privateKey,
    cert: certificate,
    secureOptions: crypto.constants.SSL_OP_NO_SSLv3 | crypto.constants.SSL_OP_NO_TLSv1 | crypto.constants.SSL_OP_NO_TLSv1_1, // Enforces TLS 1.2 and TLS 1.3 only
    minVersion: 'TLSv1.2'
};

// Setup DB pool
const pool = new Pool({
  connectionString: pgConnectionString,
  ssl: {
    require: true,
    rejectUnauthorized: false,
    ca: fs.readFileSync(pgCertPath).toString(),
  },
});

// Setup Expo SDK
const expo = new Expo();

// ✅ Add rate limiter middleware
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // max requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/send-push', limiter);

// Route to send push notification
app.post('/send-push', async (req, res) => {
    // Check shared Hash in the Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
         return res.status(403).json({ error: 'Forbidden' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== sharedHash) {
        return res.status(403).json({ error: 'Forbidden2' });
    }
    // Check request body
    const { user_ids, sender_user_id, title, body, data = {}, tournament_id = null } = req.body;

    if (!Array.isArray(user_ids) || !sender_user_id || !title || !body) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    console.log('Received request to send push notifications:', {
        user_ids,
        sender_user_id,
        title,
        body,
        data,
        tournament_id
    });

    try {
        // Fetch user push tokens and unread messages from DB
        const query = `
            SELECT
                u.id,
                u.push_token,
                (
                SELECT COUNT(*)
                FROM push_notifications pn
                WHERE pn.user_id = u.id
                    AND (pn.seen_at IS NULL OR pn.seen_at < pn.created_at)
                ) AS unread_count
            FROM users u
            WHERE u.id = ANY($1::int[]) AND (push_token IS NOT NULL OR has_push_token = true)
        `;
        const { rows } = await pool.query(query,[user_ids]);

        const messages = [];

        for (const user of rows) {
            const token = user.push_token;
            const unreadCount = parseInt(user?.unread_count) + 1 || 1;
            let message_id;

            try {
                const response = await pool.query(
                    'INSERT INTO push_notifications (user_id, sender_user_id, token, title, body, data, status, tournament_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
                    [user.id, sender_user_id, token, title, body, JSON.stringify(data), 0, tournament_id]
                );
                message_id = response.rows[0].id;
                console.log('Notification inserted with ID:', message_id);
            } catch (error) {
                console.error('Error inserting push notification:', error);
                // optionally rethrow or handle gracefully
                // throw error;
            }

            if (!Expo.isExpoPushToken(token)) {
                console.warn(`Invalid token for user ${user.id}: ${token}`);
                continue;
            }

            messages.push({
                to: token,
                sound: 'default',
                title,
                body,
                data: { ...data, ...(message_id ? { m: message_id } : {}) },
                badge: unreadCount,
                priority: 'high',
                interruptionLevel: 'time-sensitive',
                _displayInForeground: true,
            });
        }
        console.log(`Prepared ${messages.length} messages for sending.`);
        console.log('Messages:', messages);

        // Send all of the messages
        const chunks = expo.chunkPushNotifications(messages);
        const pendingTickets = new Map(); // ticket_id -> push_notification_id
        
        for (const chunk of chunks) {
            const ticketChunk = await sendWithRetry(chunk);

            for (let i = 0; i < chunk.length; i++) {
                const msg = chunk[i];
                const ticket = ticketChunk[i];
                if (ticket.status === 'ok' && ticket.id) {
                    const messageId = msg.data.m;
                    await pool.query(
                        `UPDATE push_notifications SET ticket_id = $1, status = 1 WHERE id = $2`,
                        [ticket.id, messageId]
                    );
                    pendingTickets.set(ticket.id, messageId);
                } else {
                    await pool.query(
                        `UPDATE push_notifications SET error_message = $1, status = 3 WHERE id = $2`,
                        [JSON.stringify(ticket), msg.data.m]
                    );
                    if (ticket.details && ticket.details.error === 'DeviceNotRegistered') {
                        await pool.query(
                            `UPDATE users SET push_token = NULL WHERE push_token = $1`,
                            [chunk.to]
                        );
                        console.warn(`Push token removed for user ${user.id} due to DeviceNotRegistered error.`);
                    }
                    console.warn(`Ticket error for message ${msg.data.message_id}:`, ticket);
                }
            }
        }
        
        setTimeout(() => {
            checkReceipts([...pendingTickets.keys()], pendingTickets);
        }, 45000);
                  
        res.json({ success: true, message: 'Push notifications sent and receipt check scheduled.' });

    } catch (err) {
        console.error('Push error:', err);
        res.status(500).json({ error: 'Failed to send notifications' });
    }
});

// Retry wrapper
async function sendWithRetry(chunk, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await expo.sendPushNotificationsAsync(chunk);
        } catch (err) {
            console.error(`Attempt ${attempt} failed:`, err);
            if (attempt < maxAttempts) {
                const delay = 200 * Math.pow(2, attempt);
                await new Promise(res => setTimeout(res, delay));
            } else {
                throw err;
            }
        }
    }
}

async function checkReceipts(ticketIds, pendingTickets) {
    try {
        const receiptChunks = expo.chunkPushNotificationReceiptIds(ticketIds);
        for (const chunk of receiptChunks) {
            const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
            for (const [ticketId, receipt] of Object.entries(receipts)) {
                const messageId = pendingTickets.get(ticketId);
                console.log(`Processing receipt for ticket ${ticketId}, message ID: ${messageId}`);
                console.log(`Receipt details:`, receipt);
                if (!messageId) continue;
                if (receipt.status === 'ok') {
                    await pool.query(
                        `UPDATE push_notifications
                        SET status = 2
                        WHERE id = $1`,
                        [messageId]
                    );
                    pendingTickets.delete(ticketId);
                } else if (receipt.status === 'error') {
                    if (receipt.details && receipt.details.error === 'DeviceNotRegistered') {
                        const { rows } = await pool.query(
                            `SELECT user_id FROM push_notifications WHERE id = $1`,
                            [messageId]
                        );
                        const userId = rows[0]?.user_id;
                        await pool.query(
                            `UPDATE users SET push_token = NULL WHERE id = $1`,
                            [userId]
                        );
                    }
                    await pool.query(
                        `UPDATE push_notifications
                        SET error_message = $1,
                            status = 3
                        WHERE id = $2`,
                        [JSON.stringify(receipt.details || {}), messageId]
                    );
                    pendingTickets.delete(ticketId);
                    console.warn(`Push token removed for user due to DeviceNotRegistered error.`);
                }
            }
        }
    } catch (err) {
      console.error('Error checking receipts:', err);
    }
}
  
// Start the server
const server = createServer(credentials, app);
server.listen(apiPort, apiIpAddress, () => {
    console.log(`Server running at http://${apiFQDN}:${apiPort}/`);
});
