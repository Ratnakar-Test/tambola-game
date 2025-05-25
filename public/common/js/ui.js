// Common UI Helper Functions

/**
 * Initializes a theme toggle checkbox.
 * Listens for changes and updates the <html> data-theme attribute and localStorage.
 * @param {string} checkboxId The ID of the theme toggle checkbox.
 */
function initializeThemeToggle(checkboxId) {
    const themeToggleCheckbox = document.getElementById(checkboxId);
    if (!themeToggleCheckbox) {
        // console.warn(`Theme toggle checkbox with ID '${checkboxId}' not found.`);
        return;
    }

    // Set initial state of the checkbox based on current theme
    const currentTheme = localStorage.getItem('theme') || document.documentElement.getAttribute('data-theme') || 'light';
    if (currentTheme === 'dark') {
        themeToggleCheckbox.checked = true;
    } else {
        themeToggleCheckbox.checked = false;
    }
    // Ensure the html tag has the correct theme attribute on load
    document.documentElement.setAttribute('data-theme', currentTheme);


    themeToggleCheckbox.addEventListener('change', function() {
        const selectedTheme = this.checked ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', selectedTheme);
        localStorage.setItem('theme', selectedTheme);
        console.log("Theme changed to: " + selectedTheme);
    });
}

// Example of how to use it on a page:
// Call this after the DOM is loaded, perhaps at the end of admin.js and player.js
// if (document.getElementById('themeToggleAdmin')) { // Or whatever your ID is
//     initializeThemeToggle('themeToggleAdmin');
// }
// if (document.getElementById('themeTogglePlayer')) {
//     initializeThemeToggle('themeTogglePlayer');
// }


// You can add more common UI functions here, like:
// - Modal open/close functions
// - Dynamic list rendering helpers
// - Notification/alert display functions

/**
 * Shows a generic modal with a title and message.
 * Assumes a DaisyUI modal structure is in the HTML.
 * <dialog id="my_modal_1" class="modal">
 * <div class="modal-box">
 * <h3 class="font-bold text-lg" id="modalTitle">Hello!</h3>
 * <p class="py-4" id="modalMessage">Press ESC key or click the button below to close</p>
 * <div class="modal-action">
 * <form method="dialog">
 * <button class="btn" id="modalCloseButton">Close</button>
 * </form>
 * </div>
 * </div>
 * </dialog>
 */
function showModal(modalId, title, message) {
    const modal = document.getElementById(modalId);
    const modalTitle = modal ? modal.querySelector('#modalTitle') : null; // Ensure these IDs exist in your modal
    const modalMessage = modal ? modal.querySelector('#modalMessage') : null;

    if (modal && modalTitle && modalMessage) {
        modalTitle.textContent = title;
        modalMessage.innerHTML = message; // Use innerHTML if message contains HTML
        if (typeof modal.showModal === "function") {
            modal.showModal();
        } else {
            console.error("Modal element or its showModal method not found.");
        }
    } else {
        console.error(`Modal with ID '${modalId}' or its title/message elements not found.`);
    }
}

// To close the modal, the DaisyUI default is form method="dialog" or modal.close()
// function closeModal(modalId) {
//     const modal = document.getElementById(modalId);
//     if (modal && typeof modal.close === "function") {
//         modal.close();
//     }
// }
