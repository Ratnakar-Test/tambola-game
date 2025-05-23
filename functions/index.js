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
    let colCounts = Array(9).fill(0);
    let rowCounts = Array(3).fill(0);
    let totalNumbers = 0;

    let colNumbers = [];
    for (let i = 0; i < 9; i++) {
        let start = i * 10 + (i === 0 ? 1 : 0);
        let end = i * 10 + (i === 8 ? 10 : 9);
        if (i === 8) end = 90;

        let nums = [];
        for (let j = start; j <= end; j++) {
            nums.push(j);
        }
        for (let k = nums.length - 1; k > 0; k--) {
            const l = Math.floor(Math.random() * (k + 1));
            [nums[k], nums[l]] = [nums[l], nums[k]];
        }
        colNumbers.push(nums);
    }

    // Attempt to satisfy row and column constraints
    // First pass: Ensure each column gets at least one number
    for (let c = 0; c < 9; c++) {
        if (colNumbers[c].length > 0) {
            let placedInCol = false;
            // Try to find a row that needs numbers and isn't full
            let availableRows = [];
            for(let r=0; r<3; r++) { if(rowCounts[r] < 5) availableRows.push(r); }
            if(availableRows.length > 0) {
                let randomRow = availableRows[Math.floor(Math.random() * availableRows.length)];
                 if (ticket[randomRow][c] === null) { // Check if cell is empty
                    ticket[randomRow][c] = colNumbers[c].pop();
                    colCounts[c]++;
                    rowCounts[randomRow]++;
                    totalNumbers++;
                    placedInCol = true;
                }
            }
            // If still not placed (e.g., all rows tried are full in this column), try any empty cell in this col
            if(!placedInCol) {
                for (let r = 0; r < 3; r++) {
                    if (ticket[r][c] === null && rowCounts[r] < 5 && colNumbers[c].length > 0) {
                        ticket[r][c] = colNumbers[c].pop();
                        colCounts[c]++;
                        rowCounts[r]++;
                        totalNumbers++;
                        break;
                    }
                }
            }
        }
    }

    // Second pass: Fill remaining numbers to get 5 per row and 15 total
    for (let r = 0; r < 3; r++) {
        while (rowCounts[r] < 5 && totalNumbers < 15) {
            let availableCols = [];
            for (let c = 0; c < 9; c++) {
                if (ticket[r][c] === null && colCounts[c] < 3 && colNumbers[c].length > 0) {
                    availableCols.push(c);
                }
            }
            if (availableCols.length === 0) break; // No place in this row respecting col constraints

            let chosenCol = availableCols[Math.floor(Math.random() * availableCols.length)];
            ticket[r][chosenCol] = colNumbers[chosenCol].pop();
            colCounts[chosenCol]++;
            rowCounts[r]++;
            totalNumbers++;
        }
    }
    
    // If by some chance constraints couldn't be perfectly met (e.g. not exactly 15 numbers, or a row not 5)
    // This basic algorithm might need refinement for edge cases or a more complex constraint solver.
    // For now, we proceed with what's generated. A common issue is getting stuck if one column fills up to 3 too quickly.

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
        functions.logger.warn("ensureAdmin: Unauthenticated access attempt.");
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
    }
    // Check for custom admin claim
    if (context.auth.token.admin !== true) {
        functions.logger.warn("ensureAdmin: Permission denied. User is not an admin.", {uid: context.auth.uid});
        throw new functions.https.HttpsError("permission-denied", "User must be an admin to perform this operation.");
    }
    functions.logger.log("ensureAdmin: Admin check passed for UID:", context.auth.uid);
}

// --- CALLABLE FUNCTIONS ---

/**
 * Admin starts a new game or restarts an existing one.
 */
