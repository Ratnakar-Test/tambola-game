const { HttpsError } = require("firebase-functions/v1/https");
const admin = require("firebase-admin"); // Ensure admin is required if not passed directly

// Tambola number phrases (optional, for fun)
const numberPhrases = {
    1: "Kelly's Eye", 2: "One Little Duck", 3: "Cup of Tea", 4: "Knock at the Door", 5: "Man Alive",
    6: "Tom Mix", 7: "Lucky Seven", 8: "Garden Gate", 9: "Doctor's Orders", 10: "Prime Minister's Den",
    11: "Legs Eleven", 12: "One Dozen", 13: "Unlucky for Some", 14: "Valentine's Day", 15: "Young and Keen",
    16: "Sweet Sixteen", 17: "Dancing Queen", 18: "Coming of Age", 19: "Goodbye Teens", 20: "One Score",
    21: "Royal Salute", 22: "Two Little Ducks", 23: "The Lord is My Shepherd", 24: "Two Dozen", 25: "Duck and Dive",
    26: "Pick and Mix", 27: "Gateway to Heaven", 28: "In a State", 29: "Rise and Shine", 30: "Dirty Gertie",
    31: "Get Up and Run", 32: "Buckle My Shoe", 33: "All the Threes", 34: "Ask for More", 35: "Jump and Jive",
    36: "Three Dozen", 37: "More than Eleven", 38: "Christmas Cake", 39: "Steps", 40: "Naughty Forty",
    41: "Time for Fun", 42: "Winnie the Pooh", 43: "Down on Your Knees", 44: "Droopy Drawers", 45: "Halfway There",
    46: "Up to Tricks", 47: "Four and Seven", 48: "Four Dozen", 49: "PC (Police Constable)", 50: "Half a Century",
    51: "Tweak of the Thumb", 52: "Weeks in a Year", 53: "Stuck in the Tree", 54: "Clean the Floor", 55: "Snakes Alive",
    56: "Was she worth it?", 57: "Heinz Varieties", 58: "Make them Wait", 59: "Brighton Line", 60: "Five Dozen",
    61: "Bakers Bun", 62: "Turn on the Screw", 63: "Tickle Me", 64: "Red Raw", 65: "Old Age Pension",
    66: "Clickety Click", 67: "Made in Heaven", 68: "Saving Grace", 69: "Either Way Up", 70: "Three Score and Ten",
    71: "Bang on the Drum", 72: "Six Dozen", 73: "Queen B", 74: "Candy Store", 75: "Strive and Strive",
    76: "Trombones", 77: "Sunset Strip", 78: "Heaven's Gate", 79: "One More Time", 80: "Eight and Blank",
    81: "Stop and Run", 82: "Straight On Through", 83: "Time for Tea", 84: "Seven Dozen", 85: "Staying Alive",
    86: "Between the Sticks", 87: "Torquay in Devon", 88: "Two Fat Ladies", 89: "Nearly There", 90: "Top of the Shop"
};


/**
 * Calls the next Tambola number for a given room.
 * Can be triggered manually or by auto-call logic.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} adminInstance - Firebase Admin SDK instance.
 */
