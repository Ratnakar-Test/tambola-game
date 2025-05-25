/**
 * Generates a simple unique Room ID.
 * @param {number} length The desired length of the room ID.
 * @returns {string} A random room ID.
 */
function generateRoomId(length = 6) {
    const characters = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789'; // O and 0 removed for clarity
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

/**
 * Generates a unique ID (e.g., for tickets, claims).
 * @returns {string} A unique ID string.
 */
function generateUniqueId() {
    // Firestore auto-generated IDs are also a good option for documents.
    // This creates a reasonably unique ID if needed before document creation.
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Shuffles an array in place (Fisher-Yates algorithm).
 * @param {Array} array The array to shuffle.
 * @returns {Array} The shuffled array.
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * Generates a Tambola ticket (3x9 grid, 15 numbers).
 * Numbers are distributed according to standard Tambola rules.
 * - Each row has 5 numbers.
 * - Each column has at least one number, and at most three numbers.
 * - Numbers in each column are sorted vertically.
 * - Col 1: 1-9, Col 2: 10-19, ..., Col 8: 70-79, Col 9: 80-90
 * @returns {Array<Array<number|null>>} A 3x9 array representing the ticket. null for empty cells.
 * Throws an error if a valid ticket cannot be generated after a few tries.
 */
function generateTambolaTicket(maxAttempts = 10) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let ticket = Array(3).fill(null).map(() => Array(9).fill(null));
        let colNumbersAvailable = []; // Numbers available for each column
        for (let i = 0; i < 9; i++) {
            let start = i * 10 + 1;
            let end = (i * 10) + 10;
            if (i === 0) start = 1; // Col 1 is 1-9
            if (i === 8) end = 90; // Col 9 is 80-90
            if (i > 0 && i < 8) end = i*10 + 9; // Cols 2-8 are X0-X9
            
            let colNumList = [];
            for (let k = start; k <= end; k++) {
                colNumList.push(k);
            }
            colNumbersAvailable.push(shuffleArray(colNumList));
        }

        let numbersPlaced = 0;
        let colCounts = Array(9).fill(0);
        let rowCounts = Array(3).fill(0);

        // Place numbers to satisfy constraints
        // Try to place 15 numbers
        for (let i = 0; i < 15; i++) {
            let placedThisIteration = false;
            let placementAttempts = 0;
            while (!placedThisIteration && placementAttempts < 100) { // Safety break for placement
                const r = Math.floor(Math.random() * 3); // Random row
                const c = Math.floor(Math.random() * 9); // Random col

                if (ticket[r][c] === null && rowCounts[r] < 5 && colCounts[c] < 3) {
                    if (colNumbersAvailable[c] && colNumbersAvailable[c].length > 0) {
                        const num = colNumbersAvailable[c].pop();
                        ticket[r][c] = num;
                        rowCounts[r]++;
                        colCounts[c]++;
                        numbersPlaced++;
                        placedThisIteration = true;
                    }
                }
                placementAttempts++;
            }
        }

        // If exactly 15 numbers were placed, now ensure column constraints
        // (at least one number per column) and row constraints (exactly 5 per row)
        // This simplified generation might not always perfectly hit this without more iterations or refinement.
        // A more robust algorithm would fill row by row, column by column strategically.

        if (numbersPlaced === 15) {
            // Check if all rows have 5 numbers
            const allRowsHave5 = rowCounts.every(count => count === 5);
            // Check if all columns have at least 1 number (implicit if 15 numbers are spread across 9 cols)
            // More strictly, check if colCounts are between 1 and 3.
            const colCountsValid = colCounts.every(count => count >= 1 && count <= 3);

            if (allRowsHave5 && colCountsValid) {
                // Sort numbers within each column
                for (let c = 0; c < 9; c++) {
                    let col Vals = [];
                    for (let r = 0; r < 3; r++) {
                        if (ticket[r][c] !== null) {
                            colVals.push(ticket[r][c]);
                        }
                    }
                    colVals.sort((a, b) => a - b);
                    let valIdx = 0;
                    for (let r = 0; r < 3; r++) {
                        if (ticket[r][c] !== null) {
                            ticket[r][c] = colVals[valIdx++];
                        }
                    }
                }
                // console.log(`Generated valid ticket on attempt ${attempt + 1}`);
                return ticket; // Valid ticket generated
            }
        }
    } // End of maxAttempts loop

    console.error("Failed to generate a valid Tambola ticket after multiple attempts.");
    throw new Error("Failed to generate a valid Tambola ticket.");
}


/**
 * Parses a rules string (e.g., "Early Five:10,Line1:15,FullHouse:50") into an array of rule objects.
 * @param {string} rulesString The string containing rules and their percentages.
 * @returns {Array<object>|null} An array of rule objects or null if parsing fails.
 * Rule object: { id, name, description, percentage, isActive, claims }
 */
function parseGameRulesFromString(rulesString) {
    if (!rulesString || typeof rulesString !== "string") return null;

    const rulesArray = rulesString.split(',').map((r, index) => {
        const parts = r.split(':');
        const ruleNameRaw = parts[0] ? parts[0].trim() : "";
        const rulePercentageRaw = parts[1] ? parts[1].trim() : "";

        if (parts.length !== 2 || !ruleNameRaw || isNaN(parseFloat(rulePercentageRaw))) return null;

        const name = ruleNameRaw;
        const percentage = parseFloat(rulePercentageRaw);

        if (percentage <= 0 || percentage > 100) return null; // Percentage must be valid

        return {
            id: `rule_${name.replace(/\s+/g, "").toLowerCase()}_${index}`,
            name: name,
            description: `${name} prize payout at ${percentage}% of (total collection * (this rule's % / total prize %))`,
            percentage: percentage, // This is the percentage OF THE TOTAL PRIZE POOL allocated to this rule
            isActive: true,
            claims: [],
        };
    }).filter(r => r !== null);

    if (rulesArray.length === 0 && rulesString.trim() !== "") {
        return null; // Input was not empty but nothing valid was parsed
    }
    return rulesArray;
}

module.exports = {
    generateRoomId,
    generateUniqueId,
    shuffleArray,
    generateTambolaTicket,
    parseGameRulesFromString,
};
