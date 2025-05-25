// Ensure Firebase and other scripts are loaded
// Global vars for current game state
let currentAdminUID = null;
let currentGameRoomId = null;
let roomListener = null; // Firestore listener for room updates
let playersListener = null;
let ticketRequestsListener = null;
let prizeClaimsListener = null;

// DOM Elements (examples, get all you need)
const adminContent = document.getElementById('adminContent');
const authFlowMessage = document.getElementById('authFlowMessage');
const inputAdminDisplayName = document.getElementById('inputAdminDisplayName');
const inputRoomId = document.getElementById('inputRoomId');
const btnCreateOrJoinRoom = document.getElementById('btnCreateOrJoinRoom');
const currentRoomIdDisplay = document.getElementById('currentRoomIdDisplay');
const qrCodeContainer = document.getElementById('qrCodeContainer'); // For QR code display

const inputGameRules = document.getElementById('inputGameRules');
const btnSetGameRules = document.getElementById('btnSetGameRules');
const btnStartGame = document.getElementById('btnStartGame');
const btnCallNumberManual = document.getElementById('btnCallNumberManual');
const selectAutoCall = document.getElementById('selectAutoCall');
const autoCallIntervalInput = document.getElementById('autoCallInterval');
const btnPauseResumeAutoCall = document.getElementById('btnPauseResumeAutoCall');
const btnStopGame = document.getElementById('btnStopGame');
const calledNumbersDisplayAdmin = document.getElementById('calledNumbersDisplayAdmin');
const latestCalledNumberAdmin = document.getElementById('latestCalledNumberAdmin');

const gameControlsSection = document.getElementById('gameControlsSection');
const connectedPlayersSection = document.getElementById('connectedPlayersSection');
const ticketRequestsSection = document.getElementById('ticketRequestsSection');
const prizeClaimsSection = document.getElementById('prizeClaimsSection');
const gameSummarySection = document.getElementById('gameSummarySection');

const playersListDiv = document.getElementById('playersList');
const ticketRequestsListDiv = document.getElementById('ticketRequestsList');
const prizeClaimsListDiv = document.getElementById('prizeClaimsList');
const gameWinnersDisplay = document.getElementById('gameWinnersDisplay');

// --- AUTHENTICATION LOGIC (Leveraging common/js/auth.js) ---
auth.onAuthStateChanged(user => {
    if (user) {
        currentAdminUID = user.uid;
        adminContent.classList.remove('hidden');
        authFlowMessage.classList.add('hidden');
        document.getElementById('adminDisplayName').textContent = user.displayName || user.email;
        // Auto-fill admin display name if available from profile, or allow editing
        if (user.displayName) {
            inputAdminDisplayName.value = user.displayName;
        }
        console.log("Admin signed in: ", user.uid);
        // You might want to check if this user is a designated admin in Firestore
        // or if they have an existing room.
    } else {
        currentAdminUID = null;
        currentGameRoomId = null;
        adminContent.classList.add('hidden');
        authFlowMessage.classList.remove('hidden');
        gameControlsSection.classList.add('hidden');
        connectedPlayersSection.classList.add('hidden');
        ticketRequestsSection.classList.add('hidden');
        prizeClaimsSection.classList.add('hidden');
        gameSummarySection.classList.add('hidden');
        clearRoomListeners(); // Clear listeners when admin signs out
        console.log("Admin signed out or not signed in.");
    }
});


