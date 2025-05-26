// server.js
// Tambola Game Backend with Firestore Persistence

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const admin = require('firebase-admin');

// --- Firebase Admin SDK Setup ---
const serviceAccount = require('./firebase-service-account-key.json'); // Ensure this file exists

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
// --- End Firebase Admin SDK Setup ---

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

let playerConnections = new Map(); // ws -> { roomId, playerId (firebaseUID), type: 'admin'/'player' }
let adminAutoCallTimers = new Map(); // roomId -> timerId

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log(`Tambola backend server starting on port ${PORT}...`);

// --- Helper Functions ---
function generateUniqueId() {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function sendMessageToClient(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(message)); }
        catch (e) { console.error('Send message error for client:', e, message.type); }
    }
}

function broadcastToRoom(roomId, message, excludeWs = null) {
    wss.clients.forEach(clientWs => {
        const connInfo = playerConnections.get(clientWs);
        if (connInfo && connInfo.roomId === roomId && clientWs !== excludeWs && clientWs.readyState === WebSocket.OPEN) {
            sendMessageToClient(clientWs, message);
        }
    });
}

function getAdminWs(roomId) {
    for (let [ws, connInfo] of playerConnections) {
        if (connInfo.roomId === roomId && connInfo.type === 'admin' && ws.readyState === WebSocket.OPEN) {
            return ws;
        }
    }
    return null;
}

// --- Tambola Ticket Generation ---
function generateTambolaTicket() {
    let ticket = Array(3).fill(null).map(() => Array(9).fill(null));
    const numbersOnTicket = new Set();
    const colRanges = [
        { min: 1, max: 9 }, { min: 10, max: 19 }, { min: 20, max: 29 },
        { min: 30, max: 39 }, { min: 40, max: 49 }, { min: 50, max: 59 },
        { min: 60, max: 69 }, { min: 70, max: 79 }, { min: 80, max: 90 }
    ];
    let colNumberCounts = Array(9).fill(0);
    let rowNumberCounts = Array(3).fill(0);

    for (let col = 0; col < 9; col++) {
        let numbersToPlaceInCol = Math.floor(Math.random() * 2) + 1;
        if (numbersOnTicket.size < 10 && col < 5) numbersToPlaceInCol = Math.floor(Math.random() * 3) + 1;
        for (let i = 0; i < numbersToPlaceInCol; i++) {
            let row, attempts = 0;
            do { row = Math.floor(Math.random() * 3); attempts++; }
            while ((ticket[row][col] !== null || rowNumberCounts[row] >= 5) && attempts < 20);
            if (ticket[row][col] === null && rowNumberCounts[row] < 5) {
                let num, numAttempts = 0;
                do { num = Math.floor(Math.random() * (colRanges[col].max - colRanges[col].min + 1)) + colRanges[col].min; numAttempts++; }
                while (numbersOnTicket.has(num) && numAttempts < 20);
                if (!numbersOnTicket.has(num)) {
                    ticket[row][col] = num; numbersOnTicket.add(num); rowNumberCounts[row]++; colNumberCounts[col]++;
                }
            }
        }
    }
    for (let r = 0; r < 3; r++) {
        while (rowNumberCounts[r] < 5) {
            let col, attempts = 0;
            do { col = Math.floor(Math.random() * 9); attempts++; }
            while ((ticket[r][col] !== null || colNumberCounts[col] >= 3) && attempts < 50);
            if (ticket[r][col] === null && colNumberCounts[col] < 3) {
                let num, numAttempts = 0;
                do { num = Math.floor(Math.random() * (colRanges[col].max - colRanges[col].min + 1)) + colRanges[col].min; numAttempts++; }
                while (numbersOnTicket.has(num) && numAttempts < 20);
                if (!numbersOnTicket.has(num)) {
                    ticket[r][col] = num; numbersOnTicket.add(num); rowNumberCounts[r]++; colNumberCounts[col]++;
                } else if (attempts >= 50) break;
            } else if (attempts >= 50) break;
        }
    }
    for (let c = 0; c < 9; c++) {
        let colVals = [];
        for (let r = 0; r < 3; r++) if (ticket[r][c] !== null) colVals.push(ticket[r][c]);
        colVals.sort((a, b) => a - b); let currentIdx = 0;
        for (let r = 0; r < 3; r++) if (ticket[r][c] !== null) ticket[r][c] = colVals[currentIdx++];
    }
    return ticket;
}

// --- Prize Validation ---
function getAllNumbersOnTicket(ticketNumbers) { return ticketNumbers.flat().filter(num => num !== null); }
function getNumbersInRow(ticketNumbers, rowIndex) { if (rowIndex < 0 || rowIndex >= ticketNumbers.length) return []; return ticketNumbers[rowIndex].filter(num => num !== null); }
function allNumbersAreCalled(numbersToCheck, calledNumbers) { if (!numbersToCheck || numbersToCheck.length === 0) return false; return numbersToCheck.every(num => calledNumbers.includes(num)); }

