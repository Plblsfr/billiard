// Serveur de salons pour le jeu en ligne, sans dépendance.
//
// Le serveur ne connaît pas les règles : il tient les places de la salle, relaie les messages
// entre navigateurs et garde le dernier état de la partie pour les reconnexions.
// Le navigateur du joueur qui tire calcule le coup et envoie l'état qui en résulte.
//
//   POST /api/rooms                  {name, count, realistic} → {code, seat, token}
//   POST /api/rooms/:code/join       {name, token?}         → {seat, token}
//   GET  /api/rooms/:code/events?token=…                    → flux SSE (hello, room, msg, closed)
//   POST /api/rooms/:code/send       {token, msg}           → {version?}
//   POST /api/rooms/:code/chat       {token, text}          → {}   (flux : événement « chat »)
//   POST /api/rooms/:code/leave      {token}                → {}
//   GET  /api/healthz
import { randomInt, randomUUID } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const MAX_BODY = 64 * 1024;
const NAME_MAX = 16;
const CHAT_MAX = 200;
/** Messages de chat gardés par salle (renvoyés à la connexion). */
const CHAT_KEEP = 50;
/** Au plus 5 messages par tranche de 5 secondes et par joueur. */
const CHAT_BURST = 5;
const CHAT_WINDOW_MS = 5000;

