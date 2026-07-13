import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

const firebaseConfig = {
  projectId: 'mikeadair-catan',
  appId: '1:143647896710:web:0bda6561ec2d3122848d07',
  storageBucket: 'mikeadair-catan.firebasestorage.app',
  apiKey: 'AIzaSyABWrKog3hsuwKFg9xhjJtjkk7K9mtwEso',
  authDomain: 'mikeadair-catan.firebaseapp.com',
  messagingSenderId: '143647896710',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

// e2e tests (web/playwright.config.ts) run against the Firebase Local Emulator Suite
// instead of the real `mikeadair-catan` project, so they never read or write production
// data. This only activates when the dev server Playwright spawns is started with
// VITE_USE_FIREBASE_EMULATOR=true; real users never set that flag, so the config/instances
// above stay exactly as they are today. Ports match firebase.json's `emulators` block.
if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