// --- ROOM MANAGEMENT ---
btnCreateOrJoinRoom.addEventListener('click', async () => {
    const adminName = inputAdminDisplayName.value.trim();
    let roomId = inputRoomId.value.trim().toUpperCase();

    if (!adminName) {
        alert("Please enter an Admin Display Name.");
        return;
    }
    if (!currentAdminUID) {
        alert("Please sign in first.");
        return;
    }

    if (!roomId) { // Create new room
        roomId = generateRoomId(); // Implement generateRoomId() in utils.js or here
        try {
            await db.collection('rooms').doc(roomId).set({
                adminUID: currentAdminUID,
                adminDisplayName: adminName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                gameStatus: 'idle', // "idle", "loading", "running", "paused", "stopped"
                currentNumbersCalled: [],
                currentLatestCalledNumber: null,
                callingMode: 'manual', // "manual" or "auto"
                autoCallInterval: 5, // seconds
                rules: [], // {id, name, description, percentage, claims}
                totalMoneyCollected: 0, // Or based on ticket price * count
                currentActivePlayers: {}
            });
            alert(`Room ${roomId} created successfully! Share this ID with players.`);
            joinRoom(roomId, adminName);
        } catch (error) {
            console.error("Error creating room: ", error);
            alert("Error creating room: " + error.message);
        }
    } else { // Join existing room (as admin)
        const roomRef = db.collection('rooms').doc(roomId);
        const roomSnap = await roomRef.get();
        if (roomSnap.exists && roomSnap.data().adminUID === currentAdminUID) {
            alert(`Rejoined room ${roomId} as admin.`);
            joinRoom(roomId, roomSnap.data().adminDisplayName || adminName);
             // Update admin display name if it was changed and the current input is different
            if (adminName !== roomSnap.data().adminDisplayName) {
                await roomRef.update({ adminDisplayName: adminName });
            }
        } else if (roomSnap.exists) {
            alert("Error: You are not the admin of this room or room ID is incorrect.");
        } else {
            alert("Error: Room not found. Check the Room ID or create a new room.");
        }
    }
});

function joinRoom(roomId, adminName) {
    currentGameRoomId = roomId;
    currentRoomIdDisplay.textContent = roomId;
    inputRoomId.value = roomId; // Keep it in the input for reference
    inputAdminDisplayName.value = adminName; // Reflect current admin name for this room
    gameControlsSection.classList.remove('hidden');
    connectedPlayersSection.classList.remove('hidden');
    ticketRequestsSection.classList.remove('hidden');
    prizeClaimsSection.classList.remove('hidden');
    // gameSummarySection might be shown based on gameStatus

    // Generate and display QR code for players to join
    if (window.generateQrCode && qrCodeContainer) { // Check if generateQrCode from utils.js is available
        const joinUrl = `${window.location.origin}/player/player.html?roomId=${roomId}`;
        qrCodeContainer.innerHTML = ''; // Clear previous QR
        generateQrCode(qrCodeContainer, joinUrl); // utils.js should handle this
    }


    // Attach Firestore listeners for real-time updates
    attachRoomListeners(roomId);
}

function clearRoomListeners() {
    if (roomListener) roomListener();
    if (playersListener) playersListener();
    if (ticketRequestsListener) ticketRequestsListener();
    if (prizeClaimsListener) prizeClaimsListener();
    roomListener = null;
    playersListener = null;
    ticketRequestsListener = null;
    prizeClaimsListener = null;
}

function attachRoomListeners(roomId) {
    clearRoomListeners(); // Clear any existing listeners first

    // Listener for general room data (status, numbers, rules)
    roomListener = db.collection('rooms').doc(roomId)
        .onSnapshot((doc) => {
            if (doc.exists) {
                const roomData = doc.data();
                console.log("Room data updated: ", roomData);
                updateGameControlsUI(roomData);
                updateCalledNumbersUI(roomData.currentNumbersCalled, roomData.currentLatestCalledNumber);
                // Update rules display, etc.
                if(inputGameRules && roomData.rules) {
                    inputGameRules.value = roomData.rules.map(r => `${r.name}:${r.percentage}`).join(',');
                }
                if (roomData.gameStatus === 'stopped' && roomData.gameSummary) {
                    displayGameSummary(roomData.gameSummary, roomData.currentWinners);
                    gameSummarySection.classList.remove('hidden');
                } else {
                    gameSummarySection.classList.add('hidden');
                }
            } else {
                console.log("Room deleted or not found.");
                alert("The game room no longer exists.");
                // Reset UI to pre-join state
                currentGameRoomId = null;
                gameControlsSection.classList.add('hidden');
                // ... hide other sections ...
            }
        }, (error) => {
            console.error("Error listening to room updates: ", error);
        });

    // Listener for connected players (from currentActivePlayers map in room document)
    // This is already part of the main room listener, but you can also listen to a subcollection if you change structure.
    // For now, we'll parse it from roomData.currentActivePlayers

    // Listener for ticket requests
    ticketRequestsListener = db.collection('rooms').doc(roomId).collection('ticketRequests')
        .where('status', '==', 'pending') // Only show pending requests
        .onSnapshot((querySnapshot) => {
            const requests = [];
            querySnapshot.forEach((doc) => {
                requests.push({ id: doc.id, ...doc.data() });
            });
            displayTicketRequests(requests);
        }, (error) => {
            console.error("Error listening to ticket requests: ", error);
        });

    // Listener for prize claims
    prizeClaimsListener = db.collection('prizeClaimsAudit')
        .where('roomId', '==', roomId)
        .where('status', 'in', ['pending_admin_approval', 'pending_validation']) // Show claims needing admin attention
        .orderBy('claimTimestamp', 'desc')
        .onSnapshot((querySnapshot) => {
            const claims = [];
            querySnapshot.forEach((doc) => {
                claims.push({ id: doc.id, ...doc.data() });
            });
            displayPrizeClaims(claims);
        }, (error) => {
            console.error("Error listening to prize claims: ", error);
        });

    // Update active players list (from main room document)
    // This is implicitly handled by the main room listener's `updateGameControlsUI` or a dedicated function
    db.collection('rooms').doc(roomId).onSnapshot(doc => {
        if (doc.exists) {
            displayConnectedPlayers(doc.data().currentActivePlayers || {});
        }
    });
}


