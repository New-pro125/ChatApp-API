/**
 * Manual live protocol check: `node scripts/clamd-live-check.mjs`.
 * Requires clamd on 127.0.0.1:3310 (`docker compose --profile scan up -d`).
 */
import { connect } from 'node:net';

const HOST = '127.0.0.1';
const PORT = 3310;
const TIMEOUT_MS = 5000;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const scan = (payload) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port: PORT });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`clamd did not answer within ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    socket.once('connect', () => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(payload.length, 0);
      socket.write(Buffer.from('zINSTREAM\0'));
      socket.write(length);
      socket.write(payload);
      socket.write(Buffer.alloc(4));
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const reply = Buffer.concat(chunks);
      if (!reply.includes(0)) {
        return;
      }
      clearTimeout(timer);
      socket.destroy();
      resolve(reply.toString('utf8'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const clean = await scan(Buffer.from('smoke bytes\n'));
if (clean !== 'stream: OK\0') {
  throw new Error(`Unexpected clean reply: ${JSON.stringify(clean)}`);
}

const infected = await scan(Buffer.from(EICAR));
if (!(infected.startsWith('stream: ') && infected.endsWith(' FOUND\0'))) {
  throw new Error(`Expected a FOUND verdict, got: ${JSON.stringify(infected)}`);
}

console.log(`clean: ${JSON.stringify(clean)}`);
console.log(`infected: ${JSON.stringify(infected)}`);
