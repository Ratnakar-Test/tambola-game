// server.js
// Tambola Game Backend with Firestore Persistence (Nested‐Array Fix Applied)

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

let playerConnections = new Map();     // ws -> { roomId, playerId (firebaseUID), type: 'admin'/'player' }
let adminAutoCallTimers = new Map();   // roomId -> timerId

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log(`Tambola backend server starting on port ${PORT}...`);

// --- Helper Functions ---
function generateUniqueId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function sendMessageToClient(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('Send message error for client:', e, message.type);
    }
  }
}

function broadcastToRoom(roomId, message, excludeWs = null) {
  wss.clients.forEach(clientWs => {
    const connInfo = playerConnections.get(clientWs);
    if (
      connInfo &&
      connInfo.roomId === roomId &&
      clientWs !== excludeWs &&
      clientWs.readyState === WebSocket.OPEN
    ) {
      sendMessageToClient(clientWs, message);
    }
  });
}

function getAdminWs(roomId) {
  for (let [ws, connInfo] of playerConnections) {
    if (
      connInfo.roomId === roomId &&
      connInfo.type === 'admin' &&
      ws.readyState === WebSocket.OPEN
    ) {
      return ws;
    }
  }
  return null;
}

function generateTambolaTicket() {
  let ticket = Array(3).fill(null).map(() => Array(9).fill(null));
  const numbersOnTicket = new Set();
  const colRanges = [
    { min: 1, max: 9 },
    { min: 10, max: 19 },
    { min: 20, max: 29 },
    { min: 30, max: 39 },
    { min: 40, max: 49 },
    { min: 50, max: 59 },
    { min: 60, max: 69 },
    { min: 70, max: 79 },
    { min: 80, max: 90 }
  ];
  let colNumberCounts = Array(9).fill(0);
  let rowNumberCounts = Array(3).fill(0);

  // First pass: fill random columns
  for (let col = 0; col < 9; col++) {
    let numbersToPlaceInCol = Math.floor(Math.random() * 2) + 1;
    if (numbersOnTicket.size < 10 && col < 5) {
      numbersToPlaceInCol = Math.floor(Math.random() * 3) + 1;
    }
    for (let i = 0; i < numbersToPlaceInCol; i++) {
      let row, attempts = 0;
      do {
        row = Math.floor(Math.random() * 3);
        attempts++;
      } while ((ticket[row][col] !== null || rowNumberCounts[row] >= 5) && attempts < 20);
      if (ticket[row][col] === null && rowNumberCounts[row] < 5) {
        let num, numAttempts = 0;
        do {
          num = Math.floor(
            Math.random() * (colRanges[col].max - colRanges[col].min + 1)
          ) + colRanges[col].min;
          numAttempts++;
        } while (numbersOnTicket.has(num) && numAttempts < 20);
        if (!numbersOnTicket.has(num)) {
          ticket[row][col] = num;
          numbersOnTicket.add(num);
          rowNumberCounts[row]++;
          colNumberCounts[col]++;
        }
      }
    }
  }

  // Second pass: ensure each row has 5 numbers
  for (let r = 0; r < 3; r++) {
    while (rowNumberCounts[r] < 5) {
      let col, attempts = 0;
      do {
        col = Math.floor(Math.random() * 9);
        attempts++;
      } while ((ticket[r][col] !== null || colNumberCounts[col] >= 3) && attempts < 50);
      if (ticket[r][col] === null && colNumberCounts[col] < 3) {
        let num, numAttempts = 0;
        do {
          num = Math.floor(
            Math.random() * (colRanges[col].max - colRanges[col].min + 1)
          ) + colRanges[col].min;
          numAttempts++;
        } while (numbersOnTicket.has(num) && numAttempts < 20);
        if (!numbersOnTicket.has(num)) {
          ticket[r][col] = num;
          numbersOnTicket.add(num);
          rowNumberCounts[r]++;
          colNumberCounts[col]++;
        } else if (attempts >= 50) {
          break;
        }
      } else if (attempts >= 50) {
        break;
      }
    }
  }

  // Sort each column
  for (let c = 0; c < 9; c++) {
    let colVals = [];
    for (let r = 0; r < 3; r++) {
      if (ticket[r][c] !== null) colVals.push(ticket[r][c]);
    }
    colVals.sort((a, b) => a - b);
    let idx = 0;
    for (let r = 0; r < 3; r++) {
      if (ticket[r][c] !== null) {
        ticket[r][c] = colVals[idx++];
      }
    }
  }

  return ticket;
}

