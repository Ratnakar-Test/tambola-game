// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require("firebase-functions");
const { logger } = functions;

// The Firebase Admin SDK to access Firebase services from the backend.
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// --- CORS Middleware Configuration ---
// Configure CORS options.
// For production, it's best to be specific about the origin.
const corsOptions = {
  origin: 'https://tambolapremium.netlify.app', // Your specific Netlify frontend URL
  methods: ['POST', 'OPTIONS'], // Only allow POST and OPTIONS for this function
  allowedHeaders: ['Content-Type', 'Authorization'], // Headers your client sends
  maxAge: 3600 // Optional: Cache preflight response for 1 hour
};
const corsMiddleware = require('cors')(corsOptions);


// --- Helper Functions ---
/**
 * Generates a unique Room ID.
 */
function generateRoomId() {
  return Math.random().toString().slice(2, 8);
}

/**
 * Generates a valid Tambola ticket (3x9 grid, 15 numbers).
 */
function generateTambolaTicket() {
  let ticket = Array(3).fill(null).map(() => Array(9).fill(null));
  let numbers = new Set(); 

  const getRandomNumForCol = (colIndex) => {
    const min = colIndex * 10 + (colIndex === 8 ? 0 : 1); 
    const max = colIndex * 10 + (colIndex === 8 ? 10 : 9); 
    let num;
    let attempts = 0;
    do {
      num = Math.floor(Math.random() * (max - min + 1)) + min;
      attempts++;
    } while (numbers.has(num) && attempts < 20); 
    if (numbers.has(num)) return null; 
    return num;
  };

  for (let j = 0; j < 9; j++) {
    const rowIndex = Math.floor(Math.random() * 3);
    let num = getRandomNumForCol(j);
    if (num) {
      ticket[rowIndex][j] = num;
      numbers.add(num);
    } else {
      num = getRandomNumForCol(j);
      if (num) {
          ticket[rowIndex][j] = num;
          numbers.add(num);
      } else {
          logger.warn(`Could not place initial number in column ${j}`);
      }
    }
  }

  for (let i = 0; i < 3; i++) {
    let numsInRow = ticket[i].filter(n => n !== null).length;
    let availableCols = [];
    for(let k=0; k<9; k++) availableCols.push(k); 
    availableCols.sort(() => 0.5 - Math.random());

    while (numsInRow < 5 && availableCols.length > 0) {
      const colIndex = availableCols.pop(); 
      if (ticket[i][colIndex] === null) { 
        let numsInCol = 0;
        for(let r=0; r<3; r++) if(ticket[r][colIndex] !== null) numsInCol++;

        if (numsInCol < 3) { 
          let num = getRandomNumForCol(colIndex);
          if (num) {
            ticket[i][colIndex] = num;
            numbers.add(num);
            numsInRow++;
          }
        }
      }
    }
  }

  let totalNumbers = 0;
  ticket.forEach(row => row.forEach(n => { if (n) totalNumbers++; }));

  if (totalNumbers < 15) {
      for (let i = 0; i < 3 && totalNumbers < 15; i++) {
          let numsInRow = ticket[i].filter(n => n !== null).length;
          let shuffledCols = Array.from({length: 9}, (_, k) => k).sort(() => 0.5 - Math.random());
          for (let j_idx = 0; j_idx < 9 && numsInRow < 5 && totalNumbers < 15; j_idx++) {
              const colIndex = shuffledCols[j_idx];
              if (ticket[i][colIndex] === null) {
                  let num = getRandomNumForCol(colIndex);
                  if (num) {
                      ticket[i][colIndex] = num;
                      numbers.add(num);
                      numsInRow++;
                      totalNumbers++;
                  }
              }
          }
      }
  }
  
  totalNumbers = 0; 
  ticket.forEach(row => row.forEach(n => { if (n) totalNumbers++; }));
  if (totalNumbers !== 15) {
      logger.error("Ticket generation failed: Did not produce 15 numbers. Generated:", totalNumbers, JSON.stringify(ticket));
  }
  for(let i=0; i<3; i++) {
      if (ticket[i].filter(n => n !== null).length !== 5) {
          logger.warn(`Row ${i} does not have exactly 5 numbers. Row:`, ticket[i]);
      }
  }

  for (let j = 0; j < 9; j++) {
    let colNumbers = [];
    for (let i = 0; i < 3; i++) {
      if (ticket[i][j] !== null) {
        colNumbers.push(ticket[i][j]);
      }
    }
    colNumbers.sort((a, b) => a - b); 
    let current = 0;
    for (let i = 0; i < 3; i++) {
      if (ticket[i][j] !== null) {
        ticket[i][j] = colNumbers[current++];
      }
    }
  }
  logger.info("Generated Ticket:", JSON.stringify(ticket));
  return ticket;
}


