import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

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
