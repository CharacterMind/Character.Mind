/* Puppet rig for the maintenance page.
   Each character is a flat picture on a mesh. A hidden skeleton (bones with joints) bends the mesh, like the "puppet" tool in
   animation software: arms, legs, head and hair move on their own, and every character has its own dance.
   If WebGL is not available, nothing here runs and the page falls back to its simple CSS dances. */
(function () {
  'use strict';
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  /* ---------- tiny 2D matrices: [a, b, c, d, e, f] means x' = a*x + c*y + e, y' = b*x + d*y + f ---------- */
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const rotAbout = (deg, px, py) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, px - c * px + s * py, py - s * px - c * py]; };
  const scaleAbout = (sx, sy, px, py) => [sx, 0, 0, sy, px - sx * px, py - sy * py];
  const move = (tx, ty) => [1, 0, 0, 1, tx, ty];
  const ID = [1, 0, 0, 1, 0, 0];
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const sin = Math.sin, abs = Math.abs, PI = Math.PI;
  const step = (u, a, b) => smooth((u - a) / (b - a));           // 0 before a, 1 after b, eased in between
  const dist2Seg = (px, py, ax, ay, bx, by) => { const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1; let t = ((px - ax) * vx + (py - ay) * vy) / l2; t = clamp01(t); const dx = px - (ax + t * vx), dy = py - (ay + t * vy); return Math.sqrt(dx * dx + dy * dy); };

  /* ---------- the three characters: size of the picture, bones, and the dance ---------- */
  // bone: [name, parentName, jointX, jointY, endX, endY, reach, strength]   (reach = how far its influence spreads, in picture pixels)
  const CHARS = {
    lily: {
      w: 569, h: 764, src: 'lily.webp',
      bones: [
        ['hips', null, 372, 480, 372, 330, 190, 1],
        ['chest', 'hips', 365, 420, 345, 250, 95, 3],
        ['head', 'chest', 348, 245, 340, 110, 100, 4],
        ['armR1', 'chest', 410, 262, 445, 298, 36, 4], ['armR2', 'armR1', 445, 298, 492, 190, 36, 4],
        ['armL1', 'chest', 315, 268, 300, 405, 36, 4], ['armL2', 'armL1', 300, 405, 215, 440, 32, 4],
        ['legL1', 'hips', 345, 490, 312, 548, 40, 4], ['legL2', 'legL1', 312, 548, 298, 598, 42, 4],
        ['legR1', 'hips', 395, 495, 398, 605, 42, 4], ['legR2', 'legR1', 398, 605, 400, 725, 44, 4],
        ['hairL1', 'head', 255, 95, 140, 330, 80, 3], ['hairL2', 'hairL1', 140, 330, 75, 520, 78, 3],
        ['hairR1', 'head', 440, 95, 535, 230, 70, 3], ['hairR2', 'hairR1', 535, 230, 470, 380, 62, 3],
      ],
      // Lily: a hip-hop groove. Steps side to side, pumps and waves her arms, kicks her legs out, hair whips behind the beat.
      dance(t) {
        const f = 2 * PI * t;                                        // one beat per second
        const half = f / 2;
        const k = (x) => Math.max(0, x);
        return {
          root: { tx: 18 * sin(half), ty: 8 * Math.cos(f) + 4, rot: 2.5 * sin(half), sx: 1, sy: 1 - 0.015 * Math.cos(f) },
          a: {
            hips: 6 * sin(half), chest: -9 * sin(half + 0.3), head: -13 * sin(half + 0.9) + 4 * sin(2 * f),
            armR1: -26 + 26 * sin(f), armR2: 32 * sin(2 * f + 0.8),
            armL1: 16 + 24 * sin(half + PI), armL2: 22 * sin(f + 1),
            legL1: 20 * k(sin(half)), legL2: -26 * k(sin(half)),
            legR1: -16 * k(sin(half + PI)), legR2: 20 * k(sin(half + PI)),
            hairL1: 11 * sin(half - 1.0), hairL2: 18 * sin(half - 1.8), hairR1: -11 * sin(half - 0.5), hairR2: -16 * sin(half - 1.3),
          },
          spin: 0,
        };
      },
    },
    doey: {
      w: 608, h: 800, src: 'doey.webp',
      bones: [
        ['body', null, 300, 720, 290, 330, 230, 1],
        ['head', 'body', 255, 330, 265, 160, 110, 4],
        ['hat', 'head', 270, 95, 295, 45, 42, 4],
        ['armL1', 'body', 170, 385, 45, 450, 62, 3], ['armL2', 'armL1', 45, 450, 75, 690, 58, 3],
        ['armR1', 'body', 380, 385, 565, 485, 62, 3], ['armR2', 'armR1', 565, 485, 510, 760, 62, 3],
      ],
      // Doey: a wild bouncy jig. Jumps off the floor and squashes on landing, flings his arms up one at a time, head and hat flop.
      dance(t) {
        const f = 2 * PI * t / 0.75;                                  // a beat every 0.75 s
        const air = abs(sin(f / 2));                                 // 0 on the floor, 1 at the top of the jump
        return {
          root: { tx: 10 * sin(f / 4), ty: -52 * air, rot: 5 * sin(f / 2 + 0.4), sx: 1 + 0.14 * (0.5 - air), sy: 1 - 0.18 * (0.5 - air) },
          a: {
            body: 3 * sin(f / 2), head: 15 * sin(f / 2 + 1.3), hat: 28 * sin(f / 2 - 0.4),
            armL1: 28 + 48 * sin(f / 2), armL2: 34 * sin(f / 2 + 1.3),
            armR1: -(28 + 48 * sin(f / 2 + PI)), armR2: -34 * sin(f / 2 + PI + 1.3),
          },
          spin: 0,
        };
      },
    },
    poppy: {
      w: 701, h: 719, src: 'poppy.webp',
      bones: [
        ['skirt', null, 350, 500, 350, 650, 150, 1],
        ['torso', 'skirt', 350, 490, 350, 385, 62, 3],
        ['head', 'torso', 350, 385, 350, 230, 150, 3],
        ['tailL', 'head', 205, 95, 110, 235, 100, 3],
        ['tailR', 'head', 470, 75, 590, 205, 105, 3],
        ['armL', 'torso', 255, 458, 180, 456, 30, 4],
        ['armR', 'torso', 455, 458, 545, 462, 30, 4],
      ],
      // Poppy: a music-box ballerina on a 6 s loop. Curtsy, arms rise in stiff little steps, then a double pirouette with the skirt flaring.
      dance(t) {
        const T = 6, u = (t % T) / T, q = Math.floor(t * 10) / 10;       // q: the doll moves in little ticks
        const qu = (q % T) / T;
        const curtsy = step(u, 0.0, 0.1) * (1 - step(u, 0.2, 0.28));       // dip down
        const raise = step(qu, 0.28, 0.42) * (1 - step(qu, 0.9, 0.97));   // arms overhead
        const spinPhase = step(u, 0.5, 0.88);                              // pirouette progress 0..1
        const spinSpeed = Math.sin(PI * clamp01((u - 0.5) / 0.38));         // 0 -> 1 -> 0 while spinning
        const nod = (sin(2 * PI * q / 1.2)) * (1 - raise * 0.5);
        const floatY = -8 + 5 * sin(2 * PI * t / 1.5);
        return {
          root: { tx: 0, ty: floatY + 26 * curtsy, rot: 0, sx: 1 + 0.03 * curtsy, sy: 1 - 0.04 * curtsy },
          a: {
            skirt: -4 * curtsy + 9 * spinSpeed * sin(2 * PI * t * 3), torso: 16 * curtsy - 3 * raise, head: 9 * nod - 9 * curtsy + 7 * raise * sin(2 * PI * q / 2),
            tailL: 7 * sin(2 * PI * t / 1.5 - 0.6) - 26 * spinSpeed, tailR: 7 * sin(2 * PI * t / 1.5 - 1.1) + 26 * spinSpeed,
            armL: -22 * curtsy + 118 * raise + 6 * sin(2 * PI * q / 1.2),
            armR: 22 * curtsy - 118 * raise - 6 * sin(2 * PI * q / 1.2),
          },
          spin: 720 * spinPhase,
        };
      },
    },
  };

  /* ---------- building a character: mesh, weights, GL ---------- */
  const VS = 'attribute vec2 a_pos; attribute vec2 a_uv; uniform vec2 u_size; uniform vec2 u_pad; varying vec2 v_uv;' +
    'void main(){ vec2 p = (a_pos + u_pad) / (u_size + 2.0 * u_pad); gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0); v_uv = a_uv; }';
  const FS = 'precision mediump float; uniform sampler2D u_tex; varying vec2 v_uv; void main(){ gl_FragColor = texture2D(u_tex, v_uv); }';
  const PADF = 0.2;
  const base = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, '') : '/maintenance/';

  function shader(gl, type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }

  function build(name, cfg, pal) {
    const img = pal.querySelector('img');
    const cv = document.createElement('canvas');
    const pad = Math.round(Math.max(cfg.w, cfg.h) * PADF);
    const cw = cfg.w + 2 * pad, ch = cfg.h + 2 * pad;
    const res = Math.min(1, 1100 / Math.max(cw, ch));
    cv.width = Math.round(cw * res); cv.height = Math.round(ch * res);
    cv.className = 'rig-canvas';
    cv.style.cssText = 'position:absolute;pointer-events:none;left:' + (-100 * pad / cfg.w) + '%;top:' + (-100 * pad / cfg.h) + '%;width:' + (100 * cw / cfg.w) + '%;height:' + (100 * ch / cfg.h) + '%;';
    const gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) throw new Error('no webgl');
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(prog);

    // mesh
    const cell = 13, cols = Math.round(cfg.w / cell), rows = Math.round(cfg.h / cell);
    const nv = (cols + 1) * (rows + 1);
    const rest = new Float32Array(nv * 2), uv = new Float32Array(nv * 2), pos = new Float32Array(nv * 2);
    for (let j = 0, i = 0; j <= rows; j++) for (let k = 0; k <= cols; k++, i++) { rest[i * 2] = k / cols * cfg.w; rest[i * 2 + 1] = j / rows * cfg.h; uv[i * 2] = k / cols; uv[i * 2 + 1] = j / rows; }
    const idx = new Uint16Array(cols * rows * 6);
    for (let j = 0, n = 0; j < rows; j++) for (let k = 0; k < cols; k++) { const a = j * (cols + 1) + k, b = a + 1, c = a + cols + 1, d = c + 1; idx.set([a, c, b, b, c, d], n); n += 6; }

    // bones and per-vertex weights
    const bones = cfg.bones.map((b, i) => ({ name: b[0], parent: b[1] ? cfg.bones.findIndex((x) => x[0] === b[1]) : -1, jx: b[2], jy: b[3], ex: b[4], ey: b[5], reach: b[6], gain: b[7], i }));
    const wIdx = [], wVal = [];
    for (let v = 0; v < nv; v++) {
      const x = rest[v * 2], y = rest[v * 2 + 1];
      const ws = bones.map((b) => { const d = dist2Seg(x, y, b.jx, b.jy, b.ex, b.ey); return b.gain * Math.exp(-(d * d) / (b.reach * b.reach)); });
      // the first (root) bone always has a floor of influence so no vertex is left without a bone
      ws[0] += 0.02;
      let sum = 0; for (const w of ws) sum += w;
      const li = [], lv = [];
      ws.forEach((w, i) => { if (w / sum > 0.004) { li.push(i); lv.push(w / sum); } });
      wIdx.push(li); wVal.push(lv);
    }

    // buffers
    const posBuf = gl.createBuffer(), uvBuf = gl.createBuffer(), idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    const aUv = gl.getAttribLocation(prog, 'a_uv'); gl.enableVertexAttribArray(aUv); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, pos.byteLength, gl.DYNAMIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos'); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_size'), cfg.w, cfg.h); gl.uniform2f(gl.getUniformLocation(prog, 'u_pad'), pad, pad);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, cv.width, cv.height);

    const ch0 = { name, cfg, pal, img, cv, gl, bones, rest, pos, posBuf, wIdx, wVal, nv, idxCount: idx.length, ready: false, M: bones.map(() => ID) };
    const tex = gl.createTexture();
    const im = new Image();
    im.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      ch0.ready = true; pal.classList.add('rigged'); pal.appendChild(cv);
    };
    im.src = base + cfg.src;
    return ch0;
  }

  function pose(c, t) {
    const d = c.cfg.dance(t), r = d.root;
    const hip = c.bones[0];
    // the whole body: move, lean and squash about the feet/hips
    const rootM = mul(move(r.tx, r.ty), mul(scaleAbout(r.sx, r.sy, hip.jx, c.cfg.h * 0.97), rotAbout(r.rot, hip.jx, hip.jy)));
    const M = [];
    c.bones.forEach((b, i) => {
      const local = rotAbout(d.a[b.name] || 0, b.jx, b.jy);
      M[i] = b.parent < 0 ? mul(rootM, local) : mul(M[b.parent], local);
    });
    const pos = c.pos, rest = c.rest;
    for (let v = 0; v < c.nv; v++) {
      const x = rest[v * 2], y = rest[v * 2 + 1], li = c.wIdx[v], lv = c.wVal[v];
      let px = 0, py = 0;
      for (let k = 0; k < li.length; k++) { const m = M[li[k]], w = lv[k]; px += w * (m[0] * x + m[2] * y + m[4]); py += w * (m[1] * x + m[3] * y + m[5]); }
      pos[v * 2] = px; pos[v * 2 + 1] = py;
    }
    return d;
  }

  function draw(c, t) {
    const d = pose(c, t), gl = c.gl;
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.posBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, c.pos);
    gl.drawElements(gl.TRIANGLES, c.idxCount, gl.UNSIGNED_SHORT, 0);
    c.cv.style.transform = d.spin ? 'perspective(900px) rotateY(' + d.spin.toFixed(1) + 'deg)' : '';
  }

  function start() {
    const list = [];
    document.querySelectorAll('.pal[data-rig]').forEach((pal) => {
      const name = pal.getAttribute('data-rig');
      try { list.push(build(name, CHARS[name], pal)); } catch (e) { /* this one keeps its CSS dance */ }
    });
    if (!list.length) return;
    const api = window.RIG = { time: null, chars: list };
    const t0 = performance.now();
    function frame(now) {
      const t = api.time != null ? api.time : (now - t0) / 1000;
      if (!document.hidden) list.forEach((c) => { if (c.ready) draw(c, t); });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