function validatePrizePattern(ticketNumbers, claimedNumbersOnTicket, gameCalledNumbers, rule) {
  logger.info("Validating prize:", rule.name, "Player Claimed Nums:", claimedNumbersOnTicket, "Game Called Nums:", gameCalledNumbers);

  const allClaimedAreCalled = claimedNumbersOnTicket.every(num => gameCalledNumbers.includes(num));
  if (!allClaimedAreCalled) {
    logger.warn("Validation failed: Not all numbers claimed by player were actually called in the game.");
    return false;
  }

  const ticketFlatNumbers = ticketNumbers.flat().filter(n => n !== null);
  const allClaimedAreOnTicket = claimedNumbersOnTicket.every(num => ticketFlatNumbers.includes(num));
  if (!allClaimedAreOnTicket) {
    logger.warn("Validation failed: Not all numbers claimed by player exist on their ticket.");
    return false;
  }

  const ruleId = rule.id ? rule.id.toLowerCase() : rule.name.toLowerCase().replace(/\s+/g, ''); 

  switch (ruleId) {
    case 'earlyfive':
    case 'early_five':
      if (claimedNumbersOnTicket.length < 5) {
        logger.warn("Early Five validation failed: Less than 5 numbers claimed.");
        return false;
      }
      logger.info("Early Five validation: Passed.");
      return true;

    case 'line1':
    case 'firstline':
    case 'topline':
      const line1Numbers = ticketNumbers[0].filter(n => n !== null);
      const line1Claimed = line1Numbers.every(num => claimedNumbersOnTicket.includes(num)) && claimedNumbersOnTicket.length >= line1Numbers.length;
      if (!line1Claimed) logger.warn("Line 1 validation failed: Not all numbers from line 1 are in player's claim or claim incomplete.");
      else logger.info("Line 1 validation: Passed.");
      return line1Claimed;

    case 'line2':
    case 'secondline':
    case 'middleline':
      const line2Numbers = ticketNumbers[1].filter(n => n !== null);
      const line2Claimed = line2Numbers.every(num => claimedNumbersOnTicket.includes(num)) && claimedNumbersOnTicket.length >= line2Numbers.length;
      if (!line2Claimed) logger.warn("Line 2 validation failed: Not all numbers from line 2 are in player's claim or claim incomplete.");
      else logger.info("Line 2 validation: Passed.");
      return line2Claimed;

    case 'line3':
    case 'thirdline':
    case 'bottomline':
      const line3Numbers = ticketNumbers[2].filter(n => n !== null);
      const line3Claimed = line3Numbers.every(num => claimedNumbersOnTicket.includes(num)) && claimedNumbersOnTicket.length >= line3Numbers.length;
      if (!line3Claimed) logger.warn("Line 3 validation failed: Not all numbers from line 3 are in player's claim or claim incomplete.");
      else logger.info("Line 3 validation: Passed.");
      return line3Claimed;

    case 'corners':
    case 'fourcorners':
      const corners = [];
      for(let j=0; j<9; j++) if(ticketNumbers[0][j] !== null) { corners.push(ticketNumbers[0][j]); break; }
      for(let j=8; j>=0; j--) if(ticketNumbers[0][j] !== null && !corners.includes(ticketNumbers[0][j])) { corners.push(ticketNumbers[0][j]); break; } 
      for(let j=0; j<9; j++) if(ticketNumbers[2][j] !== null && !corners.includes(ticketNumbers[2][j])) { corners.push(ticketNumbers[2][j]); break; }
      for(let j=8; j>=0; j--) if(ticketNumbers[2][j] !== null && !corners.includes(ticketNumbers[2][j])) { corners.push(ticketNumbers[2][j]); break; }
      
      const uniqueCorners = [...new Set(corners)];
      if (uniqueCorners.length < 4 && ticketFlatNumbers.length >= 4) { 
        logger.warn(`Corners validation warning: Could not identify 4 unique corner numbers on the ticket. Found: ${uniqueCorners.length}`);
      }
      const cornersClaimed = uniqueCorners.every(num => claimedNumbersOnTicket.includes(num)) && claimedNumbersOnTicket.length >= uniqueCorners.length;
      if (!cornersClaimed) logger.warn("Corners validation failed: Not all identified corner numbers are in player's claim or claim incomplete.");
      else logger.info("Corners validation: Passed.");
      return cornersClaimed;

    case 'fullhouse':
      const fullHouseClaimed = ticketFlatNumbers.every(num => claimedNumbersOnTicket.includes(num)) &&
                               claimedNumbersOnTicket.length >= ticketFlatNumbers.length; 
      if (!fullHouseClaimed) logger.warn("Full House validation failed: Not all ticket numbers are in player's claim, or player claimed too few.");
      else logger.info("Full House validation: Passed.");
      return fullHouseClaimed;

    default:
      logger.warn(`Unknown prize rule ID for validation: '${ruleId}'. Claim rejected.`);
      return false;
  }
}

