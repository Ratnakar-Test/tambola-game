// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require("firebase-functions");
const { logger } = functions;

// The Firebase Admin SDK to access Firebase services from the backend.
const admin = require("firebase-admin");
if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

// --- CORS Middleware Configuration ---
// Configure CORS options.
// For production, it's best to be specific about the origin.
// Note: This is primarily for HTTP onRequest functions. Callable functions handle CORS differently.
const cors = require("cors");
const corsMiddleware = cors({
  origin: "https://tambolapremium.netlify.app", // Your specific Netlify frontend URL
  methods: ["POST", "GET", "OPTIONS"], // Specify methods
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true, // If you need to handle cookies or authorization headers
  maxAge: 3600, // Optional: Cache preflight response for 1 hour
});


// --- Helper Functions ---
/**
 * Generates a unique Room ID.
 */
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Generates a valid Tambola ticket (3x9 grid, 15 numbers).
 * Standard rules: 3 rows, 9 columns. Each row has 5 numbers.
 * Column 1: 1-9, Col 2: 10-19, ..., Col 9: 80-90.
 * Each column must have at least one number.
 * Numbers in each column are sorted.
 */
function generateTambolaTicket() {
  const ticket = Array(3).fill(null).map(() => Array(9).fill(null));
  const colCounters = Array(9).fill(0); // Count of numbers in each column
  const rowCounters = Array(3).fill(0); // Count of numbers in each row

  // Populate columns with one number each first, respecting column limits
  for (let j = 0; j < 9; j++) {
    const min = j * 10 + (j === 0 ? 1 : 0); // Col 0: 1-9, Col 1: 10-19 ... Col 8: 80-89, Col 9: (not 9) -> Col 8: 80-90
    const max = j * 10 + 9 + (j === 8 ? 1 : 0); // for col 8, numbers 80-90

    let attempts = 0;
    let placed = false;
    while (!placed && attempts < 20) {
      const num = Math.floor(Math.random() * (max - min + 1)) + min;
      const r = Math.floor(Math.random() * 3); // Try a random row

      let unique = true;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 9; col++) {
          if (ticket[row][col] === num) {
            unique = false;
            break;
          }
        }
        if (!unique) break;
      }

      if (unique && rowCounters[r] < 5 && colCounters[j] < 3) { // Max 3 numbers per column
        ticket[r][j] = num;
        colCounters[j]++;
        rowCounters[r]++;
        placed = true;
      }
      attempts++;
    }
    if (!placed) {
      logger.warn(`Ticket Gen: Could not place initial number in column ${j} satisfying all constraints.`);
    }
  }

  // Fill remaining spots to ensure 5 numbers per row and 15 total
  let totalNumbers = rowCounters.reduce((a, b) => a + b, 0);
  const numbersOnTicket = new Set();
  ticket.forEach((row) => row.forEach((num) => {
    if (num !== null) numbersOnTicket.add(num);
  }));


  for (let r = 0; r < 3; r++) {
    while (rowCounters[r] < 5 && totalNumbers < 15) {
      const availableCols = [];
      for (let j = 0; j < 9; j++) {
        if (ticket[r][j] === null && colCounters[j] < 3) { // Max 3 numbers per column
          availableCols.push(j);
        }
      }
      if (availableCols.length === 0) break; // No valid column to place number in this row

      const j = availableCols[Math.floor(Math.random() * availableCols.length)];
      const min = j * 10 + (j === 0 ? 1 : 0);
      const max = j * 10 + 9 + (j === 8 ? 1 : 0);

      let attempts = 0;
      let placed = false;
      while (!placed && attempts < 50) { // Increased attempts for filling
        const num = Math.floor(Math.random() * (max - min + 1)) + min;
        if (!numbersOnTicket.has(num)) {
          ticket[r][j] = num;
          numbersOnTicket.add(num);
          colCounters[j]++;
          rowCounters[r]++;
          totalNumbers++;
          placed = true;
        }
        attempts++;
      }
      if (!placed) break; // Could not find a unique number for this slot
    }
  }

  // Final pass if still not 15 numbers (rare, but possible with strict constraints)
  // This part might need to be smarter, e.g. by relaxing colCounters slightly if desperate
  let allColsHaveAtLeastOne = colCounters.every((count) => count > 0);
  if (totalNumbers < 15 || !allColsHaveAtLeastOne) {
    logger.warn(`Ticket Gen: Initial generation resulted in ${totalNumbers} numbers. All cols have num: ${allColsHaveAtLeastOne}. Forcing...`);
    // This part could be very complex to "force" a valid ticket.
    // For now, we'll log and rely on the main loops being robust enough for most cases.
    // A truly production ready generator might require backtracking or a different algorithm.
    // If issues persist, the generator logic here might need significant rework.
  }

  // Sort numbers within each column
  for (let j = 0; j < 9; j++) {
    const colNums = [];
    for (let i = 0; i < 3; i++) {
      if (ticket[i][j] !== null) {
        colNums.push(ticket[i][j]);
      }
    }
    colNums.sort((a, b) => a - b);
    let currentColNumIndex = 0;
    for (let i = 0; i < 3; i++) {
      if (ticket[i][j] !== null) {
        ticket[i][j] = colNums[currentColNumIndex++];
      }
    }
  }

  // Validate final ticket (optional here, but good for debugging)
  let finalNumberCount = 0;
  ticket.forEach((row) => row.forEach((num) => {
    if (num !== null) finalNumberCount++;
  }));
  if (finalNumberCount !== 15) {
    logger.error("Ticket Generation CRITICAL FAILURE: Final ticket does not have 15 numbers. Has:", finalNumberCount, JSON.stringify(ticket));
  }
  for (let i = 0; i < 3; i++) {
    if (ticket[i].filter((n) => n !== null).length !== 5 && finalNumberCount === 15) {
      logger.warn(`Ticket Gen Warning: Row ${i} does not have 5 numbers, though total is 15. Row:`, ticket[i]);
    }
  }

  logger.info("Generated Ticket:", JSON.stringify(ticket));
  return ticket;
}