// --- UI UPDATE FUNCTIONS ---
function updateGameControlsUI(roomData) {
    // Update buttons based on gameStatus: "idle", "running", "paused", "stopped"
    btnStartGame.disabled = roomData.gameStatus !== 'idle' && roomData.gameStatus !== 'stopped';
    btnCallNumberManual.disabled = roomData.gameStatus !== 'running';
    selectAutoCall.disabled = roomData.gameStatus !== 'running' && roomData.gameStatus !== 'paused';
    autoCallIntervalInput.disabled = roomData.gameStatus !== 'running' && roomData.gameStatus !== 'paused';
    btnStopGame.disabled = roomData.gameStatus === 'idle' || roomData.gameStatus === 'stopped';

    if (roomData.callingMode === 'auto' && roomData.gameStatus === 'running') {
        btnPauseResumeAutoCall.textContent = 'Pause Auto-Call';
        btnPauseResumeAutoCall.classList.remove('hidden');
        btnPauseResumeAutoCall.disabled = false;
    } else if (roomData.callingMode === 'auto' && roomData.gameStatus === 'paused') {
        btnPauseResumeAutoCall.textContent = 'Resume Auto-Call';
        btnPauseResumeAutoCall.classList.remove('hidden');
        btnPauseResumeAutoCall.disabled = false;
    } else {
        btnPauseResumeAutoCall.classList.add('hidden');
    }
    selectAutoCall.value = roomData.callingMode || 'manual';
    autoCallIntervalInput.value = roomData.autoCallInterval || 5;
}

function updateCalledNumbersUI(numbersArray, latestNumber) {
    calledNumbersDisplayAdmin.textContent = numbersArray && numbersArray.length > 0 ? numbersArray.join(', ') : 'None yet';
    latestCalledNumberAdmin.textContent = latestNumber || '--';
}

