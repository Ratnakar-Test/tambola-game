const {HttpsError} = require("firebase-functions/v1/https");
const {generateUniqueId} = require("./utils");

/**
 * Validates if a ticket meets criteria for a prize rule.
 * @param {Array<Array<number|null>>} ticketNumbers 3x9 ticket grid.
 * @param {Array<number>} effectivelyClaimedNumbers Intersect of player marked & called.
 * @param {object} prizeRule The rule object.
 * @param {Array<number>} allCalledInRoom All numbers called in room.
 * @return {boolean} True if valid.
 */
function validateClaimPattern(
  ticketNumbers,
  effectivelyClaimedNumbers,
  prizeRule,
  allCalledInRoom,
) {
  if (!ticketNumbers || !effectivelyClaimedNumbers || !prizeRule || !allCalledInRoom) {
    console.error("Pattern validation missing essential data.");
    return false;
  }

  const ruleName = prizeRule.name.toLowerCase();
  const totalNumbersOnTicket = ticketNumbers.flat().filter((n) => n !== null).length;

  for (const num of effectivelyClaimedNumbers) {
    if (!ticketNumbers.flat().includes(num) || !allCalledInRoom.includes(num)) {
      console.warn(`Invalid num ${num} in effectivelyClaimed during pattern check.`);
      return false;
    }
  }

  if (ruleName.includes("early five") || ruleName.includes("early 5") ||
      ruleName.includes("jaldi five") || ruleName.includes("jaldi 5")) {
    return effectivelyClaimedNumbers.length >= 5;
  }
  if (ruleName.includes("star") || ruleName.includes("lucky star")) {
    return effectivelyClaimedNumbers.length >= 1;
  }

  for (let i = 0; i < 3; i++) {
    const rowNumbers = ticketNumbers[i].filter((n) => n !== null);
    if (rowNumbers.length !== 5) continue;
    const claimedInRow = rowNumbers.filter((n) => effectivelyClaimedNumbers.includes(n));
    if (ruleName.includes(`line ${i + 1}`) || ruleName.includes(`row ${i + 1}`)) {
      return claimedInRow.length === 5;
    }
    if (ruleName.includes("top line") && i === 0) return claimedInRow.length === 5;
    if (ruleName.includes("middle line") && i === 1) return claimedInRow.length === 5;
    if (ruleName.includes("bottom line") && i === 2) return claimedInRow.length === 5;
  }

  if (ruleName.includes("full house") || ruleName.includes("housie")) {
    const allOnTicketAreClaimed = ticketNumbers.flat().every((num) => {
      if (num === null) return true;
      return effectivelyClaimedNumbers.includes(num);
    });
    return allOnTicketAreClaimed && effectivelyClaimedNumbers.length === totalNumbersOnTicket && totalNumbersOnTicket > 0;
  }

  if (ruleName.includes("corners") || ruleName.includes("corner")) {
    const corners = [];
    const topRow = ticketNumbers[0].filter((n) => n !== null);
    if (topRow.length > 0) {
      corners.push(topRow[0]);
      if (topRow.length > 1) corners.push(topRow[topRow.length - 1]);
    }
    const bottomRow = ticketNumbers[2].filter((n) => n !== null);
    if (bottomRow.length > 0) {
      corners.push(bottomRow[0]);
      if (bottomRow.length > 1) corners.push(bottomRow[bottomRow.length - 1]);
    }
    const uniqueCorners = [...new Set(corners)];
    if (uniqueCorners.length < 2 && !(uniqueCorners.length > 0 && topRow.length === 1 && bottomRow.length === 0) && !(uniqueCorners.length > 0 && bottomRow.length === 1 && topRow.length === 0) ) { // Allow single-number rows for corners if that's the only number
        // This logic needs to be very specific to how 'corners' are defined for tickets with few numbers. Standard tickets have full rows.
        // For a simple case: if ticket has defined corners, all must be claimed.
        if (uniqueCorners.length < 2) return false; // Standard definition usually implies at least 2 distinct numbers for corners.
    }
    const claimedCorners = uniqueCorners.filter((c) => effectivelyClaimedNumbers.includes(c));
    return uniqueCorners.length > 0 && claimedCorners.length === uniqueCorners.length;
  }

  console.warn(`No validation logic for prize rule: ${prizeRule.name}`);
  return false;
}

