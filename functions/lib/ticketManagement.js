const { HttpsError } = require("firebase-functions/v1/https");
const { generateTambolaTicket, generateUniqueId } = require("./utils"); // From ./utils.js in lib

const MAX_TICKETS_PER_PLAYER = 6; // Configurable: Maximum tickets a player can have per room

/**
 * Handles a player's request for a game ticket.
 * Creates a request document in the 'ticketRequests' subcollection.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} admin - Firebase Admin SDK instance.
 */
exports.requestGameTicketHandler = (db, admin) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to request a ticket.");
    }
    const playerUID = context.auth.uid;
    const { roomId, playerName } = data;

    if (!roomId || !playerName) {
        throw new HttpsError("invalid-argument", "Room ID and Player Name are required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const playerRoomDataPath = `currentActivePlayers.${playerUID}`;

    try {
        const roomDoc = await roomRef.get();
        if (!roomDoc.exists) {
            throw new HttpsError("not-found", `Room ${roomId} not found.`);
        }
        const roomData = roomDoc.data();

        if (roomData.gameStatus === "running" || roomData.gameStatus === "paused") {
            throw new HttpsError("failed-precondition", "Cannot request tickets once the game has started or is paused.");
        }
        if (roomData.gameStatus === "stopped") {
            throw new HttpsError("failed-precondition", "Cannot request tickets, game has ended.");
        }

        const playerNode = roomData.currentActivePlayers ? roomData.currentActivePlayers[playerUID] : null;
        if (!playerNode) {
            throw new HttpsError("not-found", "Player not found in the room's active player list. Join room first.");
        }

        // Check existing ticket count for the player in this room
        const ticketsSnapshot = await db.collection("gameTickets")
            .where("roomId", "==", roomId)
            .where("userId", "==", playerUID)
            .get();

        if (ticketsSnapshot.size >= MAX_TICKETS_PER_PLAYER) {
            throw new HttpsError("resource-exhausted", `You have reached the maximum limit of ${MAX_TICKETS_PER_PLAYER} tickets for this room.`);
        }

        // Check for existing pending requests from this player in this room
        const pendingRequestsSnapshot = await roomRef.collection("ticketRequests")
            .where("userId", "==", playerUID)
            .where("status", "==", "pending")
            .limit(1)
            .get();

        if (!pendingRequestsSnapshot.empty) {
            throw new HttpsError("failed-precondition", "You already have a pending ticket request. Please wait for admin approval.");
        }

        const requestId = `TICKETREQ_${generateUniqueId()}`;
        const requestData = {
            userId: playerUID,
            playerName: playerName.trim() || playerNode.playerName || "Unknown Player",
            roomId: roomId,
            status: "pending", // "pending", "approved", "rejected"
            requestTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            currentTickets: ticketsSnapshot.size, // Player's ticket count at time of request
        };

        await roomRef.collection("ticketRequests").doc(requestId).set(requestData);

        console.log(`Ticket request ${requestId} created for player ${playerUID} in room ${roomId}`);
        return { success: true, message: "Ticket request submitted successfully. Waiting for admin approval.", requestId };
    } catch (error) {
        console.error("Error requesting game ticket:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not request ticket.", error.message);
    }
};


/**
 * Approves a ticket request, generates a ticket, and assigns it to the player.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} adminInstance - Firebase Admin SDK instance.
 */
exports.approveTicketRequestHandler = (db, adminInstance) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated (admin).");
    }
    const adminUID = context.auth.uid;
    const { roomId, requestId, userId, playerName: requestPlayerName } = data; // userId is the player's UID

    if (!roomId || !requestId || !userId) {
        throw new HttpsError("invalid-argument", "Room ID, Request ID, and User ID are required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const requestRef = roomRef.collection("ticketRequests").doc(requestId);

    return db.runTransaction(async (transaction) => {
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
        const roomData = roomDoc.data();

        if (roomData.adminUID !== adminUID) {
            throw new HttpsError("permission-denied", "Only the room admin can approve ticket requests.");
        }

        const requestDoc = await transaction.get(requestRef);
        if (!requestDoc.exists) throw new HttpsError("not-found", `Ticket request ${requestId} not found.`);
        const requestData = requestDoc.data();

        if (requestData.status !== "pending") {
            throw new HttpsError("failed-precondition", `Ticket request is already ${requestData.status}.`);
        }
        if (requestData.userId !== userId) { // Sanity check
            throw new HttpsError("invalid-argument", "Request User ID mismatch.");
        }

        // Check player's current ticket count again before approving
        const ticketsSnapshot = await db.collection("gameTickets")
            .where("roomId", "==", roomId)
            .where("userId", "==", userId)
            .get(); // Get within transaction if possible, or just before. Here, it's fine outside.

        if (ticketsSnapshot.size >= MAX_TICKETS_PER_PLAYER) {
            // Auto-reject if player reached max tickets (e.g. approved by another admin or client side error)
            transaction.update(requestRef, {
                status: "rejected",
                reason: `Player reached max tickets (${MAX_TICKETS_PER_PLAYER}) limit.`,
                reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
                reviewedBy: adminUID,
            });
            throw new HttpsError("resource-exhausted", `Player ${requestPlayerName || userId} has reached the maximum ticket limit.`);
        }

        let newTicketData;
        try {
            newTicketData = generateTambolaTicket(); // From your utils
        } catch (ticketGenError) {
            console.error("Failed to generate Tambola ticket:", ticketGenError);
            throw new HttpsError("internal", "Failed to generate game ticket. Please try again.");
        }

        const ticketId = `TICKET_${generateUniqueId()}`;
        const gameTicketRef = db.collection("gameTickets").doc(ticketId);

        transaction.set(gameTicketRef, {
            ticketId: ticketId,
            userId: userId,
            playerName: requestPlayerName || requestData.playerName || "Unknown Player",
            roomId: roomId,
            numbers: newTicketData, // The 3x9 array
            marked: [], // Initially empty, player marks numbers on client
            createdAt: adminInstance.firestore.FieldValue.serverTimestamp(),
            // prizeClaims: {} // Store claims on this ticket { prizeRuleId: timestamp }
        });

        transaction.update(requestRef, {
            status: "approved",
            approvedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
            ticketId: ticketId,
            reviewedBy: adminUID,
        });

        // Update player's ticket count in the room document
        const playerTicketCountPath = `currentActivePlayers.${userId}.ticketCount`;
        transaction.update(roomRef, {
            [playerTicketCountPath]: adminInstance.firestore.FieldValue.increment(1),
        });

        // Optional: Update totalMoneyCollected if tickets have a price
        // const ticketPrice = roomData.ticketPrice || 0; // Assuming ticketPrice is set in roomData
        // if (ticketPrice > 0) {
        //     transaction.update(roomRef, {
        //         totalMoneyCollected: adminInstance.firestore.FieldValue.increment(ticketPrice)
        //     });
        // }

        console.log(`Ticket request ${requestId} approved by admin ${adminUID}. Ticket ${ticketId} generated for player ${userId}.`);
        return { success: true, message: "Ticket request approved and ticket generated.", ticketId: ticketId };
    }).catch(error => {
        console.error("Error approving ticket request:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not approve ticket request.", error.message);
    });
};

/**
 * Rejects a ticket request.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} adminInstance - Firebase Admin SDK instance.
 */
exports.rejectTicketRequestHandler = (db, adminInstance) => async (data, context) => {
    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated (admin).");
    }
    const adminUID = context.auth.uid;
    const { roomId, requestId, reason } = data;

    if (!roomId || !requestId) {
        throw new HttpsError("invalid-argument", "Room ID and Request ID are required.");
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const requestRef = roomRef.collection("ticketRequests").doc(requestId);

    return db.runTransaction(async (transaction) => {
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists) throw new HttpsError("not-found", `Room ${roomId} not found.`);
        if (roomDoc.data().adminUID !== adminUID) {
            throw new HttpsError("permission-denied", "Only the room admin can reject ticket requests.");
        }

        const requestDoc = await transaction.get(requestRef);
        if (!requestDoc.exists) throw new HttpsError("not-found", `Ticket request ${requestId} not found.`);
        const requestData = requestDoc.data();

        if (requestData.status !== "pending") {
            throw new HttpsError("failed-precondition", `Ticket request is already ${requestData.status}.`);
        }

        transaction.update(requestRef, {
            status: "rejected",
            reason: reason || "Rejected by admin.",
            reviewedAt: adminInstance.firestore.FieldValue.serverTimestamp(),
            reviewedBy: adminUID,
        });

        console.log(`Ticket request ${requestId} rejected by admin ${adminUID}. Reason: ${reason || "N/A"}`);
        return { success: true, message: "Ticket request rejected." };
    }).catch(error => {
        console.error("Error rejecting ticket request:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not reject ticket request.", error.message);
    });
};