function validatePrizeClaim(ticketNumbers, calledNumbers, prizeRuleName) {
    const allTicketNums = getAllNumbersOnTicket(ticketNumbers);
    switch (prizeRuleName) {
        case 'Top Line': return allNumbersAreCalled(getNumbersInRow(ticketNumbers, 0), calledNumbers);
        case 'Middle Line': return allNumbersAreCalled(getNumbersInRow(ticketNumbers, 1), calledNumbers);
        case 'Bottom Line': return allNumbersAreCalled(getNumbersInRow(ticketNumbers, 2), calledNumbers);
        case 'Full House': if (allTicketNums.length !== 15) return false; return allNumbersAreCalled(allTicketNums, calledNumbers);
        case 'Early 5': return allTicketNums.filter(num => calledNumbers.includes(num)).length >= 5;
        case 'Early 7': return allTicketNums.filter(num => calledNumbers.includes(num)).length >= 7;
        case 'Corners': {
            const topRowActual = getNumbersInRow(ticketNumbers, 0); const bottomRowActual = getNumbersInRow(ticketNumbers, 2);
            if (topRowActual.length < 5 || bottomRowActual.length < 5) return false;
            const cornerNumbers = [topRowActual[0], topRowActual[4], bottomRowActual[0], bottomRowActual[4]];
            return allNumbersAreCalled(cornerNumbers, calledNumbers);
        }
        // Add other rules from your original file as needed
        default: console.warn(`Unknown prize rule name for validation: ${prizeRuleName}`); return false;
    }
}

// --- Auto Call Number Logic ---
async function performAutoCall(roomId) {
    const roomRef = db.collection('rooms').doc(roomId);
    try {
        const roomDoc = await roomRef.get();
        if (!roomDoc.exists) { clearTimeout(adminAutoCallTimers.get(roomId)); adminAutoCallTimers.delete(roomId); return; }
        const roomData = roomDoc.data();

        if (roomData.gameStatus !== 'running' || roomData.callingMode !== 'auto') {
            clearTimeout(adminAutoCallTimers.get(roomId)); adminAutoCallTimers.delete(roomId); return;
        }

        const calledNumbers = roomData.currentNumbersCalled || [];
        let availableNumbers = [];
        for (let i = 1; i <= 90; i++) {
            if (!calledNumbers.includes(i)) availableNumbers.push(i);
        }

        if (availableNumbers.length === 0) {
            await roomRef.update({ gameStatus: "Game Over", gameEndTime: FieldValue.serverTimestamp() });
            broadcastToRoom(roomId, { type: 'GAME_OVER_ALL_NUMBERS_CALLED', payload: { finalCalledNumbers: calledNumbers } });
            clearTimeout(adminAutoCallTimers.get(roomId)); adminAutoCallTimers.delete(roomId);
            return;
        }

        const randomIndex = Math.floor(Math.random() * availableNumbers.length);
        const calledNumber = availableNumbers[randomIndex];

        await roomRef.update({
            currentLatestCalledNumber: calledNumber,
            currentNumbersCalled: FieldValue.arrayUnion(calledNumber)
        });
        broadcastToRoom(roomId, { type: 'NUMBER_CALLED', payload: { number: calledNumber, calledNumbersHistory: [...calledNumbers, calledNumber], remainingCount: availableNumbers.length - 1 } });

        const timerId = setTimeout(() => performAutoCall(roomId), roomData.autoCallInterval * 1000);
        adminAutoCallTimers.set(roomId, timerId);
    } catch (error) {
        console.error(`Error during auto-call for room ${roomId}:`, error);
        broadcastToRoom(roomId, { type: 'ERROR', payload: { message: "Error during auto number call." } });
        clearTimeout(adminAutoCallTimers.get(roomId)); adminAutoCallTimers.delete(roomId);
    }
}