function validatePrizePattern(ticketNumbers, claimedNumbersOnTicket, gameCalledNumbers, rule) {
  logger.info("Validating prize:", rule.name, "Player Claimed Nums:", claimedNumbersOnTicket, "Game Called Nums:", gameCalledNumbers.length);

  const allClaimedAreCalled = claimedNumbersOnTicket.every((num) => gameCalledNumbers.includes(num));
  if (!allClaimedAreCalled) {
    logger.warn("Validation failed: Not all numbers claimed by player were actually called in the game.");
    return { valid: false, reason: "Not all claimed numbers were called." };
  }

  const ticketFlatNumbers = ticketNumbers.flat().filter((n) => n !== null);
  const allClaimedAreOnTicket = claimedNumbersOnTicket.every((num) => ticketFlatNumbers.includes(num));
  if (!allClaimedAreOnTicket) {
    logger.warn("Validation failed: Not all numbers claimed by player exist on their ticket.");
    return { valid: false, reason: "Not all claimed numbers exist on the ticket." };
  }

  const ruleId = rule.id ? rule.id.toLowerCase() : rule.name.toLowerCase().replace(/\s+/g, "");

  const effectivelyClaimedNumbers = claimedNumbersOnTicket.filter((num) => gameCalledNumbers.includes(num));

  switch (ruleId) {
    case "earlyfive":
    case "early_five":
      if (effectivelyClaimedNumbers.length < 5) {
        logger.warn("Early Five validation failed: Less than 5 valid numbers claimed.");
        return { valid: false, reason: "Less than 5 valid numbers claimed for Early Five." };
      }
      logger.info("Early Five validation: Passed.");
      return { valid: true, effectivelyClaimedNumbers };

    case "line1":
    case "firstline":
    case "topline": {
      const line1Numbers = ticketNumbers[0].filter((n) => n !== null);
      const line1Claimed = line1Numbers.every((num) => effectivelyClaimedNumbers.includes(num)) && effectivelyClaimedNumbers.length >= line1Numbers.length;
      if (!line1Claimed) logger.warn("Line 1 validation failed.");
      else logger.info("Line 1 validation: Passed.");
      return { valid: line1Claimed, reason: line1Claimed ? "" : "Line 1 pattern not met.", effectivelyClaimedNumbers: line1Claimed ? line1Numbers : [] };
    }
    case "line2":
    case "secondline":
    case "middleline": {
      const line2Numbers = ticketNumbers[1].filter((n) => n !== null);
      const line2Claimed = line2Numbers.every((num) => effectivelyClaimedNumbers.includes(num)) && effectivelyClaimedNumbers.length >= line2Numbers.length;
      if (!line2Claimed) logger.warn("Line 2 validation failed.");
      else logger.info("Line 2 validation: Passed.");
      return { valid: line2Claimed, reason: line2Claimed ? "" : "Line 2 pattern not met.", effectivelyClaimedNumbers: line2Claimed ? line2Numbers : [] };
    }
    case "line3":
    case "thirdline":
    case "bottomline": {
      const line3Numbers = ticketNumbers[2].filter((n) => n !== null);
      const line3Claimed = line3Numbers.every((num) => effectivelyClaimedNumbers.includes(num)) && effectivelyClaimedNumbers.length >= line3Numbers.length;
      if (!line3Claimed) logger.warn("Line 3 validation failed.");
      else logger.info("Line 3 validation: Passed.");
      return { valid: line3Claimed, reason: line3Claimed ? "" : "Line 3 pattern not met.", effectivelyClaimedNumbers: line3Claimed ? line3Numbers : [] };
    }
    case "corners":
    case "fourcorners": {
      const corners = [];
      // Top-left
      for (let j = 0; j < 9; j++) if (ticketNumbers[0][j] !== null) {
        corners.push(ticketNumbers[0][j]); break;
      }
      // Top-right
      for (let j = 8; j >= 0; j--) if (ticketNumbers[0][j] !== null && !corners.includes(ticketNumbers[0][j])) {
        corners.push(ticketNumbers[0][j]); break;
      }
      // Bottom-left
      for (let j = 0; j < 9; j++) if (ticketNumbers[2][j] !== null && !corners.includes(ticketNumbers[2][j])) {
        corners.push(ticketNumbers[2][j]); break;
      }
      // Bottom-right
      for (let j = 8; j >= 0; j--) if (ticketNumbers[2][j] !== null && !corners.includes(ticketNumbers[2][j])) {
        corners.push(ticketNumbers[2][j]); break;
      }

      const uniqueCorners = [...new Set(corners)].filter((c) => c !== undefined && c !== null);
      if (uniqueCorners.length < 4 && ticketFlatNumbers.length >= 4) {
        logger.warn(`Corners validation warning: Could not identify 4 unique corner numbers on the ticket. Found: ${uniqueCorners.length}`);
      }
      const cornersClaimed = uniqueCorners.length >= 4 && uniqueCorners.every((num) => effectivelyClaimedNumbers.includes(num)) && effectivelyClaimedNumbers.length >= uniqueCorners.length;
      if (!cornersClaimed) logger.warn("Corners validation failed.");
      else logger.info("Corners validation: Passed.");
      return { valid: cornersClaimed, reason: cornersClaimed ? "" : "Four Corners pattern not met.", effectivelyClaimedNumbers: cornersClaimed ? uniqueCorners : [] };
    }
    case "fullhouse": {
      const fullHouseClaimed = ticketFlatNumbers.every((num) => effectivelyClaimedNumbers.includes(num)) &&
                               effectivelyClaimedNumbers.length >= ticketFlatNumbers.length;
      if (!fullHouseClaimed) logger.warn("Full House validation failed.");
      else logger.info("Full House validation: Passed.");
      return { valid: fullHouseClaimed, reason: fullHouseClaimed ? "" : "Full House pattern not met.", effectivelyClaimedNumbers: fullHouseClaimed ? ticketFlatNumbers : [] };
    }
    default:
      logger.warn(`Unknown prize rule ID for validation: '${ruleId}'. Claim rejected.`);
      return { valid: false, reason: `Unknown prize rule: ${rule.name}` };
  }
}

