// Ensure Firebase and other scripts are loaded
let currentPlayerUID = null;
let currentPlayerName = '';
let currentRoomId = null;
let roomListenerPlayer = null; // Firestore listener for room updates
let ticketsListener = null; // Listener for player's tickets
let claimsListenerPlayer = null; // Listener for player's claims

// DOM Elements
const playerContent = document.getElementById('playerContent');
const authFlowMessagePlayer = document.getElementById('authFlowMessagePlayer');
const playerNameDisplay = document.getElementById('playerNameDisplay');
const playerRoomIdDisplay = document.getElementById('playerRoomIdDisplay');

const joinRoomSection = document.getElementById('joinRoomSection');
const inputPlayerDisplayName = document.getElementById('inputPlayerDisplayName');
const inputPlayerRoomId = document.getElementById('inputPlayerRoomId');
const btnJoinRoomPlayer = document.getElementById('btnJoinRoomPlayer');

const gameArea = document.getElementById('gameArea');
const btnRequestTicket = document.getElementById('btnRequestTicket');
const ticketStatusMessage = document.getElementById('ticketStatusMessage');
const playerTicketsContainer = document.getElementById('playerTicketsContainer');
const autoMarkToggle = document.getElementById('autoMarkToggle');

const gameStatusDisplay = document.getElementById('gameStatusDisplay');
const latestCalledNumberDisplayPlayer = document.getElementById('latestCalledNumberDisplayPlayer');
const calledNumbersBoardPlayer = document.getElementById('calledNumbersBoardPlayer');
const activeGameRulesPlayer = document.getElementById('activeGameRulesPlayer');
const prizeClaimOptions = document.getElementById('prizeClaimOptions');
const myClaimsStatus = document.getElementById('myClaimsStatus');
const myClaimsListPlayer = document.getElementById('myClaimsListPlayer');
const otherPlayersList = document.getElementById('otherPlayersList');

let localPlayerTickets = []; // Store ticket data locally: [{id, numbers, marked}]
let allCalledNumbers = []; // Store all called numbers from the room

// --- AUTHENTICATION ---
auth.onAuthStateChanged(user => {
    if (user) {
        currentPlayerUID = user.uid;
        playerContent.classList.remove('hidden');
        authFlowMessagePlayer.classList.add('hidden');
        // Try to get display name from auth, or use email
        currentPlayerName = user.displayName || user.email;
        playerNameDisplay.textContent = currentPlayerName;
        inputPlayerDisplayName.value = currentPlayerName; // Pre-fill display name input

        // Check if room ID is in URL params (e.g., from QR code)
        const urlParams = new URLSearchParams(window.location.search);
        const roomIdFromUrl = urlParams.get('roomId');
        if (roomIdFromUrl) {
            inputPlayerRoomId.value = roomIdFromUrl.toUpperCase();
            // Optionally, auto-join if display name is also set or pre-filled
            // if (inputPlayerDisplayName.value) btnJoinRoomPlayer.click();
        }

    } else {
        currentPlayerUID = null;
        currentPlayerName = '';
        playerContent.classList.add('hidden');
        authFlowMessagePlayer.classList.remove('hidden');
        gameArea.classList.add('hidden');
        joinRoomSection.classList.remove('hidden'); // Show join section if logged out
        clearPlayerListeners();
    }
});

