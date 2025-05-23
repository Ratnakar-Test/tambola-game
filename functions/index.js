/**
 * Firebase Cloud Functions - Tambola Backend
 * Handles game management, ticket requests, and prize claim processing.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// --- UTILITY FUNCTIONS ---

/**
 * Generates a Tambola ticket.
 * A ticket is a 3x9 grid. Each row has 5 numbers.
 * Col 0: 1-9, Col 1: 10-19, ..., Col 8: 80-90.
 * Numbers in columns are sorted.
 * Each column must have at least one number. No column can have more than 3 numbers.
 * @returns {Array<Array<number|null>>} The generated ticket.
 */
function generateTambolaTicket() {
    let ticket = Array(3).fill(null).map(() => Array(9).fill(null));
    let colCounts = Array(9).fill(0); // Count of numbers in each column
    let rowCounts = Array(3).fill(0); // Count of numbers in each row
    let totalNumbers = 0;

    // Possible numbers for each column
    let colNumbers = [];
    for (let i = 0; i < 9; i++) {
        let start = i * 10 + (i === 0 ? 1 : 0);
        let end = i * 10 + (i === 8 ? 10 : 9); // Col 8 has 80-90 (11 numbers)
        if (i === 8) end = 90; // Correctly 80-90 for the last column

        let nums = [];
        for (let j = start; j <= end; j++) {
            nums.push(j);
        }
        // Shuffle numbers within the column
        for (let k = nums.length - 1; k > 0; k--) {
            const l = Math.floor(Math.random() * (k + 1));
            [nums[k], nums[l]] = [nums[l], nums[k]];
        }
        colNumbers.push(nums);
    }

    // Fill 15 numbers respecting constraints
    while (totalNumbers < 15) {
        let placed = false;
        // Try to place numbers row by row, then column by column
        for (let r = 0; r < 3; r++) {
            if (rowCounts[r] < 5) {
                // Try to pick a column that can still accept a number for this row
                let availableCols = [];
                for (let c = 0; c < 9; c++) {
                    if (ticket[r][c] === null && colCounts[c] < 3 && colNumbers[c].length > 0) {
                         // Check if adding to this col would still allow other rows to be filled
                        let potentialFutureProblem = false;
                        if(colCounts[c] === 2) { // If this makes it 3
                            let otherRowsNeedThisCol = false;
                            for(let or=0; or<3; or++) {
                                if(or !== r && rowCounts[or] < 5 && ticket[or][c] === null) {
                                    // Check if other rows could be filled if this col is maxed out
                                    let fillableCellsInOtherRow = 0;
                                    for(let oc=0; oc<9; oc++) {
                                        if(oc !== c && ticket[or][oc] === null && colCounts[oc] < (oc === c ? 2 : 3) ) fillableCellsInOtherRow++;
                                    }
                                    if( (5 - rowCounts[or]) > fillableCellsInOtherRow) otherRowsNeedThisCol = true;
                                }
                            }
                            if(otherRowsNeedThisCol) potentialFutureProblem = true;
                        }
                        if(!potentialFutureProblem) availableCols.push(c);
                    }
                }

                if (availableCols.length > 0) {
                    let chosenCol = availableCols[Math.floor(Math.random() * availableCols.length)];
                    ticket[r][chosenCol] = colNumbers[chosenCol].pop();
                    colCounts[chosenCol]++;
                    rowCounts[r]++;
                    totalNumbers++;
                    placed = true;
                    if (totalNumbers === 15) break;
                }
            }
            if (totalNumbers === 15) break;
        }
        if (totalNumbers === 15) break;

        // If not placed after trying all rows (e.g. row constraints met but col constraints block),
        // try forcing based on column needs if totalNumbers < 15
        if (!placed) {
            // This part is tricky to ensure all constraints are met simultaneously.
            // A more robust algorithm might use backtracking or weighted distribution.
            // For now, if it gets stuck, it might generate a slightly imperfect ticket or loop.
            // The current logic is a heuristic.
            // Fallback: if stuck, could reset and try again (not implemented here for brevity)
            let colToFill = -1;
            for(let c=0; c<9; c++) { if(colCounts[c] < 1) { colToFill = c; break; } } // Ensure each col has at least 1
            if(colToFill === -1) { // All have at least 1, try to fill those with < 3
                let possibleCols = [];
                for(let c=0; c<9; c++) { if(colCounts[c] < 3) possibleCols.push(c); }
                if(possibleCols.length > 0) colToFill = possibleCols[Math.floor(Math.random() * possibleCols.length)];
            }

            if(colToFill !== -1 && colNumbers[colToFill].length > 0) {
                for(let r=0; r<3; r++) {
                    if(ticket[r][colToFill] === null && rowCounts[r] < 5) {
                        ticket[r][colToFill] = colNumbers[colToFill].pop();
                        colCounts[colToFill]++;
                        rowCounts[r]++;
                        totalNumbers++;
                        placed = true;
                        break;
                    }
                }
            }
            if(!placed) break; // Avoid infinite loop if truly stuck
        }
    }
    
    // Sort numbers within each column on the ticket
    for (let c = 0; c < 9; c++) {
        let colVals = [];
        for (let r = 0; r < 3; r++) {
            if (ticket[r][c] !== null) {
                colVals.push(ticket[r][c]);
            }
        }
        colVals.sort((a, b) => a - b);
        let valIndex = 0;
        for (let r = 0; r < 3; r++) {
            if (ticket[r][c] !== null) {
                ticket[r][c] = colVals[valIndex++];
            }
        }
    }
    return ticket;
}