function getAllNumbersOnTicket(ticketNumbers) {
  return ticketNumbers.flat().filter(num => num !== null);
}

function getNumbersInRow(ticketNumbers, rowIndex) {
  if (rowIndex < 0 || rowIndex >= ticketNumbers.length) return [];
  return ticketNumbers[rowIndex].filter(num => num !== null);
}

function allNumbersAreCalled(numbersToCheck, calledNumbers) {
  if (!numbersToCheck || numbersToCheck.length === 0) return false;
  return numbersToCheck.every(num => calledNumbers.includes(num));
}

function validatePrizeClaim(ticketNumbers, calledNumbers, prizeRuleName) {
  const allTicketNums = getAllNumbersOnTicket(ticketNumbers);
  switch (prizeRuleName) {
    case 'Top Line':
      return allNumbersAreCalled(getNumbersInRow(ticketNumbers, 0), calledNumbers);
    case 'Middle Line':
      return allNumbersAreCalled(getNumbersInRow(ticketNumbers, 1), calledNumbers);
    case 'Bottom Line':
      return allNumbersAreCalled(getNumbersInRow(ticketNumbers, 2), calledNumbers);
    case 'Full House':
      if (allTicketNums.length !== 15) return false;
      return allNumbersAreCalled(allTicketNums, calledNumbers);
    case 'Early 5':
      return allTicketNums.filter(n => calledNumbers.includes(n)).length >= 5;
    case 'Early 7':
      return allTicketNums.filter(n => calledNumbers.includes(n)).length >= 7;
    case 'Corners': {
      const top = getNumbersInRow(ticketNumbers, 0);
      const bot = getNumbersInRow(ticketNumbers, 2);
      if (top.length < 5 || bot.length < 5) return false;
      const corners = [top[0], top[4], bot[0], bot[4]];
      return allNumbersAreCalled(corners, calledNumbers);
    }
    default:
      console.warn(`Unknown prize rule: ${prizeRuleName}`);
      return false;
  }
}

async function performAutoCall(roomId) {
  const roomRef = db.collection('rooms').doc(roomId);
  try {
    const roomDoc = await roomRef.get();
    if (!roomDoc.exists) {
      clearTimeout(adminAutoCallTimers.get(roomId));
      adminAutoCallTimers.delete(roomId);
      return;
    }
    const roomData = roomDoc.data();
    if (roomData.gameStatus !== 'running' || roomData.callingMode !== 'auto') {
      clearTimeout(adminAutoCallTimers.get(roomId));
      adminAutoCallTimers.delete(roomId);
      return;
    }

    const called = roomData.currentNumbersCalled || [];
    let available = [];
    for (let i = 1; i <= 90; i++) {
      if (!called.includes(i)) available.push(i);
    }

    if (available.length === 0) {
      await roomRef.update({
        gameStatus: "Game Over",
        gameEndTime: FieldValue.serverTimestamp()
      });
      broadcastToRoom(roomId, {
        type: 'GAME_OVER_ALL_NUMBERS_CALLED',
        payload: { finalCalledNumbers: called }
      });
      clearTimeout(adminAutoCallTimers.get(roomId));
      adminAutoCallTimers.delete(roomId);
      return;
    }

    const randIdx = Math.floor(Math.random() * available.length);
    const num = available[randIdx];
    await roomRef.update({
      currentLatestCalledNumber: num,
      currentNumbersCalled: FieldValue.arrayUnion(num)
    });
    broadcastToRoom(roomId, {
      type: 'NUMBER_CALLED',
      payload: {
        number: num,
        calledNumbersHistory: [...called, num],
        remainingCount: available.length - 1
      }
    });

    const tid = setTimeout(() => performAutoCall(roomId), roomData.autoCallInterval * 1000);
    adminAutoCallTimers.set(roomId, tid);

  } catch (err) {
    console.error(`Error during auto-call for room ${roomId}:`, err);
    broadcastToRoom(roomId, { type: 'ERROR', payload: { message: "Error during auto number call." } });
    clearTimeout(adminAutoCallTimers.get(roomId));
    adminAutoCallTimers.delete(roomId);
  }
}

