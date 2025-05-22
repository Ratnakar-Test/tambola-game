/**
 * Firebase Cloud Functions - Tambola Backend
 * Handles ticket approvals, prize claim validation, and room/game syncing
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// Utility: generate a random ticket (3 rows x 9 cols, 15 numbers per ticket)
function generateTambolaTicket() {
  const ticket = Array.from({ length: 3 }, () => Array(9).fill(null));
  const columns = Array.from({ length: 9 }, (_, i) => []);

  for (let i = 0; i < 9; i++) {
    const start = i === 0 ? 1 : i * 10;
    const end = i === 8 ? 90 : i * 10 + 9;
    columns[i] = Array.from({ length: end - start + 1 }, (_, k) => start + k);
    columns[i].sort(() => Math.random() - 0.5);
  }

  const filledCols = Array(9).fill(0);
  for (let row = 0; row < 3; row++) {
    const selectedCols = [];
    while (selectedCols.length < 5) {
      const col = Math.floor(Math.random() * 9);
      if (!selectedCols.includes(col) && filledCols[col] < 3) {
        selectedCols.push(col);
        filledCols[col]++;
      }
    }
    selectedCols.forEach((col) => {
      ticket[row][col] = columns[col].pop();
    });
  }

  return ticket;
}

// Callable: Admin approves a ticket request
exports.approveTicketRequest = functions.https.onCall(async (data, context) => {
  const { roomId, requestId, playerId, playerName } = data;

  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Only authenticated users can approve requests.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const ticketRequestsRef = roomRef.collection("ticketRequests").doc(requestId);

  const ticket = generateTambolaTicket();
  const ticketDoc = {
    numbers: ticket,
    marked: [],
    playerId,
    playerName,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const playerTicketRef = roomRef.collection("tickets").doc();

  await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(ticketRequestsRef);
    if (!requestSnap.exists || requestSnap.data().status !== "pending") {
      throw new functions.https.HttpsError("failed-precondition", "Request no longer valid.");
    }

    tx.set(playerTicketRef, ticketDoc);
    tx.update(ticketRequestsRef, { status: "approved" });

    tx.update(roomRef, {
      [`currentActivePlayers.${playerId}.ticketCount`]: admin.firestore.FieldValue.increment(1)
    });
  });

  return { success: true, ticketId: playerTicketRef.id };
});

// Callable: Validate a player's prize claim
exports.validatePrizeClaim = functions.https.onCall(async (data, context) => {
  const { roomId, ticketId, playerId, claimId, prizeRuleId, numbers } = data;

  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Only authenticated users can submit claims.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const prizeRef = db.collection("prizeClaimsAudit").doc(claimId);

  const roomSnap = await roomRef.get();
  const rules = roomSnap.data().rules || [];
  const rule = rules.find(r => r.id === prizeRuleId);

  if (!rule || !rule.isActive) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid prize rule.");
  }

  // Perform basic validation (real implementation should validate line/house etc)
  if (!Array.isArray(numbers) || numbers.length === 0) {
    throw new functions.https.HttpsError("invalid-argument", "No numbers submitted.");
  }

  await prizeRef.set({
    roomId,
    ticketId,
    playerId,
    prizeRuleId,
    numbers,
    status: "pending_admin_approval",
    claimTimestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true };
});

// Callable: Admin manually updates prize claim status
exports.updateClaimStatus = functions.https.onCall(async (data, context) => {
  const { claimId, newStatus, reason } = data;

  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Only authenticated admins can update claims.");
  }

  const claimRef = db.collection("prizeClaimsAudit").doc(claimId);
  const claimSnap = await claimRef.get();
  if (!claimSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Claim not found.");
  }

  const claimData = claimSnap.data();

  const updates = {
    status: newStatus,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    reason: reason || null
  };

  await claimRef.update(updates);

  // Optionally reward if approved
  if (newStatus === "approved") {
    const winnerEntry = {
      playerId: claimData.playerId,
      ticketId: claimData.ticketId,
      prizeName: claimData.prizeRuleId,
      claimId,
      coins: 100,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    const roomRef = db.collection("rooms").doc(claimData.roomId);
    await roomRef.update({
      currentWinners: admin.firestore.FieldValue.arrayUnion(winnerEntry)
    });
  }

  return { success: true };
});