// --- WebSocket Connection Handling ---
wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');

    ws.on('message', async (messageString) => {
        let message;
        try {
            message = JSON.parse(messageString);
        } catch (e) { console.error('Failed to parse message:', messageString, e); sendMessageToClient(ws, { type: 'ERROR', payload: { message: 'Invalid message format.' } }); return; }

        const { type, payload } = message;
        const connectionInfo = playerConnections.get(ws);

        try {
            switch (type) {
                case 'ADMIN_CREATE_JOIN_ROOM': {
                    const { adminName, roomId, firebaseUID } = payload;
                    if (!adminName || !roomId || !firebaseUID) return sendMessageToClient(ws, { type: 'ERROR', payload: { message: 'Admin name, Room ID, and Firebase UID are required.' } });
                    const roomRef = db.collection('rooms').doc(roomId);
                    const roomDoc = await roomRef.get();
                    if (!roomDoc.exists) {
                        const newRoomData = {
                            adminDisplayName: adminName, adminUID: firebaseUID, gameStatus: "idle", createdAt: FieldValue.serverTimestamp(),
                            callingMode: "manual", autoCallInterval: 5, currentNumbersCalled: [], currentLatestCalledNumber: null,
                            rules: [], totalMoneyCollected: 0, currentActivePlayers: {}, currentWinners: []
                        };
                        await roomRef.set(newRoomData);
                        playerConnections.set(ws, { roomId, playerId: firebaseUID, type: 'admin' });
                        sendMessageToClient(ws, { type: 'ROOM_JOINED_SUCCESS', payload: { roomId, role: 'admin', adminId: firebaseUID, roomDetails: newRoomData } });
                    } else {
                        const roomData = roomDoc.data();
                        if (roomData.adminUID === firebaseUID || !roomData.adminUID) {
                            playerConnections.set(ws, { roomId, playerId: firebaseUID, type: 'admin' });
                            if (!roomData.adminUID) await roomRef.update({ adminUID: firebaseUID, adminDisplayName: adminName });
                            sendMessageToClient(ws, { type: 'ROOM_JOINED_SUCCESS', payload: { roomId, role: 'admin', adminId: firebaseUID, roomDetails: roomData } });
                        } else {
                            sendMessageToClient(ws, { type: 'ERROR', payload: { message: `Room ${roomId} managed by another admin.` } });
                        }
                    }
                    break;
                }
                case 'ADMIN_SUBSCRIBE_TO_ROOM': {
                    const { roomId, adminUID } = payload;
                    // Validate if the ws connection's playerId (adminUID) matches the one sent in payload
                    if (!connectionInfo || connectionInfo.type !== 'admin' || connectionInfo.playerId !== adminUID) {
                         // Attempt to re-establish connection info if it was lost or this is a fresh subscribe from a new WS
                        const adminClientInfo = Array.from(playerConnections.values()).find(ci => ci.playerId === adminUID && ci.roomId === roomId && ci.type === 'admin');
                        if(adminClientInfo){
                            playerConnections.set(ws, { roomId, playerId: adminUID, type: 'admin' }); // Update WS for this UID
                        } else {
                           // If no existing connection info matches, and current WS connectionInfo is bad, this is suspicious
                           // Or, if connectionInfo is null (first message on a new WS), set it.
                           if (!connectionInfo) playerConnections.set(ws, { roomId, playerId: adminUID, type: 'admin' });
                           else return sendMessageToClient(ws, {type: 'ERROR', payload: {message: 'Admin auth mismatch or invalid subscription.'}});
                        }
                    }

                    const roomRef = db.collection('rooms').doc(roomId);
                    const roomDoc = await roomRef.get();
                    if (roomDoc.exists) {
                         sendMessageToClient(ws, { type: 'ROOM_STATE_UPDATE', payload: roomDoc.data() });
                         const ticketRequestsSnapshot = await db.collection('rooms').doc(roomId).collection('ticketRequests').where('status', '==', 'pending').orderBy('requestTimestamp', 'desc').get();
                         const ticketRequests = ticketRequestsSnapshot.docs.map(doc => ({id: doc.id, ...doc.data()}));
                         if(ticketRequests.length >= 0) sendMessageToClient(ws, {type: 'ALL_TICKET_REQUESTS_UPDATE', payload: {requests: ticketRequests}});

                         const prizeClaimsSnapshot = await db.collection('prizeClaimsAudit').where('roomId', '==', roomId).where('status', '==', 'pending_admin_approval').orderBy('claimTimestamp', 'desc').get();
                         const prizeClaims = prizeClaimsSnapshot.docs.map(doc => ({id: doc.id, ...doc.data()}));
                         if(prizeClaims.length >= 0) sendMessageToClient(ws, {type: 'ALL_PRIZE_CLAIMS_UPDATE', payload: {claims: prizeClaims}});

                    } else { sendMessageToClient(ws, { type: 'ERROR', payload: { message: 'Room not found.' } }); }
                    break;
                }

                case 'PLAYER_JOIN_ROOM': {
                    const { playerName, roomId, firebaseUID } = payload;
                    if (!playerName || !roomId || !firebaseUID) return sendMessageToClient(ws, { type: 'ERROR', payload: { message: 'Player details incomplete.' } });
                    const roomRef = db.collection('rooms').doc(roomId);
                    const roomDoc = await roomRef.get();
                    if (!roomDoc.exists || !["idle", "running", "paused"].includes(roomDoc.data().gameStatus) ) return sendMessageToClient(ws, { type: 'ERROR', payload: { message: 'Room not found or not joinable.' } });
                    
                    const ticketNumbers = generateTambolaTicket();
                    const ticketId = generateUniqueId();
                    await db.collection('gameTickets').doc(ticketId).set({
                        userId: firebaseUID, playerName, roomId, numbers: ticketNumbers, createdAt: FieldValue.serverTimestamp()
                    });
                    const playerUpdatePath = `currentActivePlayers.${firebaseUID}`;
                    await roomRef.update({
                        [playerUpdatePath]: { 
                            playerName, 
                            ticketCount: 1, 
                            lastSeen: FieldValue.serverTimestamp(), 
                            tickets: [{ id: ticketId }], // Store only ticket ID reference
                            isOnline: true, 
                            firebaseUID 
                        }
                    });
                    playerConnections.set(ws, { roomId, playerId: firebaseUID, type: 'player' });
                    const roomDataForPlayer = roomDoc.data();
                    sendMessageToClient(ws, { type: 'PLAYER_JOIN_SUCCESS', payload: {
                        playerId: firebaseUID, playerName, roomId, 
                        tickets: [{id: ticketId, numbers: ticketNumbers, marked:[]}], // Send full ticket numbers for the first ticket
                        gameStatus: roomDataForPlayer.gameStatus, 
                        calledNumbers: roomDataForPlayer.currentNumbersCalled,
                        rules: (roomDataForPlayer.rules || []).filter(r => r.isActive), 
                        adminName: roomDataForPlayer.adminDisplayName
                    }});
                    const playersSnapshot = await roomRef.get(); // Re-fetch to get the latest player list
                    const playersList = Object.values(playersSnapshot.data().currentActivePlayers || {});
                    broadcastToRoom(roomId, { type: 'PLAYER_LIST_UPDATE', payload: { players: playersList.map(p=>({id: p.firebaseUID, name:p.playerName, ticketCount: p.ticketCount, isOnline: p.isOnline})) } }, ws);
                    break;
                }
                case 'PLAYER_REQUEST_TICKET': {
                    if (!connectionInfo || connectionInfo.type !== 'player') return;
                    const { roomId, playerId: firebaseUID } = connectionInfo;
                    const roomRef = db.collection('rooms').doc(roomId);
                    const roomDoc = await roomRef.get();
                    if (!roomDoc.exists) return;
                    const playerData = roomDoc.data().currentActivePlayers[firebaseUID];
                    if (!playerData || (playerData.tickets && playerData.tickets.length >=5) || playerData.ticketCount >=5) return sendMessageToClient(ws, {type: 'ERROR', payload: {message: 'Max tickets reached.'}});

                    const requestId = generateUniqueId();
                    const requestData = {
                        userId: firebaseUID, playerName: playerData.playerName, roomId, status: "pending",
                        requestTimestamp: FieldValue.serverTimestamp(), currentTickets: playerData.ticketCount || (playerData.tickets ? playerData.tickets.length : 0)
                    };
                    await db.collection('rooms').doc(roomId).collection('ticketRequests').doc(requestId).set(requestData);
                    const adminWs = getAdminWs(roomId);
                    if (adminWs) sendMessageToClient(adminWs, { type: 'NEW_TICKET_REQUEST', payload: {id: requestId, ...requestData} });
                    sendMessageToClient(ws, { type: 'PLAYER_TICKET_REQUEST_SENT' });
                    break;
                }

                case 'ADMIN_APPROVE_TICKET_REQUEST': {
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId } = connectionInfo;
                    const { requestId, targetPlayerId } = payload; // targetPlayerId is firebaseUID
                    const requestRef = db.collection('rooms').doc(roomId).collection('ticketRequests').doc(requestId);
                    const roomRef = db.collection('rooms').doc(roomId);
                    const ticketNumbers = generateTambolaTicket();
                    const ticketId = generateUniqueId();
                    
                    await db.runTransaction(async (transaction) => {
                        const roomSnapshot = await transaction.get(roomRef);
                        if(!roomSnapshot.exists) throw new Error("Room not found.");
                        const playerDoc = roomSnapshot.data().currentActivePlayers[targetPlayerId];
                        if(!playerDoc) throw new Error("Player not found in room.");

                        const requestDoc = await transaction.get(requestRef);
                        if (!requestDoc.exists || requestDoc.data().status !== 'pending') throw new Error("Request not found or not pending.");
                        
                        transaction.update(requestRef, { status: 'approved', approvedAt: FieldValue.serverTimestamp(), ticketId });
                        transaction.set(db.collection('gameTickets').doc(ticketId), {
                            userId: targetPlayerId, playerName: playerDoc.playerName, roomId, numbers: ticketNumbers, createdAt: FieldValue.serverTimestamp()
                        });
                        const playerUpdatePath = `currentActivePlayers.${targetPlayerId}`;
                        transaction.update(roomRef, {
                            [`${playerUpdatePath}.ticketCount`]: FieldValue.increment(1),
                            [`${playerUpdatePath}.tickets`]: FieldValue.arrayUnion({ id: ticketId }) // Store only ticket ID reference
                        });
                    });
                    const finalRoomSnapshot = await roomRef.get(); // Get updated tickets list
                    const updatedPlayerTickets = finalRoomSnapshot.data().currentActivePlayers[targetPlayerId].tickets;

                    const targetPlayerWs = Array.from(playerConnections.entries()).find(([_,val])=> val.playerId === targetPlayerId && val.roomId === roomId)?.[0];
                    if (targetPlayerWs) sendMessageToClient(targetPlayerWs, { type: 'TICKET_APPROVED', payload: { ticket: {id: ticketId, numbers: ticketNumbers, marked: []}, allTickets: updatedPlayerTickets }});
                    sendMessageToClient(ws, { type: 'ADMIN_ACTION_SUCCESS', payload: { message: `Ticket approved for ${finalRoomSnapshot.data().currentActivePlayers[targetPlayerId].playerName}` } });
                    sendMessageToClient(ws, { type: 'TICKET_REQUEST_RESOLVED', payload: { requestId } }); 
                    const playersList = Object.values(finalRoomSnapshot.data().currentActivePlayers || {});
                    broadcastToRoom(roomId, { type: 'PLAYER_LIST_UPDATE', payload: { players: playersList.map(p=>({id: p.firebaseUID, name:p.playerName, ticketCount: p.ticketCount, isOnline: p.isOnline})) } });
                    break;
                }
                // ... (Keep other handlers like ADMIN_REJECT_TICKET_REQUEST, ADMIN_UPDATE_RULES, ADMIN_START_GAME, etc. as provided in the previous full server.js, ensuring they use Firestore correctly) ...
                // (The rest of the switch cases from the previous full server.js response should be here)
                // For brevity in this diff, I'm not repeating all of them but they should be identical to the last full server.js I provided.
                // Key is the change in PLAYER_JOIN_ROOM and ADMIN_APPROVE_TICKET_REQUEST demonstrated above for `tickets` array.

                // Ensure all other existing case handlers from the previous complete server.js are included here.
                // This includes: ADMIN_REJECT_TICKET_REQUEST, ADMIN_UPDATE_RULES, ADMIN_START_GAME,
                // ADMIN_CALL_NUMBER, ADMIN_PAUSE_GAME, ADMIN_RESUME_GAME, ADMIN_STOP_GAME,
                // PLAYER_CLAIM_PRIZE, ADMIN_APPROVE_PRIZE_CLAIM, ADMIN_REJECT_PRIZE_CLAIM

                // Re-inserting the rest of the handlers from the previous version for completeness:
                case 'ADMIN_REJECT_TICKET_REQUEST': { 
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId } = connectionInfo;
                    const { requestId, targetPlayerId, reason } = payload;
                    await db.collection('rooms').doc(roomId).collection('ticketRequests').doc(requestId).update({ status: 'rejected', reason: reason || "", reviewedAt: FieldValue.serverTimestamp() });
                    const targetPlayerWs = Array.from(playerConnections.entries()).find(([_,val])=> val.playerId === targetPlayerId && val.roomId === roomId)?.[0];
                    if (targetPlayerWs) sendMessageToClient(targetPlayerWs, { type: 'TICKET_REJECTED', payload: { reason: reason || "Admin rejected." } });
                    sendMessageToClient(ws, { type: 'ADMIN_ACTION_SUCCESS', payload: { message: `Ticket request rejected.` } });
                    sendMessageToClient(ws, { type: 'TICKET_REQUEST_RESOLVED', payload: { requestId } });
                    break;
                }

                case 'ADMIN_UPDATE_RULES': { 
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId } = connectionInfo;
                    await db.collection('rooms').doc(roomId).update({
                        rules: payload.rules,
                        totalMoneyCollected: parseFloat(payload.financials.totalMoneyCollected) || 0
                    });
                    sendMessageToClient(ws, { type: 'RULES_UPDATED_CONFIRMATION', payload: {rules: payload.rules, totalMoneyCollected: payload.financials.totalMoneyCollected} }); 
                    broadcastToRoom(roomId, { type: 'RULES_UPDATED_BROADCAST', payload: { rules: payload.rules.filter(r => r.isActive), totalMoneyCollected: payload.financials.totalMoneyCollected, adminUID: connectionInfo.playerId } }, ws); 
                    break;
                }

                case 'ADMIN_START_GAME': { 
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId } = connectionInfo;
                    await db.collection('rooms').doc(roomId).update({
                        gameStatus: "running", currentNumbersCalled: [], currentLatestCalledNumber: null,
                        gameStartTime: FieldValue.serverTimestamp(), currentWinners: [],
                        callingMode: payload.callingMode, autoCallInterval: payload.autoCallInterval,
                        rules: payload.rulesConfig, 
                        totalMoneyCollected: parseFloat(payload.totalMoneyCollected) || 0
                    });
                    broadcastToRoom(roomId, { type: 'GAME_STARTED', payload: {
                        callingMode: payload.callingMode, autoCallInterval: payload.autoCallInterval,
                        rules: payload.rulesConfig.filter(r => r.isActive), totalMoneyCollected: payload.totalMoneyCollected,
                        startTime: new Date().toISOString() 
                    }});
                    if (payload.callingMode === 'auto') {
                        clearTimeout(adminAutoCallTimers.get(roomId)); 
                        adminAutoCallTimers.set(roomId, setTimeout(() => performAutoCall(roomId), payload.autoCallInterval * 1000));
                    }
                    break;
                }
                case 'ADMIN_CALL_NUMBER': {
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId } = connectionInfo;
                    const roomRef = db.collection('rooms').doc(roomId);
                    const roomDoc = await roomRef.get();
                    if (!roomDoc.exists || roomDoc.data().gameStatus !== 'running') return;

                    const calledNumbers = roomDoc.data().currentNumbersCalled || [];
                    let availableNumbers = [];
                    for (let i = 1; i <= 90; i++) { if (!calledNumbers.includes(i)) availableNumbers.push(i); }

                    if (availableNumbers.length === 0) {
                        await roomRef.update({ gameStatus: "Game Over", gameEndTime: FieldValue.serverTimestamp() });
                        broadcastToRoom(roomId, { type: 'GAME_OVER_ALL_NUMBERS_CALLED', payload: { finalCalledNumbers: calledNumbers } });
                    } else {
                        const randomIndex = Math.floor(Math.random() * availableNumbers.length);
                        const calledNumber = availableNumbers[randomIndex];
                        await roomRef.update({ currentLatestCalledNumber: calledNumber, currentNumbersCalled: FieldValue.arrayUnion(calledNumber) });
                        broadcastToRoom(roomId, { type: 'NUMBER_CALLED', payload: { number: calledNumber, calledNumbersHistory: [...calledNumbers, calledNumber], remainingCount: availableNumbers.length - 1 } });
                    }
                    break;
                }
                case 'ADMIN_PAUSE_GAME': {
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId } = connectionInfo;
                    clearTimeout(adminAutoCallTimers.get(roomId)); adminAutoCallTimers.delete(roomId);
                    await db.collection('rooms').doc(roomId).update({ gameStatus: 'paused' });
                    broadcastToRoom(roomId, { type: 'GAME_PAUSED', payload: { status: 'paused' } });
                    break;
                }
                case 'ADMIN_RESUME_GAME': {
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId } = connectionInfo;
                    const roomData = (await db.collection('rooms').doc(roomId).get()).data();
                    if (roomData.callingMode === 'auto') {
                         clearTimeout(adminAutoCallTimers.get(roomId));
                         adminAutoCallTimers.set(roomId, setTimeout(() => performAutoCall(roomId), roomData.autoCallInterval * 1000));
                    }
                    await db.collection('rooms').doc(roomId).update({ gameStatus: 'running' });
                    broadcastToRoom(roomId, { type: 'GAME_RESUMED', payload: { status: 'running' } });
                    break;
                }
                case 'ADMIN_STOP_GAME': {
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId } = connectionInfo;
                    clearTimeout(adminAutoCallTimers.get(roomId)); adminAutoCallTimers.delete(roomId);
                    const roomDoc = await db.collection('rooms').doc(roomId).get();
                    const roomData = roomDoc.data();
                    const gameSummary = {
                        totalNumbersCalled: roomData.currentNumbersCalled.length,
                        winners: roomData.currentWinners,
                    };
                    await db.collection('rooms').doc(roomId).update({ gameStatus: 'game ended by admin', gameEndTime: FieldValue.serverTimestamp(), gameSummary });
                    broadcastToRoom(roomId, { type: 'GAME_STOPPED', payload: { status: 'game ended by admin' } });
                    broadcastToRoom(roomId, { type: 'GAME_SUMMARY_BROADCAST', payload: gameSummary });
                    break;
                }

                case 'PLAYER_CLAIM_PRIZE': { 
                    if (!connectionInfo || connectionInfo.type !== 'player') return;
                    const { roomId, playerId: firebaseUID } = connectionInfo; 
                    const { ticketId, prizeRuleId } = payload;

                    const roomDoc = await db.collection('rooms').doc(roomId).get();
                    const ticketDoc = await db.collection('gameTickets').doc(ticketId).get();
                    if (!roomDoc.exists || !ticketDoc.exists || roomDoc.data().gameStatus !== 'running') return sendMessageToClient(ws, {type: 'ERROR', payload: {message: 'Cannot claim now.'}});

                    const roomData = roomDoc.data();
                    const ticketData = ticketDoc.data();
                    const ruleToClaim = (roomData.rules || []).find(r => r.id === prizeRuleId && r.isActive);
                    if (!ruleToClaim) return sendMessageToClient(ws, {type: 'ERROR', payload: {message: 'Rule not active or found.'}});
                    
                    if ((roomData.currentWinners || []).some(w => w.userId === firebaseUID && w.prizeRuleId === prizeRuleId)) {
                       return sendMessageToClient(ws, {type: 'ERROR', payload: {message: `You have already won or claimed '${ruleToClaim.name}'.`}});
                    }
                    const existingClaimsSnapshot = await db.collection('prizeClaimsAudit')
                        .where('roomId', '==', roomId).where('userId', '==', firebaseUID).where('prizeRuleId', '==', prizeRuleId)
                        .where('status', 'in', ['pending_validation', 'pending_admin_approval']).limit(1).get();
                    if(!existingClaimsSnapshot.empty) {
                        return sendMessageToClient(ws, {type: 'ERROR', payload: {message: `You have a pending claim for '${ruleToClaim.name}'.`}});
                    }

                    const isValid = validatePrizeClaim(ticketData.numbers, roomData.currentNumbersCalled, ruleToClaim.name);
                    const claimId = generateUniqueId();
                    const claimData = {
                        userId: firebaseUID, playerName: ticketData.playerName, roomId, ticketId, prizeRuleId, prizeName: ruleToClaim.name,
                        status: "pending_admin_approval", serverValidationResult: isValid, claimTimestamp: FieldValue.serverTimestamp()
                    };
                    await db.collection('prizeClaimsAudit').doc(claimId).set(claimData);
                    sendMessageToClient(ws, { type: 'PLAYER_CLAIM_SUBMITTED', payload: { claimId, prizeName: ruleToClaim.name, status: 'pending_admin_approval' } });
                    const adminWs = getAdminWs(roomId);
                    if (adminWs) sendMessageToClient(adminWs, { type: 'NEW_PRIZE_CLAIM', payload: {id: claimId, ...claimData} });
                    break;
                }
                case 'ADMIN_APPROVE_PRIZE_CLAIM': { 
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId, playerId: adminUID } = connectionInfo; 
                    const { claimId, targetPlayerId, prizeRuleId } = payload;

                    const roomRef = db.collection('rooms').doc(roomId);
                    const claimRef = db.collection('prizeClaimsAudit').doc(claimId);

                    await db.runTransaction(async (transaction) => {
                        const roomDoc = await transaction.get(roomRef);
                        const claimDoc = await transaction.get(claimRef);
                        if (!roomDoc.exists || !claimDoc.exists) throw new Error("Room or Claim not found.");
                        const roomData = roomDoc.data();
                        const claimData = claimDoc.data();
                        if (claimData.status !== 'pending_admin_approval') throw new Error("Claim not pending approval.");

                        const ruleInfo = (roomData.rules || []).find(r => r.id === prizeRuleId && r.isActive);
                        if (!ruleInfo) throw new Error("Rule not active or found for claim.");
                        
                        const maxPrizesForRule = parseInt(ruleInfo.maxPrizes) || 1;
                        const existingWinnersForRule = (roomData.currentWinners || []).filter(w => w.prizeRuleId === prizeRuleId).length;
                        if (existingWinnersForRule >= maxPrizesForRule) {
                            transaction.update(claimRef, { status: "rejected_auto_limit_reached", reason: "Max winners for this prize already declared.", reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUID });
                            throw new Error(`Max winners for ${ruleInfo.name} reached.`);
                        }

                        const coinsAwarded = parseFloat(ruleInfo.coinsPerPrize) || 0;
                        const winnerDetails = {
                            claimId, userId: targetPlayerId, playerName: claimData.playerName, prizeName: ruleInfo.name, prizeRuleId,
                            ticketId: claimData.ticketId, coinsAwarded, timestamp: FieldValue.serverTimestamp()
                        };
                        transaction.update(claimRef, { status: "approved", coinsAwarded, reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUID });
                        transaction.update(roomRef, { currentWinners: FieldValue.arrayUnion(winnerDetails) });
                    });
                    const approvedClaimData = (await claimRef.get()).data();
                    const targetPlayerWs = Array.from(playerConnections.entries()).find(([_,val])=> val.playerId === targetPlayerId && val.roomId === roomId)?.[0];
                    if (targetPlayerWs) sendMessageToClient(targetPlayerWs, { type: 'CLAIM_STATUS_UPDATE', payload: { claimId, prizeName: approvedClaimData.prizeName, status: 'approved', coinsAwarded: approvedClaimData.coinsAwarded } });
                    sendMessageToClient(ws, { type: 'ADMIN_ACTION_SUCCESS', payload: { message: `Prize '${approvedClaimData.prizeName}' approved.` } });
                    sendMessageToClient(ws, { type: 'PRIZE_CLAIM_RESOLVED', payload: { claimId, status: 'approved', winnerDetails: approvedClaimData } });
                    broadcastToRoom(roomId, {type: 'WINNER_ANNOUNCEMENT', payload: {...winnerDetails, timestamp: new Date().toISOString()}}, ws); 
                    break;
                }
                case 'ADMIN_REJECT_PRIZE_CLAIM': { 
                    if (!connectionInfo || connectionInfo.type !== 'admin') return;
                    const { roomId, playerId: adminUID } = connectionInfo;
                    const { claimId, targetPlayerId, prizeName, reason } = payload;
                    await db.collection('prizeClaimsAudit').doc(claimId).update({
                        status: "rejected_admin", reason: reason || "Admin rejected.", reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUID
                    });
                    const targetPlayerWs = Array.from(playerConnections.entries()).find(([_,val])=> val.playerId === targetPlayerId && val.roomId === roomId)?.[0];
                    if (targetPlayerWs) sendMessageToClient(targetPlayerWs, { type: 'CLAIM_STATUS_UPDATE', payload: { claimId, prizeName, status: 'rejected', reason: reason || "Admin rejected." } });
                    sendMessageToClient(ws, { type: 'ADMIN_ACTION_SUCCESS', payload: { message: `Prize claim rejected.` } });
                    sendMessageToClient(ws, { type: 'PRIZE_CLAIM_RESOLVED', payload: { claimId, status: 'rejected' } });
                    break;
                }


                default:
                    sendMessageToClient(ws, { type: 'ERROR', payload: { message: `Unknown message type: ${type}` } });
            }
        } catch (error) {
            console.error(`Error processing ${type} for ${connectionInfo ? connectionInfo.playerId : 'unknown client'}:`, error.message, payload);
            sendMessageToClient(ws, { type: 'ERROR', payload: { message: error.message || `Server error processing ${type}.` } });
            if (connectionInfo && connectionInfo.type === 'admin' && (type.startsWith("ADMIN_APPROVE") || type.startsWith("ADMIN_REJECT"))) {
                sendMessageToClient(ws, {type: 'ADMIN_ACTION_FAIL', payload: {message: error.message || "Action failed on server."}});
            }
        }
    });

    ws.on('close', async () => {
        const connectionInfo = playerConnections.get(ws);
        if (connectionInfo) {
            const { roomId, playerId, type } = connectionInfo; 
            playerConnections.delete(ws);
            console.log(`${type} ${playerId} disconnected from room ${roomId}`);

            if (type === 'player') {
                const roomRef = db.collection('rooms').doc(roomId);
                try {
                    await db.runTransaction(async (transaction) => {
                        const roomDoc = await transaction.get(roomRef);
                        if (!roomDoc.exists) return;
                        const roomData = roomDoc.data();
                        const currentActivePlayers = roomData.currentActivePlayers || {};
                        if (currentActivePlayers[playerId]) {
                             currentActivePlayers[playerId].isOnline = false;
                             currentActivePlayers[playerId].lastSeen = FieldValue.serverTimestamp();
                            transaction.update(roomRef, { currentActivePlayers });
                            const playersList = Object.values(currentActivePlayers);
                            broadcastToRoom(roomId, { type: 'PLAYER_LIST_UPDATE', payload: { players: playersList.map(p=>({id: p.firebaseUID, name:p.playerName, ticketCount: p.ticketCount, isOnline: p.isOnline})) } });
                        }
                    });
                } catch (error) { console.error(`Error updating player disconnect for ${playerId} in ${roomId}:`, error); }
            }
        } else { console.log('Unknown client disconnected'); }
    });
    ws.on('error', (error) => { console.error('WebSocket error with client:', error); });
});

// --- HTTP Routes ---
app.get('/', (req, res) => res.send('Tambola Game Backend (Firestore) is running!'));
app.get('/health', (req, res) => res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() }));
app.get('/debug/rooms', async (req, res) => {
    try {
        const roomsSnapshot = await db.collection('rooms').limit(50).get();
        const allRoomsData = roomsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(allRoomsData);
    } catch (error) { res.status(500).send("Error fetching rooms data."); }
});

server.listen(PORT, () => {
    console.log(`HTTP and WebSocket server listening on ws://localhost:${PORT} (and wss for deployed)`);
});

process.on('SIGINT', () => {
    console.log('Shutting down server...');
    adminAutoCallTimers.forEach(timerId => clearTimeout(timerId));
    adminAutoCallTimers.clear();
    wss.clients.forEach(client => client.close());
    server.close(() => { console.log('Server shut down gracefully.'); process.exit(0); });
});