// --- ROOM JOIN LOGIC ---
btnJoinRoomPlayer.addEventListener('click', async () => {
    const displayName = inputPlayerDisplayName.value.trim();
    const roomIdToJoin = inputPlayerRoomId.value.trim().toUpperCase();

    if (!currentPlayerUID) {
        alert("Please sign in first.");
        return;
    }
    if (!displayName) {
        alert("Please enter your display name.");
        return;
    }
    if (!roomIdToJoin) {
        alert("Please enter a Room ID.");
        return;
    }

    // Check if room exists
    const roomRef = db.collection('rooms').doc(roomIdToJoin);
    const roomSnap = await roomRef.get();

    if (!roomSnap.exists) {
        alert("Room not found. Please check the Room ID.");
        return;
    }

    // Update player's display name in Firebase Auth profile (optional)
    const currentUser = auth.currentUser;
    if (currentUser && currentUser.displayName !== displayName) {
        try {
            await currentUser.updateProfile({ displayName: displayName });
            currentPlayerName = displayName;
            playerNameDisplay.textContent = currentPlayerName;
            console.log("Player display name updated in Auth.");
        } catch (error) {
            console.warn("Could not update display name in Auth:", error);
        }
    } else {
        currentPlayerName = displayName; // Use it locally even if not updated in Auth
        playerNameDisplay.textContent = currentPlayerName;
    }


    currentRoomId = roomIdToJoin;
    playerRoomIdDisplay.textContent = currentRoomId;
    joinRoomSection.classList.add('hidden');
    gameArea.classList.remove('hidden');
    initializeCalledNumbersBoard(); // Initialize the 1-90 board

    // Add player to room's active players list (or update lastSeen)
    // This can be done via a Cloud Function or directly if rules allow
    await roomRef.set({
        currentActivePlayers: {
            [currentPlayerUID]: {
                playerName: currentPlayerName,
                ticketCount: localPlayerTickets.length, // initially 0 if no tickets yet
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }
        }
    }, { merge: true });


    attachPlayerListeners(currentRoomId);
    loadPlayerTickets(); // Attempt to load existing tickets for this room
    loadPlayerClaims();  // Attempt to load existing claims for this room
});

function clearPlayerListeners() {
    if (roomListenerPlayer) roomListenerPlayer();
    if (ticketsListener) ticketsListener();
    if (claimsListenerPlayer) claimsListenerPlayer();
    roomListenerPlayer = null;
    ticketsListener = null;
    claimsListenerPlayer = null;
}

function attachPlayerListeners(roomId) {
    clearPlayerListeners();

    // Listener for general room updates (game status, called numbers, rules, other players)
    roomListenerPlayer = db.collection('rooms').doc(roomId)
        .onSnapshot(doc => {
            if (doc.exists) {
                const roomData = doc.data();
                gameStatusDisplay.textContent = roomData.gameStatus || 'N/A';
                allCalledNumbers = roomData.currentNumbersCalled || [];
                updateCalledNumbersBoardPlayer(allCalledNumbers);
                if (roomData.currentLatestCalledNumber) {
                    latestCalledNumberDisplayPlayer.textContent = roomData.currentLatestCalledNumber;
                    highlightLatestCalled(roomData.currentLatestCalledNumber);
                    if (autoMarkToggle.checked) {
                        autoMarkPlayerTickets(roomData.currentLatestCalledNumber);
                    }
                } else {
                    latestCalledNumberDisplayPlayer.textContent = '--';
                }
                displayActiveGameRules(roomData.rules || []);
                displayOtherPlayers(roomData.currentActivePlayers || {});

                // Enable/disable ticket request based on game status
                btnRequestTicket.disabled = roomData.gameStatus === 'running' || roomData.gameStatus === 'paused' || roomData.gameStatus === 'stopped';

            } else {
                alert("The game room seems to have been closed or deleted.");
                // Reset UI
                currentRoomId = null;
                playerRoomIdDisplay.textContent = "Not Joined";
                gameArea.classList.add('hidden');
                joinRoomSection.classList.remove('hidden');
            }
        }, error => {
            console.error("Error listening to room (player):", error);
        });

    // Listener for this player's tickets in the current room
    ticketsListener = db.collection('gameTickets')
        .where('roomId', '==', roomId)
        .where('userId', '==', currentPlayerUID)
        .onSnapshot(snapshot => {
            const newTickets = [];
            snapshot.forEach(doc => {
                const ticketData = doc.data();
                // Check if we already have this ticket locally to preserve marked numbers
                let existingLocalTicket = localPlayerTickets.find(t => t.id === doc.id);
                newTickets.push({
                    id: doc.id,
                    numbers: ticketData.numbers, // 3x9 grid
                    marked: existingLocalTicket ? existingLocalTicket.marked : [] // Preserve client-side marking
                });
            });
            localPlayerTickets = newTickets;
            renderPlayerTickets();
            // Update ticket count in room's active players (can be done via cloud function on ticket approval too)
            if(currentRoomId && currentPlayerUID){
                db.collection('rooms').doc(currentRoomId).set({
                    currentActivePlayers: { [currentPlayerUID]: { ticketCount: localPlayerTickets.length } }
                }, {merge: true}).catch(err => console.warn("Error updating ticket count for player:", err));
            }

        }, error => {
            console.error("Error listening to player tickets:", error);
        });

    // Listener for this player's prize claims audit
    claimsListenerPlayer = db.collection('prizeClaimsAudit')
        .where('roomId', '==', roomId)
        .where('userId', '==', currentPlayerUID)
        .orderBy('claimTimestamp', 'desc')
        .limit(5) // Show recent 5 claims
        .onSnapshot(snapshot => {
            const claims = [];
            snapshot.forEach(doc => claims.push({ id: doc.id, ...doc.data() }));
            displayMyClaims(claims);
        }, error => {
            console.error("Error listening to player claims:", error);
        });
}

