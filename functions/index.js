// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require("firebase-functions");
const { logger } = functions;

// The Firebase Admin SDK to access Firebase services from the backend.
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// --- Helper Functions ---

/**
 * Generates a unique Room ID.
 */
function generateRoomId() {
  return Math.random().toString().slice(2, 8);
}

/**
 * Generates a valid Tambola ticket (3x9 grid, 15 numbers).
 * Rules:
 * - Each row has exactly 5 numbers.
 * - Each column has numbers from its respective range (1-9, 10-19, ..., 80-90).
 * - Each column must have at least one number.
 * - Numbers in a column are sorted.
 * Returns a 2D array representing the ticket.
 */
function generateTambolaTicket() {
  let ticket = Array(3).fill(null).map(() => Array(9).fill(null));
  let numbers = new Set(); // To ensure unique numbers on the ticket

  // Helper to get a random number in a column's range, not already used
  const getRandomNumForCol = (colIndex) => {
    const min = colIndex * 10 + (colIndex === 8 ? 0 : 1); // Col 8 is 80-90, others X1-X9
    const max = colIndex * 10 + (colIndex === 8 ? 10 : 9); // Col 8 is 80-90
    let num;
    let attempts = 0;
    do {
      num = Math.floor(Math.random() * (max - min + 1)) + min;
      attempts++;
    } while (numbers.has(num) && attempts < 20); // Avoid infinite loop for dense columns
    if (numbers.has(num)) return null; // Could not find unique number easily
    return num;
  };

  // Phase 1: Ensure each column has at least one number
  for (let j = 0; j < 9; j++) {
    const rowIndex = Math.floor(Math.random() * 3);
    let num = getRandomNumForCol(j);
    if (num) {
      ticket[rowIndex][j] = num;
      numbers.add(num);
    } else {
      // Fallback: if failed to get unique, try again or this column might be empty if ranges are full
      // This indicates a potential issue if it happens often. For simplicity, we retry once.
      num = getRandomNumForCol(j);
      if (num) {
          ticket[rowIndex][j] = num;
          numbers.add(num);
      } else {
          // If still fails, this ticket generation might fail to meet all constraints.
          // A more robust generator might backtrack or use different strategies.
          logger.warn(`Could not place initial number in column ${j}`);
      }
    }
  }

  // Phase 2: Fill remaining spots to ensure each row has 5 numbers
  for (let i = 0; i < 3; i++) {
    let numsInRow = ticket[i].filter(n => n !== null).length;
    let availableCols = [];
    for(let k=0; k<9; k++) availableCols.push(k); // All columns initially
    // Shuffle available columns to pick from randomly
    availableCols.sort(() => 0.5 - Math.random());

    while (numsInRow < 5 && availableCols.length > 0) {
      const colIndex = availableCols.pop(); // Get a random available column index
      if (ticket[i][colIndex] === null) { // If cell is empty
        // Check how many numbers already in this column to not overpopulate (max 2 or 3 is typical)
        let numsInCol = 0;
        for(let r=0; r<3; r++) if(ticket[r][colIndex] !== null) numsInCol++;

        if (numsInCol < 2) { // Allow max 2 numbers per column for this generator for simplicity.
                             // Tambola allows up to 3 sometimes, adjust if needed.
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

  // Phase 3: Verification and minor adjustments if constraints not perfectly met
  // Count total numbers. If not 15, or row constraints not met, this generator is flawed.
  let totalNumbers = 0;
  ticket.forEach(row => row.forEach(n => { if (n) totalNumbers++; }));

  if (totalNumbers !== 15) {
      logger.error("Ticket generation failed: Did not produce 15 numbers. Generated:", totalNumbers, ticket);
      // Fallback to a simpler, potentially less "correct" ticket or throw error
      // For now, returning what we have, but this needs robust handling.
      // This might happen if getRandomNumForCol consistently fails.
      // A production system needs a highly reliable ticket generator.
  }
   // Ensure each row has 5 numbers (simple post-check, might not be fixable here without complex logic)
  for(let i=0; i<3; i++) {
      if (ticket[i].filter(n => n !== null).length !== 5) {
          logger.warn(`Row ${i} does not have 5 numbers. This indicates an issue with generation logic.`);
          // Attempt a quick fix (very naive) by trying to fill from remaining numbers
          // This part is complex and requires careful logic to not violate other rules
      }
  }


  // Phase 4: Sort numbers within columns (optional, but good for display)
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

  logger.info("Generated Ticket:", ticket);
  return ticket;
}

/**
 * Validates if a claimed pattern is achieved.
 * @param {Array<Array<number|null>>} ticketNumbers - The player's ticket grid.
 * @param {Array<number>} claimedNumbersOnTicket - Numbers *marked by player* for this claim.
 * @param {Array<number>} gameCalledNumbers - All numbers called in the game.
 * @param {object} rule - The prize rule object (should have an id or name like 'earlyFive', 'line1', 'fullHouse', 'corners').
 * @returns {boolean} - True if the claim is valid.
 */
function validatePrizePattern(ticketNumbers, claimedNumbersOnTicket, gameCalledNumbers, rule) {
  logger.info("Validating prize:", rule.name, "Player Claimed Nums:", claimedNumbersOnTicket, "Game Called Nums:", gameCalledNumbers);

  // 1. All numbers claimed by the player MUST have been called in the game.
  const allClaimedAreCalled = claimedNumbersOnTicket.every(num => gameCalledNumbers.includes(num));
  if (!allClaimedAreCalled) {
    logger.warn("Validation failed: Not all numbers claimed by player were actually called in the game.");
    return false;
  }

  // 2. All numbers claimed by the player MUST exist on their ticket.
  const ticketFlatNumbers = ticketNumbers.flat().filter(n => n !== null);
  const allClaimedAreOnTicket = claimedNumbersOnTicket.every(num => ticketFlatNumbers.includes(num));
  if (!allClaimedAreOnTicket) {
    logger.warn("Validation failed: Not all numbers claimed by player exist on their ticket.");
    return false;
  }

  const ruleId = rule.id ? rule.id.toLowerCase() : rule.name.toLowerCase();

  switch (ruleId) {
    case 'earlyfive': // Assuming rule.id or rule.name is 'earlyFive' or similar
    case 'early five':
    case 'early_five':
      // Player claims 5 specific numbers on their ticket.
      // We've already checked they are called and on the ticket.
      // The validation is that they have *at least* 5 such numbers.
      if (claimedNumbersOnTicket.length < 5) {
        logger.warn("Early Five validation failed: Less than 5 numbers claimed.");
        return false;
      }
      // Ensure all 5 (or more claimed) are indeed on the ticket and were called (already checked).
      logger.info("Early Five validation: Passed.");
      return true;

    case 'line1':
    case 'line 1':
    case 'first line':
    case 'topline':
    case 'top line':
      const line1Numbers = ticketNumbers[0].filter(n => n !== null);
      if (line1Numbers.length !== 5) { // Should always be 5 from generator
          logger.warn("Line 1 validation warning: Ticket row 0 does not have 5 numbers.");
          return false; // Or handle as error in ticket.
      }
      // All 5 numbers of line 1 must be in claimedNumbersOnTicket
      const line1Claimed = line1Numbers.every(num => claimedNumbersOnTicket.includes(num));
      if (!line1Claimed) logger.warn("Line 1 validation failed: Not all numbers from line 1 are in player's claim.");
      else logger.info("Line 1 validation: Passed.");
      return line1Claimed;

    case 'line2':
    case 'line 2':
    case 'second line':
    case 'middleline':
    case 'middle line':
      const line2Numbers = ticketNumbers[1].filter(n => n !== null);
      if (line2Numbers.length !== 5) {
          logger.warn("Line 2 validation warning: Ticket row 1 does not have 5 numbers.");
          return false;
      }
      const line2Claimed = line2Numbers.every(num => claimedNumbersOnTicket.includes(num));
      if (!line2Claimed) logger.warn("Line 2 validation failed: Not all numbers from line 2 are in player's claim.");
      else logger.info("Line 2 validation: Passed.");
      return line2Claimed;

    case 'line3':
    case 'line 3':
    case 'third line':
    case 'bottomline':
    case 'bottom line':
      const line3Numbers = ticketNumbers[2].filter(n => n !== null);
      if (line3Numbers.length !== 5) {
          logger.warn("Line 3 validation warning: Ticket row 2 does not have 5 numbers.");
          return false;
      }
      const line3Claimed = line3Numbers.every(num => claimedNumbersOnTicket.includes(num));
      if (!line3Claimed) logger.warn("Line 3 validation failed: Not all numbers from line 3 are in player's claim.");
      else logger.info("Line 3 validation: Passed.");
      return line3Claimed;

    case 'corners':
    case 'fourcorners':
    case 'four corners':
      const corners = [];
      // First number of first row
      for(let j=0; j<9; j++) if(ticketNumbers[0][j] !== null) { corners.push(ticketNumbers[0][j]); break; }
      // Last number of first row
      for(let j=8; j>=0; j--) if(ticketNumbers[0][j] !== null) { corners.push(ticketNumbers[0][j]); break; }
      // First number of last row
      for(let j=0; j<9; j++) if(ticketNumbers[2][j] !== null) { corners.push(ticketNumbers[2][j]); break; }
      // Last number of last row
      for(let j=8; j>=0; j--) if(ticketNumbers[2][j] !== null) { corners.push(ticketNumbers[2][j]); break; }

      if (corners.length !== 4) { // Should be 4 if ticket is valid
        logger.warn("Corners validation warning: Could not identify 4 corner numbers on the ticket.");
        return false;
      }
      const cornersClaimed = corners.every(num => claimedNumbersOnTicket.includes(num));
      if (!cornersClaimed) logger.warn("Corners validation failed: Not all 4 corner numbers are in player's claim.");
      else logger.info("Corners validation: Passed.");
      return cornersClaimed;

    case 'fullhouse':
    case 'full house':
      // All 15 numbers on the ticket must be in claimedNumbersOnTicket.
      if (ticketFlatNumbers.length !== 15) {
        logger.warn("Full House validation warning: Ticket does not have 15 numbers.");
        return false; // Or handle as error in ticket.
      }
      const fullHouseClaimed = ticketFlatNumbers.every(num => claimedNumbersOnTicket.includes(num)) &&
                               claimedNumbersOnTicket.length >= ticketFlatNumbers.length; // Ensure player claimed at least all numbers
      if (!fullHouseClaimed) logger.warn("Full House validation failed: Not all 15 ticket numbers are in player's claim, or player claimed too few.");
      else logger.info("Full House validation: Passed.");
      return fullHouseClaimed;

    default:
      logger.warn(`Unknown prize rule ID for validation: '${ruleId}'. Claim rejected.`);
      return false;
  }
}


// --- Authentication Check ---
function ensureAuthenticated(context) {
  if (!context.auth) {
    logger.error("Authentication check failed: User not authenticated.");
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
}

// --- Admin Functions ---

exports.createGameRoom = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const adminUID = context.auth.uid;
  const { adminDisplayName, rules, autoCallInterval, ticketPrice } = data;

  if (!adminDisplayName || !rules || !Array.isArray(rules) || ticketPrice === undefined || ticketPrice < 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Admin display name, rules array, and a valid ticket price are required.');
  }

  const roomId = generateRoomId();
  const roomRef = db.collection('rooms').doc(roomId);

  const initializedRules = rules.map((rule, index) => ({
    id: rule.id || `rule_${index}_${Date.now()}`,
    name: rule.name,
    description: rule.description || '',
    coinsPerPrize: rule.coinsPerPrize || 0, // Fixed amount
    percentageOfTotal: rule.percentageOfTotal || 0, // Percentage of total collected money
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
      ticketPrice: Number(ticketPrice), // Ensure it's a number
      totalMoneyCollected: 0,
    });
    logger.info(`Room ${roomId} created by admin ${adminUID}`);
    return { roomId, message: "Game room created successfully." };
  } catch (error) {
    logger.error("Error creating game room:", error);
    throw new functions.https.HttpsError('internal', 'Could not create game room.', error.message);
  }
});

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
        claims: rule.claims || [], // Retain existing claims if rule ID matches, or reset if new rules array
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
            currentNumbersCalled: [], // Reset numbers
            currentLatestCalledNumber: null,
            currentWinners: [] // Reset winners
        };
        // Reset claims on rules when starting a new game session
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
    if (manualNumberInput !== undefined && manualNumberInput !== null) { // Manual call
      const number = parseInt(manualNumberInput);
      if (isNaN(number) || number < 1 || number > 90) {
        throw new functions.https.HttpsError('invalid-argument', 'Manual number must be between 1 and 90.');
      }
      if (currentNumbersCalled.includes(number)) {
        throw new functions.https.HttpsError('invalid-argument', `Number ${number} has already been called.`);
      }
      nextNumber = number;
    } else { // Auto call (or admin presses button for next random)
      let attempts = 0;
      do {
        nextNumber = Math.floor(Math.random() * 90) + 1;
        attempts++;
        if (attempts > 200) { // Safety break for unlikely scenario where random fails many times
            logger.error(`Room ${roomId}: Could not find an uncalled number after 200 attempts.`);
            throw new functions.https.HttpsError('internal', 'Could not determine next number to call.');
        }
      } while (currentNumbersCalled.includes(nextNumber));
    }

    currentNumbersCalled.push(nextNumber);
    transaction.update(roomRef, {
      currentNumbersCalled: currentNumbersCalled,
      currentLatestCalledNumber: nextNumber
    });
    logger.info(`Room ${roomId}: Number ${nextNumber} called by admin ${adminUID}`);
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
    const roomData = roomDoc.data(); // For ticketPrice

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
      const currentTicketCount = (roomData.currentActivePlayers[playerUID] && roomData.currentActivePlayers[playerUID].ticketCount) || 0;
      transaction.update(roomRef, {
        [playerPathInRoom]: currentTicketCount + 1, // More robust increment
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
    if (claimData.status !== "pending_admin_approval") { // Admin can only act on claims pending their approval
      throw new functions.https.HttpsError('failed-precondition', `Claim cannot be processed by admin. Current status: ${claimData.status}`);
    }

    const ruleBeingClaimed = roomData.rules.find(r => r.id === claimData.prizeRuleId);
    if (!ruleBeingClaimed) {
      transaction.update(claimRef, { status: "rejected_admin", reason: "Rule configuration not found.", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: adminUID });
      throw new functions.https.HttpsError('not-found', `Rule ID ${claimData.prizeRuleId} not found in room configuration.`);
    }

    if (action === "approve") {
      const existingClaimsForThisRule = roomData.rules.find(r => r.id === claimData.prizeRuleId)?.claims || [];
      if (existingClaimsForThisRule.length >= ruleBeingClaimed.maxPrizes) {
        const rejectMsg = `Maximum prizes for '${ruleBeingClaimed.name}' already claimed.`;
        transaction.update(claimRef, { status: "rejected_admin", reason: rejectMsg, reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: adminUID });
        throw new functions.https.HttpsError('failed-precondition', rejectMsg);
      }

      let coinsAwarded = 0;
      if (ruleBeingClaimed.percentageOfTotal && ruleBeingClaimed.percentageOfTotal > 0 && roomData.totalMoneyCollected > 0) {
          coinsAwarded = (Number(ruleBeingClaimed.percentageOfTotal) / 100) * Number(roomData.totalMoneyCollected);
      } else {
          coinsAwarded = Number(ruleBeingClaimed.coinsPerPrize) || 0;
      }
      // If maxPrizes > 1 for this rule, prize might be split. Simple split for now.
      // More complex scenarios (e.g. fixed prize per winner up to maxPrizes) can be added.
      if (ruleBeingClaimed.maxPrizes > 1 && ruleBeingClaimed.percentageOfTotal > 0) {
          // If it's a percentage of total, and multiple winners, the total pool for this prize is split.
          // This coinsAwarded is the total pool for THIS specific rule.
          // If we want to split it among current approved winners for this rule, that's more complex state to manage.
          // For now, each approved claim gets this calculated amount.
          // This means if percentageOfTotal is 10% and maxPrizes is 2, each winner gets 10% of total.
          // Alternative: prize pool is 10%, divided by maxPrizes. Let's assume each gets the full share for now up to maxPrizes.
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
        timestamp: admin.firestore.FieldValue.serverTimestamp() // Use claim approval time
      };
      transaction.update(roomRef, {
        currentWinners: admin.firestore.FieldValue.arrayUnion(winnerEntry)
      });

      const updatedRules = roomData.rules.map(r => {
        if (r.id === claimData.prizeRuleId) {
          const newClaimsArray = Array.isArray(r.claims) ? r.claims : [];
          return {
            ...r,
            claims: [...newClaimsArray, { // Use spread to ensure it's an array operation
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
    if (roomData.gameStatus === "stopped" || roomData.gameStatus === "error") {
      throw new functions.https.HttpsError('failed-precondition', 'Cannot join room, game is not active or has ended.');
    }
    // Prevent joining if game is running and already has numbers called (optional rule)
    // if (roomData.gameStatus === "running" && roomData.currentNumbersCalled && roomData.currentNumbersCalled.length > 0) {
    //   throw new functions.https.HttpsError('failed-precondition', 'Cannot join room, game is already in progress.');
    // }


    const playerPath = `currentActivePlayers.${playerUID}`;
    const currentPlayerData = roomData.currentActivePlayers[playerUID] || {};
    await roomRef.update({
      [playerPath]: {
        playerName: playerName,
        ticketCount: currentPlayerData.ticketCount || 0, // Preserve ticket count if rejoining
        lastSeen: admin.firestore.FieldValue.serverTimestamp()
      }
    });
    logger.info(`Player ${playerUID} (${playerName}) joined/updated in room ${roomId}`);
    return { message: `Successfully joined room ${roomId}.` };
  } catch (error) {
    logger.error(`Error joining room ${roomId} for player ${playerUID}:`, error);
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
  const playerData = roomData.currentActivePlayers ? roomData.currentActivePlayers[playerUID] : null;

  if (!playerData) {
    throw new functions.https.HttpsError('failed-precondition', 'Player not found in room. Please join the room first.');
  }
  if (roomData.gameStatus !== "idle" && roomData.gameStatus !== "running" && roomData.gameStatus !== "paused") {
      throw new functions.https.HttpsError('failed-precondition', `Cannot request tickets when game status is '${roomData.gameStatus}'. Tickets can be requested when idle, running, or paused.`);
  }
  // Optionally, add max tickets per player logic here.
  // const MAX_TICKETS_PER_PLAYER = 3; // Example
  // if ((playerData.ticketCount || 0) >= MAX_TICKETS_PER_PLAYER) {
  //    throw new functions.https.HttpsError('resource-exhausted', `Maximum ticket limit (${MAX_TICKETS_PER_PLAYER}) reached for this game.`);
  // }


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
    logger.info(`Ticket request ${newRequestRef.id} submitted by player ${playerUID} for room ${roomId}`);
    return { requestId: newRequestRef.id, message: "Ticket request submitted successfully. Waiting for admin approval." };
  } catch (error) {
    logger.error(`Error submitting ticket request for player ${playerUID}:`, error);
    throw new functions.https.HttpsError('internal', 'Could not submit ticket request.', error.message);
  }
});

exports.submitPrizeClaim = functions.https.onCall(async (data, context) => {
  ensureAuthenticated(context);
  const playerUID = context.auth.uid;
  const { roomId, ticketId, prizeRuleId, claimedNumbersOnTicket } = data; // claimedNumbersOnTicket is what player *thinks* completes the prize

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

    if (ticketData.userId !== playerUID) throw new functions.https.HttpsError('permission-denied', 'This ticket does not belong to you.');
    if (ticketData.roomId !== roomId) throw new functions.https.HttpsError('invalid-argument', 'This ticket does not belong to the specified room.');
    if (roomData.gameStatus !== "running") throw new functions.https.HttpsError('failed-precondition', `Claims can only be submitted when game is running. Current status: ${roomData.gameStatus}`);

    const ruleBeingClaimed = roomData.rules.find(r => r.id === prizeRuleId);
    if (!ruleBeingClaimed) throw new functions.https.HttpsError('not-found', `Rule ID ${prizeRuleId} not found in room configuration.`);
    if (!ruleBeingClaimed.isActive) throw new functions.https.HttpsError('failed-precondition', `Prize '${ruleBeingClaimed.name}' is currently not active.`);

    const existingClaimsForThisRule = ruleBeingClaimed.claims || [];
    if (existingClaimsForThisRule.length >= ruleBeingClaimed.maxPrizes) {
        throw new functions.https.HttpsError('failed-precondition', `Maximum prizes for '${ruleBeingClaimed.name}' already claimed by others.`);
    }
    const playerAlreadyClaimedThisRule = existingClaimsForThisRule.find(claim => claim.userId === playerUID && claim.ticketId === ticketId);
    if (playerAlreadyClaimedThisRule) { // Player cannot claim same prize on same ticket twice
         throw new functions.https.HttpsError('failed-precondition', `You have already submitted a claim for '${ruleBeingClaimed.name}' on this ticket.`);
    }

    // Server-side validation of the claim pattern
    const serverValidationResult = validatePrizePattern(
      ticketData.numbers,         // The actual ticket grid
      claimedNumbersOnTicket,     // Numbers player is claiming with
      roomData.currentNumbersCalled || [], // Numbers called so far in game
      ruleBeingClaimed            // The rule object
    );

    let claimStatus;
    let reason = "";
    let effectivelyClaimedNumbers = [];

    if (serverValidationResult) {
      claimStatus = "pending_admin_approval";
      effectivelyClaimedNumbers = claimedNumbersOnTicket; // Server agrees with player's claimed numbers for the pattern
      logger.info(`Prize claim by ${playerUID} for rule ${prizeRuleId} in room ${roomId} passed server validation.`);
    } else {
      claimStatus = "rejected_auto_invalid";
      reason = "Automatic validation failed: Pattern not achieved with claimed numbers or claimed numbers not called/on ticket.";
      logger.warn(`Prize claim by ${playerUID} for rule ${prizeRuleId} in room ${roomId} failed server validation. Reason: ${reason}`);
    }

    transaction.set(newClaimRef, {
      claimId: newClaimRef.id,
      userId: playerUID,
      playerName: roomData.currentActivePlayers[playerUID]?.playerName || 'Unknown Player',
      roomId: roomId,
      ticketId: ticketId,
      prizeRuleId: prizeRuleId,
      prizeName: ruleBeingClaimed.name,
      clientTempClaimId: data.clientTempClaimId || null,
      claimedNumbersOnTicket: claimedNumbersOnTicket, // What player sent
      effectivelyClaimedNumbers: effectivelyClaimedNumbers, // What server confirmed (if valid)
      status: claimStatus,
      reason: reason,
      serverValidationResult: serverValidationResult,
      claimTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      coinsAwarded: 0
    });

    return {
      claimId: newClaimRef.id,
      status: claimStatus,
      serverValidationResult: serverValidationResult,
      message: claimStatus === "pending_admin_approval" ? "Claim submitted and awaiting admin approval." : `Claim submission failed automatic validation: ${reason}`
    };
  });
});