// --- WebSocket Handling ---
wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');

  ws.on('message', async (messageString) => {
    let message;
    try {
      message = JSON.parse(messageString);
    } catch (e) {
      console.error('Failed to parse message:', messageString, e);
      return sendMessageToClient(ws, {
        type: 'ERROR',
        payload: { message: 'Invalid message format.' }
      });
    }

    const { type, payload } = message;
    const connectionInfo = playerConnections.get(ws);

    try {
      switch (type) {
        // … all ADMIN_CREATE_*, ADMIN_SUBSCRIBE, ADMIN_* handlers unchanged …

        case 'PLAYER_JOIN_ROOM': {
          const { playerName, roomId, firebaseUID } = payload;
          if (!playerName || !roomId || !firebaseUID) {
            return sendMessageToClient(ws, {
              type: 'ERROR',
              payload: { message: 'Player details incomplete.' }
            });
          }

          const roomRef = db.collection('rooms').doc(roomId);
          const roomDoc = await roomRef.get();
          if (
            !roomDoc.exists ||
            !["idle", "running", "paused"].includes(roomDoc.data().gameStatus)
          ) {
            return sendMessageToClient(ws, {
              type: 'ERROR',
              payload: {
                message: 'Room not found or not joinable at this moment.'
              }
            });
          }

          const ticketNumbers = generateTambolaTicket();
          const ticketId = generateUniqueId();

          // → Convert nested array into array of maps for Firestore
          const numbersToWrite = ticketNumbers.map((row, rowIndex) => ({
            rowIndex,
            numbers: row
          }));

          const gameTicketData = {
            userId: firebaseUID,
            playerName,
            roomId,
            numbers: numbersToWrite,
            createdAt: FieldValue.serverTimestamp()
          };
          await db.collection('gameTickets').doc(ticketId).set(gameTicketData);

          const newPlayerData = {
            playerName,
            ticketCount: 1,
            lastSeen: FieldValue.serverTimestamp(),
            tickets: [{ id: ticketId }],
            isOnline: true,
            firebaseUID
          };

          // Update currentActivePlayers inside a transaction
          await db.runTransaction(async (transaction) => {
            const fresh = await transaction.get(roomRef);
            if (!fresh.exists) throw new Error("Room disappeared!");
            let cap = fresh.data().currentActivePlayers || {};
            if (Array.isArray(cap)) cap = {}; // defensive
            cap[firebaseUID] = newPlayerData;
            transaction.update(roomRef, { currentActivePlayers: cap });
          });

          playerConnections.set(ws, {
            roomId,
            playerId: firebaseUID,
            type: 'player'
          });

          // Send back success + broadcast updated list
          const roomState = roomDoc.data();
          sendMessageToClient(ws, {
            type: 'PLAYER_JOIN_SUCCESS',
            payload: {
              playerId: firebaseUID,
              playerName,
              roomId,
              tickets: [{ id: ticketId, numbers: ticketNumbers, marked: [] }],
              gameStatus: roomState.gameStatus,
              calledNumbers: roomState.currentNumbersCalled,
              rules: (roomState.rules || []).filter(r => r.isActive),
              adminName: roomState.adminDisplayName
            }
          });

          const updatedRoom = await roomRef.get();
          const playersList = Object.values(updatedRoom.data().currentActivePlayers || {});
          broadcastToRoom(
            roomId,
            {
              type: 'PLAYER_LIST_UPDATE',
              payload: {
                players: playersList.map(p => ({
                  id: p.firebaseUID,
                  name: p.playerName,
                  ticketCount: p.ticketCount,
                  isOnline: p.isOnline
                }))
              }
            },
            ws
          );
          break;
        }

        // … other PLAYER_* handlers unchanged …

        case 'ADMIN_APPROVE_TICKET_REQUEST': {
          if (!connectionInfo || connectionInfo.type !== 'admin') return;
          const { roomId } = connectionInfo;
          const { requestId, targetPlayerId } = payload;
          const requestRef = db.collection('rooms')
            .doc(roomId)
            .collection('ticketRequests')
            .doc(requestId);
          const roomRef2 = db.collection('rooms').doc(roomId);
          const ticketNumbers2 = generateTambolaTicket();
          const ticketId2 = generateUniqueId();

          await db.runTransaction(async (transaction) => {
            const snap = await transaction.get(roomRef2);
            if (!snap.exists) throw new Error("Room not found.");
            const playerDoc = snap.data().currentActivePlayers[targetPlayerId];
            if (!playerDoc) throw new Error("Player not in room.");
            const reqSnap = await transaction.get(requestRef);
            if (!reqSnap.exists || reqSnap.data().status !== 'pending')
              throw new Error("No pending request.");

            transaction.update(requestRef, {
              status: 'approved',
              approvedAt: FieldValue.serverTimestamp(),
              ticketId: ticketId2
            });

            // → Same nested-array fix here:
            const numsToWrite2 = ticketNumbers2.map((row, idx) => ({
              rowIndex: idx,
              numbers: row
            }));
            transaction.set(db.collection('gameTickets').doc(ticketId2), {
              userId: targetPlayerId,
              playerName: playerDoc.playerName,
              roomId,
              numbers: numsToWrite2,
              createdAt: FieldValue.serverTimestamp()
            });

            const path = `currentActivePlayers.${targetPlayerId}`;
            transaction.update(roomRef2, {
              [`${path}.ticketCount`]: FieldValue.increment(1),
              [`${path}.tickets`]: FieldValue.arrayUnion({ id: ticketId2 })
            });
          });

          // … then send TICKET_APPROVED, ADMIN_ACTION_SUCCESS, broadcast list …
          break;
        }

        // … ALL remaining handlers (PLAYER_REQUEST_TICKET, ADMIN_CALL_NUMBER, etc.) stay exactly the same …
      }
    } catch (err) {
      console.error(`Error processing ${type}:`, err);
      sendMessageToClient(ws, {
        type: 'ERROR',
        payload: { message: err.message || 'Server error.' }
      });
    }
  });

  ws.on('close', async () => {
    const info = playerConnections.get(ws);
    if (info) {
      const { roomId, playerId, type } = info;
      playerConnections.delete(ws);
      console.log(`${type} ${playerId} disconnected from room ${roomId}`);
      if (type === 'player') {
        const roomRef = db.collection('rooms').doc(roomId);
        try {
          await db.runTransaction(async tx => {
            const snap = await tx.get(roomRef);
            if (!snap.exists) return;
            const caps = snap.data().currentActivePlayers || {};
            if (caps[playerId]) {
              caps[playerId].isOnline = false;
              caps[playerId].lastSeen = FieldValue.serverTimestamp();
              tx.update(roomRef, { currentActivePlayers: caps });
              const list = Object.values(caps);
              broadcastToRoom(roomId, {
                type: 'PLAYER_LIST_UPDATE',
                payload: {
                  players: list.map(p => ({
                    id: p.firebaseUID,
                    name: p.playerName,
                    ticketCount: p.ticketCount,
                    isOnline: p.isOnline
                  }))
                }
              });
            }
          });
        } catch (e) {
          console.error(`Disconnect-update error for ${playerId}:`, e);
        }
      }
    }
  });

  ws.on('error', (e) => console.error('WebSocket error:', e));
});

// --- HTTP Routes ---
app.get('/', (req, res) => res.send('Tambola Game Backend is running!'));
app.get('/health', (req, res) =>
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() })
);
app.get('/debug/rooms', async (req, res) => {
  try {
    const snap = await db.collection('rooms').limit(50).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch {
    res.status(500).send("Error fetching rooms data.");
  }
});

server.listen(PORT, () => {
  console.log(`HTTP + WS server listening on port ${PORT}`);
});

process.on('SIGINT', () => {
  console.log('Shutting down server...');
  adminAutoCallTimers.forEach(t => clearTimeout(t));
  wss.clients.forEach(c => c.close());
  server.close(() => process.exit(0));
});