// --- TICKET MANAGEMENT ---
btnRequestTicket.addEventListener('click', async () => {
    if (!currentRoomId || !currentPlayerUID || !currentPlayerName) {
        alert("You must be signed in and in a room to request a ticket.");
        return;
    }
    ticketStatusMessage.textContent = "Requesting ticket...";
    btnRequestTicket.disabled = true;

    try {
        // Check if player already has max tickets or if a request is pending
        // For simplicity, just send the request. Admin can manage limits.
        const requestId = `req_${currentPlayerUID}_${Date.now()}`;
        await db.collection('rooms').doc(currentRoomId).collection('ticketRequests').doc(requestId).set({
            userId: currentPlayerUID,
            playerName: currentPlayerName,
            roomId: currentRoomId,
            status: 'pending', // "pending", "approved", "rejected"
            requestTimestamp: firebase.firestore.FieldValue.serverTimestamp(),
            currentTickets: localPlayerTickets.length
        });
        ticketStatusMessage.textContent = "Ticket request sent to admin for approval.";
    } catch (error) {
        console.error("Error requesting ticket:", error);
        ticketStatusMessage.textContent = "Error requesting ticket: " + error.message;
        btnRequestTicket.disabled = false; // Re-enable on error
    }
});

function loadPlayerTickets() { // Called on joining a room
    // This is now handled by the Firestore listener `ticketsListener`
}

function renderPlayerTickets() {
    playerTicketsContainer.innerHTML = ''; // Clear existing tickets
    if (localPlayerTickets.length === 0) {
        playerTicketsContainer.innerHTML = '<p>You have no tickets yet. Request one!</p>';
        return;
    }
    localPlayerTickets.forEach((ticket, index) => {
        const ticketDiv = document.createElement('div');
        ticketDiv.className = 'p-3 border rounded-lg bg-base-content text-base-100 shadow mb-4';
        ticketDiv.innerHTML = `<h4 class="font-semibold text-center mb-2">Ticket ${index + 1} (ID: ${ticket.id.substring(0,6)}...)</h4>`;
        const grid = document.createElement('div');
        grid.className = 'ticket-grid'; // Uses styles from common/css/style.css

        ticket.numbers.forEach(row => { // Assuming ticket.numbers is 3x9 array
            row.forEach(num => {
                const cell = document.createElement('div');
                cell.className = 'ticket-cell';
                if (num) { // If the cell has a number
                    cell.textContent = num;
                    cell.classList.add('number');
                    cell.dataset.number = num;
                    if (ticket.marked.includes(num)) {
                        cell.classList.add('marked');
                    }
                    if (allCalledNumbers.includes(num)) { // Visually indicate if number was called, even if not marked by player yet
                         // cell.classList.add('highlight-called'); // Add a distinct style if needed
                    }
                    cell.addEventListener('click', () => toggleMarkNumber(ticket.id, num));
                } else {
                    cell.classList.add('empty'); // Empty cell in the ticket
                }
                grid.appendChild(cell);
            });
        });
        ticketDiv.appendChild(grid);
        playerTicketsContainer.appendChild(ticketDiv);
    });
    btnRequestTicket.disabled = false; // Re-enable after rendering. Add logic for max tickets if needed.
    ticketStatusMessage.textContent = localPlayerTickets.length > 0 ? "" : "Request a ticket to start playing!";
}

