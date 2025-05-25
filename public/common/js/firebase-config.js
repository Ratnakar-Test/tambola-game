// TODO: Replace with your actual Firebase project configuration
const firebaseConfig = {
    apiKey: "AIzaSyDeQ3YkvRLvPFnpTPz-aDyh9Yr6JNLqWF0",
    authDomain: "tambola-premium.firebaseapp.com",
    projectId: "tambola-premium",
    storageBucket: "tambola-premium.firebasestorage.app",
    messagingSenderId: "431036089573",
    appId: "1:431036089573:web:523500fb519d887535800c",
    measurementId: "G-EQHHTY8QKE"

};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
// firebase.analytics(); // If you enabled Google Analytics

const auth = firebase.auth();
const db = firebase.firestore();
// const functions = firebase.functions(); // Optional: if you want to call functions directly from client

// Example: For a specific region if your functions are not in us-central1
// const functions = firebase.app().functions('asia-south1');


// Firebase UI configuration for email link sign-in (if you were using FirebaseUI)
// const uiConfig = {
//     signInOptions: [
//         {
//             provider: firebase.auth.EmailAuthProvider.PROVIDER_ID,
//             signInMethod: firebase.auth.EmailAuthProvider.EMAIL_LINK_SIGN_IN_METHOD
//         }
//     ],
//     signInFlow: 'popup', // Or 'redirect'
//     signInSuccessUrl: '/', // Where to redirect after sign-in
//     tosUrl: '<your-tos-url>', // Terms of Service URL
//     privacyPolicyUrl: '<your-privacy-policy-url>' // Privacy Policy URL
// };

// Email link action code settings
const actionCodeSettings = {
    // URL you want to redirect back to. The domain (www.example.com) for this
    // URL must be whitelisted in the Firebase Console.
    url: window.location.href.split('?')[0], // Use current URL as base, remove query params
    // This must be true.
    handleCodeInApp: true,
    // iOS: {
    //   bundleId: 'com.example.ios'
    // },
    // android: {
    //   packageName: 'com.example.android',
    //   installApp: true,
    //   minimumVersion: '12'
    // },
    // dynamicLinkDomain: 'example.page.link' // If you use dynamic links
};
