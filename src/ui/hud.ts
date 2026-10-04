import type { Match } from '../game/match.js';
import { isOnBlack } from '../game/rules.js';
import { GROUP_LABEL } from '../game/types.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Point de vue d'un écran en ligne. */
export interface HudView {
  /** Indice du joueur de cet écran dans la partie. */
  me: number;
  /** Indices des joueurs déconnectés. */
  offline: number[];
  connected: boolean;
}

export class Hud {
  private lastKey = '';
  /** Vue 3D active : les consignes de visée changent. */
  threeD = false;

  constructor(
    private players: HTMLElement,
    private status: HTMLElement,
    private hint: HTMLElement,
    private power: HTMLElement,
    private spin: HTMLElement,
  ) {}

  /** Redessine le bandeau si l'état a changé (appelé à chaque image). */
  update(m: Match, view: HudView | null = null): void {
    const r = m.rules;
    const key = JSON.stringify([m.phase, r, m.shots, view, this.threeD]);
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.players.innerHTML = r.players
      .map((p, i) => {
        const current = i === r.current && m.phase !== 'over';
        let chip = m.playerCount === 3 ? 'open' : 'open2';
        let info = 'Table ouverte';
        if (p.eliminated) info = 'Éliminé·e';
        else if (p.group) {
          chip = p.group;
          const n = r.onTable[p.group];
          info = isOnBlack(r, i)
            ? 'Joue la noire'
            : `${n} ${n > 1 ? GROUP_LABEL[p.group].many : GROUP_LABEL[p.group].one} à rentrer`;
        }
        if (isOnBlack(r, i) && !p.eliminated) chip = 'black';
        if (r.winner === i) info = 'Vainqueur';
        if (view?.offline.includes(i)) info = `Hors ligne · ${info}`;
        const you = view?.me === i ? ' <small class="you">vous</small>' : '';
        const badge = current ? `<span class="badge">${r.visits === 2 ? '2 coups' : 'À jouer'}</span>` : '<span></span>';
        return `<li class="player${p.eliminated ? ' is-out' : ''}" aria-current="${current}">
          <span class="chip" data-kind="${chip}"></span>
          <span class="player-name">${escapeHtml(p.name)}${you}</span>${badge}
          <span class="player-info">${info}</span>
        </li>`;
      })
      .join('');

    const name = escapeHtml(r.players[r.current]!.name);
    const o = m.lastOutcome;
    if (!o) {
      this.status.innerHTML =
        m.phase === 'placing'
          ? `<strong>${name}</strong> casse. Placez la blanche derrière la ligne de baulk.`
          : `<strong>${name}</strong> casse.`;
    } else {
      this.status.innerHTML = o.messages
        .map((msg, i) => (i === 0 && o.foul ? `<span class="foul">${escapeHtml(msg)}</span>` : escapeHtml(msg)))
        .join(' · ');
    }

    const hints: Record<Match['phase'], string> = {
      placing: 'Bille en main : déplacez la blanche dans la zone de baulk puis cliquez ou relâchez pour la poser.',
      aiming: this.threeD
        ? '3D : glissez sur la table pour viser (ou « Derrière la blanche ») · clic droit ou deux doigts pour tourner · molette ou pincer pour zoomer.'
        : 'Glissez sur la table pour viser · tirez la jauge vers le bas puis relâchez pour jouer · ← → ↑ ↓ Espace au clavier.',
      rolling: ' ',
      over: 'Partie terminée.',
    };
    const myTurn = !view || view.me === r.current;
    let hint = hints[m.phase];
    if (view && !view.connected) hint = 'Connexion perdue, reconnexion…';
    else if (!myTurn && (m.phase === 'placing' || m.phase === 'aiming')) {
      const who = r.players[r.current]!.name;
      hint = view?.offline.includes(r.current) ? `${who} est hors ligne : en attente de son retour…` : `Au tour de ${who}…`;
    }
    this.hint.textContent = hint;
    const disabled = String(m.phase !== 'aiming' || !myTurn);
    this.power.setAttribute('aria-disabled', disabled);
    this.spin.setAttribute('aria-disabled', disabled);
  }

  invalidate(): void {
    this.lastKey = '';
  }
}