function ensureAuthenticated(context) {
  if (!context.auth) {
    logger.error("Authentication check failed: User not authenticated.");
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
}

// --- Admin Functions ---

exports.createGameRoom = functions.https.onRequest((req, res) => {
    // Apply CORS middleware FIRST.
    // The corsMiddleware will automatically handle OPTIONS requests.
    // For other requests (like POST), it will set headers and then call the next handler.
    corsMiddleware(req, res, async () => {
        // This block will be executed if the request is NOT an OPTIONS request
        // AND the origin is allowed by the corsMiddleware.

        // Authenticate and check method only for non-OPTIONS requests
        if (req.method !== 'POST') {
            // This check is a safeguard. corsMiddleware should ideally prevent non-specified methods.
            return res.status(405).send({ error: { message: 'Method Not Allowed' } });
        }

        let adminUID;
        const authorization = req.headers.authorization;

        if (authorization && authorization.startsWith('Bearer ')) {
            const idToken = authorization.split('Bearer ')[1];
            try {
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                adminUID = decodedToken.uid;
                logger.info(`User ${adminUID} authenticated for createGameRoom.`);
            } catch (error) {
                logger.error('Error verifying Firebase ID token for createGameRoom:', error);
                return res.status(401).send({ error: { message: 'Unauthorized. Invalid ID token.' } });
            }
        } else {
            logger.warn('No Firebase ID token was passed for createGameRoom.');
            return res.status(401).send({ error: { message: 'Unauthorized. No ID token provided.' } });
        }

        const data = req.body.data; 
        if (!data) {
            logger.error("Bad Request: No data found in request body for createGameRoom.", req.body);
            return res.status(400).send({ error: { message: 'Bad Request: No data payload found.' } });
        }

        const { adminDisplayName, rules, autoCallInterval, ticketPrice } = data;

        if (!adminDisplayName || !rules || !Array.isArray(rules) || ticketPrice === undefined || ticketPrice < 0) {
            logger.error("Validation failed for createGameRoom data:", data);
            return res.status(400).send({ error: { message: 'Admin display name, rules array, and a valid ticket price are required.' } });
        }

        const roomId = generateRoomId();
        const roomRef = db.collection('rooms').doc(roomId);

        const initializedRules = rules.map((rule, index) => ({
            id: rule.id || `rule_${index}_${Date.now()}`,
            name: rule.name,
            description: rule.description || '',
            coinsPerPrize: rule.coinsPerPrize || 0,
            percentageOfTotal: rule.percentageOfTotal || 0,
            maxPrizes: rule.maxPrizes || 1,
            isActive: true, 
            claims: [], 
            baseWeight: rule.baseWeight || 0, 
            originalWeight: rule.originalWeight || 0,
        }));

        try {
            await roomRef.set({
                roomId,
                adminDisplayName,
                adminUID, 
                autoCallInterval: autoCallInterval || 5,
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
                totalMoneyCollected: 0,
            });
            logger.info(`Room ${roomId} created by admin ${adminUID}`);
            return res.status(200).send({ data: { roomId, message: "Game room created successfully." } });
        } catch (error) {
            logger.error("Error creating game room in Firestore:", error);
            return res.status(500).send({ error: { message: 'Could not create game room.', details: error.message } });
        }
    }); // End of corsMiddleware wrapper
});


// ... (rest of your functions: updateGameConfiguration, manageGameLifecycle, etc. They are onCall so don't need manual CORS)
// --- Player Functions --- (These are onCall, CORS is handled differently or not needed in the same way)

exports.updateGameConfiguration = functions.https.onCall(async (data, context) => {
    ensureAuthenticated(context);
    const adminUID = context.auth.uid;
    const { roomId, rules, autoCallInterval, adminDisplayName, ticketPrice } = data;

    if (!roomId) {
        throw new functions.https.HttpsError('invalid-argument', 'Room ID is required.');
    }

    const roomRef = db.collection('rooms').doc(roomId);
    const roomSnap = await roomRef.get();

    if (!roomSnap.exists || roomSnap.data().adminUID !== adminUID) {
        throw new functions.https.HttpsError('permission-denied', 'You are not the admin of this room or room does not exist.');
    }
    if (roomSnap.data().gameStatus !== "idle") {
        throw new functions.https.HttpsError('failed-precondition', 'Game configuration can only be updated when game is idle.');
    }

    const updates = {};
    if (rules) updates.rules = rules.map((rule, index) => ({
        id: rule.id || `rule_${index}_${Date.now()}`, 
        name: rule.name,
        description: rule.description || '',
        coinsPerPrize: rule.coinsPerPrize || 0,
        percentageOfTotal: rule.percentageOfTotal || 0,
        maxPrizes: rule.maxPrizes || 1,
        isActive: rule.isActive !== undefined ? rule.isActive : true, 
        claims: rule.claims || [], 
        baseWeight: rule.baseWeight || 0,
        originalWeight: rule.originalWeight || 0,
    }));
    if (autoCallInterval) updates.autoCallInterval = autoCallInterval;
    if (adminDisplayName) updates.adminDisplayName = adminDisplayName;
    if (ticketPrice !== undefined && ticketPrice >= 0) { 
        updates.ticketPrice = Number(ticketPrice);
    }

    try {
        await roomRef.update(updates);
        logger.info(`Room ${roomId} configuration updated by admin ${adminUID}`);
        return { message: "Game configuration updated successfully." };
    } catch (error) {
        logger.error(`Error updating game configuration for room ${roomId}:`, error);
        throw new functions.https.HttpsError('internal', 'Could not update game configuration.', error.message);
    }
});


exports.manageGameLifecycle = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, action } = data;

  if (!roomId || !action) {
    throw new functions.https.HttpsError('invalid-argument', 'Room ID and action are required.');
  }

  const roomRef = db.collection('rooms').doc(roomId);

  try {
    const roomDoc = await roomRef.get();
    if (!roomDoc.exists || roomDoc.data().adminUID !== adminUID) {
      throw new functions.https.HttpsError('permission-denied', 'You are not the admin of this room or room does not exist.');
    }

    const roomData = roomDoc.data();
    let updateData = {};

    switch (action) {
      case "start":
        if (roomData.gameStatus !== "idle" && roomData.gameStatus !== "stopped") {
            throw new functions.https.HttpsError('failed-precondition', 'Game can only be started if idle or stopped.');
        }
        updateData = {
            gameStatus: "running",
            gameStartTime: admin.firestore.FieldValue.serverTimestamp(),
            currentNumbersCalled: [], 
            currentLatestCalledNumber: null,
            currentWinners: [] 
        };
        updateData.rules = roomData.rules.map(rule => ({ ...rule, claims: [] }));
        break;
      case "pause":
        if (roomData.gameStatus !== "running") {
            throw new functions.https.HttpsError('failed-precondition', 'Game must be running to be paused.');
        }
        updateData = { gameStatus: "paused", callingMode: "manual" }; 
        break;
      case "resume":
         if (roomData.gameStatus !== "paused") {
            throw new functions.https.HttpsError('failed-precondition', 'Game must be paused to be resumed.');
        }
        updateData = { gameStatus: "running" }; 
        break;
      case "stop":
        if (roomData.gameStatus !== "running" && roomData.gameStatus !== "paused") {
            throw new functions.https.HttpsError('failed-precondition', 'Game must be running or paused to be stopped.');
        }
        updateData = { gameStatus: "stopped", gameEndTime: admin.firestore.FieldValue.serverTimestamp(), callingMode: "manual" };
        break;
      default:
        throw new functions.https.HttpsError('invalid-argument', 'Invalid action specified.');
    }

    await roomRef.update(updateData);
    logger.info(`Room ${roomId} lifecycle action '${action}' performed by admin ${adminUID}`);
    return { message: `Game ${action} successful.` };
  } catch (error) {
    logger.error(`Error performing lifecycle action '${action}' for room ${roomId}:`, error);
    if (error instanceof functions.https.HttpsError) {
        throw error;
    }
    throw new functions.https.HttpsError('internal', `Could not perform game action: ${action}.`, error.message);
  }
});