function toggleMarkNumber(ticketId, number) {
    const ticket = localPlayerTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    const numberCell = playerTicketsContainer.querySelector(`.ticket-grid .ticket-cell[data-number="${number}"]`);

    if (ticket.marked.includes(number)) {
        ticket.marked = ticket.marked.filter(n => n !== number);
        if (numberCell) numberCell.classList.remove('marked');
    } else {
        // Only allow marking if the number has actually been called
        if (allCalledNumbers.includes(number)) {
            ticket.marked.push(number);
            if (numberCell) numberCell.classList.add('marked');
        } else {
            alert(`Number ${number} has not been called yet!`);
        }
    }
    // Note: This marking is client-side. For claims, server will verify against `currentNumbersCalled`.
    // console.log(`Ticket ${ticketId} marked numbers:`, ticket.marked);
}

function autoMarkPlayerTickets(calledNumber) {
    if (!calledNumber) return;
    localPlayerTickets.forEach(ticket => {
        let numberFoundOnTicket = false;
        for (const row of ticket.numbers) {
            if (row.includes(calledNumber)) {
                numberFoundOnTicket = true;
                break;
            }
        }

        if (numberFoundOnTicket && !ticket.marked.includes(calledNumber)) {
            ticket.marked.push(calledNumber);
            // Visually update the specific cell if it's rendered
            const ticketGridElement = playerTicketsContainer.querySelector(`div[data-ticket-id="${ticket.id}"] .ticket-grid`); // Need to add data-ticket-id to ticketDiv in render
            if(ticketGridElement){ // Fallback if ticket div not easily selectable
                 const cell = ticketGridElement.querySelector(`.ticket-cell[data-number="${calledNumber}"]`);
                 if (cell) cell.classList.add('marked');
            } else { // Brute force update if specific ticket div not found, re-render is safer but heavier.
                 renderPlayerTickets(); // Re-render to show auto-mark (can be optimized)
            }
        }
    });
}


// --- GAME INFO & ACTIONS UI ---
function initializeCalledNumbersBoard() {
    calledNumbersBoardPlayer.innerHTML = '';
    for (let i = 1; i <= 90; i++) {
        const cell = document.createElement('div');
        cell.className = 'called-number-cell';
        cell.textContent = i;
        cell.id = `board-num-${i}`;
        calledNumbersBoardPlayer.appendChild(cell);
    }
}

function updateCalledNumbersBoardPlayer(calledNumbersArray) {
    // Reset all highlights first
    for (let i = 1; i <= 90; i++) {
        const cell = document.getElementById(`board-num-${i}`);
        if (cell) cell.classList.remove('highlighted');
    }
    // Highlight called numbers
    calledNumbersArray.forEach(num => {
        const cell = document.getElementById(`board-num-${num}`);
        if (cell) cell.classList.add('highlighted');
    });
}
function highlightLatestCalled(number) {
    // Optional: Add an extra visual cue for the very latest number on the board
    const cell = document.getElementById(`board-num-${number}`);
    if (cell) {
        // cell.classList.add('latest-highlight'); // Define this class in CSS for distinct look
    }
}


function displayActiveGameRules(rules) {
    activeGameRulesPlayer.innerHTML = '<h4 class="font-semibold mb-1">Prizes to Win:</h4>';
    prizeClaimOptions.innerHTML = ''; // Clear old claim buttons

    if (!rules || rules.length === 0) {
        activeGameRulesPlayer.innerHTML += '<p>No game rules set by admin yet.</p>';
        return;
    }
    const ul = document.createElement('ul');
    ul.className = 'list-disc list-inside text-xs';
    rules.forEach(rule => {
        if (rule.isActive) { // Only show active rules
            const li = document.createElement('li');
            li.textContent = `${rule.name} (${rule.percentage}%)`;
            ul.appendChild(li);

            // Add claim button for this rule
            const claimButton = document.createElement('button');
            claimButton.className = 'btn btn-xs btn-accent mt-1 mr-1';
            claimButton.textContent = `Claim ${rule.name}`;
            claimButton.dataset.ruleId = rule.id;
            claimButton.dataset.ruleName = rule.name;
            claimButton.addEventListener('click', handlePrizeClaim);
            // Disable claim button if game not running or rule already claimed by this player (complex logic, simplified here)
            const gameStatus = gameStatusDisplay.textContent;
            if(gameStatus !== "running" && gameStatus !== "paused"){ // Allow claims during pause
                 claimButton.disabled = true;
            }
            // Add more logic if a player can only claim a rule once, or if ticket has already won this.
            prizeClaimOptions.appendChild(claimButton);
        }
    });
    activeGameRulesPlayer.appendChild(ul);
}