exports.callNextNumberHandler = (db, adminInstance) => async (data, context) => {
    // Admin SDK instance might be `admin` if globally initialized or `adminInstance` if passed.
    const currentAdmin = adminInstance || admin;

    if (!context.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    const adminUID = context.auth.uid; // Assuming admin calls this manually
    const { roomId, mode } = data; // mode: "manual" or "auto" (auto indicates it's an auto-call tick)

    if (!roomId) throw new HttpsError("invalid-argument", "Room ID is required.");

    const roomRef = db.collection("rooms").doc(roomId);

    return db.runTransaction(async (transaction) => {
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists) {
            throw new HttpsError("not-found", `Room ${roomId} not found.`);
        }
        const roomData = roomDoc.data();

        if (mode === "manual" && roomData.adminUID !== adminUID) {
            throw new HttpsError("permission-denied", "Only the room admin can call numbers manually.");
        }

        if (roomData.gameStatus !== "running") {
            // If game is paused and it's an auto-call, just ignore it silently or log.
            if (roomData.gameStatus === "paused" && mode === "auto") {
                console.log(`Auto-call skipped for room ${roomId} as game is paused.`);
                return { success: false, message: "Game paused, auto-call skipped." };
            }
            throw new HttpsError("failed-precondition", `Game is not running. Current status: ${roomData.gameStatus}.`);
        }

        let numbersCalled = roomData.currentNumbersCalled || [];
        if (numbersCalled.length >= 90) {
            // All numbers called, consider stopping the game or notifying.
            // For now, just return a message. Admin should stop the game.
            return { success: true, message: "All 90 numbers have been called." };
        }

        let availableNumbers = [];
        for (let i = 1; i <= 90; i++) {
            if (!numbersCalled.includes(i)) {
                availableNumbers.push(i);
            }
        }

        if (availableNumbers.length === 0) { // Should be caught by length >= 90 check
            return { success: true, message: "All numbers have been called." };
        }

        const randomIndex = Math.floor(Math.random() * availableNumbers.length);
        const nextNumber = availableNumbers[randomIndex];
        const nextNumberPhrase = numberPhrases[nextNumber] || "";

        numbersCalled.push(nextNumber);

        transaction.update(roomRef, {
            currentNumbersCalled: numbersCalled,
            currentLatestCalledNumber: nextNumber,
            latestCalledPhrase: nextNumberPhrase,
            lastNumberCallTime: currentAdmin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Number ${nextNumber} called for room ${roomId}. Total called: ${numbersCalled.length}`);
        return {
            success: true,
            calledNumber: nextNumber,
            phrase: nextNumberPhrase,
            totalCalled: numbersCalled.length,
        };
    }).catch(error => {
        console.error(`Error calling next number for room ${roomId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not call next number.", error.message);
    });
};

/**
 * Handles scheduled auto-calls for all active rooms in "auto" mode.
 * This would typically be triggered by a Cloud Scheduler job.
 * @param {FirebaseFirestore.Firestore} db - Firestore database instance.
 * @param {admin} adminInstance - Firebase Admin SDK instance.
 */
exports.scheduledAutoCallHandler = async (db, adminInstance) => {
    const currentAdmin = adminInstance || admin;
    const now = currentAdmin.firestore.Timestamp.now();

    const query = db.collection("rooms")
        .where("gameStatus", "==", "running")
        .where("callingMode", "==", "auto");

    const snapshot = await query.get();
    if (snapshot.empty) {
        console.log("No active rooms found for scheduled auto-call.");
        return { success: true, roomsProcessed: 0 };
    }

    let roomsProcessed = 0;
    const promises = [];

    snapshot.forEach(doc => {
        const roomData = doc.data();
        const roomId = doc.id;
        const intervalSeconds = roomData.autoCallInterval || 5; // Default to 5s
        const lastCallTime = roomData.lastNumberCallTime; // Firestore Timestamp

        let shouldCall = true;
        if (lastCallTime) {
            // Check if interval has passed since last call
            const secondsSinceLastCall = now.seconds - lastCallTime.seconds;
            if (secondsSinceLastCall < intervalSeconds) {
                shouldCall = false;
            }
        }
        // If lastCallTime is null (e.g., first auto-call after switching to auto mode), shouldCall remains true.

        if (shouldCall) {
            roomsProcessed++;
            // We are calling the callNextNumberHandler without auth context, which is fine if mode is 'auto'
            // The handler itself checks for 'auto' mode and doesn't require adminUID in that case.
            const callPromise = exports.callNextNumberHandler(db, currentAdmin)({ roomId: roomId, mode: "auto" }, {})
                .then(result => {
                    if (result.success && result.calledNumber) {
                        console.log(`Scheduled auto-call: Room ${roomId}, Called ${result.calledNumber}.`);
                    } else if (result.message === "All 90 numbers have been called.") {
                        console.log(`Scheduled auto-call: Room ${roomId}, All numbers called. Consider stopping auto-mode.`);
                        // Optionally switch to manual or notify admin
                        // return db.collection("rooms").doc(roomId).update({ callingMode: "manual", latestCalledPhrase: "All numbers called! Game ending." });
                    }
                })
                .catch(error => {
                    console.error(`Error during scheduled auto-call for room ${roomId}:`, error.message);
                });
            promises.push(callPromise);
        }
    });

    await Promise.all(promises);
    console.log(`Scheduled auto-call finished. Processed ${roomsProcessed} potential calls out of ${snapshot.size} rooms.`);
    return { success: true, roomsProcessed: roomsProcessed, activeRoomsInAuto: snapshot.size };
};
