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
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}


/**
 * Shuffles an array in place.
 * @param {Array} array The array to shuffle.
 * @returns {Array} The shuffled array.
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // Swap elements
    }
    return array;
}

/**
 * Generates a Tambola ticket (3x9 grid, 15 numbers).
 * Numbers are distributed according to standard Tambola rules.
 * - Each row has 5 numbers.
 * - Each column has at least one number, at most three.
 * - Column 1: 1-9 (max 3 numbers)
 * - Column 2: 10-19 (max 3 numbers)
 * - ...
 * - Column 8: 70-79 (max 3 numbers)
 * - Column 9: 80-90 (max 3 numbers)
 * - Numbers in each column are sorted vertically.
 * @returns {Array<Array<number|null>>} A 3x9 array representing the ticket. null for empty cells.
 */
function generateTambolaTicket() {
    let ticket = Array(3).fill(null).map(() => Array(9).fill(null));
    let columnCounts = Array(9).fill(0); // How many numbers in each column
    let numbersInTicket = 0;

    // Define column ranges
    const colRanges = [
        { start: 1, end: 9, numbers: [] }, { start: 10, end: 19, numbers: [] },
        { start: 20, end: 29, numbers: [] }, { start: 30, end: 39, numbers: [] },
        { start: 40, end: 49, numbers: [] }, { start: 50, end: 59, numbers: [] },
        { start: 60, end: 69, numbers: [] }, { start: 70, end: 79, numbers: [] },
        { start: 80, end: 90, numbers: [] }
    ];

    // Populate numbers for each column range
    for (let col = 0; col < 9; col++) {
        let range = [];
        for (let i = colRanges[col].start; i <= colRanges[col].end; i++) {
            range.push(i);
        }
        colRanges[col].numbers = shuffleArray(range);
    }

    // Place 15 numbers on the ticket
    // First pass: ensure each column gets at least one number (if possible to fit 15)
    // This standard algorithm is a bit more complex to ensure perfect distribution.
    // This is a simplified version for generation.
    // A common strategy:
    // 1. Distribute 9 numbers, one per column, randomly placed in one of the 3 rows.
    // 2. Distribute the remaining 6 numbers, ensuring no row exceeds 5 numbers and column limits are respected.

    // Simplified approach: iterate rows and try to place 5 numbers per row
    for (let row = 0; row < 3; row++) {
        let numbersInRow = 0;
        let availableColsForRow = shuffleArray([...Array(9).keys()]); // [0,1,2,...8] shuffled

        for (let i = 0; i < availableColsForRow.length && numbersInRow < 5; i++) {
            let col = availableColsForRow[i];
            if (ticket[row][col] === null && columnCounts[col] < 3) { // Max 3 numbers per column
                if (colRanges[col].numbers.length > 0) {
                    ticket[row][col] = colRanges[col].numbers.pop();
                    columnCounts[col]++;
                    numbersInRow++;
                    numbersInTicket++;
                }
            }
        }
    }

    // Second pass to fill up to 15 numbers if first pass didn't complete
    // And ensure column constraints (at least 1 number per col if ticket not full)
    // This part can be tricky to get perfect distribution without a more complex algorithm.
    // Let's try to ensure each column gets at least one number if total numbers are less than 9
    // and then fill remaining numbers randomly.

    // If less than 15 numbers, try to add more respecting constraints
    let attempts = 0; // safety break
    while (numbersInTicket < 15 && attempts < 100) {
        let randRow = Math.floor(Math.random() * 3);
        let randCol = Math.floor(Math.random() * 9);

        // Count numbers in randRow
        let currentRowCount = ticket[randRow].filter(num => num !== null).length;

        if (ticket[randRow][randCol] === null && columnCounts[randCol] < 3 && currentRowCount < 5) {
            if (colRanges[randCol].numbers.length > 0) {
                ticket[randRow][randCol] = colRanges[randCol].numbers.pop();
                columnCounts[randCol]++;
                numbersInTicket++;
            }
        }
        attempts++;
    }
    
    // Final check: if any column is empty and we have < 15 numbers, try to fill one.
    // This step is to ensure each column has at least one number if possible.
    // This simplified generator might not always produce perfectly compliant tickets
    // under all edge cases without more sophisticated placement logic.
    // For a production system, use a well-vetted Tambola ticket generation algorithm.

    // Sort numbers within each column (vertically)
    for (let col = 0; col < 9; col++) {
        let currentColNumbers = [];
        for (let row = 0; row < 3; row++) {
            if (ticket[row][col] !== null) {
                currentColNumbers.push(ticket[row][col]);
            }
        }
        currentColNumbers.sort((a, b) => a - b); // Sort ascending

        let sortedNumIdx = 0;
        for (let row = 0; row < 3; row++) {
            if (ticket[row][col] !== null) {
                ticket[row][col] = currentColNumbers[sortedNumIdx++];
            }
        }
    }
    // console.log("Generated ticket:", ticket, "Total numbers:", numbersInTicket, "Col counts:", columnCounts);
    // If numbersInTicket is not 15, the generation might need refinement or retry.
    // For this example, we proceed with what was generated.
    if (numbersInTicket !== 15) {
        console.warn(`Ticket generated with ${numbersInTicket} numbers. Standard is 15. Consider re-generating or refining algorithm.`);
        // Could throw an error or attempt to regenerate.
        // return generateTambolaTicket(); // Be careful with recursion depth if it frequently fails.
    }


    return ticket;
}