exports.startGame = functions.https.onCall(async (data, context) => {
    functions.logger.log("startGame: Function execution started.", {structuredData: true});
    functions.logger.log("startGame: Received data:", data);
    functions.logger.log("startGame: Auth context present:", !!context.auth);
    if (context.auth) {
        functions.logger.log("startGame: Auth UID:", context.auth.uid);
        // Avoid logging the full token in production unless for very specific debugging needs
        // functions.logger.log("startGame: Auth token details:", context.auth.token);
    }

    try {
        ensureAdmin(context); // This will throw if not admin

        const { roomId, rulesConfig, totalMoneyCollected, callingMode, autoCallInterval } = data;
        functions.logger.log("startGame: Destructured data:", { roomId, rulesConfigIsArray: Array.isArray(rulesConfig), totalMoneyCollected, callingMode, autoCallInterval });

        if (!roomId || !rulesConfig || !Array.isArray(rulesConfig)) {
            functions.logger.error("startGame: Invalid arguments. Room ID or rulesConfig missing/invalid.", { roomId, rulesConfigPresent: !!rulesConfig, data });
            throw new functions.https.HttpsError("invalid-argument", "Room ID and valid rulesConfig array are required.");
        }
        functions.logger.log(`startGame: Processing for Room ID: ${roomId}`);

        const roomRef = db.collection("rooms").doc(roomId);
        functions.logger.log("startGame: Room reference created for path:", roomRef.path);

        const processedRules = rulesConfig.map((rule, index) => {
            if (!rule || typeof rule.id === 'undefined') { // Basic check for rule validity
                functions.logger.warn(`startGame: Rule at index ${index} is malformed or missing id. Using defaults/skipping.`, {rule});
                // Potentially throw an error or provide default values
                return {
                    id: `default_invalid_rule_${index}`, name: "Invalid Rule", description: "Rule data was malformed.",
                    coinsPerPrize: 0, maxPrizes: 0, isActive: false, claims: 0, baseWeight: 0, originalWeight: 0
                };
            }
            return {
                id: rule.id,
                name: rule.name || "Unnamed Rule",
                description: rule.description || "",
                coinsPerPrize: parseFloat(rule.coinsPerPrize) || 0,
                maxPrizes: parseInt(rule.maxPrizes) || 1,
                isActive: !!rule.isActive,
                claims: 0, // Reset claims for a new game
                baseWeight: parseFloat(rule.baseWeight) || 0,
                originalWeight: parseFloat(rule.originalWeight) || parseFloat(rule.baseWeight) || 0
            };
        });
        functions.logger.log("startGame: Rules processed:", processedRules);

        const adminDisplayName = (context.auth.token && context.auth.token.name) || (context.auth.token && context.auth.token.email) || "Admin";
        functions.logger.log("startGame: Admin display name:", adminDisplayName);

        const gameData = {
            gameStatus: "running",
            adminDisplayName: adminDisplayName,
            adminUID: context.auth.uid, // Store admin UID
            currentNumbersCalled: [],
            currentLatestCalledNumber: null,
            latestCalledPhrase: "",
            rules: processedRules,
            totalMoneyCollected: parseFloat(totalMoneyCollected) || 0,
            callingMode: callingMode || "manual",
            autoCallInterval: parseInt(autoCallInterval) || 5,
            currentWinners: [],
            gameStartTime: admin.firestore.FieldValue.serverTimestamp(),
            // currentActivePlayers map is generally preserved or managed by player join/ticket logic
        };
        functions.logger.log("startGame: Prepared gameData:", gameData);

        await roomRef.set(gameData, { merge: true }); // Use merge to update/initialize these specific game fields
        functions.logger.log(`startGame: Game data set for Room ID: ${roomId}. Status set to running.`);

        return { success: true, message: "Game started successfully." };

    } catch (error) {
        functions.logger.error("startGame: Error caught in function execution:", {
            message: error.message,
            stack: error.stack,
            details: error.details, // For HttpsError
            code: error.code // For HttpsError
        });
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throw new functions.https.HttpsError("internal", `An internal error occurred in startGame: ${error.message}`);
    }
});

/**
 * Admin calls the next number in the Tambola game.
 */
