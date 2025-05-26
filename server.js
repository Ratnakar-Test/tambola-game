// server.js
// Tambola Game Backend
// Uses Express for basic HTTP and 'ws' for WebSockets

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors'); // For handling Cross-Origin Resource Sharing

// --- Firebase Admin SDK Setup ---
const admin = require('firebase-admin');
// **IMPORTANT**: Replace with the path to your Firebase service account key JSON file
const serviceAccount = require('./firebase-service-account-key.json'); // <<< YOU NEED TO PROVIDE THIS FILE

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore(); // Firestore database instance
// --- End Firebase Admin SDK Setup ---


const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage (playerConnections will remain for WebSocket mapping)
// let rooms = {}; // This will now be managed by Firestore
let playerConnections = new Map(); // ws -> { roomId, playerId, type: 'admin'/'player', firebaseUID: 'user_firebase_auth_uid' }

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log(`Tambola backend server starting on port ${PORT}...`);

// --- Helper Functions (generateUniqueId, generateTambolaTicket, broadcastToRoom, sendMessageToClient, prize validation functions - keep as is) ---
function generateUniqueId() {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}
// ... (Keep other existing helper functions from your provided server.js)
function broadcastToRoom(roomId, message, excludeWs = null) {
    // This function will need to be aware of how admin/player WS are stored if rooms object is removed
    // For now, assuming playerConnections helps bridge this.
    wss.clients.forEach(clientWs => {
        const connInfo = playerConnections.get(clientWs);
        if (connInfo && connInfo.roomId === roomId && clientWs !== excludeWs && clientWs.readyState === WebSocket.OPEN) {
            try { clientWs.send(JSON.stringify(message)); }
            catch (e) { console.error('Broadcast error:', e); }
        }
    });
}

function sendMessageToClient(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(message)); }
        catch (e) { console.error('Send message error:', e); }
    }
}
// ... (Keep your ticket generation and prize validation functions)


