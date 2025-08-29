// src/gallery3d.js
// ----------------------------------------------------------------------------
// 3D Team Carousel (THREE.js)
// - Drag solo sul selezionato; i non selezionati ruotano sempre
// - Quando un modello entra al centro: FRONTALE (x=0,y=0,z=0) con tween
// - Quando un modello lascia il centro: realign tilt X/Z → 0 e riprende auto-spin
// - Desktop: laterali = original(1.0) + silhouette costante (0.65), anche in uscita
// - Mobile:  slide corto con cross-fade tra ORIGINALI (silhouette off)
// - Flag SHOW_DESC per mostrare/nascondere la descrizione
// ----------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

// --- UI FLAGS ---------------------------------------------------------------
const SHOW_DESC = false; // ← metti true se vuoi vedere la desc-card

// ============================================================================
// CAMERA CONFIG
// ============================================================================
const CAMERA_CONFIG = {
  desktop: { position: [0.2, -0.4, 3.5], target: [0.0, -0.2, 0.0], fov: 45 },
  mobile:  { position: [0.2, -0.2, 4.0], target: [0.0, -0.2, 0.0], fov: 45 },
  applyOnBreakpointChange: true,
  MOBILE_MAX: 768,
};

// ============================================================================
// LAYOUT & ANIMATION CONSTANTS
// ============================================================================
const SIZE_MULTIPLIER = 0.65;

const SPACING_DESKTOP_BASE = 1.1;
const OFF_MULT             = 3.8;
const OFF_Z_MULT           = 1.9;

const SELECT_SCALE  = 1.25;
const OVS_CENTER    = 1.08;
const OTHER_SCALE   = 1.1;

const OTHER_OPACITY = 0.7;
const BASE_SPIN = 1.5;

const CENTER_Y  = 0.0;
const LATERAL_Y = 0.1;
const OFF_Y     = 0.1;

const NEAR_FRAC = 0.22;
const BACK_FRAC = 0.25;

const MOVE_MS            = 720;
const CROSSFADE_MS       = 560;
const CROSSFADE_DELAY_MS = 80;

const FADE_OUT_MS       = 700;
const FADE_OUT_DELAY_MS = 150;
const PHASE_KEEP_SIL_MS = 140;

const DRAG_YAW_SENS  = 0.008;
const DRAG_TILT_SENS = 0.006;
const TILT_MAX       = 0.35;
const REVERSE_YAW    = false;
const REVERSE_TILT   = true;

// --- MOBILE TUNING ----------------------------------------------------------
const MOBILE_GEOM = {
  SIDE_MULT: 1.25,
  OFF_MULT:  1.6,
  OFF_Z_MULT: 1.2,
};

const MOBILE_TIMING = {
  MOVE_TO_SIDE_MS: 520,
  OUT_FADE_MS:     360,
  IN_FADE_DELAY:    10,
};

// --- DESKTOP silhouette -----------------------------------------------------
const DESK_SIL_OPACITY = 0.65;

// --- REALIGN TILT -----------------------------------------------------------
const REALIGN_MS_DESKTOP = Math.round(MOVE_MS * 0.60);
const REALIGN_MS_MOBILE  = Math.round(MOBILE_TIMING.MOVE_TO_SIDE_MS * 0.70);

// ============================================================================
// UTILS
// ============================================================================
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function getDynamicSpacing() {
  const w = window.innerWidth;
  const t = clamp((w - CAMERA_CONFIG.MOBILE_MAX) / (1920 - CAMERA_CONFIG.MOBILE_MAX), 0, 1);
  return 1.0 + (1.5 - 1.0) * t;
}
function snapTransform(obj, pos, scaleScalar) {
  obj.position.copy(pos);
  obj.scale.setScalar(scaleScalar);
  // NON toccare la rotazione qui
}

