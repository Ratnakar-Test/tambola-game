const { HttpsError } = require("firebase-functions/v1/https");
const { generateTambolaTicket, parseGameRulesFromString, generateRoomId, generateUniqueId } = require("./utils"); // Assuming utils.js in lib

/**
 * Creates a new game room.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} admin - Firebase Admin SDK instance.
 */
exports.createGameRoomHandler = (db, admin) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to create a room.");
    }
    const adminUID = context.auth.uid;
    const { adminDisplayName } = data;

    if (!adminDisplayName || typeof adminDisplayName !== "string" || adminDisplayName.trim().length === 0) {
        throw new HttpsError("invalid-argument", "Admin display name is required.");
    }

    const newRoomId = generateRoomId(); // From your utils or a library

    const roomData = {
        roomId: newRoomId,
        adminUID: adminUID,
        adminDisplayName: adminDisplayName.trim(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        gameStatus: "idle", // "idle", "loading", "running", "paused", "stopped", "error"
        currentNumbersCalled: [],
        currentLatestCalledNumber: null,
        latestCalledPhrase: "",
        callingMode: "manual", // "manual" or "auto"
        autoCallInterval: 5, // Default seconds for auto-call
        rules: [], // { id, name, description, percentage, isActive, claims: [] }
        totalMoneyCollected: 0, // Will be updated based on ticket sales
        currentActivePlayers: {
            [adminUID]: { // Add admin as a player initially (optional)
                playerName: `${adminDisplayName.trim()} (Admin)`,
                ticketCount: 0,
                lastSeen: admin.firestore.FieldValue.serverTimestamp(),
                isAdmin: true,
            },
        },
        currentWinners: [],
        gameStartTime: null,
        gameEndTime: null,
        gameSummary: null,
    };

    try {
        await db.collection("rooms").doc(newRoomId).set(roomData);
        console.log(`Room ${newRoomId} created by admin ${adminUID} (${adminDisplayName})`);
        return { roomId: newRoomId, message: `Room ${newRoomId} created successfully.` };
    } catch (error) {
        console.error("Error creating room:", error);
        throw new HttpsError("internal", "Could not create room.", error.message);
    }
};


/**
 * Allows a player to join an existing game room.
 * Updates their presence in the room.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 */