exports.callNextNumber = functions.https.onCall(async (data, context) => {
    functions.logger.log("callNextNumber: Function started.", {data, auth: !!context.auth});
    try {
        ensureAdmin(context);
        const { roomId } = data;
        if (!roomId) {
            functions.logger.error("callNextNumber: Room ID is required.");
            throw new functions.https.HttpsError("invalid-argument", "Room ID is required.");
        }

        const roomRef = db.collection("rooms").doc(roomId);

        return db.runTransaction(async (transaction) => {
            const roomDoc = await transaction.get(roomRef);
            if (!roomDoc.exists) {
                functions.logger.error("callNextNumber: Room not found.", {roomId});
                throw new functions.https.HttpsError("not-found", "Room not found.");
            }

            const roomData = roomDoc.data();
            if (roomData.gameStatus !== "running") {
                functions.logger.warn("callNextNumber: Game not running.", {roomId, status: roomData.gameStatus});
                throw new functions.https.HttpsError("failed-precondition", "Game is not currently running.");
            }

            let calledNumbers = roomData.currentNumbersCalled || [];
            if (calledNumbers.length >= 90) {
                functions.logger.info("callNextNumber: All numbers called.", {roomId});
                transaction.update(roomRef, { gameStatus: "stopped", gameEndTime: admin.firestore.FieldValue.serverTimestamp() });
                return { success: true, message: "All numbers called. Game over.", number: null, allCalled: true };
            }

            let newNumber;
            let attempts = 0;
            do {
                newNumber = Math.floor(Math.random() * 90) + 1;
                attempts++;
                if (attempts > 200 && calledNumbers.length < 90) { // Safeguard for unlikely infinite loop
                    functions.logger.error("callNextNumber: Could not find a new number after 200 attempts.", {roomId, calledNumbers});
                    throw new functions.https.HttpsError("internal", "Failed to generate a new unique number.");
                }
            } while (calledNumbers.includes(newNumber));

            calledNumbers.push(newNumber);
            const updates = {
                currentNumbersCalled: calledNumbers,
                currentLatestCalledNumber: newNumber,
                latestCalledPhrase: "", // Placeholder for Genkit/AI phrase
            };

            if (calledNumbers.length === 90) {
                updates.gameStatus = "stopped";
                updates.gameEndTime = admin.firestore.FieldValue.serverTimestamp();
            }

            transaction.update(roomRef, updates);
            functions.logger.log("callNextNumber: Number called successfully.", {roomId, newNumber, allCalled: updates.gameStatus === "stopped"});
            return { success: true, number: newNumber, allCalled: updates.gameStatus === "stopped" };
        });
    } catch (error) {
        functions.logger.error("callNextNumber: Error caught.", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", `Internal error in callNextNumber: ${error.message}`);
    }
});

/**
 * Player requests a new ticket for a specific room.
 */
exports.requestTicket = functions.https.onCall(async (data, context) => {
    functions.logger.log("requestTicket: Function started.", {data, auth: !!context.auth});
    if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
    }
    const { roomId, playerName } = data;
    const userId = context.auth.uid;

    if (!roomId || !playerName) {
        throw new functions.https.HttpsError("invalid-argument", "Room ID and Player Name are required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    try {
        const roomDoc = await roomRef.get();
        if (!roomDoc.exists) {
            throw new functions.https.HttpsError("not-found", "Room not found.");
        }
        const roomData = roomDoc.data();
        if (roomData.gameStatus !== "running" && roomData.gameStatus !== "idle") {
            throw new functions.https.HttpsError("failed-precondition", `Game status (${roomData.gameStatus}) does not allow ticket requests.`);
        }

        const playerInfo = roomData.currentActivePlayers ? roomData.currentActivePlayers[userId] : null;
        if (playerInfo && (playerInfo.ticketCount || 0) >= 5) {
             throw new functions.https.HttpsError("resource-exhausted", "Maximum 5 tickets allowed per player.");
        }

        const existingRequestsQuery = roomRef.collection("ticketRequests")
            .where("userId", "==", userId)
            .where("status", "==", "pending")
            .limit(1);
        const existingRequestsSnap = await existingRequestsQuery.get();
        if (!existingRequestsSnap.empty) {
            throw new functions.https.HttpsError("already-exists", "You have an existing pending ticket request.");
        }

        const ticketRequestRef = roomRef.collection("ticketRequests").doc(); // Auto-generate ID
        await ticketRequestRef.set({
            userId: userId,
            playerName: playerName,
            roomId: roomId,
            status: "pending",
            requestTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            currentTickets: playerInfo ? (playerInfo.ticketCount || 0) : 0
        });
        
        // Ensure player is in currentActivePlayers map
        const playerUpdate = {};
        playerUpdate[`currentActivePlayers.${userId}.playerName`] = playerName;
        playerUpdate[`currentActivePlayers.${userId}.lastSeen`] = admin.firestore.FieldValue.serverTimestamp();
        if (!playerInfo || typeof playerInfo.ticketCount === 'undefined') {
            playerUpdate[`currentActivePlayers.${userId}.ticketCount`] = 0;
        }
        await roomRef.update(playerUpdate);


        functions.logger.log("requestTicket: Request submitted.", {roomId, userId, requestId: ticketRequestRef.id});
        return { success: true, message: "Ticket request submitted for admin approval.", requestId: ticketRequestRef.id };
    } catch (error) {
        functions.logger.error("requestTicket: Error.", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", `Internal error in requestTicket: ${error.message}`);
    }
});

/**
 * Admin processes a ticket request (approve or reject).
 */
exports.processTicketRequest = functions.https.onCall(async (data, context) => {
    functions.logger.log("processTicketRequest: Function started.", {data, auth: !!context.auth});
    try {
        ensureAdmin(context);
        const { roomId, requestId, action, reason } = data;

        if (!roomId || !requestId || !action || (action !== "approve" && action !== "reject")) {
            throw new functions.https.HttpsError("invalid-argument", "Room ID, Request ID, and a valid Action ('approve'/'reject') are required.");
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
                // Store tickets in a dedicated root collection for easier user-specific queries
                const playerTicketDocRef = db.collection("gameTickets").doc(); // New document in root gameTickets collection

                const newTicket = {
                    userId: requestData.userId,
                    playerName: requestData.playerName,
                    roomId: roomId, // Keep roomId for context
                    numbers: ticketNumbers,
                    marked: [],
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                transaction.set(playerTicketDocRef, newTicket);
                transaction.update(ticketRequestRef, {
                    status: "approved",
                    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                    ticketId: playerTicketDocRef.id // Store the ID of the ticket in gameTickets
                });

                const playerUpdatePath = `currentActivePlayers.${requestData.userId}`;
                transaction.update(roomRef, {
                    [`${playerUpdatePath}.ticketCount`]: admin.firestore.FieldValue.increment(1),
                    [`${playerUpdatePath}.playerName`]: requestData.playerName // Ensure consistency
                });
                functions.logger.log("processTicketRequest: Ticket approved.", {roomId, requestId, ticketId: playerTicketDocRef.id});
                return { success: true, message: "Ticket approved and assigned.", ticketId: playerTicketDocRef.id };
            } else { // action === "reject"
                transaction.update(ticketRequestRef, {
                    status: "rejected",
                    rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
                    reason: reason || "Rejected by admin."
                });
                functions.logger.log("processTicketRequest: Ticket rejected.", {roomId, requestId, reason});
                return { success: true, message: "Ticket request rejected." };
            }
        });
    } catch (error) {
        functions.logger.error("processTicketRequest: Error.", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", `Internal error: ${error.message}`);
    }
});

/**
 * Player submits a prize claim. Server performs validation.
 */
exports.submitPrizeClaim = functions.https.onCall(async (data, context) => {
    functions.logger.log("submitPrizeClaim: Function started.", {data, auth: !!context.auth});
    if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
    }
    const { roomId, prizeRuleId, prizeName, ticketId, clientTempClaimId } = data;
    const userId = context.auth.uid;
    const playerName = data.playerName || context.auth.token.name || context.auth.token.email || "Unknown Player";


    if (context.auth.uid !== userId) { // Should not happen if client sends correct userId from auth
        throw new functions.https.HttpsError("permission-denied", "UID mismatch.");
    }
    if (!roomId || !prizeRuleId || !ticketId || !prizeName) {
        throw new functions.https.HttpsError("invalid-argument", "Missing claim information (roomId, prizeRuleId, prizeName, ticketId).");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const ticketRef = db.collection("gameTickets").doc(ticketId); // Tickets stored in root gameTickets

    try {
        const [roomDoc, ticketDoc] = await Promise.all([roomRef.get(), ticketRef.get()]);

        if (!roomDoc.exists) { throw new functions.https.HttpsError("not-found", `Room ${roomId} not found.`); }
        if (!ticketDoc.exists) { throw new functions.https.HttpsError("not-found", `Ticket ${ticketId} not found.`); }

        const roomData = roomDoc.data();
        const ticketData = ticketDoc.data();

        if (ticketData.userId !== userId) {
            throw new functions.https.HttpsError("permission-denied", "Ticket does not belong to the claiming user.");
        }
        if (roomData.gameStatus !== "running") {
            throw new functions.https.HttpsError("failed-precondition", `Game is not running (status: ${roomData.gameStatus}). Cannot submit claim.`);
        }

        const rule = roomData.rules?.find(r => r.id === prizeRuleId);
        if (!rule || !rule.isActive) {
            throw new functions.https.HttpsError("invalid-argument", `Prize rule '${prizeRuleId}' is invalid or not active.`);
        }
        if ((rule.claims || 0) >= rule.maxPrizes) {
             throw new functions.https.HttpsError("failed-precondition", `Maximum claims for '${rule.name}' already reached.`);
        }

        // --- Server-Side Validation Logic ---
        const calledNumbers = roomData.currentNumbersCalled || [];
        const ticketNumbersFlat = ticketData.numbers.flat().filter(n => n !== null);
        const playerMarkedNumbersOnTicket = ticketData.marked || []; // Numbers player has marked on their UI

        // These are the numbers that are: 1. On the ticket, 2. Marked by player, 3. Called in the game
        const effectivelyClaimedNumbers = playerMarkedNumbersOnTicket.filter(num =>
            ticketNumbersFlat.includes(num) && calledNumbers.includes(num)
        );
        functions.logger.log("submitPrizeClaim: Validation details", {prizeRuleId, ticketNumbersFlat, playerMarkedNumbersOnTicket, calledNumbers, effectivelyClaimedNumbers});

        // Placeholder for specific prize pattern validation logic
        // This function MUST be implemented thoroughly for each prize type.
        function checkPrizePattern(ruleId, claimedNums, ticketLayout, allCalledNums) {
            functions.logger.log(`checkPrizePattern for ${ruleId}`, {claimedNumsCount: claimedNums.length, ticketLayout, allCalledNumsCount: allCalledNums.length});
            // TODO: Implement actual logic for each prize rule
            // Example for Early Five:
            if (ruleId === "rule_early5") {
                return claimedNums.length >= 5; // Basic check, assumes claimedNums are all valid and called
            }
            // Example for a Line (assuming ticketLayout is 3x9 and rows are identifiable)
            // This would require knowing which numbers form which line on the ticket.
            // For instance, if ruleId is "rule_topline", check if all 5 numbers from ticketLayout[0]
            // that are not null, are present in claimedNums.
            if (ruleId === "rule_topline") {
                const topLineNumbers = ticketLayout[0].filter(n => n !== null);
                return topLineNumbers.length === 5 && topLineNumbers.every(n => claimedNums.includes(n));
            }
            if (ruleId === "rule_middleline") {
                const middleLineNumbers = ticketLayout[1].filter(n => n !== null);
                return middleLineNumbers.length === 5 && middleLineNumbers.every(n => claimedNums.includes(n));
            }
             if (ruleId === "rule_bottomline") {
                const bottomLineNumbers = ticketLayout[2].filter(n => n !== null);
                return bottomLineNumbers.length === 5 && bottomLineNumbers.every(n => claimedNums.includes(n));
            }
            if (ruleId === "rule_fullhouse") {
                // All 15 numbers on the ticket must be in claimedNums
                return ticketNumbersFlat.length === 15 && ticketNumbersFlat.every(n => claimedNums.includes(n));
            }
            // Add other rule checks (Corners, etc.)
            functions.logger.warn(`checkPrizePattern: No specific validation logic for ruleId: ${ruleId}. Defaulting to false.`);
            return false; // Default to false if no specific pattern matches
        }

        const serverValidationResult = checkPrizePattern(prizeRuleId, effectivelyClaimedNumbers, ticketData.numbers, calledNumbers);
        // --- End of Server-Side Validation ---

        const claimRef = db.collection("prizeClaimsAudit").doc();
        const claimDoc = {
            userId, playerName, roomId, ticketId, prizeRuleId, prizeName,
            clientTempClaimId: clientTempClaimId || null,
            claimedNumbersOnTicket: playerMarkedNumbersOnTicket, // What player sent as marked
            effectivelyClaimedNumbers: effectivelyClaimedNumbers, // Numbers verified by server as part of the claim basis
            status: serverValidationResult ? "pending_admin_approval" : "rejected_auto_invalid",
            reason: serverValidationResult ? "Awaiting admin review." : "Automatic validation of prize pattern failed.",
            serverValidationResult,
            claimTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        };

        await claimRef.set(claimDoc);
        functions.logger.log("submitPrizeClaim: Claim processed.", {claimId: claimRef.id, status: claimDoc.status});

        return {
            success: true, claimId: claimRef.id, status: claimDoc.status,
            message: serverValidationResult ? "Claim submitted for admin review." : "Claim failed automatic validation."
        };
    } catch (error) {
        functions.logger.error("submitPrizeClaim: Error.", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", `Internal error in submitPrizeClaim: ${error.message}`);
    }
});

/**
 * Admin processes a prize claim (approve or reject).
 */
exports.processPrizeClaim = functions.https.onCall(async (data, context) => {
    functions.logger.log("processPrizeClaim: Function started.", {data, auth: !!context.auth});
    try {
        ensureAdmin(context);
        const { claimId, roomId, action, reason } = data;

        if (!claimId || !roomId || !action || (action !== "approve" && action !== "reject")) {
            throw new functions.https.HttpsError("invalid-argument", "Claim ID, Room ID, and valid Action are required.");
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
            // Allow processing only if pending admin approval or if admin wants to override a previous auto-rejection
            if (claimData.status !== "pending_admin_approval" && claimData.status !== "rejected_auto_invalid") {
                throw new functions.https.HttpsError("failed-precondition", `Claim status is '${claimData.status}', cannot process manually.`);
            }

            const rule = roomData.rules?.find(r => r.id === claimData.prizeRuleId);
            if (!rule) {
                transaction.update(claimRef, { status: "rejected_admin", reason: "Prize rule configuration missing at review time.", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: context.auth.uid });
                throw new functions.https.HttpsError("invalid-argument", "Prize rule not found in room config.");
            }

            if (action === "approve") {
                // Double check max claims for this rule
                if ((rule.claims || 0) >= rule.maxPrizes) {
                    const message = `Max claims (${rule.maxPrizes}) for prize '${rule.name}' already awarded. Cannot approve more.`;
                    transaction.update(claimRef, { status: "rejected_admin", reason: message, reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: context.auth.uid });
                    throw new functions.https.HttpsError("failed-precondition", message);
                }

                const coinsAwarded = parseFloat(rule.coinsPerPrize) || 0;
                transaction.update(claimRef, {
                    status: "approved",
                    reason: reason || "Approved by admin.",
                    coinsAwarded: coinsAwarded,
                    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                    reviewedBy: context.auth.uid,
                });

                const winnerEntry = {
                    claimId: claimId, userId: claimData.userId, playerName: claimData.playerName,
                    ticketId: claimData.ticketId, prizeName: rule.name, prizeRuleId: claimData.prizeRuleId,
                    coinsAwarded: coinsAwarded, timestamp: admin.firestore.FieldValue.serverTimestamp(),
                };
                transaction.update(roomRef, { currentWinners: admin.firestore.FieldValue.arrayUnion(winnerEntry) });

                const updatedRules = roomData.rules.map(r => {
                    if (r.id === claimData.prizeRuleId) {
                        return { ...r, claims: (r.claims || 0) + 1 };
                    }
                    return r;
                });
                transaction.update(roomRef, { rules: updatedRules });
                functions.logger.log("processPrizeClaim: Claim approved.", {roomId, claimId, coinsAwarded});
                return { success: true, message: `Claim for '${rule.name}' approved. ${coinsAwarded} coins awarded.` };
            } else { // action === "reject"
                transaction.update(claimRef, {
                    status: "rejected_admin",
                    reason: reason || "Rejected by admin.",
                    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                    reviewedBy: context.auth.uid,
                });
                functions.logger.log("processPrizeClaim: Claim rejected.", {roomId, claimId, reason});
                return { success: true, message: "Claim rejected." };
            }
        });
    } catch (error) {
        functions.logger.error("processPrizeClaim: Error.", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", `Internal error: ${error.message}`);
    }
});