function ensureAuthenticated(context) {
  if (!context.auth) {
    logger.error("Authentication check failed: User not authenticated.");
    throw new functions.https.HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
}

// --- Admin Functions ---

exports.createGameRoom = functions.https.onRequest((req, res) => {
  corsMiddleware(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send({ error: { message: "Method Not Allowed" } });
    }

    let adminUID;
    const authorization = req.headers.authorization;

    if (authorization && authorization.startsWith("Bearer ")) {
      const idToken = authorization.split("Bearer ")[1];
      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        adminUID = decodedToken.uid;
        logger.info(`User ${adminUID} authenticated for createGameRoom.`);
      } catch (error) {
        logger.error("Error verifying Firebase ID token for createGameRoom:", error);
        return res.status(401).send({ error: { message: "Unauthorized. Invalid ID token." } });
      }
    } else {
      logger.warn("No Firebase ID token was passed for createGameRoom.");
      return res.status(401).send({ error: { message: "Unauthorized. No ID token provided." } });
    }

    const data = req.body.data || req.body; // Accommodate if data is nested or direct
    if (!data) {
      logger.error("Bad Request: No data found in request body for createGameRoom.", req.body);
      return res.status(400).send({ error: { message: "Bad Request: No data payload found." } });
    }

    const { adminDisplayName, rules, autoCallInterval, ticketPrice, maxTicketsPerPlayer } = data;

    if (!adminDisplayName || !rules || !Array.isArray(rules) || ticketPrice === undefined || Number(ticketPrice) < 0 || Number(maxTicketsPerPlayer) <= 0) {
      logger.error("Validation failed for createGameRoom data:", data);
      return res.status(400).send({ error: { message: "Admin display name, rules array, valid ticket price, and positive max tickets per player are required." } });
    }

    const roomId = generateRoomId();
    const roomRef = db.collection("rooms").doc(roomId);

    const initializedRules = rules.map((rule, index) => ({
      id: rule.id || `rule_${index}_${Date.now()}`,
      name: rule.name || `Prize ${index + 1}`,
      description: rule.description || "",
      coinsPerPrize: Number(rule.coinsPerPrize) || 0,
      percentageOfTotal: Number(rule.percentageOfTotal) || 0,
      maxPrizes: Number(rule.maxPrizes) || 1,
      isActive: rule.isActive !== undefined ? rule.isActive : true,
      claims: [],
      baseWeight: Number(rule.baseWeight) || 0,
      originalWeight: Number(rule.originalWeight) || 0,
    }));

    try {
      await roomRef.set({
        roomId,
        adminDisplayName,
        adminUID,
        autoCallInterval: Number(autoCallInterval) || 7, // Default 7 seconds
        callingMode: "manual",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        currentActivePlayers: {},
        currentLatestCalledNumber: null,
        currentNumbersCalled: [],
        currentWinners: [],
        gameStartTime: null,
        gameEndTime: null,
        gameStatus: "idle",
        rules: initializedRules,
        ticketPrice: Number(ticketPrice),
        maxTicketsPerPlayer: Number(maxTicketsPerPlayer) || 3, // Default 3 tickets
        totalMoneyCollected: 0,
        gameSummary: null,
      });
      logger.info(`Room ${roomId} created by admin ${adminUID}`);
      return res.status(200).send({ data: { roomId, message: "Game room created successfully." } });
    } catch (error) {
      logger.error("Error creating game room in Firestore:", error);
      return res.status(500).send({ error: { message: "Could not create game room.", details: error.message } });
    }
  });
});


