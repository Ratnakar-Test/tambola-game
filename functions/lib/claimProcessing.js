const { HttpsError } = require("firebase-functions/v1/https");
const { generateUniqueId } = require("./utils"); // From ./utils.js in lib

/**
 * Validates if a ticket meets the criteria for a specific prize rule based on called numbers.
 * This is a simplified example. Real-world validation can be complex.
 * @param {Array<Array<number|null>>} ticketNumbers - The 3x9 ticket grid.
 * @param {Array<number>} effectivelyClaimedNumbers - Numbers on the ticket that are also in the called list.
 * @param {object} prizeRule - The rule object { id, name, description, ... }.
 * @param {Array<number>} allCalledNumbersInRoom - All numbers called in the room.
 * @returns {boolean} True if the claim is valid for the rule, false otherwise.
 */
function validateClaimPattern(ticketNumbers, effectivelyClaimedNumbers, prizeRule, allCalledNumbersInRoom) {
    if (!ticketNumbers || !effectivelyClaimedNumbers || !prizeRule || !allCalledNumbersInRoom) {
        console.error("Pattern validation missing essential data.");
        return false;
    }

    const ruleName = prizeRule.name.toLowerCase();
    const totalNumbersOnTicket = ticketNumbers.flat().filter(n => n !== null).length; // Should be 15

    // Ensure all claimed numbers are actually on the ticket and have been called
    // effectivelyClaimedNumbers should already be filtered by this, but double check.
    for (const num of effectivelyClaimedNumbers) {
        if (!ticketNumbers.flat().includes(num) || !allCalledNumbersInRoom.includes(num)) {
            console.warn(`Invalid number ${num} in effectivelyClaimedNumbers during pattern check.`);
            return false; // Should not happen if effectivelyClaimedNumbers is correctly derived
        }
    }

    // Basic validations - more can be added
    if (ruleName.includes("early five") || ruleName.includes("early 5")) {
        return effectivelyClaimedNumbers.length >= 5;
    }
    if (ruleName.includes("jaldi five") || ruleName.includes("jaldi 5")) {
        return effectivelyClaimedNumbers.length >= 5;
    }
    if (ruleName.includes("star") || ruleName.includes("lucky star")) { // Typically first number on ticket
        // This needs a specific definition, e.g., first number of the ticket overall
        // For simplicity, let's say if any one claimed number, it's a start. Needs better definition.
        return effectivelyClaimedNumbers.length >= 1;
    }

    // Line/Row validation
    for (let i = 0; i < 3; i++) { // Iterate through rows
        const rowNumbers = ticketNumbers[i].filter(n => n !== null);
        if (rowNumbers.length !== 5) continue; // Skip if row doesn't have 5 numbers (should not happen for valid tickets)

        const claimedInRow = rowNumbers.filter(n => effectivelyClaimedNumbers.includes(n));

        if (ruleName.includes(`line ${i + 1}`) || ruleName.includes(`row ${i + 1}`)) {
            return claimedInRow.length === 5;
        }
        if (ruleName.includes("top line") && i === 0) return claimedInRow.length === 5;
        if (ruleName.includes("middle line") && i === 1) return claimedInRow.length === 5;
        if (ruleName.includes("bottom line") && i === 2) return claimedInRow.length === 5;
    }

    // Full House validation
    if (ruleName.includes("full house") || ruleName.includes("housie")) {
        const allNumbersOnTicketAreClaimed = ticketNumbers.flat().every(num => {
            if (num === null) return true; // Ignore empty cells
            return effectivelyClaimedNumbers.includes(num);
        });
        // And ensure all 15 numbers are claimed
        return allNumbersOnTicketAreClaimed && effectivelyClaimedNumbers.length === totalNumbersOnTicket && totalNumbersOnTicket > 0;
    }

    // Add more complex rules here: corners, breakfast, pyramid, etc.
    // Example: Corners (4 numbers: first and last of top row, first and last of bottom row)
    if (ruleName.includes("corners") || ruleName.includes("corner")) {
        const corners = [];
        // Top row corners
        const topRow = ticketNumbers[0].filter(n => n !== null);
        if (topRow.length > 0) {
            corners.push(topRow[0]);
            if (topRow.length > 1) corners.push(topRow[topRow.length - 1]);
        }
        // Bottom row corners
        const bottomRow = ticketNumbers[2].filter(n => n !== null);
        if (bottomRow.length > 0) {
            corners.push(bottomRow[0]);
            if (bottomRow.length > 1) corners.push(bottomRow[bottomRow.length - 1]);
        }
        const uniqueCorners = [...new Set(corners)]; // Handle cases where a ticket might have less than 4 distinct corners (e.g. very few numbers on ticket)
        if (uniqueCorners.length < 2) return false; // Minimum 2 corners for a valid pattern
        
        const claimedCorners = uniqueCorners.filter(c => effectivelyClaimedNumbers.includes(c));
        return claimedCorners.length === uniqueCorners.length; // All defined corners must be claimed
    }


    console.warn(`No validation logic for prize rule: ${prizeRule.name}`);
    return false; // Default to invalid if rule not recognized
}