async function handlePrizeClaim(event) {
    const ruleId = event.target.dataset.ruleId;
    const ruleName = event.target.dataset.ruleName;

    if (!currentRoomId || !currentPlayerUID || localPlayerTickets.length === 0) {
        alert("Cannot claim: Not in a room, not signed in, or no tickets.");
        return;
    }
    const gameStatus = gameStatusDisplay.textContent;
     if(gameStatus !== "running" && gameStatus !== "paused"){
        alert("Cannot claim: Game is not currently running or paused.");
        return;
    }


    // For simplicity, player claims for *any* of their tickets.
    // A more advanced system might let them choose which ticket is claiming.
    // We'll assume the claim is for the first ticket that might qualify or just a general claim for now.
    // The backend MUST validate which ticket and if the pattern is met.
    // Let's just use the first ticket's ID for the claim, or require player to select.
    // For now, let's make it simpler: player claims, backend validates against *all* their tickets.
    // BUT the prizeClaimsAudit needs a ticketId.

    if (localPlayerTickets.length === 0) {
        alert("You don't have any tickets to claim with!");
        return;
    }

    // Simplification: Use the first ticket ID. In a real game, you might need UI to select ticket for claim.
    const ticketToClaimWith = localPlayerTickets[0]; // Or implement selection
    const clientMarkedNumbersForClaim = ticketToClaimWith.marked; // Send what player has marked

    const clientClaimId = `client_${currentPlayerUID}_${ruleId}_${Date.now()}`;

    const claimPrizeFunction = firebase.functions().httpsCallable('submitPrizeClaim');
    try {
        const result = await claimPrizeFunction({
            roomId: currentRoomId,
            userId: currentPlayerUID,
            playerName: currentPlayerName,
            ticketId: ticketToClaimWith.id, // IMPORTANT: Server needs to know which ticket
            prizeRuleId: ruleId,
            prizeName: ruleName,
            clientTempClaimId: clientClaimId,
            claimedNumbersOnTicket: clientMarkedNumbersForClaim, // Player's current view of marked numbers
        });
        alert(result.data.message || `Claim for ${ruleName} submitted! Admin will verify.`);
    } catch (error) {
        console.error(`Error claiming ${ruleName}:`, error);
        alert(`Error claiming ${ruleName}: ${error.message}`);
    }
}

function displayMyClaims(claims) {
    myClaimsListPlayer.innerHTML = '';
    if (claims.length === 0) {
        myClaimsListPlayer.innerHTML = '<li>No recent claims made.</li>';
        return;
    }
    claims.forEach(claim => {
        const li = document.createElement('li');
        let statusText = claim.status.replace(/_/g, ' ');
        statusText = statusText.charAt(0).toUpperCase() + statusText.slice(1);
        li.textContent = `${claim.prizeName}: ${statusText}`;
        if (claim.status === 'approved') li.classList.add('text-success');
        if (claim.status.includes('rejected')) li.classList.add('text-error');
        if (claim.coinsAwarded) li.textContent += ` (${claim.coinsAwarded} coins awarded)`;
        if (claim.reason) li.textContent += ` - Reason: ${claim.reason}`;
        myClaimsListPlayer.appendChild(li);
    });
}

function displayOtherPlayers(playersMap) {
    otherPlayersList.innerHTML = '';
    if (!playersMap || Object.keys(playersMap).length === 0) {
        otherPlayersList.innerHTML = '<li>No other players yet.</li>';
        return;
    }
    Object.values(playersMap).forEach(player => {
        if (player.playerName && player.playerName !== currentPlayerName) { // Don't list self
            const li = document.createElement('li');
            li.textContent = `${player.playerName} (Tickets: ${player.ticketCount || 0})`;
            otherPlayersList.appendChild(li);
        }
    });
    if(otherPlayersList.children.length === 0) {
         otherPlayersList.innerHTML = '<li>Just you in the room for now!</li>';
    }
}

// Initialize theme toggle from ui.js if it exists
if (window.initializeThemeToggle) {
    window.initializeThemeToggle('themeTogglePlayer');
}

// Initial setup on DOM load
document.addEventListener('DOMContentLoaded', () => {
    // Any setup that needs DOM ready but not necessarily auth ready
});