exports.updateGameConfiguration = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, rules, autoCallInterval, adminDisplayName, ticketPrice, maxTicketsPerPlayer } = data;

  if (!roomId) {
    throw new functions.https.HttpsError("invalid-argument", "Room ID is required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const roomSnap = await roomRef.get();

  if (!roomSnap.exists || roomSnap.data().adminUID !== adminUID) {
    throw new functions.https.HttpsError("permission-denied", "You are not the admin of this room or room does not exist.");
  }
  if (roomSnap.data().gameStatus !== "idle") {
    throw new functions.https.HttpsError("failed-precondition", "Game configuration can only be updated when game is idle.");
  }

  const updates = {};
  if (rules && Array.isArray(rules)) {
    updates.rules = rules.map((rule, index) => ({
      id: rule.id || `rule_${index}_${Date.now()}`,
      name: rule.name || `Prize ${index + 1}`,
      description: rule.description || "",
      coinsPerPrize: Number(rule.coinsPerPrize) || 0,
      percentageOfTotal: Number(rule.percentageOfTotal) || 0,
      maxPrizes: Number(rule.maxPrizes) || 1,
      isActive: rule.isActive !== undefined ? rule.isActive : true,
      claims: rule.claims || [], // Preserve existing claims if any during config update (usually done when idle)
      baseWeight: Number(rule.baseWeight) || 0,
      originalWeight: Number(rule.originalWeight) || 0,
    }));
  }
  if (autoCallInterval !== undefined) updates.autoCallInterval = Number(autoCallInterval);
  if (adminDisplayName !== undefined) updates.adminDisplayName = adminDisplayName;
  if (ticketPrice !== undefined && Number(ticketPrice) >= 0) {
    updates.ticketPrice = Number(ticketPrice);
  }
  if (maxTicketsPerPlayer !== undefined && Number(maxTicketsPerPlayer) > 0) {
    updates.maxTicketsPerPlayer = Number(maxTicketsPerPlayer);
  }


  try {
    await roomRef.update(updates);
    logger.info(`Room ${roomId} configuration updated by admin ${adminUID}`);
    return { success: true, message: "Game configuration updated successfully." };
  } catch (error) {
    logger.error(`Error updating game configuration for room ${roomId}:`, error);
    throw new functions.https.HttpsError("internal", "Could not update game configuration.", error.message);
  }
});


