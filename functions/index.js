/**
 * Import function triggers from their respective modules.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Initialize Firebase Admin SDK
// Ensure your Firebase project has been initialized for Admin SDK
// (typically done once, often without arguments if deployed in Firebase environment)
try {
    admin.initializeApp();
} catch (e) {
    console.error("Firebase admin initialization error", e);
}

const db = admin.firestore();

// Import game logic functions from lib/
const gameManagement = require("./lib/gameManagement");
const ticketManagement = require("./lib/ticketManagement");
const numberCalling = require("./lib/numberCalling");
const claimProcessing = require("./lib/claimProcessing");

// --- Game Management Functions ---
exports.createGameRoom = functions.https.onCall(gameManagement.createGameRoomHandler(db, admin));
exports.joinGameRoom = functions.https.onCall(gameManagement.joinGameRoomHandler(db)); // Player joining
exports.setGameRules = functions.https.onCall(gameManagement.setGameRulesHandler(db));
exports.startGame = functions.https.onCall(gameManagement.startGameHandler(db, admin));
exports.stopGame = functions.https.onCall(gameManagement.stopGameHandler(db, admin));
exports.setCallingMode = functions.https.onCall(gameManagement.setCallingModeHandler(db));
exports.togglePauseResumeGame = functions.https.onCall(gameManagement.togglePauseResumeGameHandler(db));
exports.updatePlayerPresence = functions.https.onCall(gameManagement.updatePlayerPresenceHandler(db, admin));


// --- Number Calling Functions ---
exports.callNextNumber = functions.https.onCall(numberCalling.callNextNumberHandler(db, admin));
// HTTP triggered function for scheduled auto-calling (if using Cloud Scheduler)
// exports.scheduledAutoCall = functions.pubsub.schedule('every 1 minutes').onRun(async (context) => {
//   return numberCalling.scheduledAutoCallHandler(db, admin);
// });
// Or a cron-triggered HTTP function if you prefer to call it from outside:
// exports.httpAutoCall = functions.https.onRequest(async (req, res) => {
//     // Add security: Check for a secret header or Firebase Auth token
//     const result = await numberCalling.scheduledAutoCallHandler(db, admin);
//     res.json(result);
// });


// --- Ticket Management Functions ---
exports.requestGameTicket = functions.https.onCall(ticketManagement.requestGameTicketHandler(db, admin));
exports.approveTicketRequest = functions.https.onCall(ticketManagement.approveTicketRequestHandler(db, admin));
exports.rejectTicketRequest = functions.https.onCall(ticketManagement.rejectTicketRequestHandler(db, admin));


// --- Prize Claim Processing Functions ---
exports.submitPrizeClaim = functions.https.onCall(claimProcessing.submitPrizeClaimHandler(db, admin));
exports.approvePrizeClaim = functions.https.onCall(claimProcessing.approvePrizeClaimHandler(db, admin)); // Admin manual approval
exports.rejectPrizeClaim = functions.https.onCall(claimProcessing.rejectPrizeClaimHandler(db, admin)); // Admin manual rejection


// --- Firestore Triggers (Example: for cleanup or other automated actions) ---

// Example: When a room is deleted, clean up associated tickets or claims
// exports.onRoomDeleted = functions.firestore
//     .document('rooms/{roomId}')
//     .onDelete(async (snap, context) => {
//         const roomId = context.params.roomId;
//         console.log(`Room ${roomId} deleted. Cleaning up associated data.`);
//         // Add cleanup logic for gameTickets, prizeClaimsAudit related to this roomId
//         const ticketBatch = db.batch();
//         const ticketsQuery = db.collection('gameTickets').where('roomId', '==', roomId);
//         const ticketSnaps = await ticketsQuery.get();
//         ticketSnaps.forEach(doc => ticketBatch.delete(doc.ref));
//         await ticketBatch.commit();
//         console.log(`Deleted ${ticketSnaps.size} tickets for room ${roomId}.`);
//         // Similar cleanup for prizeClaimsAudit
//         return null;
//     });

// Example: Maintain player count in a separate document or update aggregated stats
// exports.onPlayerActiveUpdate = functions.firestore
//   .document('rooms/{roomId}')
//   .onUpdate(async (change, context) => {
//     const beforeData = change.before.data();
//     const afterData = change.after.data();
//     // Logic to check changes in currentActivePlayers and update stats if needed
//     return null;
//   });

console.log("Tambola Cloud Functions initialized.");
