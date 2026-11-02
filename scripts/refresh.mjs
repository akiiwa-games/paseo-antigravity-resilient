// node refresh.mjs <ws-url|offer-file> <provider>
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import {WebSocket} from 'ws';
import {parseConnectionOfferFromUrl} from '@getpaseo/protocol/connection-offer';
import {buildRelayWebSocketUrl} from '@getpaseo/protocol/daemon-endpoints';
const [target, provider] = process.argv.slice(2);
let url, e2ee;
if (target.startsWith('ws')) url = target;
else { const offer = parseConnectionOfferFromUrl(fs.readFileSync(target, 'utf8').trim());
  url = buildRelayWebSocketUrl({...offer.relay, serverId: offer.serverId, role: 'client'}); e2ee = {enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64}; }
const client = new DaemonClient({url, clientId: randomUUID(), clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 30000,
  webSocketFactory: (u, c) => new WebSocket(u, {headers: c?.headers, protocols: c?.protocols}), ...(e2ee ? {e2ee} : {}), reconnect: {enabled: false}});
await client.connect();
try {
  const name = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).find(n => /refreshProvidersSnapshot|refreshProviderSnapshot/i.test(n));
  const r = await client[name]({providers: [provider]});
  console.log(name, JSON.stringify(r).slice(0, 400));
} finally { await client.close(); }