function displayConnectedPlayers(playersMap) {
    playersListDiv.innerHTML = ''; // Clear previous list
    if (!playersMap || Object.keys(playersMap).length === 0) {
        playersListDiv.innerHTML = '<p>No players connected yet.</p>';
        return;
    }
    const table = document.createElement('table');
    table.className = 'table table-zebra w-full';
    table.innerHTML = `
        <thead>
            <tr>
                <th>Player Name</th>
                <th>Tickets</th>
                <th>Last Seen</th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    for (const playerId in playersMap) {
        const player = playersMap[playerId];
        const row = tbody.insertRow();
        row.insertCell().textContent = player.playerName || 'Unnamed Player';
        row.insertCell().textContent = player.ticketCount || 0;
        row.insertCell().textContent = player.lastSeen ? new Date(player.lastSeen.seconds * 1000).toLocaleTimeString() : 'N/A';
    }
    playersListDiv.appendChild(table);
}


function displayTicketRequests(requests) {
    ticketRequestsListDiv.innerHTML = ''; // Clear list
    if (requests.length === 0) {
        ticketRequestsListDiv.innerHTML = '<p>No pending ticket requests.</p>';
        return;
    }
    const ul = document.createElement('ul');
    ul.className = 'list-disc pl-5';
    requests.forEach(req => {
        const li = document.createElement('li');
        li.className = 'mb-2 p-2 border rounded-md';
        li.innerHTML = `
            Player: ${req.playerName} (UID: ${req.userId}) requests tickets.
            (Currently has: ${req.currentTickets || 0})
            <button data-request-id="${req.id}" data-user-id="${req.userId}" data-player-name="${req.playerName}" class="btn btn-xs btn-success ml-2 btn-approve-ticket">Approve</button>
            <button data-request-id="${req.id}" class="btn btn-xs btn-error ml-2 btn-reject-ticket">Reject</button>
        `;
        ul.appendChild(li);
    });
    ticketRequestsListDiv.appendChild(ul);

    // Add event listeners for new buttons
    ticketRequestsListDiv.querySelectorAll('.btn-approve-ticket').forEach(btn => {
        btn.addEventListener('click', handleApproveTicket);
    });
    ticketRequestsListDiv.querySelectorAll('.btn-reject-ticket').forEach(btn => {
        btn.addEventListener('click', handleRejectTicket);
    });
}

async function handleApproveTicket(event) {
    const requestId = event.target.dataset.requestId;
    const userId = event.target.dataset.userId;
    const playerName = event.target.dataset.playerName;

    if (!currentGameRoomId || !requestId || !userId) return;
    // Call a Cloud Function to handle ticket generation and approval to keep logic server-side
    const approveTicketFunction = firebase.functions().httpsCallable('approveTicketRequest');
    try {
        const result = await approveTicketFunction({ roomId: currentGameRoomId, requestId: requestId, userId: userId, playerName: playerName });
        alert(result.data.message || 'Ticket approved!');
    } catch (error) {
        console.error("Error approving ticket:", error);
        alert("Error approving ticket: " + error.message);
    }
}

async function handleRejectTicket(event) {
    const requestId = event.target.dataset.requestId;
    if (!currentGameRoomId || !requestId) return;
    const reason = prompt("Reason for rejection (optional):");

    const rejectTicketFunction = firebase.functions().httpsCallable('rejectTicketRequest');
    try {
        const result = await rejectTicketFunction({ roomId: currentGameRoomId, requestId: requestId, reason: reason });
        alert(result.data.message || 'Ticket rejected.');
    } catch (error) {
        console.error("Error rejecting ticket:", error);
        alert("Error rejecting ticket: " + error.message);
    }
}


function displayPrizeClaims(claims) {
    prizeClaimsListDiv.innerHTML = ''; // Clear list
    if (claims.length === 0) {
        prizeClaimsListDiv.innerHTML = '<p>No pending prize claims.</p>';
        return;
    }
    const ul = document.createElement('ul');
    ul.className = 'list-disc pl-5';
    claims.forEach(claim => {
        const li = document.createElement('li');
        li.className = 'mb-2 p-2 border rounded-md';
        li.innerHTML = `
            Player: ${claim.playerName} (Ticket: ${claim.ticketId}) claims: ${claim.prizeName}.
            Status: ${claim.status}. Numbers claimed: ${claim.claimedNumbersOnTicket ? claim.claimedNumbersOnTicket.join(', ') : 'N/A'}.
            ${claim.status === 'pending_admin_approval' || claim.status === 'pending_validation' ? `
            <button data-claim-id="${claim.id}" class="btn btn-xs btn-success ml-2 btn-approve-claim">Approve Claim</button>
            <button data-claim-id="${claim.id}" class="btn btn-xs btn-error ml-2 btn-reject-claim">Reject Claim</button>
            ` : ''}
        `;
        ul.appendChild(li);
    });
    prizeClaimsListDiv.appendChild(ul);

    // Add event listeners
    prizeClaimsListDiv.querySelectorAll('.btn-approve-claim').forEach(btn => {
        btn.addEventListener('click', handleApproveClaim);
    });
    prizeClaimsListDiv.querySelectorAll('.btn-reject-claim').forEach(btn => {
        btn.addEventListener('click', handleRejectClaim);
    });
}

async function handleApproveClaim(event) {
    const claimId = event.target.dataset.claimId;
    if (!currentGameRoomId || !claimId) return;

    const approveClaimFunction = firebase.functions().httpsCallable('approvePrizeClaim');
    try {
        const result = await approveClaimFunction({ roomId: currentGameRoomId, claimId: claimId, adminUID: currentAdminUID });
        alert(result.data.message || 'Claim approved!');
    } catch (error) {
        console.error("Error approving claim:", error);
        alert("Error approving claim: " + error.message);
    }
}

async function handleRejectClaim(event) {
    const claimId = event.target.dataset.claimId;
    if (!currentGameRoomId || !claimId) return;
    const reason = prompt("Reason for rejection (mandatory for admin rejection):");
    if (!reason) {
        alert("Reason is mandatory for rejecting a claim.");
        return;
    }
    const rejectClaimFunction = firebase.functions().httpsCallable('rejectPrizeClaim');
    try {
        const result = await rejectClaimFunction({ roomId: currentGameRoomId, claimId: claimId, reason: reason, adminUID: currentAdminUID });
        alert(result.data.message || 'Claim rejected.');
    } catch (error) {
        console.error("Error rejecting claim:", error);
        alert("Error rejecting claim: " + error.message);
    }
}

function displayGameSummary(summary, winners) {
    gameWinnersDisplay.innerHTML = '<h3>Winners:</h3>';
    if (winners && winners.length > 0) {
        const ul = document.createElement('ul');
        winners.forEach(winner => {
            const li = document.createElement('li');
            li.textContent = `${winner.playerName} won ${winner.prizeName} (${winner.coinsAwarded} coins) for ticket ${winner.ticketId}`;
            ul.appendChild(li);
        });
        gameWinnersDisplay.appendChild(ul);
    } else {
        gameWinnersDisplay.innerHTML += '<p>No winners recorded for this game.</p>';
    }

    const prizeDistributionDisplay = document.getElementById('prizeDistributionDisplay');
    prizeDistributionDisplay.innerHTML = '<h3>Prize Distribution:</h3>';
    if (summary && summary.rulesSnapshot) { // Assuming rules are snapshotted in summary
        const ul = document.createElement('ul');
        summary.rulesSnapshot.forEach(rule => {
             const li = document.createElement('li');
             li.textContent = `${rule.name}: ${rule.percentage}% of total. Claimed by: ${rule.claims ? rule.claims.length : 0} winner(s).`;
             ul.appendChild(li);
        });
        prizeDistributionDisplay.appendChild(ul);
    } else {
        prizeDistributionDisplay.innerHTML += '<p>No prize distribution details available.</p>';
    }

    const fullGameSummaryDiv = document.getElementById('fullGameSummary');
    fullGameSummaryDiv.innerHTML = '<h3>Full Game Details:</h3>';
    if(summary) {
        fullGameSummaryDiv.innerHTML += `<p>Total Players: ${summary.players ? Object.keys(summary.players).length : 'N/A'}</p>`;
        fullGameSummaryDiv.innerHTML += `<p>Total Money Collected: ${summary.totalMoneyCollected || 'N/A'}</p>`;
        fullGameSummaryDiv.innerHTML += `<p>Total Numbers Called: ${summary.totalNumbersCalled || 'N/A'}</p>`;
    } else {
        fullGameSummaryDiv.innerHTML += '<p>No summary data.</p>';
    }
}


// --- GAME ACTIONS ---
btnSetGameRules.addEventListener('click', async () => {
    if (!currentGameRoomId) return;
    const rulesString = inputGameRules.value.trim(); // e.g., "Early Five:10,Line1:15,FullHouse:50"
    if (!rulesString) {
        alert("Please define game rules and percentages.");
        return;
    }
    // Parse rulesString into an array of rule objects
    // { id, name, description (optional), percentage, isActive: true, claims: [], baseWeight, originalWeight }
    const rulesArray = rulesString.split(',').map((r, index) => {
        const parts = r.split(':');
        if (parts.length !== 2 || !parts[0].trim() || isNaN(parseFloat(parts[1]))) return null;
        return {
            id: `rule_${index}_${Date.now()}`, // Simple unique ID
            name: parts[0].trim(),
            description: `${parts[0].trim()} prize`,
            percentage: parseFloat(parts[1]),
            isActive: true,
            claims: [], // Will store { userId, playerName, ticketId, coinsAwarded }
            // baseWeight and originalWeight might be used for more complex prize systems
        };
    }).filter(r => r !== null);

    if (rulesArray.length === 0) {
        alert("Invalid rules format. Use 'Name:Percentage', separated by commas.");
        return;
    }
    const totalPercentage = rulesArray.reduce((sum, rule) => sum + rule.percentage, 0);
    if (totalPercentage > 100) {
        alert(`Total prize percentage (${totalPercentage}%) cannot exceed 100%.`);
        return;
    }

    try {
        await db.collection('rooms').doc(currentGameRoomId).update({ rules: rulesArray });
        alert("Game rules updated!");
    } catch (error) {
        console.error("Error setting game rules: ", error);
        alert("Error setting game rules: " + error.message);
    }
});

btnStartGame.addEventListener('click', async () => {
    if (!currentGameRoomId) return;
    // Call a Cloud Function to handle game start logic
    const startGameFunction = firebase.functions().httpsCallable('startGame');
    try {
        const result = await startGameFunction({ roomId: currentGameRoomId });
        alert(result.data.message || "Game started!");
    } catch (error) {
        console.error("Error starting game:", error);
        alert("Error starting game: " + error.message);
    }
});

btnCallNumberManual.addEventListener('click', async () => {
    if (!currentGameRoomId) return;
    const callNumberFunction = firebase.functions().httpsCallable('callNextNumber');
    try {
        const result = await callNumberFunction({ roomId: currentGameRoomId, mode: 'manual' });
        if(result.data.error) {
            alert("Error calling number: " + result.data.error);
        } else if (result.data.message) {
            alert(result.data.message); // E.g., "All numbers called"
        } else {
            // UI should update via Firestore listener
            console.log("Called number (manual): ", result.data.calledNumber);
        }
    } catch (error) {
        console.error("Error calling number manually:", error);
        alert("Error calling number: " + error.message);
    }
});

selectAutoCall.addEventListener('change', async () => {
    if (!currentGameRoomId) return;
    const mode = selectAutoCall.value; // "auto" or "manual"
    const interval = parseInt(autoCallIntervalInput.value, 10);

    const setCallingModeFunction = firebase.functions().httpsCallable('setCallingMode');
    try {
        await setCallingModeFunction({ roomId: currentGameRoomId, mode: mode, interval: interval });
        alert(`Calling mode set to ${mode}.` + (mode === 'auto' ? ` Interval: ${interval}s` : ''));
        if (mode === 'auto') {
            // Optionally trigger first auto call immediately if game is running
            // Or let the backend handle the scheduling logic entirely
        }
    } catch (error) {
        console.error("Error setting calling mode:", error);
        alert("Error setting calling mode: " + error.message);
    }
});

autoCallIntervalInput.addEventListener('change', () => {
    // If mode is already auto, changing interval should update it
    // This can be combined with selectAutoCall logic or handled separately
    if (selectAutoCall.value === 'auto' && currentGameRoomId) {
        selectAutoCall.dispatchEvent(new Event('change')); // Trigger the change event
    }
});


btnPauseResumeAutoCall.addEventListener('click', async () => {
    if (!currentGameRoomId) return;
    // This button's text/action depends on current state ("Pause Auto-Call" or "Resume Auto-Call")
    // This implies the game is in 'running' or 'paused' state with 'auto' mode.
    // The actual pause/resume is a game status change ('running' <-> 'paused') handled by a function
    const roomSnap = await db.collection('rooms').doc(currentGameRoomId).get();
    if (!roomSnap.exists) return;
    const currentStatus = roomSnap.data().gameStatus;
    const targetStatus = currentStatus === 'running' ? 'paused' : 'running';

    const togglePauseFunction = firebase.functions().httpsCallable('togglePauseResumeGame');
    try {
        await togglePauseFunction({ roomId: currentGameRoomId, targetStatus: targetStatus });
        alert(`Game ${targetStatus}.`);
    } catch (error) {
        console.error(`Error ${targetStatus} game:`, error);
        alert(`Error ${targetStatus} game: ` + error.message);
    }
});


btnStopGame.addEventListener('click', async () => {
    if (!currentGameRoomId) return;
    if (!confirm("Are you sure you want to stop the game? This will end the game and calculate winners.")) {
        return;
    }
    const stopGameFunction = firebase.functions().httpsCallable('stopGame');
    try {
        const result = await stopGameFunction({ roomId: currentGameRoomId });
        alert(result.data.message || "Game stopped and summary generated.");
        // UI will update via listener, show summary section
    } catch (error) {
        console.error("Error stopping game:", error);
        alert("Error stopping game: " + error.message);
    }
});


// --- UTILITY FUNCTIONS (Admin specific, or move to common/utils.js if shared) ---
function generateRoomId(length = 6) {
    // Simple random ID generator
    const characters = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789'; // O and 0 removed for clarity
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// Initialize theme toggle from ui.js if it exists
if (window.initializeThemeToggle) {
    window.initializeThemeToggle('themeToggleAdmin');
}