exports.joinGameRoomHandler = (db) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to join a room.");
    }
    const playerUID = context.auth.uid;
    const { roomId, playerName } = data;

    if (!roomId || typeof roomId !== "string") {
        throw new HttpsError("invalid-argument", "Room ID is required.");
    }
    if (!playerName || typeof playerName !== "string" || playerName.trim().length === 0) {
        throw new HttpsError("invalid-argument", "Player name is required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);

    try {
        const roomDoc = await roomRef.get();
        if (!roomDoc.exists) {
            throw new HttpsError("not-found", `Room ${roomId} not found.`);
        }

        // Add/Update player in currentActivePlayers map
        const playerData = {
            playerName: playerName.trim(),
            ticketCount: 0, // Will be updated when tickets are assigned
            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
            isAdmin: roomDoc.data().adminUID === playerUID, // Check if joining player is admin
        };

        await roomRef.update({
            [`currentActivePlayers.${playerUID}`]: playerData,
        });

        console.log(`Player ${playerUID} (${playerName}) joined room ${roomId}`);
        return { success: true, message: `Successfully joined room ${roomId}.`, roomData: roomDoc.data() };
    } catch (error) {
        console.error(`Error joining room ${roomId} for player ${playerUID}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not join room.", error.message);
    }
};

/**
 * Sets or updates game rules and prize allocations for a room.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 */
exports.setGameRulesHandler = (db) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    const adminUID = context.auth.uid;
    const { roomId, rulesString } = data; // rulesString like "Early Five:10,Line1:15,FullHouse:50"

    if (!roomId) throw new HttpsError("invalid-argument", "Room ID is required.");
    if (!rulesString) throw new HttpsError("invalid-argument", "Rules string is required.");

    const roomRef = db.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
    if (roomDoc.data().adminUID !== adminUID) {
        throw new HttpsError("permission-denied", "Only the room admin can set rules.");
    }
    if (roomDoc.data().gameStatus !== "idle" && roomDoc.data().gameStatus !== "stopped") {
        throw new HttpsError("failed-precondition", "Rules can only be set when the game is idle or stopped.");
    }

    const parsedRules = parseGameRulesFromString(rulesString); // Use your util function
    if (!parsedRules) {
        throw new HttpsError("invalid-argument", "Invalid rules format. Expected 'Name:Percentage,...'. Percentages must be >0 and <=100.");
    }
    const totalPercentage = parsedRules.reduce((sum, rule) => sum + rule.percentage, 0);
    if (totalPercentage > 100) {
        throw new HttpsError("invalid-argument", `Total prize percentage (${totalPercentage}%) cannot exceed 100%.`);
    }

    try {
        await roomRef.update({ rules: parsedRules });
        console.log(`Rules updated for room ${roomId} by admin ${adminUID}`);
        return { success: true, message: "Game rules updated successfully.", rules: parsedRules };
    } catch (error) {
        console.error("Error setting game rules:", error);
        throw new HttpsError("internal", "Could not update game rules.", error.message);
    }
};

/**
 * Starts a game in a room.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} admin - Firebase Admin SDK instance.
 */
exports.startGameHandler = (db, admin) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    const adminUID = context.auth.uid;
    const { roomId } = data;

    if (!roomId) throw new HttpsError("invalid-argument", "Room ID is required.");

    const roomRef = db.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
    const roomData = roomDoc.data();
    if (roomData.adminUID !== adminUID) {
        throw new HttpsError("permission-denied", "Only the room admin can start the game.");
    }
    if (roomData.gameStatus !== "idle" && roomData.gameStatus !== "stopped") {
        throw new HttpsError("failed-precondition", `Game cannot be started. Current status: ${roomData.gameStatus}.`);
    }
    if (!roomData.rules || roomData.rules.length === 0) {
        throw new HttpsError("failed-precondition", "Cannot start game. Please set game rules first.");
    }
    // Check if there are active players with tickets (optional, admin might start for testing)
    // const activePlayersWithTickets = Object.values(roomData.currentActivePlayers || {}).filter(p => p.ticketCount > 0).length;
    // if (activePlayersWithTickets === 0) {
    //     throw new HttpsError("failed-precondition", "Cannot start game. No players have tickets yet.");
    // }

    try {
        await roomRef.update({
            gameStatus: "running",
            gameStartTime: admin.firestore.FieldValue.serverTimestamp(),
            gameEndTime: null,
            currentNumbersCalled: [], // Reset numbers
            currentLatestCalledNumber: null,
            latestCalledPhrase: "",
            currentWinners: [], // Reset winners
            gameSummary: null, // Clear previous summary
            // Reset claims in rules
            rules: roomData.rules.map(rule => ({ ...rule, claims: [] })),
        });
        console.log(`Game started in room ${roomId} by admin ${adminUID}`);
        return { success: true, message: "Game started successfully." };
    } catch (error) {
        console.error("Error starting game:", error);
        throw new HttpsError("internal", "Could not start game.", error.message);
    }
};

/**
 * Stops a game in a room and generates a summary.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} admin - Firebase Admin SDK instance.
 */
exports.stopGameHandler = (db, admin) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    const adminUID = context.auth.uid;
    const { roomId } = data;

    if (!roomId) throw new HttpsError("invalid-argument", "Room ID is required.");

    const roomRef = db.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
    const roomData = roomDoc.data();
    if (roomData.adminUID !== adminUID) {
        throw new HttpsError("permission-denied", "Only the room admin can stop the game.");
    }
    if (roomData.gameStatus === "idle" || roomData.gameStatus === "stopped") {
        throw new HttpsError("failed-precondition", `Game is already ${roomData.gameStatus}.`);
    }

    try {
        // Construct game summary
        const gameSummary = {
            totalNumbersCalled: roomData.currentNumbersCalled.length,
            winnersSnapshot: [...roomData.currentWinners], // Copy current winners
            playersSnapshot: { ...roomData.currentActivePlayers }, // Snapshot of players at game end
            rulesSnapshot: [...roomData.rules], // Snapshot of rules and their claims
            totalMoneyCollected: roomData.totalMoneyCollected,
            gameStartTime: roomData.gameStartTime,
            gameEndTime: admin.firestore.FieldValue.serverTimestamp(),
        };

        await roomRef.update({
            gameStatus: "stopped",
            gameEndTime: gameSummary.gameEndTime,
            gameSummary: gameSummary,
            callingMode: "manual", // Reset calling mode
        });
        console.log(`Game stopped in room ${roomId} by admin ${adminUID}. Summary generated.`);
        return { success: true, message: "Game stopped. Summary generated.", gameSummary };
    } catch (error) {
        console.error("Error stopping game:", error);
        throw new HttpsError("internal", "Could not stop game.", error.message);
    }
};

/**
 * Sets the number calling mode (manual/auto) and interval for a room.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 */
exports.setCallingModeHandler = (db) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    const adminUID = context.auth.uid;
    const { roomId, mode, interval } = data; // mode: "manual" or "auto", interval: seconds

    if (!roomId) throw new HttpsError("invalid-argument", "Room ID is required.");
    if (!["manual", "auto"].includes(mode)) {
        throw new HttpsError("invalid-argument", "Invalid calling mode. Must be 'manual' or 'auto'.");
    }
    if (mode === "auto" && (typeof interval !== "number" || interval < 3 || interval > 60)) { // Min 3s, max 60s for auto call
        throw new HttpsError("invalid-argument", "Auto-call interval must be a number between 3 and 60 seconds.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
    if (roomDoc.data().adminUID !== adminUID) {
        throw new HttpsError("permission-denied", "Only the room admin can set the calling mode.");
    }

    try {
        const updateData = { callingMode: mode };
        if (mode === "auto") {
            updateData.autoCallInterval = interval;
        }
        await roomRef.update(updateData);
        console.log(`Calling mode for room ${roomId} set to ${mode} (Interval: ${interval || 'N/A'}s) by admin ${adminUID}`);
        return { success: true, message: `Calling mode set to ${mode}.` };
    } catch (error) {
        console.error("Error setting calling mode:", error);
        throw new HttpsError("internal", "Could not set calling mode.", error.message);
    }
};

/**
 * Toggles game state between "running" and "paused".
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 */
exports.togglePauseResumeGameHandler = (db) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    const adminUID = context.auth.uid;
    const { roomId, targetStatus } = data; // targetStatus: "paused" or "running"

    if (!roomId) throw new HttpsError("invalid-argument", "Room ID is required.");
    if (!["paused", "running"].includes(targetStatus)) {
        throw new HttpsError("invalid-argument", "Invalid target status.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
    const roomData = roomDoc.data();
    if (roomData.adminUID !== adminUID) {
        throw new HttpsError("permission-denied", "Only the room admin can pause/resume the game.");
    }

    if (targetStatus === "paused" && roomData.gameStatus !== "running") {
        throw new HttpsError("failed-precondition", "Game must be 'running' to be paused.");
    }
    if (targetStatus === "running" && roomData.gameStatus !== "paused") {
        throw new HttpsError("failed-precondition", "Game must be 'paused' to be resumed.");
    }

    try {
        await roomRef.update({ gameStatus: targetStatus });
        console.log(`Game in room ${roomId} status changed to ${targetStatus} by admin ${adminUID}`);
        return { success: true, message: `Game ${targetStatus}.` };
    } catch (error) {
        console.error(`Error changing game status to ${targetStatus}:`, error);
        throw new HttpsError("internal", `Could not change game status.`, error.message);
    }
};

/**
 * Updates a player's last seen timestamp. Can be called periodically by the client.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} admin - Firebase Admin SDK instance.
 */
exports.updatePlayerPresenceHandler = (db, admin) => async (data, context) => {
    if (!context.auth) {
        // This can be a soft failure if just for presence, or an error if critical.
        console.warn("Unauthenticated user tried to update presence.");
        return { success: false, message: "Authentication required." };
    }
    const playerUID = context.auth.uid;
    const { roomId } = data;

    if (!roomId) {
        console.warn("Room ID missing for presence update.");
        return { success: false, message: "Room ID required." };
    }

    const roomRef = db.collection("rooms").doc(roomId);
    try {
        const playerPath = `currentActivePlayers.${playerUID}.lastSeen`;
        await roomRef.update({
            [playerPath]: admin.firestore.FieldValue.serverTimestamp(),
        });
        // console.log(`Player ${playerUID} presence updated in room ${roomId}.`); // Too verbose for frequent calls
        return { success: true };
    } catch (error) {
        // Log but don't throw HttpsError to avoid breaking client if room/player path doesn't exist yet
        console.warn(`Could not update presence for player ${playerUID} in room ${roomId}:`, error.message);
        return { success: false, message: "Could not update presence." };
    }
};
