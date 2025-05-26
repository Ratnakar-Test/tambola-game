/**
 * Import function triggers from their respective modules.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

try {
  admin.initializeApp();
} catch (e) {
  console.error("Firebase admin initialization error", e);
}

const db = admin.firestore();

const gameManagement = require("./lib/gameManagement");
const ticketManagement = require("./lib/ticketManagement");
const numberCalling = require("./lib/numberCalling");
const claimProcessing = require("./lib/claimProcessing");

// --- Game Management Functions ---
exports.createGameRoom = functions.https.onCall(
  gameManagement.createGameRoomHandler(db, admin),
);
exports.joinGameRoom = functions.https.onCall(
  gameManagement.joinGameRoomHandler(db, admin), // Added admin for consistency if needed later for timestamps
);
exports.setGameRules = functions.https.onCall(
  gameManagement.setGameRulesHandler(db),
);
exports.startGame = functions.https.onCall(
  gameManagement.startGameHandler(db, admin),
);
exports.stopGame = functions.https.onCall(
  gameManagement.stopGameHandler(db, admin),
);
exports.setCallingMode = functions.https.onCall(
  gameManagement.setCallingModeHandler(db),
);
exports.togglePauseResumeGame = functions.https.onCall(
  gameManagement.togglePauseResumeGameHandler(db),
);
exports.updatePlayerPresence = functions.https.onCall(
  gameManagement.updatePlayerPresenceHandler(db, admin),
);

// --- Number Calling Functions ---
exports.callNextNumber = functions.https.onCall(
  numberCalling.callNextNumberHandler(db, admin),
);
// exports.scheduledAutoCall = functions.pubsub.schedule('every 1 minutes').onRun(async (context) => {
//   return numberCalling.scheduledAutoCallHandler(db, admin);
// });

// --- Ticket Management Functions ---
exports.requestGameTicket = functions.https.onCall(
  ticketManagement.requestGameTicketHandler(db, admin),
);
exports.approveTicketRequest = functions.https.onCall(
  ticketManagement.approveTicketRequestHandler(db, admin),
);
exports.rejectTicketRequest = functions.https.onCall(
  ticketManagement.rejectTicketRequestHandler(db, admin),
);

// --- Prize Claim Processing Functions ---
exports.submitPrizeClaim = functions.https.onCall(
  claimProcessing.submitPrizeClaimHandler(db, admin),
);
exports.approvePrizeClaim = functions.https.onCall(
  claimProcessing.approvePrizeClaimHandler(db, admin),
);
exports.rejectPrizeClaim = functions.https.onCall(
  claimProcessing.rejectPrizeClaimHandler(db, admin),
);

console.log("Tambola Cloud Functions initialized.");
