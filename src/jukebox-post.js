// The Purification Chamber's glow: trails and bloom for the things that give off light. The scene is drawn as it always is, straight to the screen, so that the
// dancers' own shaders and colours are left alone. Only the glowing things (layer 1: the visualizer's ribbons and starburst, the rings and lamps, the motes) are
// drawn again, small and on black, into a buffer. That buffer is
//   - fed back on itself each frame, a little zoomed and turned and faded, which leaves the glow trailing behind (the way MilkDrop's feedback loop does it),
//   - blurred at two sizes, which is the bloom,
// and the two are added over the picture. Nothing here knows about the music: the chamber says how much of each.
import * as THREE from '../node_modules/three/build/three.module.js';

export const GLOW_LAYER = 1;

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const COPY = 'uniform sampler2D source; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(source, vUv).rgb, 1.0); }';
// the last frame's trail, seen a little zoomed in and turned about `centre` (and so a little further out and round), faded, with this frame's glow on it
const TRAIL = `
uniform sampler2D previous, glow;
uniform float decay, zoom, turn, inject, aspect;
uniform vec2 centre;
varying vec2 vUv;
void main() {
  vec2 p = vUv - centre;
  p.x *= aspect;
  float c = cos(turn), s = sin(turn);
  p = mat2(c, -s, s, c) * p / zoom;
  p.x /= aspect;
  vec3 old = max(texture2D(previous, p + centre).rgb * decay - 0.004, 0.0);   // (taking a little off, so that a trail in 8 bits dies away entirely)
  gl_FragColor = vec4(old + texture2D(glow, vUv).rgb * inject, 1.0);
}`;
const BLUR = `
uniform sampler2D source;
uniform vec2 direction;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(source, vUv).rgb * 0.2270270270;
  sum += (texture2D(source, vUv + direction * 1.3846153846).rgb + texture2D(source, vUv - direction * 1.3846153846).rgb) * 0.3162162162;
  sum += (texture2D(source, vUv + direction * 3.2307692308).rgb + texture2D(source, vUv - direction * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;
const COMPOSITE = `
uniform sampler2D trail, bloomNear, bloomFar;
uniform float trailGain, bloomGain;
varying vec2 vUv;
void main() {
  vec3 light = texture2D(trail, vUv).rgb * trailGain + (texture2D(bloomNear, vUv).rgb * 0.75 + texture2D(bloomFar, vUv).rgb * 0.85) * bloomGain;
  gl_FragColor = vec4(light, 1.0);
  #include <colorspace_fragment>
}`;

export function createPost(renderer) {
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), flat = new THREE.Scene(), eye = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  flat.add(quad);
  const material = (fragmentShader, uniforms, options = {}) => new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...options });
  const copy = material(COPY, { source: { value: null } });
  const trailer = material(TRAIL, { previous: { value: null }, glow: { value: null }, decay: { value: 0.88 }, zoom: { value: 1.01 }, turn: { value: 0 }, inject: { value: 1 }, aspect: { value: 1.6 }, centre: { value: new THREE.Vector2(0.5, 0.5) } });
  const blur = material(BLUR, { source: { value: null }, direction: { value: new THREE.Vector2() } });
  const composite = material(COMPOSITE, { trail: { value: null }, bloomNear: { value: null }, bloomFar: { value: null }, trailGain: { value: 0 }, bloomGain: { value: 0 } },
    { transparent: true, blending: THREE.AdditiveBlending });
  const floatable = renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float');

  let size = null, glow = null, trail = [null, null], flip = 0, near = [null, null], far = [null, null];
  const target = (w, h, depth = false) => new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
    type: floatable ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: depth, stencilBuffer: false,
  });
  const free = () => { for (const each of [glow, ...trail, ...near, ...far]) each?.dispose(); glow = null; trail = [null, null]; near = [null, null]; far = [null, null]; };
  const blit = (shader, into) => { quad.material = shader; renderer.setRenderTarget(into); renderer.render(flat, eye); };
  const clear = into => { renderer.setRenderTarget(into); renderer.clear(); };

  // the buffers, `scale` of the picture's size across (the glow is soft, so it can be small), the bloom half and a quarter of that
  function resize(width, height, scale) {
    if (size && size.width === width && size.height === height && size.scale === scale) return;
    free();
    size = { width, height, scale };
    const w = Math.round(width * scale), h = Math.round(height * scale);
    glow = target(w, h, true);
    trail = [target(w, h), target(w, h)];
    near = [target(w / 2, h / 2), target(w / 2, h / 2)];
    far = [target(w / 4, h / 4), target(w / 4, h / 4)];
    const clearColor = new THREE.Color(), alpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    renderer.setClearColor(0x000000, 1);
    for (const each of [glow, ...trail, ...near, ...far]) clear(each);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clearColor, alpha);
  }

  // the glowing things on black, small. With `occlude` what stands in front of them (the dancers, the floor) hides them, drawn black; without it they show
  // through, which costs less
  function drawGlow(scene, camera, occlude) {
    const was = { target: renderer.getRenderTarget(), alpha: renderer.getClearAlpha(), color: renderer.getClearColor(new THREE.Color()), fog: scene.fog, mask: camera.layers.mask, auto: renderer.autoClear };
    const hidden = new Map(), unseen = [];
    scene.fog = null;
    camera.layers.mask = occlude ? 1 | (1 << GLOW_LAYER) : 1 << GLOW_LAYER;
    // what is not glowing is drawn without colour: it only keeps the glow behind it from showing
    // (the music notes are sprites, and would be drawn into the glow in full colour, and bleed)
    scene.traverse(object => { if (object.isSprite && object.visible) { object.visible = false; unseen.push(object); } });
    if (occlude) scene.traverse(object => {
      if (!object.isMesh || !object.visible || (object.layers.mask & (1 << GLOW_LAYER))) return;
      for (const m of Array.isArray(object.material) ? object.material : [object.material]) if (m && !hidden.has(m)) { hidden.set(m, m.colorWrite); m.colorWrite = false; }
    });
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.setRenderTarget(glow);
    renderer.render(scene, camera);
    for (const [m, write] of hidden) m.colorWrite = write;
    for (const object of unseen) object.visible = true;
    scene.fog = was.fog;
    camera.layers.mask = was.mask;
    renderer.setRenderTarget(was.target);
    renderer.setClearColor(was.color, was.alpha);
    renderer.autoClear = was.auto;
  }

  const blurInto = (from, through, into, step) => {
    blur.uniforms.source.value = from.texture;
    blur.uniforms.direction.value.set(step / through.width, 0);
    blit(blur, through);
    blur.uniforms.source.value = through.texture;
    blur.uniforms.direction.value.set(0, step / into.height);
    blit(blur, into);
  };

  return {
    resize,
    // The frame's glow, before the picture is drawn: `mode` 'full' (trails and bloom) or 'bloom'; { occlude, decay, zoom, turn, inject, centre } shape the trail.
    prepare(scene, camera, mode, { occlude = true, decay = 0.88, zoom = 1.01, turn = 0, inject = 0.9, aspect = 1.6 } = {}) {
      if (!glow) return;
      drawGlow(scene, camera, occlude);
      const was = renderer.autoClear;
      renderer.autoClear = false;
      let source = glow;
      if (mode === 'full') {
        const from = trail[flip], to = trail[1 - flip];
        Object.assign(trailer.uniforms.decay, { value: decay }); trailer.uniforms.zoom.value = zoom; trailer.uniforms.turn.value = turn; trailer.uniforms.inject.value = inject;
        trailer.uniforms.aspect.value = aspect; trailer.uniforms.centre.value.set(0.5, 0.46);
        trailer.uniforms.previous.value = from.texture; trailer.uniforms.glow.value = glow.texture;
        blit(trailer, to);
        flip = 1 - flip;
        source = to;
      }
      // the bloom: the glow (or the trail, which has the glow on it), at half and a quarter size, blurred each way
      copy.uniforms.source.value = source.texture;
      blit(copy, near[0]);
      blurInto(near[0], near[1], near[0], 1.0);
      copy.uniforms.source.value = near[0].texture;
      blit(copy, far[0]);
      blurInto(far[0], far[1], far[0], 1.0);
      renderer.setRenderTarget(null);
      renderer.autoClear = was;
      this.mode = mode;
      this.source = source;
    },
    // Added over the picture, after it is drawn
    composite(trailGain, bloomGain) {
      if (!glow || !this.source) return;
      composite.uniforms.trail.value = this.mode === 'full' ? this.source.texture : glow.texture;
      composite.uniforms.bloomNear.value = near[0].texture;
      composite.uniforms.bloomFar.value = far[0].texture;
      composite.uniforms.trailGain.value = this.mode === 'full' ? trailGain : 0;
      composite.uniforms.bloomGain.value = bloomGain;
      const was = renderer.autoClear;
      renderer.autoClear = false;
      blit(composite, null);
      renderer.autoClear = was;
    },
    // a fresh start for the trails (a new song, or the glow just turned back on)
    wipe() {
      if (!glow) return;
      const color = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 1);
      for (const each of trail) clear(each);
      renderer.setRenderTarget(null);
      renderer.setClearColor(color, alpha);
    },
    free,
    dispose() { free(); copy.dispose(); trailer.dispose(); blur.dispose(); composite.dispose(); quad.geometry.dispose(); },
    mode: 'off', source: null,
  };
}