/**
 * Generates a QR code and appends it to the specified container.
 * This function relies on the qrcode.js library being available (e.g., via CDN).
 * Example CDN: <script src="https://cdn.jsdelivr.net/npm/qrcode-generator/qrcode.js"></script> (or similar)
 * Ensure your HTML includes this script if you use this function.
 * @param {HTMLElement} container The HTML element to append the QR code to.
 * @param {string} text The text to encode in the QR code.
 * @param {number} [size=128] The size of the QR code image in pixels.
 */
function generateQrCode(container, text, size = 128) {
    if (!container) {
        console.error("QR Code container not found.");
        return;
    }
    container.innerHTML = ''; // Clear previous QR code

    try {
        if (typeof QRCode === 'undefined') {
            console.error("QRCode library is not loaded. Please include qrcode.js script.");
            container.textContent = "QR Code library not loaded.";
            // Fallback or simple text display
            const p = document.createElement('p');
            p.textContent = `Join Link (QR lib missing): ${text}`;
            container.appendChild(p);
            const a = document.createElement('a');
            a.href = text;
            a.textContent = text;
            container.appendChild(a);
            return;
        }

        const typeNumber = 0; // Auto detect
        const errorCorrectionLevel = 'L'; // Low, Medium, Quartile, High
        const qr = QRCode(typeNumber, errorCorrectionLevel);
        qr.addData(text);
        qr.make();

        // Create an image tag
        const imgTag = qr.createImgTag(Math.floor(size / 20), 4); // cell size, margin
        const imgElement = document.createElement('div'); // Wrapper to help with styling if needed
        imgElement.innerHTML = imgTag;
        const actualImg = imgElement.firstChild;
        if (actualImg) {
            actualImg.style.width = `${size}px`;
            actualImg.style.height = `${size}px`;
            container.appendChild(actualImg);
        } else {
            throw new Error("Could not create image tag from QRCode library.");
        }

    } catch (e) {
        console.error("Failed to generate QR code:", e);
        container.textContent = "Error generating QR code.";
        const p = document.createElement('p');
        p.textContent = `Join Link: ${text}`;
        container.appendChild(p);
    }
}

/**
 * Formats Firestore Timestamp to a readable string.
 * @param {object} timestamp Firestore timestamp object { seconds, nanoseconds }.
 * @returns {string} Formatted date-time string or 'Invalid Date' if input is null/undefined.
 */
function formatFirestoreTimestamp(timestamp) {
    if (!timestamp || typeof timestamp.seconds !== 'number') {
        return 'N/A';
    }
    try {
        const date = new Date(timestamp.seconds * 1000 + (timestamp.nanoseconds || 0) / 1000000);
        return date.toLocaleString(); // Adjust format as needed, e.g., .toLocaleTimeString() or .toLocaleDateString()
    } catch (e) {
        return 'Invalid Date';
    }
}

/**
 * Parses a rules string (e.g., "Early Five:10,Line1:15,FullHouse:50") into an array of rule objects.
 * @param {string} rulesString The string containing rules and their percentages.
 * @returns {Array<object>|null} An array of rule objects or null if parsing fails.
 * Rule object: { id, name, description, percentage, isActive, claims }
 */
function parseGameRulesFromString(rulesString) {
    if (!rulesString || typeof rulesString !== 'string') return null;

    const rulesArray = rulesString.split(',').map((r, index) => {
        const parts = r.split(':');
        if (parts.length !== 2 || !parts[0].trim() || isNaN(parseFloat(parts[1]))) return null;
        const name = parts[0].trim();
        const percentage = parseFloat(parts[1]);
        if (percentage <= 0 || percentage > 100) return null; // Percentage must be valid

        return {
            id: `rule_${name.replace(/\s+/g, '')}_${index}`, // Simple unique ID
            name: name,
            description: `${name} prize`,
            percentage: percentage,
            isActive: true, // Default to active
            claims: [], // To be populated by { userId, playerName, ticketId, coinsAwarded, timestamp }
            // baseWeight, originalWeight could be added for advanced prize logic
        };
    }).filter(r => r !== null); // Remove any nulls from failed parsing

    if (rulesArray.length === 0 && rulesString.trim() !== "") {
        // Input was not empty but nothing valid was parsed
        return null;
    }
    return rulesArray;
}


// Make functions available globally if not using modules, or export if using modules.
// window.generateRoomId = generateRoomId;
// window.generateTambolaTicket = generateTambolaTicket;
// window.generateQrCode = generateQrCode;
// window.formatFirestoreTimestamp = formatFirestoreTimestamp;
// window.parseGameRulesFromString = parseGameRulesFromString;
// window.generateUniqueId = generateUniqueId;
