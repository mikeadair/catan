// Must run before any test file imports './db' (which calls initializeApp()/getFirestore()
// at module-load time) — vitest's setupFiles run before the test file's own imports resolve,
// so this is the one place these env vars are guaranteed to land in time.
process.env.FIRESTORE_EMULATOR_HOST ??= 'localhost:8080';
process.env.GCLOUD_PROJECT ??= 'demo-catan-test';