exports.callNextNumber = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, number: manualNumberInput } = data;

  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Room ID is required.');
  }

  const roomRef = db.collection('rooms').doc(roomId);
  return db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.get(roomRef);
    if (!roomDoc.exists || roomDoc.data().adminUID !== adminUID) {
      throw new functions.https.HttpsError('permission-denied', 'You are not the admin of this room or room does not exist.');
    }
    if (roomDoc.data().gameStatus !== "running") {
      throw new functions.https.HttpsError('failed-precondition', 'Numbers can only be called when the game is running.');
    }

    let currentNumbersCalled = roomDoc.data().currentNumbersCalled || [];
    if (currentNumbersCalled.length >= 90) {
      transaction.update(roomRef, { gameStatus: "stopped", gameEndTime: admin.firestore.FieldValue.serverTimestamp() });
      throw new functions.https.HttpsError('failed-precondition', 'All 90 numbers have been called. Game stopped.');
    }

    let nextNumber;
    if (manualNumberInput !== undefined && manualNumberInput !== null) { 
      const number = parseInt(manualNumberInput);
      if (isNaN(number) || number < 1 || number > 90) {
        throw new functions.https.HttpsError('invalid-argument', 'Manual number must be between 1 and 90.');
      }
      if (currentNumbersCalled.includes(number)) {
        throw new functions.https.HttpsError('invalid-argument', `Number ${number} has already been called.`);
      }
      nextNumber = number;
    } else { 
      let attempts = 0;
      do {
        nextNumber = Math.floor(Math.random() * 90) + 1;
        attempts++;
        if (attempts > 200) { 
            logger.error(`Room ${roomId}: Could not find an uncalled number after 200 attempts. Called: ${currentNumbersCalled.length}`);
            throw new functions.https.HttpsError('internal', 'Could not determine next number to call. Please try manual entry if stuck.');
        }
      } while (currentNumbersCalled.includes(nextNumber));
    }

    currentNumbersCalled.push(nextNumber);
    currentNumbersCalled.sort((a,b) => a-b); 
    transaction.update(roomRef, {
      currentNumbersCalled: currentNumbersCalled, 
      currentLatestCalledNumber: nextNumber
    });
    logger.info(`Room ${roomId}: Number ${nextNumber} called by admin ${adminUID}. Total called: ${currentNumbersCalled.length}`);
    return { calledNumber: nextNumber, message: `Number ${nextNumber} called.` };
  });
});