// ============================================================================
// ENTRY POINT
// ============================================================================
export async function initGallery3D(canvasSelector) {
  // Canvas + Renderer
  const canvas = document.querySelector(canvasSelector);
  if (!canvas) throw new Error('Canvas non trovato: ' + canvasSelector);
  canvas.style.touchAction = 'none';
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const renderer = new THREE.WebGLRenderer({ antialias: true, canvas, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.physicallyCorrectLights = true;

  // Scene + Camera + Env
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xE3E3E3);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  scene.add(camera);

  function isMobile() { return window.innerWidth <= CAMERA_CONFIG.MOBILE_MAX; }
  function applyCameraFromConfig() {
    const cfg = isMobile() ? CAMERA_CONFIG.mobile : CAMERA_CONFIG.desktop;
    camera.fov = cfg.fov;
    camera.updateProjectionMatrix();
    camera.position.set(...cfg.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(...cfg.target);
  }
  resizeRenderer(); applyCameraFromConfig();

  if (CAMERA_CONFIG.applyOnBreakpointChange) {
    const mql = window.matchMedia(`(max-width:${CAMERA_CONFIG.MOBILE_MAX}px)`);
    mql.addEventListener('change', () => {
      applyCameraFromConfig();
      recomputeDepthOffsets();
      applySelection(selectedIndex, true);
    });
  }

  // Luci
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b0b0, 0.7));
  const key  = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(3, 5, 7);  scene.add(key);
  const rim  = new THREE.DirectionalLight(0xffffff, 0.4); rim.position.set(-5, 4, -5); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-2, 2, 3); scene.add(fill);

  // UI
  const ui = document.createElement('div');
  ui.className = 'ui';
  ui.innerHTML = `
    <div class="topbar">
      <button class="chip chip--accent" id="chipTeam">OUR TEAM</button>
      <span class="chip chip--filled" id="chipName">—</span>
      <span class="chip" id="chipRole">—</span>
      ${SHOW_DESC ? `<div class="desc-card" id="descCard">—</div>` : ``}
    </div>
    <button class="nav-arrow left" id="navLeft">‹</button>
    <button class="nav-arrow right" id="navRight">›</button>
  `;
  document.body.appendChild(ui);
  const chipName = ui.querySelector('#chipName');
  const chipRole = ui.querySelector('#chipRole');
  const descCard = SHOW_DESC ? ui.querySelector('#descCard') : null;
  const btnLeft  = ui.querySelector('#navLeft');
  const btnRight = ui.querySelector('#navRight');

  // Data + Loader
  const loader = new GLTFLoader();
  const modelsMeta = await (await fetch('./models.json')).json();

  const roots = [];
  let selectedIndex = 0;
  let lastSelectedIndex = 0;
  let navDir = 0; // -1 = left, +1 = right

  let nearOffset = 0.7;
  let backOffset = -0.6;

  // Load models
  async function loadModel(entry) {
    const glb = await loader.loadAsync(entry.url);
    const original = (glb.scene || (glb.scenes && glb.scenes[0]) || new THREE.Group()).clone(true);

    const s = (entry.scale ?? 1) * SIZE_MULTIPLIER;
    original.scale.setScalar(s);

    const box1  = new THREE.Box3().setFromObject(original);
    const size  = new THREE.Vector3(); box1.getSize(size);
    const maxAxis = Math.max(size.x, size.y, size.z) || 1;
    const target  = 1.4 / maxAxis;
    original.scale.multiplyScalar(target);

    const center = new THREE.Vector3(); box1.getCenter(center);
    original.position.sub(center);

    const silhouette = SkeletonUtils.clone(original);
    const matsSil = [];
    silhouette.traverse((o) => {
      if (!o.isMesh) return;
      const mm = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 1.0, transparent: true });
      mm.depthWrite = false;
      mm.depthTest  = true;
      o.renderOrder = 2;
      o.material    = mm;
      matsSil.push(mm);
    });

    const matsOrig = [];
    original.traverse((o) => {
      if (o.isMesh && o.material) {
        const arr = Array.isArray(o.material) ? o.material : [o.material];
        arr.forEach((m) => { m.transparent = true; m.depthWrite = true; matsOrig.push(m); });
      }
    });

    const root = new THREE.Group();
    root.add(original);
    root.add(silhouette);

    root.rotation.set(0, 0, 0); // solo alla creazione

    const meta = {
      label: entry.label ?? entry.id ?? '—',
      role:  entry.role  ?? '—',
      desc:  Array.isArray(entry.phrases) ? entry.phrases.join(' ') : (entry.desc ?? ''),
    };

    root.userData = {
      meta,
      _orig:      original,
      _sil:       silhouette,
      _matsOrig:  matsOrig,
      _matsSil:   matsSil,
      rotSpeed:   0,
      rotTarget:  0,
      isFrozen:   true,
      baseScale:  1.0,
      layoutState:'offR',
    };

    setOpacities(root, 1.0, 0.0);
    recenterGroup(root);
    return root;
  }

  for (const entry of modelsMeta) {
    const root = await loadModel(entry);
    roots.push(root);
    scene.add(root);
  }

  // Opacity helpers
  function setOpacities(root, origOpacity, silOpacity) {
    const o = clamp(origOpacity, 0, 1);
    const s = clamp(silOpacity, 0, 1);
    for (const m of root.userData._matsOrig || []) { m.opacity = o; m.needsUpdate = true; }
    for (const m of root.userData._matsSil  || []) { m.opacity = s; m.needsUpdate = true; }
  }
  function tweenOpacities(root, targetOrig, targetSil, duration = CROSSFADE_MS, delay = 0, onDone = null) {
    const matsO  = root.userData._matsOrig || [];
    const matsS  = root.userData._matsSil  || [];
    const startO = matsO.map((m) => m.opacity ?? 1);
    const startS = matsS.map((m) => m.opacity ?? 0);
    const t0     = performance.now() + delay;
    const t1     = t0 + duration;
    anims.add({ type: 'mats', obj: root, root, matsO, matsS, startO, startS, endO: targetOrig, endS: targetSil, t0, t1, onDone });
  }

  // Desktop exit: mantieni original(1.0) + silhouette(0.65) fino a off
  function exitWithSilhouette(r, fadeMs = FADE_OUT_MS, fadeDelay = FADE_OUT_DELAY_MS, keepSilMs = PHASE_KEEP_SIL_MS, onDone) {
    r.userData._exiting = true;
    r.visible = true;
    setOpacities(r, 1.0, DESK_SIL_OPACITY);
    const t0 = performance.now();
    const t1 = t0 + fadeDelay + keepSilMs + MOVE_MS;
    anims.add({
      type: 'hold',
      obj: r,
      t0, t1,
      onDone: () => {
        r.userData._exiting = false;
        r.visible = false;
        setOpacities(r, 0.0, 0.0);
        if (typeof onDone === 'function') onDone();
      }
    });
  }

  // Viewport config + depth
  function getViewportConfig() {
    if (isMobile()) {
      return { spacing: SPACING_DESKTOP_BASE * 3.4, showSides: false, otherOpacity: 0.0 };
    }
    return { spacing: getDynamicSpacing(), showSides: true, otherOpacity: OTHER_OPACITY };
  }
  function recomputeDepthOffsets() {
    const camDist     = camera.position.z || 6;
    const desiredNear = camDist * NEAR_FRAC;
    const desiredBack = -camDist * BACK_FRAC;
    nearOffset = clamp(desiredNear, 0, camDist - 0.1);
    backOffset = Math.max(-1.5, desiredBack);
  }
  function stateForD(d, cfg) {
    if (d === 0) return 'center';
    if (cfg.showSides && Math.abs(d) === 1) return d === -1 ? 'sideL' : 'sideR';
    return d <= -1 ? 'offL' : 'offR';
  }

  // =========================
  // MOBILE
  // =========================
  function applySelectionMobile(index, first = false) {
    const N = roots.length;
    if (!N) return;

    const meta = roots[index].userData.meta || {};
    chipName.textContent = (meta.label || '—').toUpperCase();
    chipRole.textContent = (meta.role  || '—').toUpperCase();
    if (descCard) descCard.textContent = meta.desc || '—';

    const cfg      = getViewportConfig();
    const spacing  = cfg.spacing;

    const center = new THREE.Vector3(0, CENTER_Y, nearOffset);
    const sideL  = new THREE.Vector3(-spacing * MOBILE_GEOM.SIDE_MULT, LATERAL_Y, backOffset);
    const sideR  = new THREE.Vector3(+spacing * MOBILE_GEOM.SIDE_MULT, LATERAL_Y, backOffset);
    const offL   = new THREE.Vector3(-spacing * MOBILE_GEOM.OFF_MULT,  OFF_Y, backOffset * MOBILE_GEOM.OFF_Z_MULT);
    const offR   = new THREE.Vector3(+spacing * MOBILE_GEOM.OFF_MULT,  OFF_Y, backOffset * MOBILE_GEOM.OFF_Z_MULT);

    const rel = (i, sel) => { let d = (i - sel + N) % N; if (d > N / 2) d -= N; return d; };

    const incoming = roots[index];
    const outgoing = roots[lastSelectedIndex];

    // Pulizia mobile
    roots.forEach((r) => {
      cancelTweens(r, 'mats'); cancelTweens(r, 'hold');
      cancelTweens(r, 'pos');  cancelTweens(r, 'scale'); cancelTweens(r, 'roty'); cancelTweens(r, 'rotxz');
      r.userData._exiting = false;
      for (const m of (r.userData._matsSil || [])) { m.opacity = 0; m.needsUpdate = true; }
    });

    if (first || !outgoing || outgoing === incoming) {
      roots.forEach((r, i) => {
        const d = rel(i, index);
        const st = stateForD(d, cfg);
        if (r === incoming) {
          r.visible = true;
          snapTransform(r, center, r.userData.baseScale * SELECT_SCALE);
          setOpacities(r, 1.0, 0.0);
          // FRONTALE subito al primo layout
          r.rotation.set(0, 0, 0);
          r.userData.layoutState = 'center';
          cancelSpin(r);
        } else {
          r.visible = false;
          const target = (st === 'offL') ? offL : offR;
          snapTransform(r, target, r.userData.baseScale * OTHER_SCALE);
          setOpacities(r, 0.0, 0.0);
          r.userData.layoutState = st;
          cancelSpin(r);
        }
      });
      lastSelectedIndex = index;
      return;
    }

    // Altri → off invisibili (realign tilt per pulizia)
    roots.forEach((r, i) => {
      if (r === outgoing || r === incoming) return;
      const d = rel(i, index);
      const st = stateForD(d, cfg);
      r.visible = false;
      setOpacities(r, 0.0, 0.0);
      const target = (st === 'offL') ? offL : offR;
      snapTransform(r, target, r.userData.baseScale * OTHER_SCALE);
      tweenRotXZ(r, 0, 0, REALIGN_MS_MOBILE * 0.8);
      r.userData.layoutState = st;
      cancelSpin(r);
    });

    const outSideVec = (navDir >= 0) ? sideR : sideL;
    const inStartVec = (navDir >= 0) ? sideL : sideR;

    // OUTGOING
    outgoing.visible = true;
    snapTransform(outgoing, center, outgoing.userData.baseScale * SELECT_SCALE);
    setOpacities(outgoing, 1.0, 0.0);
    cancelSpin(outgoing);

    tweenPos(outgoing, outSideVec.clone(), MOBILE_TIMING.MOVE_TO_SIDE_MS, 0, () => {
      outgoing.visible = false;
      setOpacities(outgoing, 0.0, 0.0);
      const outOff = (navDir >= 0) ? offR : offL;
      snapTransform(outgoing, outOff, outgoing.userData.baseScale * OTHER_SCALE);
      outgoing.userData.layoutState = (navDir >= 0) ? 'offR' : 'offL';
    });
    // riallinea tilt mentre esce verso il lato
    tweenRotXZ(outgoing, 0, 0, REALIGN_MS_MOBILE);
    tweenScale(outgoing, outgoing.userData.baseScale * OTHER_SCALE, MOBILE_TIMING.MOVE_TO_SIDE_MS, 0);
    tweenOpacities(outgoing, 0.0, 0.0, MOBILE_TIMING.OUT_FADE_MS, 0);

    // INCOMING
    incoming.visible = true;
    snapTransform(incoming, inStartVec, incoming.userData.baseScale * OTHER_SCALE);
    setOpacities(incoming, 0.0, 0.0);
    cancelSpin(incoming);

    tweenPos(incoming, center.clone(), MOBILE_TIMING.MOVE_TO_SIDE_MS);
    const sBase = incoming.userData.baseScale * SELECT_SCALE;
    const sOver = sBase * OVS_CENTER;
    tweenScale(incoming, sOver, MOBILE_TIMING.MOVE_TO_SIDE_MS * 0.55, 0);
    tweenScale(incoming, sBase, MOBILE_TIMING.MOVE_TO_SIDE_MS * 0.45, MOBILE_TIMING.MOVE_TO_SIDE_MS * 0.55);
    tweenOpacities(incoming, 1.0, 0.0, CROSSFADE_MS, MOBILE_TIMING.IN_FADE_DELAY);

    // ALLINEA FRONTale in ingresso al centro
    cancelTweens(incoming, 'roty'); cancelTweens(incoming, 'rotxz');
    tweenRotXZ(incoming, 0, 0, MOBILE_TIMING.MOVE_TO_SIDE_MS);
    tweenRotY(incoming, 0, MOBILE_TIMING.MOVE_TO_SIDE_MS);

    incoming.userData.layoutState = 'center';
    lastSelectedIndex = index;
  }

  // =========================
  // DESKTOP
  // =========================
  function applySelectionDesktop(index, first = false) {
    if (!roots.length) return;
    const N = roots.length;

    const meta = roots[index].userData.meta || {};
    chipName.textContent = (meta.label || '—').toUpperCase();
    chipRole.textContent = (meta.role  || '—').toUpperCase();
    if (descCard) descCard.textContent = meta.desc || '—';

    const cfg      = getViewportConfig();
    const spacing  = cfg.spacing;
    const center   = new THREE.Vector3(0,                CENTER_Y,  nearOffset);
    const left     = new THREE.Vector3(-spacing,         LATERAL_Y, backOffset);
    const right    = new THREE.Vector3(+spacing,         LATERAL_Y, backOffset);
    const offL     = new THREE.Vector3(-spacing*OFF_MULT,OFF_Y,     backOffset*OFF_Z_MULT);
    const offR     = new THREE.Vector3(+spacing*OFF_MULT,OFF_Y,     backOffset*OFF_Z_MULT);

    const rel = (i, sel) => { let d = (i - sel + N) % N; if (d > N / 2) d -= N; return d; };

    roots.forEach((r, i) => {
      const d         = rel(i, index);
      let   newState  = stateForD(d, cfg);
      const prevState = r.userData.layoutState || 'offR';

      cancelTweens(r, 'mats'); cancelTweens(r, 'rotxz'); cancelTweens(r, 'roty');
      const wasExiting = !!r.userData._exiting;
      cancelTweens(r, 'hold');
      if (wasExiting) {
        r.userData._exiting = false;
        r.visible = false;
        setOpacities(r, 0.0, 0.0);
      }

      const isExiting =
        (newState === 'offL' || newState === 'offR') &&
        (prevState === 'center' || prevState === 'sideL' || prevState === 'sideR');
      if (isExiting) {
        if (prevState === 'sideL')      newState = 'offL';
        else if (prevState === 'sideR') newState = 'offR';
        else                            newState = (navDir >= 0) ? 'offR' : 'offL';
      }

      let targetPos, targetScale, spin;
      if (newState === 'center') { targetPos = center; targetScale = r.userData.baseScale * SELECT_SCALE; spin = 0; }
      else if (newState === 'sideL') { targetPos = left; targetScale = r.userData.baseScale * OTHER_SCALE; spin = BASE_SPIN * 0.6; }
      else if (newState === 'sideR') { targetPos = right; targetScale = r.userData.baseScale * OTHER_SCALE; spin = BASE_SPIN * 0.6; }
      else if (newState === 'offL')   { targetPos = offL; targetScale = r.userData.baseScale * OTHER_SCALE; spin = 0; }
      else                            { targetPos = offR; targetScale = r.userData.baseScale * OTHER_SCALE; spin = 0; }

      let snapNoAnim = false;

      if (newState === 'center') {
        r.visible = true;
        if (!first) tweenOpacities(r, 1.0, 0.0, CROSSFADE_MS, CROSSFADE_DELAY_MS);
        else setOpacities(r, 1.0, 0.0);

        // FRONTALE in ingresso al centro
        if (first) {
          r.rotation.set(0, 0, 0); // primo layout: snap
        } else {
          tweenRotXZ(r, 0, 0, MOVE_MS * 0.9);
          tweenRotY(r, 0, MOVE_MS * 0.9);
        }
      }
      else if (newState === 'sideL' || newState === 'sideR') {
        r.visible = true;

        if (!first && (prevState === 'offL' || prevState === 'offR')) {
          cancelTweens(r);
          if (newState === 'sideL') r.position.copy(offL); else r.position.copy(offR);
          r.scale.setScalar(r.userData.baseScale * OTHER_SCALE);
          setOpacities(r, 1.0, DESK_SIL_OPACITY);
        } else {
          tweenOpacities(r, 1.0, DESK_SIL_OPACITY, CROSSFADE_MS, CROSSFADE_DELAY_MS);
        }

        // non selezionato: riallinea tilt e riprendi auto-rotazione (già in side)
        tweenRotXZ(r, 0, 0, REALIGN_MS_DESKTOP);
      }
      else {
        if (prevState === 'center' || prevState === 'sideL' || prevState === 'sideR') {
          r.visible = true;
          exitWithSilhouette(r);
          tweenRotXZ(r, 0, 0, REALIGN_MS_DESKTOP * 0.9);
        } else {
          r.visible = false;
          setOpacities(r, 0.0, 0.0);
          cancelTweens(r);
          snapTransform(r, targetPos, targetScale);
          tweenRotXZ(r, 0, 0, REALIGN_MS_DESKTOP * 0.6);
          snapNoAnim = true;
        }
      }

      if (!first && !snapNoAnim) {
        tweenPos(r, targetPos.clone(), MOVE_MS);
        cancelTweens(r, 'scale');
        if (newState === 'center') {
          const sBase = r.userData.baseScale * SELECT_SCALE;
          const sOver = sBase * OVS_CENTER;
          tweenScale(r, sOver, MOVE_MS * 0.55, 0);
          tweenScale(r, sBase, MOVE_MS * 0.45, MOVE_MS * 0.55);
        } else {
          tweenScale(r, targetScale, MOVE_MS, 0);
        }
      } else if (first) {
        snapTransform(r, targetPos, targetScale);
      }

      // Spin on/off
      if (spin === 0) cancelSpin(r);
      else { r.userData.isFrozen = false; setSpinTarget(r, spin); }

      r.userData.layoutState = newState;
    });

    lastSelectedIndex = index;
  }

  // Selezione (switch desktop/mobile)
  function applySelection(index, first = false) {
    if (isMobile()) applySelectionMobile(index, first);
    else            applySelectionDesktop(index, first);
  }

  // --------------------------------------------------------------------------
  // TWEEN ENGINE
  // --------------------------------------------------------------------------
  const anims = new Set();

  function cancelTweens(obj, type) {
    for (const a of Array.from(anims)) {
      if (a.obj === obj && (!type || a.type === type)) anims.delete(a);
    }
  }

  function tweenPos(obj, targetVec3, duration = 450, delay = 0, onDone = null) {
    const start = obj.position.clone();
    const t0 = performance.now() + delay;
    const t1 = t0 + duration;
    anims.add({ type: 'pos', obj, start, target: targetVec3.clone(), t0, t1, onDone });
  }

  function tweenScale(obj, targetScalar, duration = 450, delay = 0, onDone = null) {
    const s0 = obj.scale.x;
    const t0 = performance.now() + delay;
    const t1 = t0 + duration;
    anims.add({ type: 'scale', obj, s0, s1: targetScalar, t0, t1, onDone });
  }

  // riallineo del tilt: X/Z → target
  function tweenRotXZ(obj, targetX = 0, targetZ = 0, duration = 420, delay = 0, onDone = null) {
    const x0 = obj.rotation.x;
    const z0 = obj.rotation.z;
    const t0 = performance.now() + delay;
    const t1 = t0 + duration;
    anims.add({ type: 'rotxz', obj, x0, z0, x1: targetX, z1: targetZ, t0, t1, onDone });
  }

  // yaw verso target, con arco più corto
  function tweenRotY(obj, targetY, duration = 420, delay = 0, onDone = null) {
    const TWO_PI = Math.PI * 2;
    let y0 = obj.rotation.y;
    let d  = ((targetY - y0 + Math.PI) % TWO_PI) - Math.PI;
    const y1 = y0 + d;
    const t0 = performance.now() + delay;
    const t1 = t0 + duration;
    anims.add({ type: 'roty', obj, y0, y1, t0, t1, onDone });
  }

  function easeInOutQuint(t) {
    return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
  }

  function stepTweens(now) {
    for (const a of Array.from(anims)) {
      const raw = (now - a.t0) / (a.t1 - a.t0);
      const t   = clamp(raw, 0, 1);
      const e   = easeInOutQuint(t);

      if (a.type === 'roty') {
        a.obj.rotation.y = a.y0 + (a.y1 - a.y0) * e;
      }
      else if (a.type === 'rotxz') {
        a.obj.rotation.x = a.x0 + (a.x1 - a.x0) * e;
        a.obj.rotation.z = a.z0 + (a.z1 - a.z0) * e;
      }
      else if (a.type === 'pos') {
        a.obj.position.lerpVectors(a.start, a.target, e);
      }
      else if (a.type === 'scale') {
        a.obj.scale.setScalar(a.s0 + (a.s1 - a.s0) * e);
      }
      else if (a.type === 'mats') {
        const { matsO, matsS, startO, startS, endO, endS } = a;
        for (let i = 0; i < matsO.length; i++) {
          const m = matsO[i];
          m.opacity = startO[i] + (endO - startO[i]) * e;
          m.needsUpdate = true;
        }
        for (let i = 0; i < matsS.length; i++) {
          const m = matsS[i];
          m.opacity = startS[i] + (endS - startS[i]) * e;
          m.needsUpdate = true;
        }
      }

      if (t >= 1) {
        const done = a.onDone;
        anims.delete(a);
        if (typeof done === 'function') done();
      }
    }
  }

  // Auto-spin
  function setSpinTarget(obj, v) { obj.userData.rotTarget = v; }
  function cancelSpin(obj) { obj.userData.rotTarget = 0; obj.userData.rotSpeed = 0; obj.userData.isFrozen = true; }
  function stepSpin(now, dt) {
    roots.forEach((r) => {
      if (r.userData.isFrozen) return;
      const speed  = r.userData.rotSpeed  ?? 0;
      const target = r.userData.rotTarget ?? 0;
      const s      = THREE.MathUtils.lerp(speed, target, Math.min(1, dt * 3.0));
      r.userData.rotSpeed = s;
      r.rotation.y += s * dt;
    });
  }

  // Drag: solo sul selezionato
  const drag = { active: false, id: null, lastX: 0, lastY: 0, lastT: 0, vx: 0 };
  function currentRoot() { return roots[selectedIndex]; }
  function endDrag(e) {
    if (!drag.active || (e && e.pointerId !== drag.id)) return;
    const r = currentRoot();
    if (r) { r.userData.isFrozen = false; r.userData.rotSpeed = drag.vx; r.userData.rotTarget = 0; }
    if (drag.id != null) { try { canvas.releasePointerCapture(drag.id); } catch {} }
    drag.active = false; drag.id = null;
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    drag.active = true; drag.id = e.pointerId;
    drag.lastX = e.clientX; drag.lastY = e.clientY; drag.lastT = performance.now();
    const r = currentRoot(); if (r) { cancelSpin(r); r.userData.isFrozen = true; }
    canvas.setPointerCapture(e.pointerId);
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag.active || e.pointerId !== drag.id) return;
    const now = performance.now(); const dt = Math.max(0.001, (now - drag.lastT) / 1000);
    const dx = e.clientX - drag.lastX; const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX; drag.lastY = e.clientY; drag.lastT = now;
    const r = currentRoot();
    if (r) {
      const dxEff = REVERSE_YAW ? -dx : dx;
      const dyEff = REVERSE_TILT ?  dy : -dy;
      r.rotation.y += dxEff * DRAG_YAW_SENS;
      const nextX = r.rotation.x + dyEff * DRAG_TILT_SENS;
      r.rotation.x = clamp(nextX, -TILT_MAX, TILT_MAX);
      r.rotation.z = 0;
      drag.vx = (dxEff * DRAG_YAW_SENS) / dt;
    }
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);

  // Nav
  function next() { navDir = +1; endDrag({ pointerId: drag.id }); lastSelectedIndex = selectedIndex; selectedIndex = (selectedIndex + 1) % roots.length; applySelection(selectedIndex); }
  function prev() { navDir = -1; endDrag({ pointerId: drag.id }); lastSelectedIndex = selectedIndex; selectedIndex = (selectedIndex - 1 + roots.length) % roots.length; applySelection(selectedIndex); }
  btnLeft .addEventListener('click', prev);
  btnRight.addEventListener('click', next);
  window.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') prev(); });

  // Loop
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    stepTweens(now);
    stepSpin(now, dt);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // First layout
  applySelection(selectedIndex, true);

  // Resize
  window.addEventListener('resize', () => {
    resizeRenderer();
    recomputeDepthOffsets();
    applySelection(selectedIndex, true);
  });

  function recenterGroup(grp) {
    const box = new THREE.Box3().setFromObject(grp);
    const c   = new THREE.Vector3();
    box.getCenter(c);
    grp.position.x -= c.x;
    grp.position.y -= c.y;
  }
  function resizeRenderer() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
