// First-person walking: drag to look, WASD / arrows / on-screen stick to move.
// The walker stays inside a box around the original camera position, because
// the further you go, the more of the world the photo never saw.

export class WalkControls {
  constructor(camera, dom, stick) {
    this.camera = camera;
    this.dom = dom;
    this.stick = stick;
    this.knob = stick.querySelector('.knob');
    this.enabled = false;
    this.yaw = 0; this.pitch = 0;
    this.speed = 1;
    this.bounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    this.keys = new Set();
    this.look = null;          // { id, x, y }
    this.stickVec = { x: 0, y: 0 };
    this.stickId = null;
    this.wheel = 0;
    this.moved = 0;            // total distance walked, for hints

    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    dom.addEventListener('wheel', (e) => { if (!this.enabled) return; e.preventDefault(); this.wheel += -e.deltaY; }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.target.closest('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
        this.keys.add(k); e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    stick.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault(); e.stopPropagation();
      this.stickId = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      this.onStick(e);
    });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === this.stickId) this.onStick(e); });
    const release = (e) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null; this.stickVec = { x: 0, y: 0 };
      this.knob.style.transform = '';
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
  }

  onStick(e) {
    const r = this.stick.getBoundingClientRect();
    const R = r.width / 2;
    let x = (e.clientX - (r.left + R)) / R, y = (e.clientY - (r.top + R)) / R;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    this.stickVec = { x, y };
    this.knob.style.transform = `translate(${x * R * 0.55}px, ${y * R * 0.55}px)`;
  }

  onDown(e) {
    if (!this.enabled || this.look) return;
    this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.dom.setPointerCapture?.(e.pointerId);
  }
  onMove(e) {
    if (!this.enabled || !this.look || e.pointerId !== this.look.id) return;
    const k = (this.camera.fov / 70) * 0.0042;
    this.yaw += (e.clientX - this.look.x) * k;
    this.pitch += (e.clientY - this.look.y) * k;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
    this.look.x = e.clientX; this.look.y = e.clientY;
  }
  onUp(e) { if (this.look && e.pointerId === this.look.id) this.look = null; }

  reset() {
    this.yaw = 0; this.pitch = 0; this.moved = 0;
    this.camera.position.set(0, 0, 0);
    this.apply();
  }

  /** Adopt the camera's current orientation (used after a fly-in). */
  syncFromCamera() {
    const e = this.camera.rotation.clone().reorder('YXZ');
    this.yaw = e.y; this.pitch = e.x;
  }

  apply() { this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ'); }

  update(dt) {
    if (!this.enabled) return;
    const K = this.keys;
    let fwd = (K.has('w') || K.has('arrowup') ? 1 : 0) - (K.has('s') || K.has('arrowdown') ? 1 : 0);
    let side = (K.has('d') ? 1 : 0) - (K.has('a') ? 1 : 0);
    // Arrow left/right turn instead of strafing: friendlier for one hand.
    const turn = (K.has('arrowright') ? 1 : 0) - (K.has('arrowleft') ? 1 : 0);
    this.yaw -= turn * dt * 1.4;
    fwd += -this.stickVec.y; side += this.stickVec.x;
    const wheelStep = this.wheel * 0.0016; this.wheel *= 0.75; if (Math.abs(this.wheel) < 1) this.wheel = 0;
    const m = Math.hypot(fwd, side);
    if (m > 1) { fwd /= m; side /= m; }
    const sp = this.speed * (K.has('shift') ? 2 : 1);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const dx = (-sy * fwd + cy * side) * sp * dt - sy * wheelStep * this.speed * 0.2;
    const dz = (-cy * fwd - sy * side) * sp * dt - cy * wheelStep * this.speed * 0.2;
    const p = this.camera.position, b = this.bounds;
    const ox = p.x, oz = p.z;
    p.x = Math.min(b.maxX, Math.max(b.minX, p.x + dx));
    p.z = Math.min(b.maxZ, Math.max(b.minZ, p.z + dz));
    p.y = 0;
    this.moved += Math.hypot(p.x - ox, p.z - oz);
    this.apply();
  }
}