exports.manageTicketRequest = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, requestId, action, reason } = data;

  if (!roomId || !requestId || !action) {
    throw new functions.https.HttpsError('invalid-argument', 'Room ID, request ID, and action are required.');
  }

  const roomRef = db.collection('rooms').doc(roomId);
  const requestRef = db.collection('rooms').doc(roomId).collection('ticketRequests').doc(requestId);

  return db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.get(roomRef);
    const requestDoc = await transaction.get(requestRef);

    if (!roomDoc.exists || roomDoc.data().adminUID !== adminUID) {
      throw new functions.https.HttpsError('permission-denied', 'You are not the admin of this room or room does not exist.');
    }
    if (!requestDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Ticket request not found.');
    }
    if (requestDoc.data().status !== "pending") {
      throw new functions.https.HttpsError('failed-precondition', 'Ticket request has already been processed.');
    }

    const requestData = requestDoc.data();
    const playerUID = requestData.userId;
    const roomData = roomDoc.data(); 

    if (action === "approve") {
      const ticketNumbers = generateTambolaTicket();
      const newTicketRef = db.collection('gameTickets').doc(); 

      transaction.set(newTicketRef, {
        ticketId: newTicketRef.id, 
        userId: playerUID,
        playerName: requestData.playerName, 
        roomId: roomId,
        numbers: ticketNumbers,
        marked: [], 
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(requestRef, {
        status: "approved",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        ticketId: newTicketRef.id 
      });

      const playerPathInRoom = `currentActivePlayers.${playerUID}.ticketCount`;
      const currentTicketCount = (roomData.currentActivePlayers && roomData.currentActivePlayers[playerUID] && roomData.currentActivePlayers[playerUID].ticketCount) || 0;
      transaction.update(roomRef, {
        [`currentActivePlayers.${playerUID}.playerName`]: requestData.playerName,
        [`currentActivePlayers.${playerUID}.lastSeen`]: admin.firestore.FieldValue.serverTimestamp(),
        [playerPathInRoom]: currentTicketCount + 1, 
        totalMoneyCollected: admin.firestore.FieldValue.increment(Number(roomData.ticketPrice) || 0)
      });

      logger.info(`Ticket request ${requestId} approved for player ${playerUID} in room ${roomId}. Ticket price: ${roomData.ticketPrice}`);
      return { message: "Ticket request approved.", ticketId: newTicketRef.id };

    } else if (action === "reject") {
      transaction.update(requestRef, {
        status: "rejected",
        reason: reason || "Rejected by admin." 
      });
      logger.info(`Ticket request ${requestId} rejected for player ${playerUID} in room ${roomId}`);
      return { message: "Ticket request rejected." };
    } else {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid action specified for ticket request.');
    }
  });
});

