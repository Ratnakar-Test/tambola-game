// Ensure firebase.js (and firebase-config.js) is loaded before this script
// This script assumes `auth` and `actionCodeSettings` are available from firebase-config.js

const
    uiContainer = document.getElementById('firebaseui-auth-container'); // If using FirebaseUI
const emailInput = document.getElementById('emailInput'); // Assuming an input with id="emailInput"
const sendLinkButton = document.getElementById('sendLinkButton'); // Assuming a button with id="sendLinkButton"
const signOutButton = document.getElementById('signOutButton'); // Assuming a button with id="signOutButton"
const userStatusElement = document.getElementById('userStatus'); // Element to display user status
const userNameDisplay = document.getElementById('userNameDisplay'); // Element to display user name/email

// Function to send sign-in link
async function sendSignInLink(email) {
    if (!email) {
        alert('Please enter your email address.');
        return;
    }
    try {
        // Update actionCodeSettings.url to the current page to handle the link correctly
        actionCodeSettings.url = window.location.href.split('?')[0];
        await auth.sendSignInLinkToEmail(email, actionCodeSettings);
        window.localStorage.setItem('emailForSignIn', email); // Store email locally
        alert(`A sign-in link has been sent to ${email}. Please check your inbox.`);
        if (emailInput) emailInput.value = ''; // Clear input
    } catch (error) {
        console.error("Error sending sign-in link:", error);
        alert(`Error sending sign-in link: ${error.message}`);
    }
}

// Function to handle sign-in completion
async function completeSignIn() {
    if (auth.isSignInWithEmailLink(window.location.href)) {
        let email = window.localStorage.getItem('emailForSignIn');
        if (!email) {
            // User opened the link on a different device. To prevent session fixation
            // attacks, ask the user to provide the email again. For example:
            email = window.prompt('Please provide your email for confirmation');
            if (!email) {
                alert('Email is required to complete sign-in.');
                return;
            }
        }
        try {
            const result = await auth.signInWithEmailLink(email, window.location.href);
            window.localStorage.removeItem('emailForSignIn'); // Clean up
            // You can access the new user via result.user
            // Additional user info profile not available via offline sign-in.
            console.log("User signed in:", result.user);
            // Redirect to a logged-in page or update UI
            // window.location.replace('/'); // Or appropriate page
            updateUserStatus(result.user);
            // Clear the URL of the sign-in link parameters
            if (window.history && window.history.replaceState) {
                window.history.replaceState({}, document.title, window.location.pathname);
            }

        } catch (error) {
            console.error("Error completing sign-in:", error);
            alert(`Error completing sign-in: ${error.message}`);
            // window.location.replace('/signin-error.html'); // Redirect to an error page
        }
    }
}

// Function to sign out
async function signOutUser() {
    try {
        await auth.signOut();
        console.log("User signed out.");
        // Redirect or update UI
        // window.location.replace('/');
        updateUserStatus(null);
    } catch (error) {
        console.error("Error signing out:", error);
        alert(`Error signing out: ${error.message}`);
    }
}

// Update UI based on auth state
function updateUserStatus(user) {
    if (user) {
        if (userStatusElement) userStatusElement.textContent = `Signed in as: ${user.email}`;
        if (userNameDisplay) userNameDisplay.textContent = user.displayName || user.email;
        if (emailInput) emailInput.style.display = 'none';
        if (sendLinkButton) sendLinkButton.style.display = 'none';
        if (signOutButton) signOutButton.style.display = 'block';
    } else {
        if (userStatusElement) userStatusElement.textContent = 'You are not signed in.';
        if (userNameDisplay) userNameDisplay.textContent = '';
        if (emailInput) emailInput.style.display = 'block';
        if (sendLinkButton) sendLinkButton.style.display = 'block';
        if (signOutButton) signOutButton.style.display = 'none';
    }
}

// Listener for auth state changes
auth.onAuthStateChanged(user => {
    updateUserStatus(user);
    if (user) {
        // User is signed in.
        // You might want to fetch additional user data from Firestore here
        console.log("Auth state changed: User is signed in", user);
    } else {
        // User is signed out.
        console.log("Auth state changed: User is signed out");
        // Attempt to complete sign-in if the URL contains a sign-in link
        completeSignIn();
    }
});

// Event listeners for buttons (if they exist on the current page)
if (sendLinkButton && emailInput) {
    sendLinkButton.addEventListener('click', () => {
        sendSignInLink(emailInput.value);
    });
}

if (signOutButton) {
    signOutButton.addEventListener('click', signOutUser);
}

// Call completeSignIn on page load to handle incoming links immediately
// This is already handled by onAuthStateChanged, but can be called explicitly if needed.
// window.addEventListener('DOMContentLoaded', completeSignIn);
