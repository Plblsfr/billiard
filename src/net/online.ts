/**
 * Connexion au serveur de salons : création / entrée dans une salle, flux d'événements (SSE)
 * et envoi des messages de jeu (POST). Aucune règle ici, seulement le transport.
 */
import type { MatchSnapshot } from '../game/match.js';

export interface SeatInfo {
  name: string;
  online: boolean;
}

export interface RoomInfo {
  code: string;
  count: 2 | 3;
  host: number;
  started: boolean;
  seats: (SeatInfo | null)[];
}

/** État officiel de la partie, envoyé par l'hôte au départ puis par le tireur après chaque coup. */
export interface StateMsg {
  type: 'state';
  /** Numéro de partie dans la salle (revanches). */
  game: number;
  /** Place (siège) de chaque joueur de la partie, dans l'ordre du jeu. */
  order: number[];
  /** Siège qui a la main. */
  turn: number;
  over: boolean;
  snap: MatchSnapshot;
}

export interface ShotMsg {
  type: 'shot';
  angle: number;
  power: number;
  spin: number;
  /** Numéro du coup (Match.shots après le tir). */
  shots: number;
}

/** Aperçu de la visée ou de la blanche en main, pour les autres écrans. */
export interface AimMsg {
  type: 'aim';
  angle: number;
  power: number;
  x?: number;
  y?: number;
}

export type GameMsg = StateMsg | ShotMsg | AimMsg;
export type Incoming = GameMsg & { from: number; version?: number };

export interface Session {
  code: string;
  seat: number;
  token: string;
}

export interface OnlineHandlers {
  room(info: RoomInfo): void;
  msg(m: Incoming): void;
  connection(connected: boolean): void;
  closed(reason: string): void;
}

const API = '/api';

/** Erreur renvoyée par le serveur (status 0 : serveur injoignable). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const AIM_INTERVAL = 70;

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Serveur injoignable', 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  // sans message JSON, la réponse ne vient pas du relais (pas déployé ou arrêté)
  if (!res.ok) throw new ApiError(data.error ?? 'Le jeu en ligne n’est pas disponible sur ce serveur', res.status);
  return data;
}

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export async function createRoom(name: string, count: 2 | 3): Promise<Session> {
  return post<Session>('/rooms', { name, count });
}

export async function joinRoom(code: string, name: string, token?: string): Promise<Session> {
  const c = normalizeCode(code);
  const r = await post<{ seat: number; token: string }>(`/rooms/${c}/join`, { name, token });
  return { code: c, seat: r.seat, token: r.token };
}

export class Online {
  private source: EventSource | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private aimPending: AimMsg | null = null;
  private aimTimer: number | null = null;
  private aimLast = 0;
  private closed = false;
  private retryTimer: number | null = null;

  constructor(
    readonly session: Session,
    private handlers: OnlineHandlers,
  ) {}

  get seat(): number {
    return this.session.seat;
  }

  connect(): void {
    const { code, token } = this.session;
    const src = new EventSource(`${API}/rooms/${code}/events?token=${encodeURIComponent(token)}`);
    this.source = src;
    src.addEventListener('open', () => this.handlers.connection(true));
    src.addEventListener('error', () => {
      if (this.closed) return;
      this.handlers.connection(false);
      // EventSource abandonne sur une réponse en erreur : on vérifie la salle avant de réessayer
      if (src.readyState === EventSource.CLOSED) this.retry();
    });
    src.addEventListener('room', (e) => this.handlers.room(JSON.parse((e as MessageEvent<string>).data) as RoomInfo));
    src.addEventListener('msg', (e) => this.handlers.msg(JSON.parse((e as MessageEvent<string>).data) as Incoming));
    src.addEventListener('closed', (e) => {
      const { reason } = JSON.parse((e as MessageEvent<string>).data) as { reason: string };
      this.fail(reason);
    });
  }

  private retry(): void {
    this.source?.close();
    this.source = null;
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      const { code, token } = this.session;
      post(`/rooms/${code}/join`, { token })
        .then(() => {
          if (!this.closed) this.connect();
        })
        .catch((err: ApiError) => {
          if (err.status === 404 || err.status === 403) this.fail('La salle n’existe plus');
          else this.retry();
        });
    }, 2000);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.disconnect();
    this.handlers.closed(reason);
  }

  /** Envoie un message ; les envois restent dans l'ordre. Renvoie la version pour un état. */
  send(msg: StateMsg | ShotMsg): Promise<number | undefined> {
    const { code, token } = this.session;
    const p = this.queue.then(() => post<{ version?: number }>(`/rooms/${code}/send`, { token, msg }));
    this.queue = p.catch(() => undefined);
    return p.then((r) => r.version);
  }

  /** Aperçu de visée : seul le plus récent compte, au plus un toutes les 70 ms. */
  aim(msg: AimMsg): void {
    this.aimPending = msg;
    if (this.aimTimer !== null) return;
    const wait = Math.max(0, this.aimLast + AIM_INTERVAL - performance.now());
    this.aimTimer = window.setTimeout(() => {
      this.aimTimer = null;
      const m = this.aimPending;
      this.aimPending = null;
      if (!m || this.closed) return;
      this.aimLast = performance.now();
      const { code, token } = this.session;
      // hors file : un aperçu perdu ou refusé n'a pas d'importance
      post(`/rooms/${code}/send`, { token, msg: m }).catch(() => undefined);
    }, wait);
  }

  async leave(): Promise<void> {
    const { code, token } = this.session;
    this.disconnect();
    await post(`/rooms/${code}/leave`, { token }).catch(() => undefined);
  }

  disconnect(): void {
    this.closed = true;
    this.source?.close();
    this.source = null;
    if (this.aimTimer !== null) window.clearTimeout(this.aimTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.aimTimer = null;
    this.retryTimer = null;
  }
}
