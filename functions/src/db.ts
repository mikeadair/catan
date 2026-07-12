import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type DocumentReference } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();

export function roomRef(roomId: string): DocumentReference {
  return db.collection('rooms').doc(roomId);
}
export function playerRef(roomId: string, uid: string): DocumentReference {
  return db.collection('rooms').doc(roomId).collection('players').doc(uid);
}
export function handRef(roomId: string, uid: string): DocumentReference {
  return playerRef(roomId, uid).collection('private').doc('hand');
}
export function tradeRef(roomId: string, tradeId: string): DocumentReference {
  return db.collection('rooms').doc(roomId).collection('trades').doc(tradeId);
}
export function devDeckRef(roomId: string): DocumentReference {
  return db.collection('rooms').doc(roomId).collection('serverOnly').doc('devDeck');
}