exports.manageGameLifecycle = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, action } = data; // action: "start", "pause", "resume", "stop"

  if (!roomId || !action) {
    throw new functions.https.HttpsError("invalid-argument", "Room ID and action are required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);

  try {
    return await db.runTransaction(async (transaction) => {
      const roomDoc = await transaction.get(roomRef);
      if (!roomDoc.exists || roomDoc.data().adminUID !== adminUID) {
        throw new functions.https.HttpsError("permission-denied", "You are not the admin of this room or room does not exist.");
      }

      const roomData = roomDoc.data();
      let updateData = {};

      switch (action) {
        case "start":
          if (roomData.gameStatus !== "idle" && roomData.gameStatus !== "stopped") {
            throw new functions.https.HttpsError("failed-precondition", "Game can only be started if idle or stopped.");
          }
          updateData = {
            gameStatus: "running",
            gameStartTime: admin.firestore.FieldValue.serverTimestamp(),
            currentNumbersCalled: [],
            currentLatestCalledNumber: null,
            currentWinners: [], // Reset winners
            gameEndTime: null, // Clear previous end time
            gameSummary: null, // Clear previous summary
          };
          // Reset claims on rules
          updateData.rules = roomData.rules.map((rule) => ({ ...rule, claims: [] }));
          break;
        case "pause":
          if (roomData.gameStatus !== "running") {
            throw new functions.https.HttpsError("failed-precondition", "Game must be running to be paused.");
          }
          updateData = { gameStatus: "paused", callingMode: "manual" }; // Force manual if paused
          break;
        case "resume":
          if (roomData.gameStatus !== "paused") {
            throw new functions.https.HttpsError("failed-precondition", "Game must be paused to be resumed.");
          }
          updateData = { gameStatus: "running" }; // callingMode remains as it was or admin can set
          break;
        case "stop":
          if (roomData.gameStatus !== "running" && roomData.gameStatus !== "paused") {
            throw new functions.https.HttpsError("failed-precondition", "Game must be running or paused to be stopped.");
          }
          updateData = {
            gameStatus: "stopped",
            gameEndTime: admin.firestore.FieldValue.serverTimestamp(),
            callingMode: "manual",
            gameSummary: {
              totalNumbersCalledCount: (roomData.currentNumbersCalled || []).length,
              winners: roomData.currentWinners || [],
              playersCount: Object.keys(roomData.currentActivePlayers || {}).length,
              totalMoneyCollected: roomData.totalMoneyCollected || 0,
              gameDurationSeconds: roomData.gameStartTime ?
                Math.floor((Date.now() - roomData.gameStartTime.toDate().getTime()) / 1000) : 0,
            },
          };
          break;
        default:
          throw new functions.https.HttpsError("invalid-argument", "Invalid action specified.");
      }

      transaction.update(roomRef, updateData);
      logger.info(`Room ${roomId} lifecycle action '${action}' performed by admin ${adminUID}`);
      return { success: true, message: `Game ${action} successful.` };
    });
  } catch (error) {
    logger.error(`Error performing lifecycle action '${action}' for room ${roomId}:`, error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw new functions.https.HttpsError("internal", `Could not perform game action: ${action}.`, error.message);
  }
});

exports.callNextNumber = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, number: manualNumberInput } = data;

  if (!roomId) {
    throw new functions.https.HttpsError("invalid-argument", "Room ID is required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  return db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.get(roomRef);
    if (!roomDoc.exists || roomDoc.data().adminUID !== adminUID) {
      throw new functions.https.HttpsError("permission-denied", "You are not the admin of this room or room does not exist.");
    }
    const roomData = roomDoc.data();
    if (roomData.gameStatus !== "running") {
      throw new functions.https.HttpsError("failed-precondition", "Numbers can only be called when the game is running.");
    }

    let currentNumbersCalled = roomData.currentNumbersCalled || [];
    if (currentNumbersCalled.length >= 90) {
      transaction.update(roomRef, { gameStatus: "stopped", gameEndTime: admin.firestore.FieldValue.serverTimestamp() });
      throw new functions.https.HttpsError("failed-precondition", "All 90 numbers have been called. Game stopped.");
    }

    let nextNumber;
    if (manualNumberInput !== undefined && manualNumberInput !== null) {
      const number = parseInt(manualNumberInput, 10);
      if (isNaN(number) || number < 1 || number > 90) {
        throw new functions.https.HttpsError("invalid-argument", "Manual number must be between 1 and 90.");
      }
      if (currentNumbersCalled.includes(number)) {
        throw new functions.https.HttpsError("already-exists", `Number ${number} has already been called.`);
      }
      nextNumber = number;
    } else {
      let attempts = 0;
      do {
        nextNumber = Math.floor(Math.random() * 90) + 1;
        attempts++;
        if (attempts > 200) { // Safety break
          logger.error(`Room ${roomId}: Could not find an uncalled number after 200 attempts. Called: ${currentNumbersCalled.length}`);
          throw new functions.https.HttpsError("internal", "Could not determine next number to call. Please try manual entry or check called numbers.");
        }
      } while (currentNumbersCalled.includes(nextNumber));
    }

    currentNumbersCalled.push(nextNumber);
    // currentNumbersCalled.sort((a, b) => a - b); // Sorting might be more of a client-side display concern

    transaction.update(roomRef, {
      currentNumbersCalled: currentNumbersCalled,
      currentLatestCalledNumber: nextNumber,
    });
    logger.info(`Room ${roomId}: Number ${nextNumber} called by admin ${adminUID}. Total called: ${currentNumbersCalled.length}`);
    return { success: true, calledNumber: nextNumber, message: `Number ${nextNumber} called.` };
  });
});

exports.manageTicketRequest = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, requestId, action, reason } = data; // action: "approve", "reject"

  if (!roomId || !requestId || !action) {
    throw new functions.https.HttpsError("invalid-argument", "Room ID, request ID, and action are required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const requestRef = db.collection("rooms").doc(roomId).collection("ticketRequests").doc(requestId);

  return db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.get(roomRef);
    const requestDoc = await transaction.get(requestRef);

    if (!roomDoc.exists || roomDoc.data().adminUID !== adminUID) {
      throw new functions.https.HttpsError("permission-denied", "You are not the admin of this room or room does not exist.");
    }
    if (!requestDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Ticket request not found.");
    }
    const requestData = requestDoc.data();
    if (requestData.status !== "pending") {
      throw new functions.https.HttpsError("failed-precondition", `Ticket request has already been processed with status: ${requestData.status}.`);
    }

    const playerUID = requestData.userId;
    const roomData = roomDoc.data();

    if (action === "approve") {
      const ticketNumbers = generateTambolaTicket();
      const newTicketRef = db.collection("gameTickets").doc();

      transaction.set(newTicketRef, {
        ticketId: newTicketRef.id,
        userId: playerUID,
        playerName: requestData.playerName,
        roomId: roomId,
        numbers: ticketNumbers,
        marked: [], // Client manages marking until claim
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(requestRef, {
        status: "approved",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        ticketId: newTicketRef.id,
      });

      const playerPathInRoom = `currentActivePlayers.${playerUID}`;
      const currentTicketCount = (roomData.currentActivePlayers && roomData.currentActivePlayers[playerUID] && roomData.currentActivePlayers[playerUID].ticketCount) || 0;

      const updates = {
        [`${playerPathInRoom}.playerName`]: requestData.playerName, // Ensure player name is up-to-date
        [`${playerPathInRoom}.lastSeen`]: admin.firestore.FieldValue.serverTimestamp(),
        [`${playerPathInRoom}.ticketCount`]: currentTicketCount + 1,
        totalMoneyCollected: admin.firestore.FieldValue.increment(Number(roomData.ticketPrice) || 0),
      };
      transaction.update(roomRef, updates);

      logger.info(`Ticket request ${requestId} approved for player ${playerUID} in room ${roomId}. Ticket price: ${roomData.ticketPrice}`);
      return { success: true, message: "Ticket request approved.", ticketId: newTicketRef.id };
    } else if (action === "reject") {
      transaction.update(requestRef, {
        status: "rejected",
        reason: reason || "Rejected by admin.",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(), // Timestamp of rejection
      });
      logger.info(`Ticket request ${requestId} rejected for player ${playerUID} in room ${roomId}`);
      return { success: true, message: "Ticket request rejected." };
    } else {
      throw new functions.https.HttpsError("invalid-argument", "Invalid action specified for ticket request.");
    }
  });
});

