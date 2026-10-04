// Tests du serveur de salons (JavaScript pur : exécutés directement par node --test).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRelay } from '../server/relay.mjs';

let server;
let relay;
let base;

before(async () => {
  relay = createRelay({ heartbeatMs: 60_000 });
  server = createServer((req, res) => {
    if (!relay.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  relay.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Ouvre le flux SSE et renvoie une fonction qui attend le prochain événement d'un type donné. */
async function listen(code, token) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/rooms/${code}/events?token=${token}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const queue = [];
  const waiters = [];
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!ev) continue;
          queue.push({ event: ev, data: JSON.parse(data) });
          waiters.splice(0).forEach((w) => w());
        }
      }
    } catch {
      /* flux fermé */
    }
  })();
  async function next(event) {
    for (;;) {
      const k = queue.findIndex((e) => e.event === event);
      if (k >= 0) return queue.splice(k, 1)[0].data;
      await new Promise((r) => waiters.push(r));
    }
  }
  return { next, close: () => ctrl.abort() };
}

const state = (turn, over = false, game = 1) => ({ type: 'state', game, order: [0, 1], turn, over, snap: { shots: 0 } });

describe('relais de salons', () => {
  it('répond au healthcheck', async () => {
    const res = await fetch(`${base}/api/healthz`);
    assert.equal(res.status, 200);
  });

  it('crée une salle, fait entrer un joueur et relaie les messages dans l’ordre du jeu', async () => {
    const host = await post('/api/rooms', { name: 'Anna', count: 2, realistic: true });
    assert.equal(host.status, 201);
    assert.match(host.body.code, /^[A-Z2-9]{5}$/);
    const code = host.body.code;

    const a = await listen(code, host.body.token);
    assert.deepEqual(await a.next('hello'), { seat: 0 });
    let room = await a.next('room');
    assert.equal(room.seats[1], null);
    assert.equal(room.realistic, true, 'le mode de visée de la salle est partagé');

    // l'état ne part pas tant que la salle n'est pas pleine
    assert.equal((await post(`/api/rooms/${code}/send`, { token: host.body.token, msg: state(0) })).status, 409);

    const guest = await post(`/api/rooms/${code.toLowerCase()}/join`, { name: '  Bob<script>  ' });
    assert.equal(guest.status, 200);
    assert.equal(guest.body.seat, 1);
    room = await a.next('room');
    assert.equal(room.seats[1].name, 'Bob<script>');

    assert.equal((await post(`/api/rooms/${code}/join`, { name: 'Chloé' })).status, 409, 'salle complète');

    const b = await listen(code, guest.body.token);
    await b.next('hello');

    // l'invité ne peut ni lancer la partie ni jouer à la place de l'hôte
    assert.equal((await post(`/api/rooms/${code}/send`, { token: guest.body.token, msg: state(1) })).status, 409);

    const sent = await post(`/api/rooms/${code}/send`, { token: host.body.token, msg: state(0) });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.version, 1);
    const got = await b.next('msg');
    assert.equal(got.type, 'state');
    assert.equal(got.from, 0);
    assert.equal(got.version, 1);

    // tir et visée relayés depuis le joueur qui a la main seulement
    assert.equal((await post(`/api/rooms/${code}/send`, { token: guest.body.token, msg: { type: 'aim', angle: 1, power: 0 } })).status, 409);
    await post(`/api/rooms/${code}/send`, { token: host.body.token, msg: { type: 'shot', angle: 0.5, power: 1, spin: 0, shots: 1 } });
    assert.equal((await b.next('msg')).type, 'shot');

    // après le coup, la main passe à l'invité
    await post(`/api/rooms/${code}/send`, { token: host.body.token, msg: state(1) });
    assert.equal((await b.next('msg')).turn, 1);
    assert.equal((await post(`/api/rooms/${code}/send`, { token: host.body.token, msg: state(1) })).status, 409);
    assert.equal((await post(`/api/rooms/${code}/send`, { token: guest.body.token, msg: state(0, true) })).status, 200);

    // partie terminée : l'hôte peut lancer la revanche
    assert.equal((await post(`/api/rooms/${code}/send`, { token: host.body.token, msg: state(1, false, 2) })).status, 200);

    // une reconnexion reçoit le dernier état
    b.close();
    const again = await post(`/api/rooms/${code}/join`, { token: guest.body.token });
    assert.equal(again.body.seat, 1);
    const b2 = await listen(code, guest.body.token);
    const last = await b2.next('msg');
    assert.equal(last.game, 2);
    assert.equal(last.version, 4);

    a.close();
    b2.close();
  });

  it('refuse les inconnus et les salles absentes', async () => {
    const host = await post('/api/rooms', { name: 'Anna', count: 3 });
    const code = host.body.code;
    assert.equal((await post(`/api/rooms/${code}/send`, { token: 'faux', msg: state(0) })).status, 403);
    assert.equal((await fetch(`${base}/api/rooms/${code}/events?token=faux`)).status, 403);
    assert.equal((await post('/api/rooms/ZZZZZ/join', { name: 'x' })).status, 404);
    assert.equal((await post(`/api/rooms/${code}/send`, { token: host.body.token, msg: { type: 'autre' } })).status, 400);
  });

  it('ferme la salle quand l’hôte part avant la partie', async () => {
    const host = await post('/api/rooms', { name: 'Anna', count: 2 });
    const code = host.body.code;
    const guest = await post(`/api/rooms/${code}/join`, { name: 'Bob' });
    const b = await listen(code, guest.body.token);
    await b.next('hello');
    await post(`/api/rooms/${code}/leave`, { token: host.body.token });
    assert.match((await b.next('closed')).reason, /hôte/);
    assert.equal((await post(`/api/rooms/${code}/join`, { name: 'Chloé' })).status, 404);
  });

  it('relaie le chat à toute la salle, le garde pour les reconnexions et limite le débit', async () => {
    const host = await post('/api/rooms', { name: 'Anna', count: 2 });
    const code = host.body.code;
    const guest = await post(`/api/rooms/${code}/join`, { name: 'Bob' });
    const a = await listen(code, host.body.token);
    const b = await listen(code, guest.body.token);
    await a.next('hello');
    await b.next('hello');

    // le chat marche dès la salle d'attente, hors de tout tour de jeu
    assert.equal((await post(`/api/rooms/${code}/chat`, { token: guest.body.token, text: '  Salut\n<b>Anna</b>  ' })).status, 200);
    const seenByA = await a.next('chat');
    const seenByB = await b.next('chat');
    assert.equal(seenByA.text, 'Salut <b>Anna</b>');
    assert.equal(seenByA.name, 'Bob');
    assert.equal(seenByA.seat, 1);
    assert.equal(seenByB.id, seenByA.id, 'l’expéditeur reçoit son propre message');

    assert.equal((await post(`/api/rooms/${code}/chat`, { token: host.body.token, text: '   ' })).status, 400);
    assert.equal((await post(`/api/rooms/${code}/chat`, { token: 'faux', text: 'x' })).status, 403);
    const long = await post(`/api/rooms/${code}/chat`, { token: host.body.token, text: 'x'.repeat(500) });
    assert.equal(long.status, 200);
    assert.equal((await a.next('chat')).text.length, 200);

    // 5 messages par tranche de 5 s : le 6e est refusé (1 déjà envoyé)
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(`/api/rooms/${code}/chat`, { token: host.body.token, text: `m${i}` })).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 429]);

    // une reconnexion reçoit l'historique
    const a2 = await listen(code, host.body.token);
    const log = await a2.next('chatlog');
    assert.equal(log[0].text, 'Salut <b>Anna</b>');
    assert.equal(log.length, 6);
    a.close();
    a2.close();
    b.close();
  });

  it('libère la place d’un invité parti avant la partie', async () => {
    const host = await post('/api/rooms', { name: 'Anna', count: 2 });
    const code = host.body.code;
    const guest = await post(`/api/rooms/${code}/join`, { name: 'Bob' });
    await post(`/api/rooms/${code}/leave`, { token: guest.body.token });
    const other = await post(`/api/rooms/${code}/join`, { name: 'Chloé' });
    assert.equal(other.body.seat, 1);
  });
});
