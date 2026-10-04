/**
 * Rendu 3D de la table (WebGL, three.js), chargé seulement quand le joueur passe en 3D.
 *
 * La physique et les règles ne changent pas : on affiche la même partie que le rendu 2D.
 * Repère : la table (x, y) en mm devient (x − W/2, hauteur, y − H/2) ; l'axe y de three.js est la verticale.
 *
 * Caméra :
 *  - « libre » : on tourne autour de la table (clic droit, deux doigts, ou glisser quand on ne vise pas),
 *    on zoome (molette, pincer), et l'on vise en pointant la table comme en 2D ;
 *  - « derrière la blanche » : la caméra suit l'axe du tir ; glisser tourne la visée (gauche / droite)
 *    et la hauteur de la caméra (haut / bas) ;
 *  - « dessus » : vue de haut, comme en 2D.
 */
import * as THREE from 'three';
import { BALL_R, BAULK_X, BLACK_SPOT, FOOT_SPOT, TABLE_H, TABLE_W } from '../game/constants.js';
import type { Match } from '../game/match.js';
import { traceAim, type PhysicsEvent } from '../game/physics.js';
import { legalTargets } from '../game/rules.js';
import { CUSHIONS, POCKETS, type Segment, type Vec } from '../game/table.js';
import type { Ball, BallKind } from '../game/types.js';
import { cueGap, strikeLead, strikePose, type AimState, type TableRenderer, type TableView } from './types.js';

export type CameraMode = 'free' | 'behind' | 'top';

export interface Renderer3DHost {
  /** Angle de visée actuellement affiché (le sien ou celui du joueur qui a la main). */
  aimAngle(): number;
  /** Ce joueur vise en ce moment (glisser en vue « derrière la blanche » tourne alors la visée). */
  canRotateAim(): boolean;
  rotateAim(delta: number): void;
  /** Ce joueur place ou vise : un glisser sur la table lui revient (sinon il fait tourner la vue). */
  wantsPointer(): boolean;
  /** La vue reprend un geste commencé par les commandes de jeu (deuxième doigt). */
  cancelGamePointer(): void;
  /** Le mode de caméra a changé (bouton de la barre 3D). */
  modeChanged(mode: CameraMode): void;
}

const W = TABLE_W;
const H = TABLE_H;
const R = BALL_R;
const CUSHION_H = 38;
const CUSHION_BACK = 55;
const RAIL_H = 46;
const RAIL_OUT = 150;
const APRON = 170;
const FALL_MS = 420;
const RIPPLE_MS = 560;
const TILT = 0.085;

const COLORS: Record<BallKind, string> = {
  cue: '#f6f1e7',
  black: '#161616',
  red: '#d1342f',
  yellow: '#f0bd24',
  blue: '#2f63d6',
};
const FELT = '#2c6b52';
const CUSHION = '#245a45';
const RAIL = '#141414';
const CREME = '#faf6f3';
const ROSE = '#f4c7d5';
const ROSE_DARK = '#c8607f';

const X = (x: number): number => x - W / 2;
const Z = (y: number): number => y - H / 2;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const shortest = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

interface Pose {
  target: THREE.Vector3;
  yaw: number;
  pitch: number;
  dist: number;
}

interface Fall {
  mesh: THREE.Mesh;
  from: Vec;
  to: Vec;
  t0: number;
}

interface Ripple {
  mesh: THREE.Mesh;
  t0: number;
}

/** Bande pointillée ou pleine posée sur le tapis (les lignes WebGL n'ont qu'un pixel d'épaisseur). */
class Strip {
  readonly mesh: THREE.Mesh;
  private tex: THREE.Texture | null;