/**
 * Handles a player's submission of a prize claim.
 * Creates an audit document and performs initial server-side validation.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} adminInstance - Firebase Admin SDK instance.
 */
exports.submitPrizeClaimHandler = (db, adminInstance) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to claim a prize.");
    }
    const playerUID = context.auth.uid;
    const {
        roomId,
        ticketId,
        prizeRuleId,
        prizeName, // From client, for display consistency
        clientTempClaimId, // Optional, for client reconciliation
        claimedNumbersOnTicket, // Array of numbers player *thinks* they marked for this claim on this ticket
    } = data;

    if (!roomId || !ticketId || !prizeRuleId || !prizeName || !Array.isArray(claimedNumbersOnTicket)) {
        throw new HttpsError("invalid-argument", "Missing required claim data (roomId, ticketId, prizeRuleId, prizeName, claimedNumbersOnTicket array).");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const ticketRef = db.collection("gameTickets").doc(ticketId);
    const claimId = `CLAIM_${generateUniqueId()}`;
    const claimAuditRef = db.collection("prizeClaimsAudit").doc(claimId);

    try {
        const [roomDoc, ticketDoc] = await Promise.all([roomRef.get(), ticketRef.get()]);

        if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
        const roomData = roomDoc.data();

        if (!ticketDoc.exists) throw new HttpsError("not-found", `Ticket ${ticketId} not found.`);
        const ticketData = ticketDoc.data();

        if (ticketData.userId !== playerUID) {
            throw new HttpsError("permission-denied", "This ticket does not belong to you.");
        }
        if (ticketData.roomId !== roomId) { // Sanity check
            throw new HttpsError("invalid-argument", "Ticket does not belong to this room.");
        }

        if (roomData.gameStatus !== "running" && roomData.gameStatus !== "paused") {
            throw new HttpsError("failed-precondition", `Cannot claim prize. Game is not active (status: ${roomData.gameStatus}).`);
        }

        const ruleBeingClaimed = roomData.rules.find(r => r.id === prizeRuleId);
        if (!ruleBeingClaimed) {
            throw new HttpsError("not-found", `Prize rule ID ${prizeRuleId} not found in this room's rules.`);
        }
        if (!ruleBeingClaimed.isActive) {
            throw new HttpsError("failed-precondition", `Prize rule '${ruleBeingClaimed.name}' is currently not active.`);
        }

        // Check if this player has already successfully claimed this specific rule for this ticket (or globally for some rules)
        // This is complex. For now, let's check if this rule (by ID) already has a claim by this player in roomData.currentWinners for THIS specific ticket.
        // Or if rule has maxClaims and it's reached.
        const existingWinnerForThisRuleOnTicket = roomData.currentWinners.find(
            w => w.prizeRuleId === prizeRuleId && w.userId === playerUID && w.ticketId === ticketId
        );
        if (existingWinnerForThisRuleOnTicket) {
             throw new HttpsError("failed-precondition", `You have already successfully claimed '${ruleBeingClaimed.name}' with this ticket.`);
        }

        // Check max claims for the rule from roomData.rules[ruleIndex].claims array
        const ruleInRoomData = roomData.rules.find(r => r.id === prizeRuleId);
        if (ruleInRoomData && ruleInRoomData.claims && ruleInRoomData.maxPrizes && ruleInRoomData.claims.length >= ruleInRoomData.maxPrizes) {
             throw new HttpsError("failed-precondition", `Prize '${ruleBeingClaimed.name}' has already reached its maximum number of winners.`);
        }


        const allCalledNumbersInRoom = roomData.currentNumbersCalled || [];
        // Determine effectively claimed numbers: intersection of what player claims AND what's actually called
        const effectivelyClaimedNumbers = claimedNumbersOnTicket.filter(num => allCalledNumbersInRoom.includes(num));

        // Server-side validation of the pattern
        const isPatternValid = validateClaimPattern(ticketData.numbers, effectivelyClaimedNumbers, ruleBeingClaimed, allCalledNumbersInRoom);

        const claimStatus = isPatternValid ? "pending_admin_approval" : "rejected_auto_invalid";
        if (!isPatternValid) {
            console.log(`Claim ${claimId} for rule ${prizeRuleId} by ${playerUID} for ticket ${ticketId} auto-rejected due to invalid pattern.`);
        }


        const claimData = {
            claimId: claimId,
            userId: playerUID,
            playerName: ticketData.playerName || "Unknown Player", // Use name from ticket or context auth
            roomId: roomId,
            ticketId: ticketId,
            prizeRuleId: prizeRuleId,
            prizeName: ruleBeingClaimed.name, // Use authoritative name from rule
            clientTempClaimId: clientTempClaimId || null,
            claimedNumbersOnTicket: claimedNumbersOnTicket, // What player sent
            effectivelyClaimedNumbers: effectivelyClaimedNumbers, // What server validated as called from player's list
            allCalledNumbersInRoomSnapshot: [...allCalledNumbersInRoom], // Snapshot of called numbers at time of claim
            ticketSnapshot: ticketData.numbers, // Snapshot of ticket numbers
            status: claimStatus, // "pending_submission", "pending_validation", "pending_admin_approval", "approved", "rejected_auto_invalid", "rejected_admin"
            reason: isPatternValid ? null : "Automatic validation failed: Claimed pattern not met with called numbers.",
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
            message: `Claim submitted. Status: ${claimStatus.replace(/_/g, ' ')}. ${isPatternValid ? 'Awaiting admin approval.' : 'Pattern invalid.'}`
        };

    } catch (error) {
        console.error("Error submitting prize claim:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not submit prize claim.", error.message);
    }
};