exports.managePrizeClaim = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { roomId, claimId, action, reason } = data;

  if (!roomId || !claimId || !action) {
    throw new functions.https.HttpsError('invalid-argument', 'Room ID, claim ID, and action are required.');
  }

  const roomRef = db.collection('rooms').doc(roomId);
  const claimRef = db.collection('prizeClaimsAudit').doc(claimId);

  return db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.get(roomRef);
    const claimDoc = await transaction.get(claimRef);

    if (!roomDoc.exists || roomDoc.data().adminUID !== adminUID) {
      throw new functions.https.HttpsError('permission-denied', 'You are not the admin of this room or room does not exist.');
    }
    if (!claimDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Prize claim not found.');
    }

    const claimData = claimDoc.data();
    const roomData = roomDoc.data();

    if (claimData.roomId !== roomId) {
        throw new functions.https.HttpsError('invalid-argument', 'Claim does not belong to this room.');
    }
    if (claimData.status !== "pending_admin_approval") { 
      throw new functions.https.HttpsError('failed-precondition', `Claim cannot be processed by admin. Current status: ${claimData.status}`);
    }

    const ruleBeingClaimed = roomData.rules.find(r => r.id === claimData.prizeRuleId);
    if (!ruleBeingClaimed) {
      transaction.update(claimRef, { status: "rejected_admin", reason: "Rule configuration not found at time of review.", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: adminUID });
      throw new functions.https.HttpsError('not-found', `Rule ID ${claimData.prizeRuleId} not found in current room configuration.`);
    }

    if (action === "approve") {
      const existingClaimsForThisRuleArray = ruleBeingClaimed.claims || []; 
      if (existingClaimsForThisRuleArray.length >= ruleBeingClaimed.maxPrizes) {
        const rejectMsg = `Maximum prizes for '${ruleBeingClaimed.name}' already claimed. Cannot approve more.`;
        transaction.update(claimRef, { status: "rejected_admin", reason: rejectMsg, reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: adminUID });
        throw new functions.https.HttpsError('failed-precondition', rejectMsg);
      }

      let coinsAwarded = 0;
      if (ruleBeingClaimed.percentageOfTotal && ruleBeingClaimed.percentageOfTotal > 0 && roomData.totalMoneyCollected > 0) {
          coinsAwarded = (Number(ruleBeingClaimed.percentageOfTotal) / 100) * Number(roomData.totalMoneyCollected);
      } else {
          coinsAwarded = Number(ruleBeingClaimed.coinsPerPrize) || 0;
      }
      coinsAwarded = Math.floor(coinsAwarded); 

      transaction.update(claimRef, {
        status: "approved",
        coinsAwarded: coinsAwarded,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedBy: adminUID
      });

      const winnerEntry = {
        claimId: claimId,
        userId: claimData.userId,
        playerName: claimData.playerName, 
        ticketId: claimData.ticketId,
        prizeName: claimData.prizeName,     
        prizeRuleId: claimData.prizeRuleId, 
        coinsAwarded: coinsAwarded,
        timestamp: admin.firestore.FieldValue.serverTimestamp() 
      };
      transaction.update(roomRef, {
        currentWinners: admin.firestore.FieldValue.arrayUnion(winnerEntry)
      });

      const updatedRules = roomData.rules.map(r => {
        if (r.id === claimData.prizeRuleId) {
          const newClaimsArray = Array.isArray(r.claims) ? r.claims : [];
          return {
            ...r,
            claims: [...newClaimsArray, { 
              userId: claimData.userId,
              playerName: claimData.playerName,
              ticketId: claimData.ticketId,
              claimId: claimId 
            }]
          };
        }
        return r;
      });
      transaction.update(roomRef, { rules: updatedRules });

      logger.info(`Prize claim ${claimId} approved by admin ${adminUID} for player ${claimData.userId}. Awarded: ${coinsAwarded}`);
      return { message: "Prize claim approved.", coinsAwarded: coinsAwarded };

    } else if (action === "reject") {
      transaction.update(claimRef, {
        status: "rejected_admin",
        reason: reason || "Rejected by admin.",
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedBy: adminUID
      });
      logger.info(`Prize claim ${claimId} rejected by admin ${adminUID}`);
      return { message: "Prize claim rejected." };
    } else {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid action specified for prize claim.');
    }
  });
});