exports.managePrizeClaim = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, claimId, action, reason } = data; // action: "approve", "reject"

  if (!roomId || !claimId || !action) {
    throw new functions.https.HttpsError("invalid-argument", "Room ID, claim ID, and action are required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const claimRef = db.collection("prizeClaimsAudit").doc(claimId);

  return db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.get(roomRef);
    const claimDoc = await transaction.get(claimRef);

    if (!roomDoc.exists || roomDoc.data().adminUID !== adminUID) {
      throw new functions.https.HttpsError("permission-denied", "You are not the admin of this room or room does not exist.");
    }
    if (!claimDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Prize claim not found.");
    }

    const claimData = claimDoc.data();
    const roomData = roomDoc.data();

    if (claimData.roomId !== roomId) {
      throw new functions.https.HttpsError("invalid-argument", "Claim does not belong to this room.");
    }
    if (claimData.status !== "pending_admin_approval") {
      throw new functions.https.HttpsError("failed-precondition", `Claim cannot be processed by admin. Current status: ${claimData.status}`);
    }

    const ruleBeingClaimed = roomData.rules.find((r) => r.id === claimData.prizeRuleId);
    if (!ruleBeingClaimed) {
      transaction.update(claimRef, { status: "rejected_admin", reason: "Rule configuration not found at time of review.", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: adminUID });
      logger.error(`Rule ID ${claimData.prizeRuleId} not found in room ${roomId} for claim ${claimId}.`);
      throw new functions.https.HttpsError("not-found", `Rule ID ${claimData.prizeRuleId} not found in current room configuration.`);
    }

    if (action === "approve") {
      const existingClaimsForThisRuleArray = ruleBeingClaimed.claims || [];
      if (existingClaimsForThisRuleArray.length >= ruleBeingClaimed.maxPrizes) {
        const rejectMsg = `Maximum prizes (${ruleBeingClaimed.maxPrizes}) for '${ruleBeingClaimed.name}' already claimed. Cannot approve more.`;
        transaction.update(claimRef, { status: "rejected_admin", reason: rejectMsg, reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: adminUID });
        throw new functions.https.HttpsError("failed-precondition", rejectMsg);
      }

      let coinsAwarded = 0;
      if (ruleBeingClaimed.percentageOfTotal && ruleBeingClaimed.percentageOfTotal > 0 && roomData.totalMoneyCollected > 0) {
        coinsAwarded = (Number(ruleBeingClaimed.percentageOfTotal) / 100) * Number(roomData.totalMoneyCollected);
      } else {
        coinsAwarded = Number(ruleBeingClaimed.coinsPerPrize) || 0;
      }
      coinsAwarded = Math.floor(coinsAwarded); // Ensure integer coins

      transaction.update(claimRef, {
        status: "approved",
        coinsAwarded: coinsAwarded,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedBy: adminUID,
      });

      const winnerEntry = {
        claimId: claimId,
        userId: claimData.userId,
        playerName: claimData.playerName,
        ticketId: claimData.ticketId,
        prizeName: claimData.prizeName,
        prizeRuleId: claimData.prizeRuleId,
        coinsAwarded: coinsAwarded,
        timestamp: admin.firestore.FieldValue.serverTimestamp(), // Timestamp of approval
      };
      transaction.update(roomRef, {
        currentWinners: admin.firestore.FieldValue.arrayUnion(winnerEntry),
      });

      const updatedRules = roomData.rules.map((r) => {
        if (r.id === claimData.prizeRuleId) {
          const newClaimsArray = Array.isArray(r.claims) ? r.claims : [];
          return {
            ...r,
            claims: [...newClaimsArray, {
              userId: claimData.userId,
              playerName: claimData.playerName,
              ticketId: claimData.ticketId,
              claimId: claimId,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
            }],
          };
        }
        return r;
      });
      transaction.update(roomRef, { rules: updatedRules });

      logger.info(`Prize claim ${claimId} approved by admin ${adminUID} for player ${claimData.userId}. Awarded: ${coinsAwarded}`);
      return { success: true, message: "Prize claim approved.", coinsAwarded: coinsAwarded };
    } else if (action === "reject") {
      transaction.update(claimRef, {
        status: "rejected_admin",
        reason: reason || "Rejected by admin.",
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedBy: adminUID,
      });
      logger.info(`Prize claim ${claimId} rejected by admin ${adminUID}`);
      return { success: true, message: "Prize claim rejected." };
    } else {
      throw new functions.https.HttpsError("invalid-argument", "Invalid action specified for prize claim.");
    }
  });
});