/**
 * Admin approves a prize claim.
 * Updates room winners, rule claims, and potentially player balances.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} adminInstance - Firebase Admin SDK instance.
 */
exports.approvePrizeClaimHandler = (db, adminInstance) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated (admin).");
    }
    const adminActingUID = context.auth.uid; // Admin performing the action
    const { roomId, claimId } = data;

    if (!roomId || !claimId) {
        throw new HttpsError("invalid-argument", "Room ID and Claim ID are required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const claimAuditRef = db.collection("prizeClaimsAudit").doc(claimId);

    return db.runTransaction(async (transaction) => {
        const [roomDoc, claimDoc] = await Promise.all([
            transaction.get(roomRef),
            transaction.get(claimAuditRef)
        ]);

        if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
        const roomData = roomDoc.data();

        if (roomData.adminUID !== adminActingUID) { // Check if acting user is the room admin
            throw new HttpsError("permission-denied", "Only the room admin can approve claims.");
        }

        if (!claimDoc.exists) throw new HttpsError("not-found", `Claim ${claimId} not found.`);
        const claimData = claimDoc.data();

        if (claimData.roomId !== roomId) { // Sanity check
            throw new HttpsError("invalid-argument", "Claim does not belong to this room.");
        }
        if (claimData.status === "approved") {
            throw new HttpsError("failed-precondition", "This claim has already been approved.");
        }
        if (claimData.status === "rejected_admin" || claimData.status === "rejected_auto_invalid") {
            throw new HttpsError("failed-precondition", "This claim has already been rejected.");
        }
        // Must be pending_admin_approval or potentially pending_validation if admin bypasses strict flow
        if (claimData.status !== "pending_admin_approval" && claimData.status !== "pending_validation") {
             throw new HttpsError("failed-precondition", `Claim status is '${claimData.status}', cannot approve directly without validation or if not pending admin action.`);
        }
        if (!claimData.serverValidationResult && claimData.status !== "pending_validation") { // If auto-validation failed, admin cannot approve unless it was pending_validation
            // This check might be too strict if admin has overriding power.
            // For now, if serverValidationResult is false, it should have been rejected automatically.
            // If an admin wants to override a serverValidationResult=false, the flow might need adjustment.
            // Let's assume admin approves only if serverValidationResult was true.
            throw new HttpsError("failed-precondition", "Claim was marked invalid by automatic server validation. Cannot approve directly.");
        }


        const ruleBeingClaimed = roomData.rules.find(r => r.id === claimData.prizeRuleId);
        if (!ruleBeingClaimed) {
            // This should not happen if claim submission was valid
            transaction.update(claimAuditRef, {
                status: "rejected_admin",
                reason: "Rule definition not found at time of approval. Inconsistency.",
                reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
                reviewedBy: adminActingUID,
            });
            throw new HttpsError("internal", "Claimed rule definition vanished. Rejecting.");
        }

        // Double check max claims for the rule at the moment of approval
        const currentRuleClaimsCount = ruleBeingClaimed.claims ? ruleBeingClaimed.claims.length : 0;
        if (ruleBeingClaimed.maxPrizes && currentRuleClaimsCount >= ruleBeingClaimed.maxPrizes) {
            transaction.update(claimAuditRef, {
                status: "rejected_admin",
                reason: `Prize '${ruleBeingClaimed.name}' reached its maximum winners just before approval.`,
                reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
                reviewedBy: adminActingUID,
            });
            throw new HttpsError("failed-precondition", `Prize '${ruleBeingClaimed.name}' has reached its maximum number of winners.`);
        }
        // Also check if this specific player has already won this specific prize on this ticket (again, for safety)
        const alreadyWon = roomData.currentWinners.some(w => w.userId === claimData.userId && w.prizeRuleId === claimData.prizeRuleId && w.ticketId === claimData.ticketId);
        if(alreadyWon){
            transaction.update(claimAuditRef, {
                status: "rejected_admin",
                reason: `Player already won '${ruleBeingClaimed.name}' on this ticket. Duplicate approval attempt.`,
                reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
                reviewedBy: adminActingUID,
            });
            throw new HttpsError("failed-precondition", "Player already won this prize on this ticket.");
        }


        // Calculate prize money (example: percentage of total collected money)
        // This logic needs to be robust. Total money collected might be based on ticket sales.
        // Prize distribution should be based on the percentages set in rules.
        // For simplicity, let's assume totalMoneyCollected is accurate in roomData.
        let coinsAwarded = 0;
        const totalPrizePoolPercentage = roomData.rules.reduce((sum, r) => sum + r.percentage, 0);
        if (roomData.totalMoneyCollected > 0 && ruleBeingClaimed.percentage > 0 && totalPrizePoolPercentage > 0) {
            // The prize for this rule is (rule.percentage / totalPrizePoolPercentage) of the actual money dedicated to prizes.
            // Or, if rule.percentage is a direct fraction of totalMoneyCollected:
            coinsAwarded = Math.floor(roomData.totalMoneyCollected * (ruleBeingClaimed.percentage / 100));
            // If multiple people can win the same prize, coinsAwarded might need to be divided or handled by "maxPrizes".
            // For now, assume full award per approved claim up to maxPrizes.
        } else if (ruleBeingClaimed.coinsPerPrize) { // Alternative: fixed coins per prize
             coinsAwarded = ruleBeingClaimed.coinsPerPrize;
        }


        // Update claim audit
        transaction.update(claimAuditRef, {
            status: "approved",
            coinsAwarded: coinsAwarded,
            reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
            reviewedBy: adminActingUID,
        });

        // Add to room's currentWinners array
        const winnerEntry = {
            claimId: claimId,
            userId: claimData.userId,
            playerName: claimData.playerName,
            ticketId: claimData.ticketId,
            prizeName: ruleBeingClaimed.name,
            prizeRuleId: ruleBeingClaimed.id,
            coinsAwarded: coinsAwarded,
            timestamp: adminInstance.firestore.FieldValue.serverTimestamp(), // Approval time
        };
        transaction.update(roomRef, {
            currentWinners: adminInstance.firestore.FieldValue.arrayUnion(winnerEntry),
        });

        // Update the specific rule in the room's rules array to record this claim
        const updatedRules = roomData.rules.map(r => {
            if (r.id === ruleBeingClaimed.id) {
                const newClaims = [...(r.claims || []), {
                    userId: claimData.userId,
                    playerName: claimData.playerName,
                    ticketId: claimData.ticketId,
                    coinsAwarded: coinsAwarded,
                    claimId: claimId,
                    timestamp: winnerEntry.timestamp // use consistent timestamp
                }];
                return { ...r, claims: newClaims };
            }
            return r;
        });
        transaction.update(roomRef, { rules: updatedRules });

        // TODO: Optional: Update player's total winnings in a separate player profile/balance if you have one.
        // const playerProfileRef = db.collection('userProfiles').doc(claimData.userId);
        // transaction.update(playerProfileRef, {
        //    totalWinnings: adminInstance.firestore.FieldValue.increment(coinsAwarded),
        //    lastWinTimestamp: adminInstance.firestore.FieldValue.serverTimestamp()
        // });

        console.log(`Claim ${claimId} approved by admin ${adminActingUID}. Player ${claimData.userId} awarded ${coinsAwarded} for ${ruleBeingClaimed.name}.`);
        return { success: true, message: "Claim approved successfully.", awarded: coinsAwarded };

    }).catch(error => {
        console.error("Error approving prize claim:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not approve prize claim.", error.message);
    });
};

/**
 * Admin rejects a prize claim.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} adminInstance - Firebase Admin SDK instance.
 */
exports.rejectPrizeClaimHandler = (db, adminInstance) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated (admin).");
    }
    const adminActingUID = context.auth.uid;
    const { roomId, claimId, reason } = data;

    if (!roomId || !claimId) {
        throw new HttpsError("invalid-argument", "Room ID and Claim ID are required.");
    }
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        throw new HttpsError("invalid-argument", "A reason is required for rejecting a claim.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const claimAuditRef = db.collection("prizeClaimsAudit").doc(claimId);

    return db.runTransaction(async (transaction) => {
        const [roomDoc, claimDoc] = await Promise.all([
            transaction.get(roomRef),
            transaction.get(claimAuditRef)
        ]);

        if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
        if (roomDoc.data().adminUID !== adminActingUID) {
            throw new HttpsError("permission-denied", "Only the room admin can reject claims.");
        }

        if (!claimDoc.exists) throw new HttpsError("not-found", `Claim ${claimId} not found.`);
        const claimData = claimDoc.data();

        if (claimData.status === "approved" || claimData.status === "rejected_admin") {
            throw new HttpsError("failed-precondition", `Claim has already been ${claimData.status}.`);
        }

        transaction.update(claimAuditRef, {
            status: "rejected_admin",
            reason: reason.trim(),
            reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
            reviewedBy: adminActingUID,
            coinsAwarded: null, // Ensure no coins if previously set then rejected
        });

        console.log(`Claim ${claimId} rejected by admin ${adminActingUID}. Reason: ${reason.trim()}`);
        return { success: true, message: "Claim rejected successfully." };

    }).catch(error => {
        console.error("Error rejecting prize claim:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not reject prize claim.", error.message);
    });
};