  constructor(scene: THREE.Scene, color: string, width: number, opacity: number, dashed: THREE.Texture | null) {
    this.tex = dashed ? dashed.clone() : null;
    if (this.tex) {
      this.tex.wrapS = THREE.RepeatWrapping;
      this.tex.needsUpdate = true;
    }
    const geo = new THREE.PlaneGeometry(1, width);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0.5, 0, 0);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      alphaMap: this.tex,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  set(from: Vec, to: Vec, color?: string): void {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    if (len < 1) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.mesh.position.set(X(from.x), 0.8, Z(from.y));
    this.mesh.rotation.y = -Math.atan2(to.y - from.y, to.x - from.x);
    this.mesh.scale.x = len;
    if (this.tex) this.tex.repeat.x = len / 26;
    if (color) (this.mesh.material as THREE.MeshBasicMaterial).color.set(color);
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

export class Renderer3D implements TableRenderer {
  readonly view: TableView;
  private gl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 10, 20000);
  private width = 1;
  private height = 1;

  private balls = new Map<number, THREE.Mesh>();
  private spins = new Map<number, { x: number; y: number }>();
  private ballGeo = new THREE.SphereGeometry(R, 40, 26);
  private ballMats: Record<BallKind, THREE.Material>;

  private stick = new THREE.Group();
  private stickInner = new THREE.Group();
  private stickMats: THREE.MeshStandardMaterial[] = [];
  private strike: { from: Vec; angle: number; gap: number; t0: number; lead: number } | null = null;

  private cueLine: Strip;
  private deflectLine: Strip;
  private targetLine: Strip;
  private ghost: THREE.Mesh;
  private halos: THREE.Mesh[] = [];
  private placeRing: THREE.Mesh;
  private baulk: THREE.Mesh;
  private falls: Fall[] = [];
  private ripples: Ripple[] = [];

  private _mode: CameraMode = 'free';
  private free: Pose;
  private behind = { pitch: 0.3, dist: 680 };
  private topDist = 0;
  private cur: Pose;
  private lastNow = 0;
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R);

  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: 'orbit' | 'aim' | 'pinch' | null = null;
  private pinchDist = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    surface: HTMLElement,
    private host: Renderer3DHost,
  ) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;

    const cueTex = this.cueBallTexture();
    const mat = (kind: BallKind): THREE.Material =>
      new THREE.MeshPhysicalMaterial({
        color: kind === 'cue' ? '#ffffff' : COLORS[kind],
        map: kind === 'cue' ? cueTex : null,
        roughness: 0.22,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
      });
    this.ballMats = { cue: mat('cue'), black: mat('black'), red: mat('red'), yellow: mat('yellow'), blue: mat('blue') };

    this.buildLights();
    this.buildTable();
    this.buildStick();

    const dash = this.dashTexture();
    this.cueLine = new Strip(this.scene, '#ffffff', 4, 0.75, dash);
    this.deflectLine = new Strip(this.scene, '#ffffff', 3, 0.4, dash);
    this.targetLine = new Strip(this.scene, '#ffffff', 5, 0.9, null);
    this.ghost = this.flatRing(R - 2.5, R + 0.5, '#ffffff', 0.85);
    this.placeRing = this.flatRing(R + 6, R + 10, CREME, 0.95);
    const baulkGeo = new THREE.PlaneGeometry(BAULK_X, H);
    baulkGeo.rotateX(-Math.PI / 2);
    this.baulk = new THREE.Mesh(
      baulkGeo,
      new THREE.MeshBasicMaterial({ color: ROSE, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    this.baulk.position.set(X(BAULK_X / 2), 0.4, 0);
    this.baulk.visible = false;
    this.scene.add(this.baulk);

    this.free = { target: new THREE.Vector3(0, 0, 0), yaw: Math.PI, pitch: 0.62, dist: 2500 };
    this.cur = { target: this.free.target.clone(), yaw: this.free.yaw, pitch: this.free.pitch, dist: this.free.dist };

    this.view = {
      toWorld: (sx, sy) => this.toWorld(sx, sy),
      screenDirToWorld: (dx, dy) => this.screenDirToWorld(dx, dy),
    };
    this.bindGestures(surface);
  }

  get mode(): CameraMode {
    return this._mode;
  }

  set mode(m: CameraMode) {
    if (m === this._mode) return;
    if (m === 'free') this.free = this.clonePose(this.cur);
    this._mode = m;
    this.host.modeChanged(m);
  }

  /** Revient à la vue d'ensemble de départ. */
  resetView(): void {
    this.free = { target: new THREE.Vector3(0, 0, 0), yaw: Math.PI, pitch: 0.62, dist: this.fitDist() };
    this._mode = 'free';
    this.host.modeChanged('free');
  }

  // ---------- TableRenderer ----------
  resize(width: number, height: number): void {
    const first = this.width <= 1;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // taille CSS fixée aussi : sur écran haute densité le tampon est plus grand que l'affichage
    this.gl.setSize(this.width, this.height, true);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.topDist = this.fitTopDist();
    if (first) {
      this.free.dist = this.fitDist();
      this.cur.dist = this.free.dist;
    }
  }

  reset(): void {
    for (const f of this.falls) this.scene.remove(f.mesh);
    for (const r of this.ripples) this.scene.remove(r.mesh);
    this.falls = [];
    this.ripples = [];
    this.strike = null;
    this.spins.clear();
  }

  event(e: PhysicsEvent, now = performance.now()): void {
    if (e.type !== 'pocket') return;
    const p = POCKETS[e.pocket];
    if (!p) return;
    const speed = Math.hypot(e.vx, e.vy);
    const push = Math.min(p.hole * 0.35, speed * 0.012);
    const to = speed > 0 ? { x: p.c.x + (e.vx / speed) * push, y: p.c.y + (e.vy / speed) * push } : { ...p.c };
    const mesh = new THREE.Mesh(this.ballGeo, this.ballMats[e.kind]);
    mesh.castShadow = true;
    const src = this.balls.get(e.a);
    if (src) mesh.quaternion.copy(src.quaternion);
    this.scene.add(mesh);
    this.falls.push({ mesh, from: { x: e.x, y: e.y }, to, t0: now });
    const ring = this.flatRing(p.hole + 4, p.hole + 9, COLORS[e.kind], 0.8);
    ring.position.set(X(p.c.x), RAIL_H + 0.6, Z(p.c.y));
    ring.visible = false;
    this.ripples.push({ mesh: ring, t0: now + FALL_MS * 0.55 });
  }

  shot(cue: Vec, angle: number, power: number, now = performance.now()): number {
    const lead = strikeLead(power);
    this.strike = { from: { x: cue.x, y: cue.y }, angle, gap: cueGap(power), t0: now, lead };
    return lead;
  }

  draw(m: Match, aim: AimState, now = performance.now()): void {
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;

    this.updateBalls(m.world.balls);
    this.updateFalls(now);
    this.updateRipples(now);
    this.updateGuides(m, aim, now);
    this.updateCamera(m, dt);
    this.gl.render(this.scene, this.camera);
  }

  // ---------- construction ----------
  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight('#fff4e6', '#2a2420', 0.9));
    // lampe de billard au-dessus du centre : l'ombre des billes sur le tapis
    const spot = new THREE.SpotLight('#fff8ee', 2.4, 0, 0.62, 0.55, 0);
    spot.position.set(0, 2300, 0);
    spot.target.position.set(0, 0, 0);
    spot.castShadow = true;
    const small = Math.min(screen.width, screen.height) < 700;
    spot.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    spot.shadow.camera.near = 1200;
    spot.shadow.camera.far = 2700;
    spot.shadow.bias = -0.0004;
    spot.shadow.radius = 5;
    this.scene.add(spot, spot.target);
    // deux lampes plus douces pour les reflets sur les billes
    for (const x of [-W / 4, W / 4]) {
      const p = new THREE.PointLight('#ffffff', 0.45, 0, 0);
      p.position.set(x, 1100, 0);
      this.scene.add(p);
    }
  }

  private buildTable(): void {
    // tapis
    const feltGeo = new THREE.PlaneGeometry(W + 2 * CUSHION_BACK, H + 2 * CUSHION_BACK);
    feltGeo.rotateX(-Math.PI / 2);
    const feltTex = this.feltTexture();
    const felt = new THREE.Mesh(feltGeo, new THREE.MeshStandardMaterial({ color: FELT, map: feltTex, roughness: 0.95 }));
    felt.receiveShadow = true;
    this.scene.add(felt);

    // ligne de baulk et mouches
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, H).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.32, depthWrite: false }),
    );
    line.position.set(X(BAULK_X), 0.3, 0);
    this.scene.add(line);
    for (const s of [BLACK_SPOT, FOOT_SPOT, { x: W / 2, y: H / 2 }]) {
      const dot = this.flatDisc(4, '#ffffff', 0.45);
      dot.position.set(X(s.x), 0.35, Z(s.y));
    }

    // bandes : nez de bande, mâchoires et dos, extrudés
    const cushionMat = new THREE.MeshStandardMaterial({ color: CUSHION, roughness: 0.9 });
    const longs = CUSHIONS.slice(0, 6);
    const jaws = CUSHIONS.slice(6);
    const same = (a: Vec, b: Vec): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
    for (const s of longs) {
      const ja = jaws.find((j) => same(j.a, s.a));
      const jb = jaws.find((j) => same(j.a, s.b));
      if (!ja || !jb) continue;
      const pts = this.cushionOutline(s, ja, jb);
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(X(p.x), Z(p.y))));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: CUSHION_H, bevelEnabled: false });
      geo.rotateX(Math.PI / 2);
      geo.translate(0, CUSHION_H, 0);
      const mesh = new THREE.Mesh(geo, cushionMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }

    // cadre (laqué noir) percé autour des poches, et son tablier
    const railShape = new THREE.Shape();
    const o = RAIL_OUT;
    const rr = 46;
    const x0 = X(-o);
    const x1 = X(W + o);
    const z0 = Z(-o);
    const z1 = Z(H + o);
    railShape.moveTo(x0 + rr, z0);
    railShape.lineTo(x1 - rr, z0);
    railShape.quadraticCurveTo(x1, z0, x1, z0 + rr);
    railShape.lineTo(x1, z1 - rr);
    railShape.quadraticCurveTo(x1, z1, x1 - rr, z1);
    railShape.lineTo(x0 + rr, z1);
    railShape.quadraticCurveTo(x0, z1, x0, z1 - rr);
    railShape.lineTo(x0, z0 + rr);
    railShape.quadraticCurveTo(x0, z0, x0 + rr, z0);
    railShape.holes.push(this.railHole());
    const railGeo = new THREE.ExtrudeGeometry(railShape, {
      depth: RAIL_H + APRON,
      bevelEnabled: true,
      bevelThickness: 6,
      bevelSize: 6,
      bevelSegments: 3,
      curveSegments: 24,
    });
    railGeo.rotateX(Math.PI / 2);
    railGeo.translate(0, RAIL_H, 0);
    const rail = new THREE.Mesh(railGeo, new THREE.MeshPhysicalMaterial({ color: RAIL, roughness: 0.35, clearcoat: 0.6 }));
    rail.castShadow = true;
    rail.receiveShadow = true;
    this.scene.add(rail);

    // mouches nacrées sur le cadre
    const sightOff = (CUSHION_BACK + RAIL_OUT) / 2;
    const sight = (x: number, y: number): void => {
      const d = this.flatDisc(6, CREME, 1);
      d.position.set(X(x), RAIL_H + 6.5, Z(y));
    };
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      sight((W * i) / 8, -sightOff);
      sight((W * i) / 8, H + sightOff);
    }
    for (let i = 1; i < 4; i++) {
      sight(-sightOff, (H * i) / 4);
      sight(W + sightOff, (H * i) / 4);
    }

    // poches : puits noir et fond
    const pocketMat = new THREE.MeshBasicMaterial({ color: '#030303', side: THREE.BackSide });
    for (const p of POCKETS) {
      const well = new THREE.Mesh(new THREE.CylinderGeometry(p.hole, p.hole * 0.9, RAIL_H + 140, 40, 1, true), pocketMat);
      well.position.set(X(p.c.x), (RAIL_H - 140) / 2, Z(p.c.y));
      this.scene.add(well);
      const mouth = this.flatDisc(p.hole, '#050505', 1);
      mouth.position.set(X(p.c.x), 0.5, Z(p.c.y));
      const bottom = this.flatDisc(p.hole, '#000000', 1);
      bottom.position.set(X(p.c.x), -139, Z(p.c.y));
    }
  }

  /** Contour d'une bande : mâchoire, nez de bande, mâchoire, puis le dos de la bande. */
  private cushionOutline(s: Segment, ja: Segment, jb: Segment): Vec[] {
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy);
    let n = { x: -dy / len, y: dx / len };
    const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    if (n.x * (mid.x - W / 2) + n.y * (mid.y - H / 2) < 0) n = { x: -n.x, y: -n.y };
    const back = (p: Vec): Vec => {
      const depth = (p.x - s.a.x) * n.x + (p.y - s.a.y) * n.y;
      const k = CUSHION_BACK - depth;
      return { x: p.x + n.x * k, y: p.y + n.y * k };
    };
    return [ja.b, s.a, s.b, jb.b, back(jb.b), back(ja.b)];
  }

  /** Bord intérieur du cadre, échancré autour de chaque poche. */
  private railHole(): THREE.Path {
    const e = CUSHION_BACK;
    const path = new THREE.Path();
    const cross = (c: Vec, r: number, axis: 'x' | 'y', at: number, sign: 1 | -1): Vec => {
      const d = Math.sqrt(Math.max(0, r * r - (at - (axis === 'x' ? c.x : c.y)) ** 2));
      return axis === 'y' ? { x: c.x + sign * d, y: at } : { x: at, y: c.y + sign * d };
    };
    const arc = (c: Vec, r: number, from: Vec, to: Vec): void => {
      const cx = X(c.x);
      const cz = Z(c.y);
      const a0 = Math.atan2(Z(from.y) - cz, X(from.x) - cx);
      const a1 = Math.atan2(Z(to.y) - cz, X(to.x) - cx);
      const ccw = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const midCcw = a0 + ccw / 2;
      const midCw = a0 - (2 * Math.PI - ccw) / 2;
      // l'arc passe par l'extérieur de la table
      const far = (a: number): number => Math.hypot(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
      const clockwise = far(midCw) > far(midCcw);
      path.absarc(cx, cz, r, a0, a1, clockwise);
    };
    const [tl, tm, tr, bl, bm, br] = POCKETS as unknown as [
      (typeof POCKETS)[0],
      (typeof POCKETS)[0],
      (typeof POCKETS)[0],
      (typeof POCKETS)[0],
      (typeof POCKETS)[0],
      (typeof POCKETS)[0],
    ];
    const start = cross(tl.c, tl.hole, 'y', -e, 1);
    path.moveTo(X(start.x), Z(start.y));
    arc(tm.c, tm.hole, cross(tm.c, tm.hole, 'y', -e, -1), cross(tm.c, tm.hole, 'y', -e, 1));
    arc(tr.c, tr.hole, cross(tr.c, tr.hole, 'y', -e, -1), cross(tr.c, tr.hole, 'x', W + e, 1));
    arc(br.c, br.hole, cross(br.c, br.hole, 'x', W + e, -1), cross(br.c, br.hole, 'y', H + e, -1));
    arc(bm.c, bm.hole, cross(bm.c, bm.hole, 'y', H + e, 1), cross(bm.c, bm.hole, 'y', H + e, -1));
    arc(bl.c, bl.hole, cross(bl.c, bl.hole, 'y', H + e, 1), cross(bl.c, bl.hole, 'x', -e, -1));
    arc(tl.c, tl.hole, cross(tl.c, tl.hole, 'x', -e, 1), start);
    return path;
  }

  private buildStick(): void {
    const part = (r0: number, r1: number, len: number, color: string, at: number, rough = 0.45): void => {
      const geo = new THREE.CylinderGeometry(r0, r1, len, 28);
      geo.rotateZ(-Math.PI / 2); // axe le long de +x, extrémité « r0 » côté +x
      const mat = new THREE.MeshStandardMaterial({ color, roughness: rough, transparent: true });
      this.stickMats.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.x = at - len / 2;
      mesh.castShadow = true;
      this.stickInner.add(mesh);
    };
    // de la pointe (x = 0) vers le talon (x négatifs)
    part(5.6, 5.8, 5, '#4a7bd0', 0, 0.9);
    part(6, 6.2, 22, CREME, -5, 0.4);
    part(6.2, 10.5, 860, '#dcbc8a', -27);
    part(10.5, 11, 18, ROSE, -887, 0.4);
    part(11, 14, 450, '#141414', -905, 0.3);
    this.stickInner.rotation.z = -TILT;
    this.stick.add(this.stickInner);
    this.stick.visible = false;
    this.scene.add(this.stick);
  }

  // ---------- mise à jour ----------
  private updateBalls(balls: readonly Ball[]): void {
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3();
    for (const b of balls) {
      let mesh = this.balls.get(b.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.ballGeo, this.ballMats[b.kind]);
        mesh.castShadow = true;
        mesh.quaternion.setFromEuler(new THREE.Euler(b.id * 1.7, b.id * 0.9, 0));
        this.balls.set(b.id, mesh);
        this.scene.add(mesh);
      }
      if (mesh.material !== this.ballMats[b.kind]) mesh.material = this.ballMats[b.kind];
      mesh.visible = b.onTable;
      if (!b.onTable) continue;
      mesh.position.set(X(b.x), R, Z(b.y));
      // roulement sans glissement : rotation autour de l'axe horizontal perpendiculaire au déplacement
      const prev = this.spins.get(b.id);
      this.spins.set(b.id, { x: b.x, y: b.y });
      if (!prev) continue;
      const dx = b.x - prev.x;
      const dy = b.y - prev.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6 || d > R * 4) continue;
      axis.set(dy / d, 0, -dx / d);
      q.setFromAxisAngle(axis, d / R);
      mesh.quaternion.premultiply(q);
    }
  }

  private updateFalls(now: number): void {
    this.falls = this.falls.filter((f) => {
      const t = (now - f.t0) / FALL_MS;
      if (t >= 1) {
        this.scene.remove(f.mesh);
        return false;
      }
      const k = easeOutCubic(Math.max(0, t));
      f.mesh.position.set(X(f.from.x + (f.to.x - f.from.x) * k), R - R * 3 * t * t, Z(f.from.y + (f.to.y - f.from.y) * k));
      return true;
    });
  }

  private updateRipples(now: number): void {
    this.ripples = this.ripples.filter((r) => {
      const t = (now - r.t0) / RIPPLE_MS;
      if (t >= 1) {
        this.scene.remove(r.mesh);
        return false;
      }
      r.mesh.visible = t >= 0;
      if (t < 0) return true;
      const s = 1 + 0.9 * easeOutCubic(t);
      r.mesh.scale.set(s, 1, s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t);
      return true;
    });
  }

  private updateGuides(m: Match, aim: AimState, now: number): void {
    const cue = m.cue;
    const aiming = m.phase === 'aiming' && !this.strike;
    this.baulk.visible = m.phase === 'placing';
    this.placeRing.visible = m.phase === 'placing';
    if (m.phase === 'placing') {
      this.placeRing.position.set(X(cue.x), 0.7, Z(cue.y));
      (this.placeRing.material as THREE.MeshBasicMaterial).color.set(aim.placeValid ? CREME : ROSE_DARK);
    }

    // halos des billes jouables
    const legal = aiming && !m.rules.isBreak ? legalTargets(m.rules, m.rules.current) : [];
    let h = 0;
    for (const b of m.world.balls) {
      if (!b.onTable || b.kind === 'cue' || !legal.includes(b.kind)) continue;
      const ring = this.halos[h] ?? (this.halos[h] = this.flatRing(R + 4, R + 7.5, '#ffffff', 0.45));
      ring.visible = true;
      ring.position.set(X(b.x), 0.6, Z(b.y));
      h++;
    }
    for (; h < this.halos.length; h++) this.halos[h]!.visible = false;

    // ligne de visée
    this.cueLine.hide();
    this.deflectLine.hide();
    this.targetLine.hide();
    this.ghost.visible = false;
    if (aiming) {
      const t = traceAim(m.world.balls, cue, aim.angle);
      const dir = { x: Math.cos(aim.angle), y: Math.sin(aim.angle) };
      this.cueLine.set({ x: cue.x + dir.x * R, y: cue.y + dir.y * R }, t.ghost);
      if (!aim.realistic) {
        this.ghost.visible = true;
        this.ghost.position.set(X(t.ghost.x), 0.9, Z(t.ghost.y));
        if (t.target && t.targetDir) {
          const ok = legalTargets(m.rules, m.rules.current).includes(t.target.kind);
          const n = Math.hypot(t.targetDir.x, t.targetDir.y) || 1;
          const len = 90 + 260 * Math.hypot(t.targetDir.x, t.targetDir.y);
          this.targetLine.set(
            t.target,
            { x: t.target.x + (t.targetDir.x / n) * len, y: t.target.y + (t.targetDir.y / n) * len },
            ok ? '#ffffff' : ROSE,
          );
          if (t.cueDir) {
            const cn = Math.hypot(t.cueDir.x, t.cueDir.y) || 1;
            const cl = 50 + 200 * Math.hypot(t.cueDir.x, t.cueDir.y);
            this.deflectLine.set(t.ghost, { x: t.ghost.x + (t.cueDir.x / cn) * cl, y: t.ghost.y + (t.cueDir.y / cn) * cl });
          }
        }
      }
    }

    // queue : en visée, ou pendant la frappe
    let pose: { gap: number; alpha: number } | null = null;
    let from: Vec = cue;
    let angle = aim.angle;
    if (this.strike) {
      pose = strikePose(now - this.strike.t0, this.strike.gap, this.strike.lead);
      from = this.strike.from;
      angle = this.strike.angle;
      if (!pose) this.strike = null;
    } else if (aiming) {
      pose = { gap: cueGap(aim.power), alpha: 1 };
    }
    this.stick.visible = pose !== null;
    if (pose) {
      this.stick.position.set(X(from.x), R, Z(from.y));
      this.stick.rotation.y = -angle;
      this.stickInner.position.x = -pose.gap;
      // près d'une bande, on lève le talon pour passer au-dessus du cadre
      const toEdge = this.exitDistance(from, angle + Math.PI, CUSHION_BACK);
      this.stickInner.rotation.z = -clamp(Math.max(TILT, Math.atan((RAIL_H + 18 - R) / Math.max(toEdge, 30))), 0, 0.6);
      for (const mat of this.stickMats) {
        mat.opacity = pose.alpha;
        mat.depthWrite = pose.alpha > 0.99;
      }
    }
  }

  private updateCamera(m: Match, dt: number): void {
    const want = this.desiredPose(m);
    const k = dt > 0 ? 1 - Math.exp(-dt * 7) : 1;
    this.cur.target.lerp(want.target, k);
    this.cur.yaw += shortest(want.yaw - this.cur.yaw) * k;
    this.cur.pitch += (want.pitch - this.cur.pitch) * k;
    this.cur.dist += (want.dist - this.cur.dist) * k;
    this.applyPose(this.cur);
  }

  private desiredPose(m: Match): Pose {
    if (this._mode === 'behind') {
      const c = m.cue;
      const yaw = this.host.aimAngle() + Math.PI;
      // blanche près d'une bande : la caméra est derrière le cadre. On la relève juste assez pour
      // que la ligne de vue vers la blanche passe au-dessus du bord du cadre (avec un peu de marge).
      const h = this.behind.dist * Math.cos(this.behind.pitch);
      let v = this.behind.dist * Math.sin(this.behind.pitch);
      const toEdge = this.exitDistance(c, yaw, CUSHION_BACK);
      if (h > toEdge) {
        const need = R + ((RAIL_H + 35 - R) * h) / Math.max(toEdge, 40);
        v = Math.min(Math.max(v, need), h * 1.3);
      }
      return { target: new THREE.Vector3(X(c.x), R, Z(c.y)), yaw, pitch: Math.atan2(v, h), dist: Math.hypot(h, v) };
    }
    if (this._mode === 'top') {
      const portrait = this.height > this.width * 1.15;
      return { target: new THREE.Vector3(0, 0, 0), yaw: portrait ? Math.PI : Math.PI / 2, pitch: 1.5, dist: this.topDist };
    }
    return this.free;
  }

  /** Distance horizontale entre p et le bord du rectangle de la table élargi de margin, dans la direction a. */
  private exitDistance(p: Vec, a: number, margin: number): number {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const lim = (q: number, d: number, lo: number, hi: number): number =>
      d > 1e-9 ? (hi - q) / d : d < -1e-9 ? (lo - q) / d : Infinity;
    return Math.max(0, Math.min(lim(p.x, dx, -margin, W + margin), lim(p.y, dy, -margin, H + margin)));
  }

  private applyPose(p: Pose): void {
    const cp = Math.cos(p.pitch);
    this.camera.position.set(
      p.target.x + p.dist * cp * Math.cos(p.yaw),
      p.target.y + p.dist * Math.sin(p.pitch),
      p.target.z + p.dist * cp * Math.sin(p.yaw),
    );
    this.camera.lookAt(p.target);
    this.camera.updateMatrixWorld();
  }

  /** Distance pour voir toute la table en vue d'ensemble. */
  private fitDist(): number {
    const aspect = this.width / this.height;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // vue depuis le bout de la table : la largeur (H) occupe l'horizontale
    const needH = (H + 2 * RAIL_OUT) / 2 / (tanV * aspect);
    const needV = (W + 2 * RAIL_OUT) / 2 / tanV;
    return clamp(Math.max(needH, needV * 0.62), 1200, 6000);
  }

  private fitTopDist(): number {
    const aspect = this.width / this.height;
    const portrait = this.height > this.width * 1.15;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const across = (portrait ? H : W) + 2 * RAIL_OUT;
    const along = (portrait ? W : H) + 2 * RAIL_OUT;
    return Math.max(across / 2 / (tanV * aspect), along / 2 / tanV) * 1.04;
  }

  private clonePose(p: Pose): Pose {
    return { target: p.target.clone(), yaw: p.yaw, pitch: p.pitch, dist: p.dist };
  }

  // ---------- écran ↔ table ----------
  private toWorld(sx: number, sy: number): Vec {
    const ndc = new THREE.Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) {
      // rayon vers le ciel : point lointain dans la direction visée
      const d = this.raycaster.ray.direction;
      hit.copy(this.raycaster.ray.origin).addScaledVector(new THREE.Vector3(d.x, 0, d.z).normalize(), 5000);
    }
    return { x: hit.x + W / 2, y: hit.z + H / 2 };
  }

  private screenDirToWorld(dx: number, dy: number): Vec {
    const e = this.camera.matrixWorld.elements;
    const right = { x: e[0]!, y: e[2]! };
    const back = { x: e[8]!, y: e[10]! }; // l'axe z de la caméra pointe vers l'arrière
    const rl = Math.hypot(right.x, right.y) || 1;
    const bl = Math.hypot(back.x, back.y) || 1;
    const v = { x: (dx * right.x) / rl + (dy * back.x) / bl, y: (dx * right.y) / rl + (dy * back.y) / bl };
    const n = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / n, y: v.y / n };
  }

  // ---------- gestes ----------
  private bindGestures(surface: HTMLElement): void {
    const active = (): boolean => !this.canvas.hidden;
    // phase de capture sur le conteneur : on passe avant les commandes de jeu (sur le canevas)
    surface.addEventListener(
      'pointerdown',
      (e) => {
        // les boutons posés sur la table (caméra, replay) gardent leurs clics
        if (!active() || e.target !== this.canvas) return;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        let claim: 'orbit' | 'aim' | 'pinch' | null = null;
        if (this.pointers.size >= 2) claim = 'pinch';
        else if (e.button === 1 || e.button === 2 || e.shiftKey) claim = 'orbit';
        else if (this._mode === 'behind' && this.host.canRotateAim()) claim = 'aim';
        else if (!this.host.wantsPointer()) claim = 'orbit';
        if (!claim) return;
        if (claim === 'pinch') {
          this.host.cancelGamePointer();
          this.pinchDist = this.pinchSpan();
        }
        this.gesture = claim;
        e.stopPropagation();
        e.preventDefault();
        this.canvas.setPointerCapture(e.pointerId);
      },
      { capture: true },
    );
    surface.addEventListener(
      'pointermove',
      (e) => {
        const prev = this.pointers.get(e.pointerId);
        if (!active() || !prev || !this.gesture) return;
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        e.stopPropagation();
        if (this.gesture === 'pinch') {
          const span = this.pinchSpan();
          if (this.pinchDist > 0 && span > 0) this.zoom(this.pinchDist / span);
          this.pinchDist = span;
          this.orbit(dx / 2, dy / 2);
        } else if (this.gesture === 'aim') {
          this.host.rotateAim(dx * 0.0032);
          this.behind.pitch = clamp(this.behind.pitch + dy * 0.004, 0.05, 1.3);
        } else {
          this.orbit(dx, dy);
        }
      },
      { capture: true },
    );
    const end = (e: PointerEvent): void => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (this.gesture) e.stopPropagation();
      if (this.pointers.size === 0) this.gesture = null;
      else if (this.gesture === 'pinch') this.gesture = 'orbit';
    };
    surface.addEventListener('pointerup', end, { capture: true });
    surface.addEventListener('pointercancel', end, { capture: true });
    surface.addEventListener(
      'wheel',
      (e) => {
        if (!active() || e.target !== this.canvas) return;
        e.preventDefault();
        e.stopPropagation();
        this.zoom(Math.exp(e.deltaY * 0.0012));
      },
      { capture: true, passive: false },
    );
    surface.addEventListener('contextmenu', (e) => {
      if (active()) e.preventDefault();
    });
  }

  private pinchSpan(): number {
    const p = [...this.pointers.values()];
    return p.length >= 2 ? Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y) : 0;
  }

  /** Rotation de la vue : on quitte les vues guidées pour la vue libre, depuis la position actuelle. */
  private orbit(dx: number, dy: number): void {
    if (this._mode === 'behind' && this.host.canRotateAim()) {
      this.host.rotateAim(dx * 0.0032);
      this.behind.pitch = clamp(this.behind.pitch + dy * 0.004, 0.05, 1.3);
      return;
    }
    this.mode = 'free';
    this.free.yaw += dx * 0.006;
    this.free.pitch = clamp(this.free.pitch + dy * 0.005, 0.06, 1.52);
  }

  private zoom(factor: number): void {
    if (this._mode === 'behind') this.behind.dist = clamp(this.behind.dist * factor, 260, 2400);
    else if (this._mode === 'top') this.topDist = clamp(this.topDist * factor, 900, 7000);
    else this.free.dist = clamp(this.free.dist * factor, 500, 7000);
  }

  // ---------- petits objets et textures ----------
  private flatRing(r0: number, r1: number, color: string, opacity: number): THREE.Mesh {
    const geo = new THREE.RingGeometry(r0, r1, 56);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    mesh.renderOrder = 2;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  private flatDisc(r: number, color: string, opacity: number): THREE.Mesh {
    const geo = new THREE.CircleGeometry(r, 40);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }),
    );
    this.scene.add(mesh);
    return mesh;
  }

  private canvasTexture(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (g) paint(g);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  /** Blanche à pois rouges (projection équirectangulaire de la sphère). */
  private cueBallTexture(): THREE.CanvasTexture {
    return this.canvasTexture(512, 256, (g) => {
      g.fillStyle = COLORS.cue;
      g.fillRect(0, 0, 512, 256);
      g.fillStyle = '#c8302c';
      const r = 15;
      for (const u of [0, 128, 256, 384, 512]) {
        g.beginPath();
        g.ellipse(u, 128, r, r, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.fillRect(0, 0, 512, r);
      g.fillRect(0, 256 - r, 512, r);
    });
  }

  private feltTexture(): THREE.CanvasTexture {
    const tex = this.canvasTexture(128, 128, (g) => {
      const img = g.createImageData(128, 128);
      let seed = 11;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 16807) % 2147483647;
        const v = 225 + (seed % 30);
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(16, 8);
    return tex;
  }

  private dashTexture(): THREE.CanvasTexture {
    const tex = this.canvasTexture(64, 4, (g) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, 64, 4);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 36, 4);
    });
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  }
}