// --- WebSocket Connection Handling ---
wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', async (messageString) => { // Added async here
        let message;
        try {
            message = JSON.parse(messageString);
            console.log(`Received from client:`, message);
        } catch (e) {
            console.error('Failed to parse message:', messageString, e);
            sendMessageToClient(ws, { type: 'ERROR', payload: { message: 'Invalid message format.' } });
            return;
        }

        const { type, payload } = message;
        // const connectionInfo = playerConnections.get(ws); // Get connectionInfo after potential auth

        switch (type) {
            case 'ADMIN_CREATE_JOIN_ROOM': {
                // **TODO**: Implement Firebase Auth token verification here if available from client
                // For now, assuming payload contains adminName and potential firebaseUID
                const { adminName, roomId, firebaseUID /* pass this from client after auth */ } = payload;

                if (!adminName || !roomId) {
                    return sendMessageToClient(ws, { type: 'ERROR', payload: { message: 'Admin name and Room ID are required.' } });
                }
                
                const adminUserUID = firebaseUID || `admin_${generateUniqueId()}`; // Placeholder if no Firebase Auth UID yet

                const roomRef = db.collection('rooms').doc(roomId);
                try {
                    const roomDoc = await roomRef.get();

                    if (!roomDoc.exists) {
                        // Create new room
                        const newRoomData = {
                            adminDisplayName: adminName,
                            adminUID: adminUserUID, // Store Firebase Auth UID
                            gameStatus: "idle",
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            callingMode: "manual",
                            autoCallInterval: 5,
                            currentNumbersCalled: [],
                            currentLatestCalledNumber: null,
                            rules: [], // Consider adding default rules here from your admin_room.html defaults
                            totalMoneyCollected: 0,
                            currentActivePlayers: {},
                            currentWinners: []
                        };
                        await roomRef.set(newRoomData);
                        playerConnections.set(ws, { roomId, playerId: adminUserUID, type: 'admin', firebaseUID: adminUserUID });
                        sendMessageToClient(ws, { type: 'ROOM_JOINED_SUCCESS', payload: { roomId, role: 'admin', adminId: adminUserUID, roomDetails: newRoomData } });
                        console.log(`Admin ${adminName} (UID: ${adminUserUID}) created and joined room ${roomId}`);
                    } else {
                        // Room exists
                        const roomData = roomDoc.data();
                        if (roomData.adminUID === adminUserUID || !roomData.adminUID) { // Allow rejoining or taking over an orphaned room (adjust logic if needed)
                            // Admin is rejoining or room was orphaned
                            playerConnections.set(ws, { roomId, playerId: adminUserUID, type: 'admin', firebaseUID: adminUserUID });
                            // If adminUID wasn't set before, set it now
                            if (!roomData.adminUID) {
                                await roomRef.update({ adminUID: adminUserUID, adminDisplayName: adminName });
                                roomData.adminUID = adminUserUID;
                                roomData.adminDisplayName = adminName;
                            }
                            sendMessageToClient(ws, { type: 'ROOM_JOINED_SUCCESS', payload: { roomId, role: 'admin', adminId: adminUserUID, roomDetails: roomData } });
                            console.log(`Admin ${adminName} (UID: ${adminUserUID}) re-joined room ${roomId}`);
                        } else {
                            // Room exists with a different admin
                            sendMessageToClient(ws, { type: 'ERROR', payload: { message: `Room ${roomId} already exists and is managed by a different admin.` } });
                            console.warn(`Admin ${adminName} failed to join room ${roomId} - already exists with admin ${roomData.adminUID}`);
                        }
                    }
                } catch (error) {
                    console.error("Error accessing/creating room:", error);
                    sendMessageToClient(ws, { type: 'ERROR', payload: { message: 'Server error creating/joining room.' } });
                }
                break;
            }

            // ... (Other message handlers: ADMIN_START_GAME, PLAYER_JOIN_ROOM, etc. will need Firestore integration)

            default:
                // const connectionInfo = playerConnections.get(ws); // Ensure connectionInfo is defined if needed for other types
                sendMessageToClient(ws, { type: 'ERROR', payload: { message: `Unknown message type: ${type}` } });
        }
    });

    ws.on('close', async () => { // Added async
        console.log('Client disconnected');
        const connectionInfo = playerConnections.get(ws);
        if (connectionInfo) {
            const { roomId, playerId, type, firebaseUID } = connectionInfo;
            playerConnections.delete(ws); // Remove WebSocket mapping

            if (type === 'admin') {
                console.log(`Admin ${firebaseUID} disconnected from room ${roomId}. WebSocket connection removed.`);
                // Optionally, update admin's 'lastSeen' or 'isOnline' status in Firestore if tracking that.
                // Room persists even if admin disconnects.
            } else if (type === 'player') {
                const roomRef = db.collection('rooms').doc(roomId);
                try {
                    await db.runTransaction(async (transaction) => {
                        const roomDoc = await transaction.get(roomRef);
                        if (!roomDoc.exists) return;

                        const roomData = roomDoc.data();
                        const currentActivePlayers = roomData.currentActivePlayers || {};
                        const playerKey = Object.keys(currentActivePlayers).find(key => currentActivePlayers[key].firebaseUID === firebaseUID || key === playerId); // Match by firebaseUID or old playerId

                        if (playerKey && currentActivePlayers[playerKey]) {
                            console.log(`Player ${currentActivePlayers[playerKey].playerName} (UID: ${firebaseUID}) disconnected from room ${roomId}.`);
                            // Option 1: Mark as inactive / update lastSeen
                            // currentActivePlayers[playerKey].lastSeen = admin.firestore.FieldValue.serverTimestamp();
                            // currentActivePlayers[playerKey].isOnline = false; 
                            // transaction.update(roomRef, { currentActivePlayers });

                            // Option 2: Remove player (simpler for now, adjust if rejoining with same tickets is needed)
                            delete currentActivePlayers[playerKey];
                            transaction.update(roomRef, { currentActivePlayers });
                            
                            // Prepare player list for broadcast (excluding WS objects)
                            const updatedPlayerListForBroadcast = Object.values(currentActivePlayers).map(p => ({
                                id: p.firebaseUID || p.id, // Use firebaseUID if available
                                name: p.playerName,
                                ticketCount: p.tickets ? p.tickets.length : (p.ticketCount || 0) // Handle both structures
                            }));

                            broadcastToRoom(roomId, { type: 'PLAYER_LIST_UPDATE', payload: { players: updatedPlayerListForBroadcast } });
                        }
                    });
                } catch (error) {
                    console.error(`Error updating player disconnect in Firestore for room ${roomId}:`, error);
                }
            }
            // Consider room cleanup logic if room becomes empty for a certain period.
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error with client:', error);
        // Basic cleanup, connection will also trigger 'close'
        const connectionInfo = playerConnections.get(ws);
        if (connectionInfo) playerConnections.delete(ws); 
    });
});


// --- Basic HTTP Routes (Keep as is) ---
app.get('/', (req, res) => res.send('Tambola Game Backend is running with Firestore!'));
// ... (Keep other HTTP routes like /health, /debug/rooms - /debug/rooms will need to fetch from Firestore)

app.get('/debug/rooms', async (req, res) => {
    try {
        const roomsSnapshot = await db.collection('rooms').get();
        const allRoomsData = [];
        roomsSnapshot.forEach(doc => {
            const data = doc.data();
            allRoomsData.push({
                id: doc.id,
                adminDisplayName: data.adminDisplayName,
                adminUID: data.adminUID,
                gameStatus: data.gameStatus,
                playerCount: data.currentActivePlayers ? Object.keys(data.currentActivePlayers).length : 0,
                calledCount: data.currentNumbersCalled ? data.currentNumbersCalled.length : 0,
                // Add other summary data as needed
            });
        });
        res.json(allRoomsData);
    } catch (error) {
        console.error("Error fetching rooms for debug:", error);
        res.status(500).send("Error fetching rooms data.");
    }
});


server.listen(PORT, () => {
    console.log(`HTTP and WebSocket server listening on ws://localhost:${PORT}`);
});

process.on('SIGINT', () => {
    console.log('Shutting down server...');
    wss.clients.forEach(client => client.close());
    server.close(() => {
        console.log('Server shut down gracefully.');
        playerConnections.clear();
        process.exit(0);
    });
});