// --- Player Functions ---

exports.joinGameRoom = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const playerUID = context.auth.uid;
  const { roomId, playerName } = data;

  if (!roomId || !playerName) {
    throw new functions.https.HttpsError('invalid-argument', 'Room ID and player name are required.');
  }

  const roomRef = db.collection('rooms').doc(roomId);
  try {
    const roomDoc = await roomRef.get();
    if (!roomDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Game room not found.');
    }
    const roomData = roomDoc.data();
    if (roomData.gameStatus === "stopped") {
      throw new functions.https.HttpsError('failed-precondition', 'Cannot join room, game has ended.');
    }
    if (roomData.gameStatus === "error") { 
        throw new functions.https.HttpsError('failed-precondition', 'Cannot join room due to room error.');
    }

    const playerPath = `currentActivePlayers.${playerUID}`;
    const currentPlayerData = (roomData.currentActivePlayers && roomData.currentActivePlayers[playerUID]) ? roomData.currentActivePlayers[playerUID] : {};
    
    await roomRef.update({
      [`${playerPath}.playerName`]: playerName, 
      [`${playerPath}.ticketCount`]: currentPlayerData.ticketCount || 0, 
      [`${playerPath}.lastSeen`]: admin.firestore.FieldValue.serverTimestamp()
    });
    logger.info(`Player ${playerUID} (${playerName}) joined/updated in room ${roomId}`);
    return { success: true, message: `Successfully joined room ${roomId}. Welcome, ${playerName}!` };
  } catch (error) {
    logger.error(`Error joining room ${roomId} for player ${playerUID}:`, error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Could not join game room.', error.message);
  }
});

exports.requestGameTicket = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const playerUID = context.auth.uid;
  const { roomId } = data;


  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Room ID is required.');
  }

  const roomRef = db.collection('rooms').doc(roomId);
  const roomDoc = await roomRef.get();

  if (!roomDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Room not found.');
  }
  const roomData = roomDoc.data();
  const playerData = (roomData.currentActivePlayers && roomData.currentActivePlayers[playerUID]) ? roomData.currentActivePlayers[playerUID] : null;


  if (!playerData || !playerData.playerName) { 
    throw new functions.https.HttpsError('failed-precondition', 'Player not found in room or player name missing. Please ensure you have joined the room with a name first.');
  }
  if (roomData.gameStatus !== "idle" && roomData.gameStatus !== "running" && roomData.gameStatus !== "paused") {
      throw new functions.https.HttpsError('failed-precondition', `Cannot request tickets when game status is '${roomData.gameStatus}'. Tickets can usually be requested when idle, running, or paused.`);
  }

  const maxTicketsPerPlayer = roomData.maxTicketsPerPlayer || 5; 
  if ((playerData.ticketCount || 0) >= maxTicketsPerPlayer) {
      throw new functions.https.HttpsError('failed-precondition', `You have reached the maximum of ${maxTicketsPerPlayer} tickets for this game.`);
  }

  const newRequestRef = db.collection('rooms').doc(roomId).collection('ticketRequests').doc(); 
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
    throw new functions.https.HttpsError('internal', 'Could not submit ticket request.', error.message);
  }
});

