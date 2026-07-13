import { doc, getDoc, setDoc } from 'firebase/firestore';
import type { PlayerColor } from '@catan/engine';
import { db } from './config';

// users/{uid} — a small, per-account preference doc (display name + preferred color),
// only ever populated once a guest upgrades to a real (email) account. Anonymous sessions
// never read or write this collection. See firestore.rules for the matching own-doc-only
// read/write rule.
export interface UserProfile {
  displayName: string;
  color: PlayerColor;
}

function userRef(uid: string) {
  return doc(db, 'users', uid);
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(userRef(uid));
  return snap.exists() ? (snap.data() as UserProfile) : null;
}

export async function saveUserProfile(uid: string, profile: UserProfile): Promise<void> {
  await setDoc(userRef(uid), profile, { merge: true });
}
