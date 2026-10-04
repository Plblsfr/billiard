import type { ChatLine } from '../net/online.js';

export interface ChatElements {
  panel: HTMLElement;
  list: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  quick: HTMLElement;
  error: HTMLElement;
  toggle: HTMLButtonElement;
  unread: HTMLElement;
  close: HTMLElement;
}

export interface ChatHost {
  /** Envoie le texte ; le message revient ensuite par le flux de la salle. */
  send(text: string): Promise<void>;
  /** Un message d'un autre joueur vient d'arriver. */
  incoming(): void;
}

const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Panneau de chat de la salle (jeu en ligne). */
export class Chat {
  private seen = new Set<number>();
  private unread = 0;
  private mySeat = -1;
  private sending = false;

  constructor(
    private el: ChatElements,
    private host: ChatHost,
  ) {
    el.toggle.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    el.close.addEventListener('click', () => this.close());
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit(el.input.value);
    });
    el.quick.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.textContent) this.submit(b.textContent);
    });
    el.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.el.panel.hidden;
  }

  /** Nouvelle salle : historique vidé, bouton affiché. */
  reset(seat: number): void {
    this.mySeat = seat;
    this.seen.clear();
    this.el.list.innerHTML = '';
    this.setUnread(0);
    this.showError(null);
    this.el.toggle.hidden = false;
    this.renderEmpty();
  }

  /** Fin du jeu en ligne : bouton et panneau masqués. */
  disable(): void {
    this.close();
    this.el.toggle.hidden = true;
    this.el.list.innerHTML = '';
    this.seen.clear();
    this.setUnread(0);
  }

  open(): void {
    this.el.panel.hidden = false;
    document.body.classList.add('chat-open');
    this.el.toggle.setAttribute('aria-expanded', 'true');
    this.setUnread(0);
    this.scrollDown();
    this.el.input.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.panel.hidden = true;
    document.body.classList.remove('chat-open');
    this.el.toggle.setAttribute('aria-expanded', 'false');
    if (this.el.panel.contains(document.activeElement)) this.el.toggle.focus({ preventScroll: true });
  }

  add(lines: ChatLine[]): void {
    let fresh = 0;
    for (const line of lines) {
      // l'historique est renvoyé à chaque reconnexion : on ne garde que les nouveaux
      if (this.seen.has(line.id)) continue;
      this.seen.add(line.id);
      this.el.list.querySelector('.chat-empty')?.remove();
      const mine = line.seat === this.mySeat;
      const li = document.createElement('li');
      li.className = mine ? 'chat-line is-mine' : 'chat-line';
      const meta = document.createElement('span');
      meta.className = 'chat-meta';
      const who = document.createElement('strong');
      who.textContent = mine ? 'Vous' : line.name;
      const time = document.createElement('time');
      time.dateTime = new Date(line.at).toISOString();
      time.textContent = timeFmt.format(line.at);
      meta.append(who, ' ', time);
      const text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = line.text;
      li.append(meta, text);
      this.el.list.append(li);
      if (!mine) fresh++;
    }
    while (this.el.list.children.length > 100) this.el.list.firstElementChild?.remove();
    this.scrollDown();
    if (fresh > 0) {
      if (!this.isOpen) this.setUnread(this.unread + fresh);
      this.host.incoming();
    }
  }

  private submit(raw: string): void {
    const text = raw.trim();
    if (!text || this.sending) return;
    this.sending = true;
    this.showError(null);
    this.host
      .send(text)
      .then(() => {
        if (this.el.input.value.trim() === text) this.el.input.value = '';
      })
      .catch((err: Error) => this.showError(err.message))
      .finally(() => {
        this.sending = false;
      });
  }

  private renderEmpty(): void {
    const li = document.createElement('li');
    li.className = 'chat-empty';
    li.textContent = 'Aucun message pour l’instant. Dites bonjour !';
    this.el.list.append(li);
  }

  private setUnread(n: number): void {
    this.unread = n;
    this.el.unread.hidden = n === 0;
    this.el.unread.textContent = n > 9 ? '9+' : String(n);
    this.el.toggle.setAttribute('aria-label', n ? `Chat, ${n} message${n > 1 ? 's' : ''} non lu${n > 1 ? 's' : ''}` : 'Chat');
  }

  private showError(msg: string | null): void {
    this.el.error.textContent = msg ?? '';
    this.el.error.hidden = !msg;
  }

  private scrollDown(): void {
    this.el.list.scrollTop = this.el.list.scrollHeight;
  }
}
