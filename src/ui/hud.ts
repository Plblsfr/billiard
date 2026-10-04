import type { Match } from '../game/match.js';
import { isOnBlack } from '../game/rules.js';
import { GROUP_LABEL } from '../game/types.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class Hud {
  private lastKey = '';

  constructor(
    private players: HTMLElement,
    private status: HTMLElement,
    private hint: HTMLElement,
    private power: HTMLElement,
    private spin: HTMLElement,
  ) {}

  /** Redessine le bandeau si l'état a changé (appelé à chaque image). */
  update(m: Match): void {
    const r = m.rules;
    const key = JSON.stringify([m.phase, r, m.shots]);
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
        const badge = current ? `<span class="badge">${r.visits === 2 ? '2 coups' : 'À jouer'}</span>` : '<span></span>';
        return `<li class="player${p.eliminated ? ' is-out' : ''}" aria-current="${current}">
          <span class="chip" data-kind="${chip}"></span>
          <span class="player-name">${escapeHtml(p.name)}</span>${badge}
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
      aiming: 'Glissez sur la table pour viser · tirez la jauge vers le bas puis relâchez pour jouer · ← → ↑ ↓ Espace au clavier.',
      rolling: ' ',
      over: 'Partie terminée.',
    };
    this.hint.textContent = hints[m.phase];
    const disabled = String(m.phase !== 'aiming');
    this.power.setAttribute('aria-disabled', disabled);
    this.spin.setAttribute('aria-disabled', disabled);
  }

  invalidate(): void {
    this.lastKey = '';
  }
}
