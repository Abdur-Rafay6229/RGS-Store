// Firebase config — replace with env vars for production builds
// (e.g. window.__RGS_FIREBASE_CONFIG injected at build time)
const firebaseConfig = {
  apiKey: "AIzaSyBS1kNJWHUwD4BmxqYR_CF3WqFwEPlHqK8",
  authDomain: "rgs-store-99c55.firebaseapp.com",
  projectId: "rgs-store-99c55",
  storageBucket: "rgs-store-99c55.firebasestorage.app",
  messagingSenderId: "955139680771",
  appId: "1:955139680771:web:bc42dc095c47ff486dfc36",
  measurementId: "G-RCPTE7RXDB"
};

let firebaseReady = false;
let fbAuth = null, fbDb = null;

// Firebase CDN scripts (loaded before this file in index.html)
// provide the global `firebase` object.
try {
  if (typeof firebase !== 'undefined' && firebaseConfig.apiKey !== "YOUR_API_KEY_HERE") {
    firebase.initializeApp(firebaseConfig);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    // Session ek baar login karne par yaad rahe (browser/local persistence)
    try { fbAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) { console.warn('setPersistence failed', e); }
    firebaseReady = true;
  } else if (typeof firebase === 'undefined') {
    console.warn('Firebase CDN scripts not loaded — check network connection');
  }
} catch (e) { console.warn('Firebase init failed:', e); }