exports.submitPrizeClaim = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const playerUID = context.auth.uid;
  const { roomId, ticketId, prizeRuleId, claimedNumbersOnTicket, clientTempClaimId } = data; 

  if (!roomId || !ticketId || !prizeRuleId || !Array.isArray(claimedNumbersOnTicket) || claimedNumbersOnTicket.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Room ID, ticket ID, prize rule ID, and a non-empty array of claimed numbers are required.');
  }

  const roomRef = db.collection('rooms').doc(roomId);
  const ticketRef = db.collection('gameTickets').doc(ticketId);
  const newClaimRef = db.collection('prizeClaimsAudit').doc(); 

  return db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.get(roomRef);
    const ticketDoc = await transaction.get(ticketRef);

    if (!roomDoc.exists) throw new functions.https.HttpsError('not-found', 'Game room not found.');
    if (!ticketDoc.exists) throw new functions.https.HttpsError('not-found', 'Ticket not found.');

    const roomData = roomDoc.data();
    const ticketData = ticketDoc.data();
    const playerData = (roomData.currentActivePlayers && roomData.currentActivePlayers[playerUID]) ? roomData.currentActivePlayers[playerUID] : null;

    if (!playerData || !playerData.playerName) {
        throw new functions.https.HttpsError('failed-precondition', 'Player not found in room or player name missing. Please ensure you have joined the room.');
    }
    if (ticketData.userId !== playerUID) throw new functions.https.HttpsError('permission-denied', 'This ticket does not belong to you.');
    if (ticketData.roomId !== roomId) throw new functions.https.HttpsError('invalid-argument', 'This ticket does not belong to the specified room.');
    if (roomData.gameStatus !== "running") throw new functions.https.HttpsError('failed-precondition', `Claims can only be submitted when game is running. Current status: ${roomData.gameStatus}`);

    const ruleBeingClaimed = roomData.rules.find(r => r.id === prizeRuleId);
    if (!ruleBeingClaimed) throw new functions.https.HttpsError('not-found', `Rule ID ${prizeRuleId} not found in room configuration.`);
    if (!ruleBeingClaimed.isActive) throw new functions.https.HttpsError('failed-precondition', `Prize '${ruleBeingClaimed.name}' is currently not active.`);

    const claimsForThisRuleArray = ruleBeingClaimed.claims || []; 
    if (claimsForThisRuleArray.length >= ruleBeingClaimed.maxPrizes) {
        throw new functions.https.HttpsError('failed-precondition', `Maximum prizes for '${ruleBeingClaimed.name}' already claimed by others.`);
    }
    const existingPlayerClaimForThisRuleOnTicket = await db.collection('prizeClaimsAudit')
        .where('userId', '==', playerUID)
        .where('roomId', '==', roomId)
        .where('ticketId', '==', ticketId)
        .where('prizeRuleId', '==', prizeRuleId)
        .where('status', 'in', ['pending_admin_approval', 'approved'])
        .get();

    if (!existingPlayerClaimForThisRuleOnTicket.empty) {
         throw new functions.https.HttpsError('failed-precondition', `You have already submitted or won a claim for '${ruleBeingClaimed.name}' on this ticket.`);
    }
    
    const serverValidationResult = validatePrizePattern(
      ticketData.numbers,         
      claimedNumbersOnTicket,     
      roomData.currentNumbersCalled || [], 
      ruleBeingClaimed            
    );

    let claimStatus;
    let reason = "";
    let effectivelyClaimedNumbers = claimedNumbersOnTicket; 

    if (serverValidationResult) {
      claimStatus = "pending_admin_approval"; 
      logger.info(`Prize claim by ${playerUID} for rule ${prizeRuleId} in room ${roomId} passed server validation.`);
    } else {
      claimStatus = "rejected_auto_invalid"; 
      reason = "Automatic validation failed: The claimed numbers do not fulfill the prize pattern requirements based on the called numbers and your ticket.";
      logger.warn(`Prize claim by ${playerUID} for rule ${prizeRuleId} in room ${roomId} failed server validation. Reason: ${reason}`);
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
      claimedNumbersOnTicket: claimedNumbersOnTicket, 
      effectivelyClaimedNumbers: effectivelyClaimedNumbers, 
      status: claimStatus,
      reason: reason,
      serverValidationResult: serverValidationResult, 
      claimTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      coinsAwarded: 0 
    });

    return {
      success: true, 
      claimId: newClaimRef.id, 
      status: claimStatus,
      serverValidationResult: serverValidationResult,
      message: claimStatus === "pending_admin_approval" ? "Claim submitted and awaiting admin approval." : `Claim submission ${serverValidationResult ? "partially successful" : "failed automatic validation"}: ${reason || "Please check the numbers."}`
    };
  });
});