/** Messages relayés ; seul « state » est conservé. */
const RELAYED = new Set(['state', 'shot', 'aim']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanName(v, fallback) {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) : '';
  return s || fallback;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Message trop gros'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * @param {{ maxRooms?: number, idleMs?: number, heartbeatMs?: number, now?: () => number }} [opts]
 */
export function createRelay(opts = {}) {
  const maxRooms = opts.maxRooms ?? 1000;
  const idleMs = opts.idleMs ?? 2 * 60 * 60 * 1000;
  const heartbeatMs = opts.heartbeatMs ?? 20_000;
  const now = opts.now ?? Date.now;

  /** @type {Map<string, any>} */
  const rooms = new Map();

  function newCode() {
    for (let i = 0; i < 50; i++) {
      let code = '';
      for (let k = 0; k < CODE_LENGTH; k++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    throw new HttpError(503, 'Plus de salle disponible');
  }

  function getRoom(code) {
    const room = rooms.get(String(code).toUpperCase());
    if (!room) throw new HttpError(404, 'Salle introuvable');
    room.touched = now();
    return room;
  }

  function seatOf(room, token) {
    const i = typeof token === 'string' ? room.seats.findIndex((s) => s && s.token === token) : -1;
    if (i < 0) throw new HttpError(403, 'Vous ne faites pas partie de cette salle');
    return i;
  }

  function roomInfo(room) {
    return {
      code: room.code,
      count: room.count,
      realistic: room.realistic,
      host: 0,
      started: room.state !== null,
      seats: room.seats.map((s) => (s ? { name: s.name, online: s.clients.size > 0 } : null)),
    };
  }

  function broadcast(room, event, data, exceptSeat = -1) {
    room.seats.forEach((s, i) => {
      if (!s || i === exceptSeat) return;
      for (const res of s.clients) sse(res, event, data);
    });
  }

  function closeRoom(room, reason) {
    broadcast(room, 'closed', { reason });
    for (const s of room.seats) if (s) for (const res of s.clients) res.end();
    rooms.delete(room.code);
  }

  // ---------- routes ----------
  async function create(req, res) {
    const body = await readJson(req);
    if (rooms.size >= maxRooms) throw new HttpError(503, 'Trop de salles ouvertes, réessayez plus tard');
    const count = body.count === 3 ? 3 : 2;
    const code = newCode();
    const token = randomUUID();
    const seats = Array(count).fill(null);
    seats[0] = { name: cleanName(body.name, 'Joueur 1'), token, clients: new Set(), chatTimes: [] };
    const realistic = body.realistic === true;
    rooms.set(code, { code, count, realistic, seats, state: null, version: 0, turn: 0, over: false, chat: [], chatId: 0, touched: now() });
    json(res, 201, { code, seat: 0, token });
  }

  async function join(req, res, code) {
    const body = await readJson(req);
    const room = getRoom(code);
    const known = typeof body.token === 'string' ? room.seats.findIndex((s) => s && s.token === body.token) : -1;
    if (known >= 0) {
      const s = room.seats[known];
      if (room.state === null && typeof body.name === 'string') s.name = cleanName(body.name, s.name);
      broadcast(room, 'room', roomInfo(room));
      return json(res, 200, { seat: known, token: s.token });
    }
    const free = room.seats.findIndex((s) => s === null);
    if (free < 0 || room.state !== null) throw new HttpError(409, 'Salle complète');
    const token = randomUUID();
    room.seats[free] = { name: cleanName(body.name, `Joueur ${free + 1}`), token, clients: new Set(), chatTimes: [] };
    broadcast(room, 'room', roomInfo(room));
    json(res, 200, { seat: free, token });
  }

  function events(req, res, code, url) {
    const room = getRoom(code);
    const seat = seatOf(room, url.searchParams.get('token'));
    const s = room.seats[seat];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    s.clients.add(res);
    sse(res, 'hello', { seat });
    broadcast(room, 'room', roomInfo(room));
    if (room.chat.length) sse(res, 'chatlog', room.chat);
    if (room.state) sse(res, 'msg', room.state);
    req.on('close', () => {
      s.clients.delete(res);
      if (rooms.get(room.code) === room) {
        room.touched = now();
        broadcast(room, 'room', roomInfo(room));
      }
    });
  }

  async function send(req, res, code) {
    const body = await readJson(req);
    const room = getRoom(code);
    const seat = seatOf(room, body.token);
    const msg = body.msg;
    if (!msg || typeof msg !== 'object' || !RELAYED.has(msg.type)) throw new HttpError(400, 'Message inconnu');

    if (msg.type === 'state') {
      // l'hôte lance la partie (ou la revanche) ; ensuite seul le joueur dont c'est le tour fait avancer
      const hostMayReset = seat === 0 && (room.state === null || room.over);
      if (!hostMayReset && seat !== room.turn) throw new HttpError(409, "Ce n'est pas votre tour");
      if (!Number.isInteger(msg.turn) || msg.turn < 0 || msg.turn >= room.count) throw new HttpError(400, 'Tour invalide');
      if (room.seats.some((x) => x === null)) throw new HttpError(409, 'Il manque des joueurs');
      const stored = { ...msg, from: seat, version: ++room.version };
      room.state = stored;
      room.turn = msg.turn;
      room.over = msg.over === true;
      broadcast(room, 'msg', stored, seat);
      return json(res, 200, { version: stored.version });
    }

    if (room.state === null || room.over || seat !== room.turn) throw new HttpError(409, "Ce n'est pas votre tour");
    broadcast(room, 'msg', { ...msg, from: seat }, seat);
    json(res, 200, {});
  }

  async function chat(req, res, code) {
    const body = await readJson(req);
    const room = getRoom(code);
    const seat = seatOf(room, body.token);
    const text = typeof body.text === 'string' ? body.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX) : '';
    if (!text) throw new HttpError(400, 'Message vide');
    const s = room.seats[seat];
    const t = now();
    s.chatTimes = s.chatTimes.filter((x) => t - x < CHAT_WINDOW_MS);
    if (s.chatTimes.length >= CHAT_BURST) throw new HttpError(429, 'Doucement, trop de messages');
    s.chatTimes.push(t);
    const line = { id: ++room.chatId, seat, name: s.name, text, at: t };
    room.chat.push(line);
    if (room.chat.length > CHAT_KEEP) room.chat.shift();
    // l'expéditeur le reçoit aussi : tout le monde voit les messages dans le même ordre
    broadcast(room, 'chat', line);
    json(res, 200, {});
  }

  async function leave(req, res, code) {
    const body = await readJson(req);
    const room = getRoom(code);
    const seat = seatOf(room, body.token);
    if (room.state === null) {
      // avant la partie : la place se libère, et la salle ferme si l'hôte s'en va
      if (seat === 0) {
        closeRoom(room, "L'hôte a fermé la salle");
      } else {
        for (const c of room.seats[seat].clients) c.end();
        room.seats[seat] = null;
        broadcast(room, 'room', roomInfo(room));
      }
    }
    json(res, 200, {});
  }

  // ---------- entretien ----------
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const s of room.seats) if (s) for (const res of s.clients) res.write(': ping\n\n');
    }
  }, heartbeatMs);
  const sweep = setInterval(() => sweepIdle(), Math.min(60_000, idleMs));
  heartbeat.unref?.();
  sweep.unref?.();

  function sweepIdle() {
    const t = now();
    for (const room of [...rooms.values()]) {
      const online = room.seats.some((s) => s && s.clients.size > 0);
      if (!online && t - room.touched > idleMs) closeRoom(room, 'Salle fermée après inactivité');
    }
  }

  /**
   * Traite une requête /api/… ; renvoie faux si l'URL n'est pas pour le relais.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    const method = req.method ?? 'GET';

    const route = async () => {
      if (parts.length === 1 && parts[0] === 'healthz' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok\n');
        return;
      }
      if (parts[0] !== 'rooms') throw new HttpError(404, 'Introuvable');
      if (parts.length === 1 && method === 'POST') return create(req, res);
      const [, code, action] = parts;
      if (parts.length !== 3) throw new HttpError(404, 'Introuvable');
      if (action === 'events' && method === 'GET') return events(req, res, code, url);
      if (method !== 'POST') throw new HttpError(405, 'Méthode non autorisée');
      if (action === 'join') return join(req, res, code);
      if (action === 'send') return send(req, res, code);
      if (action === 'chat') return chat(req, res, code);
      if (action === 'leave') return leave(req, res, code);
      throw new HttpError(404, 'Introuvable');
    };

    route().catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Erreur du serveur' : err.message });
      else res.end();
    });
    return true;
  }

  function close() {
    clearInterval(heartbeat);
    clearInterval(sweep);
    for (const room of [...rooms.values()]) closeRoom(room, 'Serveur arrêté');
  }

  return { handle, close, sweepIdle, rooms };
}