// --- Player Functions ---

exports.joinGameRoom = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const playerUID = context.auth.uid;
  const { roomId, playerName } = data;

  if (!roomId || !playerName || typeof playerName !== "string" || playerName.trim() === "") {
    throw new functions.https.HttpsError("invalid-argument", "Room ID and a non-empty player name are required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  try {
    const roomDoc = await roomRef.get();
    if (!roomDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Game room not found.");
    }
    const roomData = roomDoc.data();
    if (roomData.gameStatus === "stopped" || roomData.gameStatus === "error") {
      throw new functions.https.HttpsError("failed-precondition", `Cannot join room. Game status is '${roomData.gameStatus}'.`);
    }

    const playerPath = `currentActivePlayers.${playerUID}`;
    const currentPlayerData = (roomData.currentActivePlayers && roomData.currentActivePlayers[playerUID]) ? roomData.currentActivePlayers[playerUID] : {};

    await roomRef.update({
      [`${playerPath}.playerName`]: playerName.trim(),
      [`${playerPath}.ticketCount`]: currentPlayerData.ticketCount || 0, // Preserve ticket count
      [`${playerPath}.lastSeen`]: admin.firestore.FieldValue.serverTimestamp(),
      [`${playerPath}.uid`]: playerUID, // Store UID for easier reference if needed
    });
    logger.info(`Player ${playerUID} (${playerName.trim()}) joined/updated in room ${roomId}`);
    return { success: true, message: `Successfully joined room ${roomId}. Welcome, ${playerName.trim()}!` };
  } catch (error) {
    logger.error(`Error joining room ${roomId} for player ${playerUID}:`, error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError("internal", "Could not join game room.", error.message);
  }
});

exports.requestGameTicket = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const playerUID = context.auth.uid;
  const { roomId } = data;

  if (!roomId) {
    throw new functions.https.HttpsError("invalid-argument", "Room ID is required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const roomDoc = await roomRef.get();

  if (!roomDoc.exists) {
    throw new functions.https.HttpsError("not-found", "Room not found.");
  }
  const roomData = roomDoc.data();
  const playerData = (roomData.currentActivePlayers && roomData.currentActivePlayers[playerUID]) ? roomData.currentActivePlayers[playerUID] : null;

  if (!playerData || !playerData.playerName) {
    throw new functions.https.HttpsError("failed-precondition", "Player not found in room or player name missing. Please ensure you have joined the room with a name first.");
  }
  // Allow ticket requests when game is idle, running or paused.
  if (!["idle", "running", "paused"].includes(roomData.gameStatus)) {
    throw new functions.https.HttpsError("failed-precondition", `Cannot request tickets when game status is '${roomData.gameStatus}'.`);
  }

  const maxTicketsPerPlayer = Number(roomData.maxTicketsPerPlayer) || 3; // Default from room settings
  if ((playerData.ticketCount || 0) >= maxTicketsPerPlayer) {
    throw new functions.https.HttpsError("resource-exhausted", `You have reached the maximum of ${maxTicketsPerPlayer} tickets for this game.`);
  }

  const newRequestRef = db.collection("rooms").doc(roomId).collection("ticketRequests").doc();
  try {
    await newRequestRef.set({
      requestId: newRequestRef.id,
      userId: playerUID,
      playerName: playerData.playerName,
      roomId: roomId,
      status: "pending",
      requestTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      currentTickets: playerData.ticketCount || 0,
    });
    logger.info(`Ticket request ${newRequestRef.id} submitted by player ${playerUID} (${playerData.playerName}) for room ${roomId}`);
    return { success: true, requestId: newRequestRef.id, message: "Ticket request submitted successfully. Waiting for admin approval." };
  } catch (error) {
    logger.error(`Error submitting ticket request for player ${playerUID} in room ${roomId}:`, error);
    throw new functions.https.HttpsError("internal", "Could not submit ticket request.", error.message);
  }
});

