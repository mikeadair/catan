// Test-only stand-in for the Firebase Functions emulator, used by the e2e/screenshot CI job.
// The Functions emulator's worker process is unreliable in this class of sandboxed
// environment (WSL2 locally, and now GitHub Actions too): it dies silently on invocation
// ("killed because it raised an unhandled error", no stack trace forwarded through
// firebase-tools' own logging) even in --debug mode. That's a firebase-tools/emulator
// infrastructure issue, not application code — npm run test -w functions calls
// startGameHandler/submitActionHandler directly (no Functions Framework HTTP layer) and has
// always passed 100% reliably, locally and in CI.
//
// This bridge serves those exact same handlers over a minimal HTTP server implementing just
// enough of the callable-functions wire protocol (see @firebase/functions' _url()/postJSON()/
// makeAuthHeaders()) for the web client's httpsCallable() to talk to it in place of the real
// emulator. It is never bundled into the deployed function (only src/index.ts's exports are;
// see functions/package.json's build script) and is not referenced by firebase.json.
import http from 'node:http';
import { getAuth } from 'firebase-admin/auth';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { startGameHandler } from './startGame';
import { submitActionHandler } from './submitAction';

const PORT = Number(process.env.E2E_BRIDGE_PORT ?? 5001);
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'mikeadair-catan';

const ROUTES: Record<string, (request: CallableRequest<any>) => Promise<unknown>> = {
  startGame: startGameHandler,
  submitAction: submitActionHandler,
};

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function authenticate(req: http.IncomingMessage): Promise<CallableRequest<unknown>['auth']> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const rawToken = header.slice('Bearer '.length);
  const token = await getAuth().verifyIdToken(rawToken);
  return { uid: token.uid, token, rawToken };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const [, , functionName] = url.pathname.split('/').filter(Boolean);
  const handler = functionName ? ROUTES[functionName] : undefined;

  if (req.method !== 'POST' || !handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: `Unknown function: ${functionName}` } }));
    return;
  }

  void (async () => {
    try {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const auth = await authenticate(req).catch(() => {
        throw new HttpsError('unauthenticated', 'Invalid ID token.');
      });
      const request = { data: parsed.data, auth, rawRequest: req, acceptsStreaming: false } as CallableRequest<any>;
      const result = await handler(request);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    } catch (err) {
      if (err instanceof HttpsError) {
        res.writeHead(err.httpErrorCode.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.toJSON() }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { status: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } }));
      }
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[e2e-bridge] listening on 127.0.0.1:${PORT} for project ${PROJECT_ID}`);
});