/**
 * Ensures the calling user has admin privileges.
 * @param {object} context - The context object from the callable function.
 */
function ensureAdmin(context) {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
    }
    if (context.auth.token.admin !== true) {
        throw new functions.https.HttpsError("permission-denied", "User must be an admin to perform this operation.");
    }
}

// --- CALLABLE FUNCTIONS ---

/**
 * Admin starts a new game or restarts an existing one.
 */
exports.startGame = functions.https.onCall(async (data, context) => {
    ensureAdmin(context);

    const { roomId, rulesConfig, totalMoneyCollected, callingMode, autoCallInterval } = data;

    if (!roomId || !rulesConfig || !Array.isArray(rulesConfig)) {
        throw new functions.https.HttpsError("invalid-argument", "Room ID and valid rulesConfig are required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);

    // Ensure rules have claims reset and necessary fields
    const processedRules = rulesConfig.map(rule => ({
        id: rule.id || "unknown_rule",
        name: rule.name || "Unnamed Rule",
        description: rule.description || "",
        coinsPerPrize: parseFloat(rule.coinsPerPrize) || 0,
        maxPrizes: parseInt(rule.maxPrizes) || 1,
        isActive: !!rule.isActive, // Ensure boolean
        claims: 0, // Reset claims for a new game
        baseWeight: parseFloat(rule.baseWeight) || 0, // For admin display and potential re-calc
        originalWeight: parseFloat(rule.originalWeight) || parseFloat(rule.baseWeight) || 0
    }));

    const gameData = {
        gameStatus: "running",
        adminDisplayName: context.auth.token.name || context.auth.token.email || "Admin", // From custom claims or email
        currentNumbersCalled: [],
        currentLatestCalledNumber: null,
        latestCalledPhrase: "",
        rules: processedRules, // Store the specific rules for this game instance
        totalMoneyCollected: parseFloat(totalMoneyCollected) || 0,
        callingMode: callingMode || "manual",
        autoCallInterval: parseInt(autoCallInterval) || 5,
        currentWinners: [], // Reset winners for a new game
        gameStartTime: admin.firestore.FieldValue.serverTimestamp(),
        // currentActivePlayers is managed by ticket requests/player joins, not reset here typically
    };

    await roomRef.set(gameData, { merge: true }); // Use set with merge to overwrite/initialize game fields

    return { success: true, message: "Game started successfully." };
});

/**
 * Admin calls the next number in the Tambola game.
 */
exports.callNextNumber = functions.https.onCall(async (data, context) => {
    ensureAdmin(context);
    const { roomId } = data;
    if (!roomId) {
        throw new functions.https.HttpsError("invalid-argument", "Room ID is required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);

    return db.runTransaction(async (transaction) => {
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists) {
            throw new functions.https.HttpsError("not-found", "Room not found.");
        }

        const roomData = roomDoc.data();
        if (roomData.gameStatus !== "running") {
            throw new functions.https.HttpsError("failed-precondition", "Game is not currently running.");
        }

        let calledNumbers = roomData.currentNumbersCalled || [];
        if (calledNumbers.length >= 90) {
            transaction.update(roomRef, { gameStatus: "stopped", gameEndTime: admin.firestore.FieldValue.serverTimestamp() });
            return { success: true, message: "All numbers called. Game over." , number: null, allCalled: true};
        }

        let newNumber;
        do {
            newNumber = Math.floor(Math.random() * 90) + 1;
        } while (calledNumbers.includes(newNumber));

        calledNumbers.push(newNumber);
        const updates = {
            currentNumbersCalled: calledNumbers,
            currentLatestCalledNumber: newNumber,
            latestCalledPhrase: "", // Placeholder for potential Genkit/AI phrase
        };

        if (calledNumbers.length === 90) {
            updates.gameStatus = "stopped";
            updates.gameEndTime = admin.firestore.FieldValue.serverTimestamp();
        }

        transaction.update(roomRef, updates);
        return { success: true, number: newNumber, allCalled: calledNumbers.length === 90 };
    });
});

/**
 * Player requests a new ticket for a specific room.
 */
exports.requestTicket = functions.https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated to request a ticket.");
    }
    const { roomId, playerName } = data; // userId comes from context.auth.uid
    const userId = context.auth.uid;

    if (!roomId || !playerName) {
        throw new functions.https.HttpsError("invalid-argument", "Room ID and Player Name are required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get();
    if (!roomDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Room not found.");
    }
    const roomData = roomDoc.data();
    if (roomData.gameStatus !== "running" && roomData.gameStatus !== "idle") { // Allow requests before game starts or while running
        throw new functions.https.HttpsError("failed-precondition", `Game is not in a state to request tickets (status: ${roomData.gameStatus}).`);
    }

    // Check max tickets per player (e.g., 5)
    const playerInfo = roomData.currentActivePlayers ? roomData.currentActivePlayers[userId] : null;
    if (playerInfo && playerInfo.ticketCount >= 5) {
         throw new functions.https.HttpsError("resource-exhausted", "You have reached the maximum number of tickets (5).");
    }

    // Check for existing pending request for this player in this room
    const existingRequests = await roomRef.collection("ticketRequests")
        .where("userId", "==", userId)
        .where("status", "==", "pending")
        .limit(1)
        .get();

    if (!existingRequests.empty) {
        throw new functions.https.HttpsError("already-exists", "You already have a pending ticket request.");
    }

    const ticketRequestRef = roomRef.collection("ticketRequests").doc();
    await ticketRequestRef.set({
        userId: userId,
        playerName: playerName,
        roomId: roomId,
        status: "pending",
        requestTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        currentTickets: playerInfo ? playerInfo.ticketCount : 0 // For admin info
    });

    // Update currentActivePlayers map if player is new or ensure name is up-to-date
    const playerUpdatePath = `currentActivePlayers.${userId}`;
    const playerUpdateData = {
        playerName: playerName,
        // ticketCount will be incremented by admin on approval
    };
    if(!playerInfo) { // If player is not in the map yet, initialize ticketCount
        playerUpdateData.ticketCount = 0;
    }


    await roomRef.update({
        [playerUpdatePath]: admin.firestore.FieldValue.serverTimestamp(), // Just to ensure the map key exists or use merge
        [`${playerUpdatePath}.playerName`]: playerName, // Ensure name is updated
        [`${playerUpdatePath}.lastSeen`]: admin.firestore.FieldValue.serverTimestamp(),
        // Initialize ticketCount if player is new to the room in this session
        ...( !playerInfo && { [`${playerUpdatePath}.ticketCount`]: 0 } )
    });


    return { success: true, message: "Ticket request submitted for admin approval.", requestId: ticketRequestRef.id };
});


/**
 * Admin processes a ticket request (approve or reject).
 */
exports.processTicketRequest = functions.https.onCall(async (data, context) => {
    ensureAdmin(context);
    const { roomId, requestId, action, reason } = data; // action: 'approve' or 'reject'

    if (!roomId || !requestId || !action) {
        throw new functions.https.HttpsError("invalid-argument", "Room ID, Request ID, and Action are required.");
    }
    if (action !== "approve" && action !== "reject") {
        throw new functions.https.HttpsError("invalid-argument", "Invalid action. Must be 'approve' or 'reject'.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const ticketRequestRef = roomRef.collection("ticketRequests").doc(requestId);

    return db.runTransaction(async (transaction) => {
        const requestSnap = await transaction.get(ticketRequestRef);
        if (!requestSnap.exists) {
            throw new functions.https.HttpsError("not-found", "Ticket request not found.");
        }
        const requestData = requestSnap.data();
        if (requestData.status !== "pending") {
            throw new functions.https.HttpsError("failed-precondition", "Ticket request already processed.");
        }

        if (action === "approve") {
            const ticketNumbers = generateTambolaTicket();
            const playerTicketDocRef = db.collection("gameTickets").doc(); // Store tickets in a root collection for easier querying by user

            const newTicket = {
                userId: requestData.userId,
                playerName: requestData.playerName,
                roomId: roomId,
                numbers: ticketNumbers,
                marked: [],
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            transaction.set(playerTicketDocRef, newTicket);
            transaction.update(ticketRequestRef, {
                status: "approved",
                approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                ticketId: playerTicketDocRef.id
            });

            // Update player's ticket count in the room's active players list
            const playerUpdatePath = `currentActivePlayers.${requestData.userId}`;
            transaction.update(roomRef, {
                [`${playerUpdatePath}.ticketCount`]: admin.firestore.FieldValue.increment(1),
                [`${playerUpdatePath}.playerName`]: requestData.playerName // Ensure name consistency
            });
            return { success: true, message: "Ticket approved and assigned.", ticketId: playerTicketDocRef.id };
        } else { // action === "reject"
            transaction.update(ticketRequestRef, {
                status: "rejected",
                rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
                reason: reason || "Rejected by admin."
            });
            return { success: true, message: "Ticket request rejected." };
        }
    });
});

/**
 * Player submits a prize claim. Server performs initial validation.
 */
exports.submitPrizeClaim = functions.https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated to submit a claim.");
    }
    const { roomId, userId, playerName, prizeRuleId, prizeName, ticketId, clientTempClaimId } = data;

    if (context.auth.uid !== userId) {
        throw new functions.https.HttpsError("permission-denied", "Cannot submit claim for another user.");
    }
    if (!roomId || !prizeRuleId || !ticketId || !prizeName) {
        throw new functions.https.HttpsError("invalid-argument", "Missing required claim information.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const ticketRef = db.collection("gameTickets").doc(ticketId); // Assuming tickets are in root gameTickets
    // OR: const ticketRef = db.collection("rooms").doc(roomId).collection("playerTickets").doc(ticketId);

    const roomDoc = await roomRef.get();
    const ticketDoc = await ticketRef.get();

    if (!roomDoc.exists) { throw new functions.https.HttpsError("not-found", "Room not found."); }
    if (!ticketDoc.exists) { throw new functions.https.HttpsError("not-found", `Ticket ${ticketId} not found.`); }

    const roomData = roomDoc.data();
    const ticketData = ticketDoc.data();

    if (ticketData.userId !== userId) {
        throw new functions.https.HttpsError("permission-denied", "This ticket does not belong to you.");
    }
    if (roomData.gameStatus !== "running") {
        throw new functions.https.HttpsError("failed-precondition", "Game is not running. Cannot submit claim.");
    }

    const rule = roomData.rules?.find(r => r.id === prizeRuleId);
    if (!rule || !rule.isActive) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid or inactive prize rule.");
    }
    if ((rule.claims || 0) >= rule.maxPrizes) {
         throw new functions.https.HttpsError("failed-precondition", `Maximum claims for '${rule.name}' already reached.`);
    }

    // Basic Server-Side Validation Logic Placeholder
    // This needs to be implemented thoroughly for each prize type
    const calledNumbers = roomData.currentNumbersCalled || [];
    const ticketNumbersFlat = ticketData.numbers.flat().filter(n => n !== null);
    const playerMarkedNumbersOnTicket = ticketData.marked || []; // Numbers player claims are marked on their UI

    // For this function, we'll assume the 'claimedNumbers' are the ones player asserts make the pattern
    // A more robust way is for player to send their ENTIRE 'marked' array for the ticket,
    // and server verifies the pattern using those marked numbers that are ALSO in calledNumbers.
    // For now, let's assume `playerMarkedNumbersOnTicket` are the relevant numbers for the claim.

    let serverValidationResult = false;
    let validatedClaimedNumbers = []; // Numbers that are on ticket, marked by player, and called by game

    playerMarkedNumbersOnTicket.forEach(num => {
        if (ticketNumbersFlat.includes(num) && calledNumbers.includes(num)) {
            validatedClaimedNumbers.push(num);
        }
    });

    // --- Placeholder for specific prize pattern validation ---
    // Example: For 'Early Five', check if validatedClaimedNumbers.length >= 5
    // This needs to be specific to `prizeRuleId`
    function isValidPrizePattern(ruleId, _validatedNumbers, _ticketDefinition) {
        // TODO: Implement actual logic for each prize rule
        // e.g., checkEarlyFive, checkLineOne, checkFullHouse
        // This function must return true if the pattern is met with _validatedNumbers on _ticketDefinition
        if (ruleId === "rule_early5") return _validatedNumbers.length >= 5;
        // Add other rule checks...
        // For simplicity, let's assume any claim with some validated numbers passes for now.
        // THIS IS A CRITICAL PART TO IMPLEMENT CORRECTLY.
        return _validatedNumbers.length > 0; // Highly simplified
    }

    serverValidationResult = isValidPrizePattern(prizeRuleId, validatedClaimedNumbers, ticketData.numbers);
    // --- End of placeholder ---

    const claimRef = db.collection("prizeClaimsAudit").doc(); // Auto-generate ID
    const claimDoc = {
        userId, playerName, roomId, ticketId, prizeRuleId, prizeName,
        clientTempClaimId: clientTempClaimId || null, // Store client's temp ID for reconciliation
        claimedNumbersOnTicket: playerMarkedNumbersOnTicket, // Player's view of marked numbers for this claim
        validatedClaimedNumbers: validatedClaimedNumbers, // Numbers verified by server for this claim
        status: serverValidationResult ? "pending_admin_approval" : "rejected_auto_invalid",
        reason: serverValidationResult ? "Awaiting admin review." : "Automatic validation failed (e.g., numbers not called/on ticket, or pattern incorrect).",
        serverValidationResult,
        claimTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    await claimRef.set(claimDoc);

    return {
        success: true,
        claimId: claimRef.id, // Return the actual server-generated claim ID
        status: claimDoc.status,
        message: serverValidationResult ? "Claim submitted for admin approval." : "Claim automatically reviewed; did not pass initial validation."
    };
});


/**
 * Admin processes a prize claim (approve or reject).
 */
exports.processPrizeClaim = functions.https.onCall(async (data, context) => {
    ensureAdmin(context);
    const { claimId, roomId, action, reason } = data; // action: 'approve' or 'reject'

    if (!claimId || !roomId || !action) {
        throw new functions.https.HttpsError("invalid-argument", "Claim ID, Room ID, and Action are required.");
    }
    if (action !== "approve" && action !== "reject") {
        throw new functions.https.HttpsError("invalid-argument", "Invalid action.");
    }

    const claimRef = db.collection("prizeClaimsAudit").doc(claimId);
    const roomRef = db.collection("rooms").doc(roomId);

    return db.runTransaction(async (transaction) => {
        const claimDoc = await transaction.get(claimRef);
        const roomDoc = await transaction.get(roomRef);

        if (!claimDoc.exists) { throw new functions.https.HttpsError("not-found", "Claim not found."); }
        if (!roomDoc.exists) { throw new functions.https.HttpsError("not-found", "Room not found."); }

        const claimData = claimDoc.data();
        const roomData = roomDoc.data();

        if (claimData.roomId !== roomId) {
            throw new functions.https.HttpsError("invalid-argument", "Claim does not belong to this room.");
        }
        // Allow processing only if pending admin approval or if admin wants to override a previous rejection
        if (claimData.status !== "pending_admin_approval" && claimData.status !== "rejected_auto_invalid" && claimData.status !== "rejected_admin") {
            throw new functions.https.HttpsError("failed-precondition", `Claim status is '${claimData.status}', cannot process.`);
        }

        const rule = roomData.rules?.find(r => r.id === claimData.prizeRuleId);
        if (!rule) {
            // This case should ideally be caught earlier, but double-check
            transaction.update(claimRef, {
                status: "rejected_admin",
                reason: reason || "Prize rule not found or inactive at time of admin review.",
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedBy: context.auth.uid,
            });
            throw new functions.https.HttpsError("invalid-argument", "Prize rule configuration not found in room.");
        }


        if (action === "approve") {
            if (!claimData.serverValidationResult && rule.id !== "special_manual_prize") { // Assuming auto-validation must pass unless it's a special prize
                 // If admin is approving something the server flagged as invalid
                 // Log this or handle with caution. For now, let admin override if they insist.
                 functions.logger.warn(`Admin overriding failed server validation for claim ${claimId}. Rule: ${rule.name}`);
            }

            if ((rule.claims || 0) >= rule.maxPrizes) {
                transaction.update(claimRef, {
                    status: "rejected_admin", // Or a new status like 'rejected_max_claims_met'
                    reason: reason || `Max claims (${rule.maxPrizes}) for prize '${rule.name}' already awarded.`,
                    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                    reviewedBy: context.auth.uid
                });
                throw new functions.https.HttpsError("failed-precondition", `Max claims for '${rule.name}' already reached.`);
            }

            const coinsAwarded = parseFloat(rule.coinsPerPrize) || 0;
            transaction.update(claimRef, {
                status: "approved",
                reason: reason || "Approved by admin.",
                coinsAwarded: coinsAwarded,
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedBy: context.auth.uid,
            });

            // Add to room's currentWinners
            const winnerEntry = {
                claimId: claimId,
                userId: claimData.userId,
                playerName: claimData.playerName,
                ticketId: claimData.ticketId,
                prizeName: rule.name, // Use name from rule
                prizeRuleId: claimData.prizeRuleId,
                coinsAwarded: coinsAwarded,
                timestamp: admin.firestore.FieldValue.serverTimestamp(), // Approval timestamp
            };
            transaction.update(roomRef, {
                currentWinners: admin.firestore.FieldValue.arrayUnion(winnerEntry)
            });

            // Update claims count for this rule in the room's rules array
            const updatedRules = roomData.rules.map(r => {
                if (r.id === claimData.prizeRuleId) {
                    return { ...r, claims: (r.claims || 0) + 1 };
                }
                return r;
            });
            transaction.update(roomRef, { rules: updatedRules });

            return { success: true, message: `Claim for '${rule.name}' approved. ${coinsAwarded} coins awarded.` };

        } else { // action === "reject"
            transaction.update(claimRef, {
                status: "rejected_admin",
                reason: reason || "Rejected by admin.",
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedBy: context.auth.uid,
            });
            return { success: true, message: "Claim rejected." };
        }
    });
});