exports.submitPrizeClaim = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const playerUID = context.auth.uid;
  const { roomId, ticketId, prizeRuleId, claimedNumbersOnTicket, clientTempClaimId } = data;

  if (!roomId || !ticketId || !prizeRuleId || !Array.isArray(claimedNumbersOnTicket) || claimedNumbersOnTicket.length === 0) {
    throw new functions.https.HttpsError("invalid-argument", "Room ID, ticket ID, prize rule ID, and a non-empty array of claimed numbers are required.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const ticketRef = db.collection("gameTickets").doc(ticketId);
  const newClaimRef = db.collection("prizeClaimsAudit").doc(); // Auto-generate ID

  return db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.get(roomRef);
    const ticketDoc = await transaction.get(ticketRef);

    if (!roomDoc.exists) throw new functions.https.HttpsError("not-found", "Game room not found.");
    if (!ticketDoc.exists) throw new functions.https.HttpsError("not-found", "Ticket not found.");

    const roomData = roomDoc.data();
    const ticketData = ticketDoc.data();
    const playerData = (roomData.currentActivePlayers && roomData.currentActivePlayers[playerUID]) ? roomData.currentActivePlayers[playerUID] : null;

    if (!playerData || !playerData.playerName) {
      throw new functions.https.HttpsError("failed-precondition", "Player not found in room or player name missing.");
    }
    if (ticketData.userId !== playerUID) throw new functions.https.HttpsError("permission-denied", "This ticket does not belong to you.");
    if (ticketData.roomId !== roomId) throw new functions.https.HttpsError("invalid-argument", "This ticket does not belong to the specified room.");
    if (roomData.gameStatus !== "running") throw new functions.https.HttpsError("failed-precondition", `Claims can only be submitted when game is running. Current status: ${roomData.gameStatus}`);

    const ruleBeingClaimed = roomData.rules.find((r) => r.id === prizeRuleId);
    if (!ruleBeingClaimed) throw new functions.https.HttpsError("not-found", `Rule ID ${prizeRuleId} not found in room configuration.`);
    if (!ruleBeingClaimed.isActive) throw new functions.https.HttpsError("failed-precondition", `Prize '${ruleBeingClaimed.name}' is currently not active.`);

    const claimsForThisRuleArray = ruleBeingClaimed.claims || [];
    if (claimsForThisRuleArray.length >= ruleBeingClaimed.maxPrizes) {
      throw new functions.https.HttpsError("resource-exhausted", `Maximum prizes for '${ruleBeingClaimed.name}' already claimed by others.`);
    }

    // Check if this player has already an approved or pending claim for THIS rule on THIS ticket
    const existingPlayerClaimsSnapshot = await db.collection("prizeClaimsAudit")
      .where("userId", "==", playerUID)
      .where("roomId", "==", roomId)
      .where("ticketId", "==", ticketId)
      .where("prizeRuleId", "==", prizeRuleId)
      .where("status", "in", ["pending_admin_approval", "approved"])
      .limit(1) // We only need to know if at least one exists
      .get(); // Execute this query outside transaction if it becomes a contention point

    if (!existingPlayerClaimsSnapshot.empty) {
      throw new functions.https.HttpsError("already-exists", `You have already submitted or won a claim for '${ruleBeingClaimed.name}' on this ticket.`);
    }

    const validationOutcome = validatePrizePattern(
      ticketData.numbers,
      claimedNumbersOnTicket,
      roomData.currentNumbersCalled || [],
      ruleBeingClaimed,
    );

    let claimStatus;
    let finalReason = validationOutcome.reason || "";
    let finalEffectivelyClaimedNumbers = validationOutcome.effectivelyClaimedNumbers || claimedNumbersOnTicket;

    if (validationOutcome.valid) {
      claimStatus = "pending_admin_approval";
      logger.info(`Prize claim by ${playerUID} for rule ${prizeRuleId} in room ${roomId} passed server validation.`);
    } else {
      claimStatus = "rejected_auto_invalid";
      finalReason = finalReason || "Automatic validation failed: The claimed numbers do not fulfill the prize pattern requirements.";
      logger.warn(`Prize claim by ${playerUID} for rule ${prizeRuleId} in room ${roomId} failed server validation. Reason: ${finalReason}`);
    }

    transaction.set(newClaimRef, {
      claimId: newClaimRef.id,
      userId: playerUID,
      playerName: playerData.playerName,
      roomId: roomId,
      ticketId: ticketId,
      prizeRuleId: prizeRuleId,
      prizeName: ruleBeingClaimed.name,
      clientTempClaimId: clientTempClaimId || null,
      claimedNumbersOnTicket: claimedNumbersOnTicket, // Numbers as claimed by player
      effectivelyClaimedNumbers: finalEffectivelyClaimedNumbers, // Numbers server considers valid for the claim
      status: claimStatus,
      reason: finalReason,
      serverValidationResult: validationOutcome.valid,
      claimTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      coinsAwarded: 0, // To be set upon admin approval
    });

    return {
      success: true,
      claimId: newClaimRef.id,
      status: claimStatus,
      serverValidationResult: validationOutcome.valid,
      message: claimStatus === "pending_admin_approval" ? "Claim submitted and awaiting admin approval." : `Claim submission failed automatic validation: ${finalReason}`,
    };
  });
});