/**
 * Handles a player's submission of a prize claim.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {object} adminInstance - Firebase Admin SDK instance.
 * @return {Function} Callable Cloud Function.
 */
exports.submitPrizeClaimHandler = (db, adminInstance) => async (data, context) => {
  if (!context.auth) {
    throw new HttpsError(
      "unauthenticated",
      "User must be authenticated to claim a prize.",
    );
  }
  const playerUID = context.auth.uid;
  const {
    roomId,
    ticketId,
    prizeRuleId,
    prizeName, // From client
    clientTempClaimId,
    claimedNumbersOnTicket, // Array from client
  } = data;

  if (
    !roomId ||
    !ticketId ||
    !prizeRuleId ||
    !prizeName ||
    !Array.isArray(claimedNumbersOnTicket)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Missing required claim data (roomId, ticketId, prizeRuleId, " +
      "prizeName, claimedNumbersOnTicket array).",
    );
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const ticketRef = db.collection("gameTickets").doc(ticketId);
  const claimId = `CLAIM_${generateUniqueId()}`;
  const claimAuditRef = db.collection("prizeClaimsAudit").doc(claimId);

  try {
    const [roomDoc, ticketDoc] = await Promise.all([
      roomRef.get(),
      ticketRef.get(),
    ]);

    if (!roomDoc.exists) {
      throw new HttpsError("not-found", `Room ${roomId} not found.`);
    }
    const roomData = roomDoc.data();

    if (!ticketDoc.exists) {
      throw new HttpsError("not-found", `Ticket ${ticketId} not found.`);
    }
    const ticketData = ticketDoc.data();

    if (ticketData.userId !== playerUID) {
      throw new HttpsError(
        "permission-denied",
        "This ticket does not belong to you.",
      );
    }
    if (ticketData.roomId !== roomId) {
      throw new HttpsError("invalid-argument", "Ticket does not belong to this room.");
    }

    if (roomData.gameStatus !== "running" && roomData.gameStatus !== "paused") {
      throw new HttpsError(
        "failed-precondition",
        `Cannot claim prize. Game is not active (status: ${roomData.gameStatus}).`,
      );
    }

    const ruleBeingClaimed = roomData.rules.find((r) => r.id === prizeRuleId);
    if (!ruleBeingClaimed) {
      throw new HttpsError(
        "not-found",
        `Prize rule ID ${prizeRuleId} not found in this room's rules.`,
      );
    }
    if (!ruleBeingClaimed.isActive) {
      throw new HttpsError(
        "failed-precondition",
        `Prize rule '${ruleBeingClaimed.name}' is currently not active.`,
      );
    }

    const existingWinner = roomData.currentWinners.find(
      (w) => w.prizeRuleId === prizeRuleId &&
             w.userId === playerUID &&
             w.ticketId === ticketId,
    );
    if (existingWinner) {
      throw new HttpsError(
        "failed-precondition",
        `You have already successfully claimed '${ruleBeingClaimed.name}' with this ticket.`,
      );
    }

    const ruleInRoom = roomData.rules.find((r) => r.id === prizeRuleId);
    if (
      ruleInRoom &&
      ruleInRoom.claims &&
      ruleInRoom.maxPrizes &&
      ruleInRoom.claims.length >= ruleInRoom.maxPrizes
    ) {
      throw new HttpsError(
        "failed-precondition",
        `Prize '${ruleBeingClaimed.name}' has reached maximum winners.`,
      );
    }

    const allCalledInRoom = roomData.currentNumbersCalled || [];
    const effectivelyClaimed = claimedNumbersOnTicket.filter((num) => allCalledInRoom.includes(num));
    const isPatternValid = validateClaimPattern(
      ticketData.numbers,
      effectivelyClaimed,
      ruleBeingClaimed,
      allCalledInRoom,
    );
    const claimStatus = isPatternValid ? "pending_admin_approval" : "rejected_auto_invalid";

    if (!isPatternValid) {
      console.log(`Claim ${claimId} for rule ${prizeRuleId} by ${playerUID} for ticket ${ticketId} auto-rejected.`);
    }

    const claimData = {
      claimId: claimId,
      userId: playerUID,
      playerName: ticketData.playerName || "Unknown Player",
      roomId: roomId,
      ticketId: ticketId,
      prizeRuleId: prizeRuleId,
      prizeName: ruleBeingClaimed.name,
      clientTempClaimId: clientTempClaimId || null,
      claimedNumbersOnTicket: claimedNumbersOnTicket,
      effectivelyClaimedNumbers: effectivelyClaimed,
      allCalledNumbersInRoomSnapshot: [...allCalledInRoom],
      ticketSnapshot: ticketData.numbers,
      status: claimStatus,
      reason: isPatternValid ? null : "Automatic validation failed: Pattern not met.",
      serverValidationResult: isPatternValid,
      claimTimestamp: adminInstance.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      coinsAwarded: null,
    };

    await claimAuditRef.set(claimData);

    return {
      success: true,
      claimId: claimId,
      status: claimStatus,
      message: `Claim submitted. Status: ${claimStatus.replace(/_/g, " ")}. ` +
               `${isPatternValid ? "Awaiting admin approval." : "Pattern invalid."}`,
    };
  } catch (error) {
    console.error("Error submitting prize claim:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "Could not submit prize claim.", error.message);
  }
};

/**
 * Admin approves a prize claim.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {object} adminInstance - Firebase Admin SDK instance.
 * @return {Function} Callable Cloud Function.
 */
exports.approvePrizeClaimHandler = (db, adminInstance) => async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated (admin).");
  }
  const adminActingUID = context.auth.uid;
  const {roomId, claimId} = data;

  if (!roomId || !claimId) {
    throw new HttpsError("invalid-argument", "Room ID and Claim ID are required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const claimAuditRef = db.collection("prizeClaimsAudit").doc(claimId);

  return db.runTransaction(async (transaction) => {
    const [roomDoc, claimDoc] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(claimAuditRef),
    ]);

    if (!roomDoc.exists) {
      throw new HttpsError("not-found", `Room ${roomId} not found.`);
    }
    const roomData = roomDoc.data();

    if (roomData.adminUID !== adminActingUID) {
      throw new HttpsError(
        "permission-denied",
        "Only the room admin can approve claims.",
      );
    }

    if (!claimDoc.exists) {
      throw new HttpsError("not-found", `Claim ${claimId} not found.`);
    }
    const claimData = claimDoc.data();

    if (claimData.roomId !== roomId) {
      throw new HttpsError("invalid-argument", "Claim does not belong to this room.");
    }
    if (claimData.status === "approved") {
      throw new HttpsError(
        "failed-precondition",
        "This claim has already been approved.",
      );
    }
    if (claimData.status === "rejected_admin" || claimData.status === "rejected_auto_invalid") {
      throw new HttpsError(
        "failed-precondition",
        "This claim has already been rejected.",
      );
    }
    if (claimData.status !== "pending_admin_approval" && claimData.status !== "pending_validation") {
      throw new HttpsError(
        "failed-precondition",
        `Claim status is '${claimData.status}', cannot approve directly.`,
      );
    }
    if (!claimData.serverValidationResult) {
      throw new HttpsError(
        "failed-precondition",
        "Claim was auto-invalidated. Cannot approve directly.",
      );
    }

    const ruleToAward = roomData.rules.find((r) => r.id === claimData.prizeRuleId);
    if (!ruleToAward) {
      transaction.update(claimAuditRef, {
        status: "rejected_admin",
        reason: "Rule definition not found at time of approval.",
        reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
        reviewedBy: adminActingUID,
      });
      throw new HttpsError("internal", "Claimed rule definition vanished.");
    }

    const currentRuleClaimsCount = ruleToAward.claims ? ruleToAward.claims.length : 0;
    if (ruleToAward.maxPrizes && currentRuleClaimsCount >= ruleToAward.maxPrizes) {
      transaction.update(claimAuditRef, {
        status: "rejected_admin",
        reason: `Prize '${ruleToAward.name}' reached max winners before approval.`,
        reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
        reviewedBy: adminActingUID,
      });
      throw new HttpsError(
        "failed-precondition",
        `Prize '${ruleToAward.name}' has reached its maximum winners.`,
      );
    }
    const alreadyWonThis = roomData.currentWinners.some(
      (w) => w.userId === claimData.userId &&
             w.prizeRuleId === claimData.prizeRuleId &&
             w.ticketId === claimData.ticketId,
    );
    if (alreadyWonThis) {
      transaction.update(claimAuditRef, {
        status: "rejected_admin",
        reason: `Player already won '${ruleToAward.name}' on this ticket.`,
        reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
        reviewedBy: adminActingUID,
      });
      throw new HttpsError("failed-precondition", "Player already won this prize on this ticket.");
    }

    let coinsAwarded = 0;
    if (roomData.totalMoneyCollected > 0 && ruleToAward.percentage > 0) {
      coinsAwarded = Math.floor(roomData.totalMoneyCollected * (ruleToAward.percentage / 100));
    } else if (ruleToAward.coinsPerPrize) {
      coinsAwarded = ruleToAward.coinsPerPrize;
    }

    transaction.update(claimAuditRef, {
      status: "approved",
      coinsAwarded: coinsAwarded,
      reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
      reviewedBy: adminActingUID,
    });

    const winnerEntry = {
      claimId: claimId,
      userId: claimData.userId,
      playerName: claimData.playerName,
      ticketId: claimData.ticketId,
      prizeName: ruleToAward.name,
      prizeRuleId: ruleToAward.id,
      coinsAwarded: coinsAwarded,
      timestamp: adminInstance.firestore.FieldValue.serverTimestamp(),
    };
    transaction.update(roomRef, {
      currentWinners: adminInstance.firestore.FieldValue.arrayUnion(winnerEntry),
    });

    const updatedRules = roomData.rules.map((r) => {
      if (r.id === ruleToAward.id) {
        const newClaims = [
          ...(r.claims || []),
          {
            userId: claimData.userId,
            playerName: claimData.playerName,
            ticketId: claimData.ticketId,
            coinsAwarded: coinsAwarded,
            claimId: claimId,
            timestamp: winnerEntry.timestamp,
          },
        ];
        return {...r, claims: newClaims};
      }
      return r;
    });
    transaction.update(roomRef, {rules: updatedRules});

    console.log(`Claim ${claimId} approved by admin ${adminActingUID}. Player ${claimData.userId} awarded ${coinsAwarded} for ${ruleToAward.name}.`);
    return {success: true, message: "Claim approved successfully.", awarded: coinsAwarded};
  }).catch((error) => {
    console.error("Error approving prize claim:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "Could not approve prize claim.", error.message);
  });
};

/**
 * Admin rejects a prize claim.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {object} adminInstance - Firebase Admin SDK instance.
 * @return {Function} Callable Cloud Function.
 */
exports.rejectPrizeClaimHandler = (db, adminInstance) => async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated (admin).");
  }
  const adminActingUID = context.auth.uid;
  const {roomId, claimId, reason} = data;

  if (!roomId || !claimId) {
    throw new HttpsError("invalid-argument", "Room ID and Claim ID are required.");
  }
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "A reason is required for rejecting a claim.",
    );
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const claimAuditRef = db.collection("prizeClaimsAudit").doc(claimId);

  return db.runTransaction(async (transaction) => {
    const [roomDoc, claimDoc] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(claimAuditRef),
    ]);

    if (!roomDoc.exists) {
      throw new HttpsError("not-found", `Room ${roomId} not found.`);
    }
    if (roomDoc.data().adminUID !== adminActingUID) {
      throw new HttpsError(
        "permission-denied",
        "Only the room admin can reject claims.",
      );
    }

    if (!claimDoc.exists) {
      throw new HttpsError("not-found", `Claim ${claimId} not found.`);
    }
    const claimData = claimDoc.data();

    if (claimData.status === "approved" || claimData.status === "rejected_admin") {
      throw new HttpsError(
        "failed-precondition",
        `Claim has already been ${claimData.status}.`,
      );
    }

    transaction.update(claimAuditRef, {
      status: "rejected_admin",
      reason: reason.trim(),
      reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
      reviewedBy: adminActingUID,
      coinsAwarded: null,
    });

    console.log(`Claim ${claimId} rejected by admin ${adminActingUID}. Reason: ${reason.trim()}`);
    return {success: true, message: "Claim rejected successfully."};
  }).catch((error) => {
    console.error("Error rejecting prize claim:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "Could not reject prize claim.", error.message);
  });
};
