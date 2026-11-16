/**
 * 金邊鍋貼｜首頁 3D「人來人往」街景（Three.js r128）
 *
 * - 一間店面 + 低多邊形路人；有人經過、有人轉向走進店門、有人逛一會兒再走出來
 * - 進出店門時，門燈會亮一下
 * - WebGL 或 three.js 無法使用時直接結束，頁面維持原本的 2D 剪影動畫
 * - 「減少動態效果」：仍顯示，但速度放慢、不擺動手腳
 * - 畫面不在可視範圍或分頁隱藏時暫停繪製
 */
(function () {
  'use strict';

  var host = document.getElementById('crowd3d');
  var flat = document.getElementById('crowd');     // 2D 備援版
  var T = window.THREE;
  if (!host || !T) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SPEED = reduce ? 0.35 : 1;
  var SWING = reduce ? 0 : 1;

  /* ---------- 渲染器 ---------- */
  var renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (e) { return; }
  if (!renderer || !renderer.getContext()) return;
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;            // 讓人走進門時被門面「切掉」
  host.appendChild(renderer.domElement);

  var scene = new T.Scene();
  var camera = new T.PerspectiveCamera(30, 2, 0.1, 100);
  camera.position.set(0, 3.0, 12);
  camera.lookAt(0, 1.9, 0);

  /* ---------- 燈光 ---------- */
  scene.add(new T.HemisphereLight(0xfff1dc, 0x5a4230, 0.95));
  var sun = new T.DirectionalLight(0xffe2b8, 0.8);
  sun.position.set(-6, 9, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 8;    sun.shadow.camera.bottom = -8;
  sun.shadow.camera.near = 1;   sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  var doorLight = new T.PointLight(0xffa04a, 1.0, 10);
  scene.add(doorLight);

  /* ---------- 地面 ---------- */
  var floor = new T.Mesh(
    new T.PlaneGeometry(160, 14),
    new T.MeshStandardMaterial({ color: 0x1d130c, transparent: true, opacity: 0.62, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 3.5);
  floor.receiveShadow = true;
  scene.add(floor);
  var curb = new T.Mesh(
    new T.BoxGeometry(160, 0.05, 0.12),
    new T.MeshBasicMaterial({ color: 0xc9a77c, transparent: true, opacity: 0.55 })
  );
  curb.position.set(0, 0.02, 4.7);
  scene.add(curb);

  /* ---------- 店面 ---------- */
  var DOOR_Z = -0.5;                               // 走到這裡就算「進門」
  var store = new T.Group();
  scene.add(store);

  function box(w, h, d, color, x, y, z, shadow) {
    var m = new T.Mesh(new T.BoxGeometry(w, h, d), new T.MeshStandardMaterial({ color: color, roughness: 0.9 }));
    m.position.set(x, y, z);
    if (shadow) { m.castShadow = true; m.receiveShadow = true; }
    store.add(m);
    return m;
  }
  function glow(w, h, color, x, y, z, opacity) {
    var m = new T.Mesh(new T.PlaneGeometry(w, h),
      new T.MeshBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity }));
    m.position.set(x, y, z);
    store.add(m);
    return m;
  }

  box(6.4, 4.6, 3, 0x5c4330, 0, 2.3, -1.5, true);              // 主體
  box(6.7, 0.2, 3.2, 0x2a1d14, 0, 4.65, -1.45, true);          // 屋頂邊
  box(1.75, 2.75, 0.1, 0x2a1d14, 0, 1.38, 0.01, false);        // 門框
  var doorGlow = glow(1.5, 2.55, 0xffc27a, 0, 1.3, 0.07, 1);   // 門內暖光
  [-2.1, 2.1].forEach(function (x) {                           // 兩側櫥窗
    box(1.7, 1.7, 0.1, 0x2a1d14, x, 1.75, 0.01, false);
    glow(1.5, 1.5, 0xffd9a0, x, 1.75, 0.07, 0.92);
  });
  var awning = box(6.7, 0.18, 1.3, 0xb85e1e, 0, 3.12, 0.55, true); // 遮雨棚
  awning.rotation.x = 0.28;
  [-2.7, 2.7].forEach(function (x) {                           // 燈籠
    var cord = new T.Mesh(new T.CylinderGeometry(0.015, 0.015, 0.3, 4), new T.MeshBasicMaterial({ color: 0x2a1d14 }));
    cord.position.set(x, 2.78, 0.95); store.add(cord);
    var lamp = new T.Mesh(new T.SphereGeometry(0.2, 12, 10), new T.MeshBasicMaterial({ color: 0xff6a2b }));
    lamp.scale.set(1, 1.15, 1);
    lamp.position.set(x, 2.5, 0.95); store.add(lamp);
  });

  // 招牌：用 canvas 畫字當貼圖
  var signCanvas = document.createElement('canvas');
  signCanvas.width = 1040; signCanvas.height = 190;
  var signTex = new T.CanvasTexture(signCanvas);
  function drawSign() {
    var c = signCanvas.getContext('2d');
    c.fillStyle = '#2a1d14'; c.fillRect(0, 0, 1040, 190);
    c.strokeStyle = '#E07A2E'; c.lineWidth = 8; c.strokeRect(10, 10, 1020, 170);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#FBF6EE';
    c.font = '700 108px "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif';
    c.fillText('金邊鍋貼', 520, 92);
    c.fillStyle = '#E07A2E';
    c.font = '600 30px "Noto Sans TC", system-ui, sans-serif';
    c.fillText('J I N B I A N   D U M P L I N G', 520, 156);
    signTex.needsUpdate = true;
  }
  drawSign();
  if (document.fonts && document.fonts.load) {
    document.fonts.load('700 108px "Noto Serif TC"', '金邊鍋貼').then(drawSign).catch(function () {});
  }
  var sign = new T.Mesh(new T.PlaneGeometry(5.2, 0.95), new T.MeshBasicMaterial({ map: signTex }));
  sign.position.set(0, 3.95, 0.03);
  store.add(sign);

  /* ---------- 路人 ---------- */
  var clip = new T.Plane(new T.Vector3(0, 0, 1), -0.04);       // z < 0.04 的部分不繪製（門內）
  var G = {
    torso: new T.CylinderGeometry(0.27, 0.23, 0.78, 10),
    head: new T.SphereGeometry(0.2, 14, 10),
    hair: new T.SphereGeometry(0.215, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    leg: new T.BoxGeometry(0.15, 0.72, 0.17).translate(0, -0.36, 0),
    arm: new T.BoxGeometry(0.11, 0.6, 0.13).translate(0, -0.28, 0),
    pack: new T.BoxGeometry(0.34, 0.4, 0.14)
  };
  var matCache = {};
  function mat(color) {
    return matCache[color] || (matCache[color] = new T.MeshStandardMaterial({
      color: color, roughness: 0.85, flatShading: true, clippingPlanes: [clip]
    }));
  }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  var SKIN = [0xf2c9a0, 0xe0ac80, 0xc68642, 0x8d5524, 0xffdbac];
  var HAIR = [0x1c1410, 0x3b2a1e, 0x6b4a2e, 0x8a8a8a, 0x2a2a30];
  var TOP = [0xfbf6ee, 0xe07a2e, 0x3b7a8c, 0x6b8e4e, 0xc0504d, 0x4a5b8c, 0xd9b24c, 0x2e2e34];
  var BOTTOM = [0x2b2b33, 0x3a4a66, 0x5c4330, 0x4a4a4a];

  function part(geo, color, x, y, z, parent) {
    var m = new T.Mesh(geo, mat(color));
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  }
  function makePerson() {
    var g = new T.Group();
    var top = pick(TOP);
    part(G.torso, top, 0, 1.18, 0, g);
    part(G.head, pick(SKIN), 0, 1.74, 0, g);
    part(G.hair, pick(HAIR), 0, 1.77, -0.01, g);
    if (Math.random() < 0.4) part(G.pack, pick(TOP), 0, 1.22, -0.2, g);   // 背包（也能看出前後）
    var legs = [], arms = [], bottom = pick(BOTTOM);
    [-0.09, 0.09].forEach(function (x) {
      var pivot = new T.Group(); pivot.position.set(x, 0.8, 0); g.add(pivot);
      part(G.leg, bottom, 0, 0, 0, pivot); legs.push(pivot);
    });
    [-0.35, 0.35].forEach(function (x) {
      var pivot = new T.Group(); pivot.position.set(x, 1.5, 0); g.add(pivot);
      part(G.arm, top, 0, 0, 0, pivot); arms.push(pivot);
    });
    g.userData = { legs: legs, arms: arms };
    return g;
  }

  /* ---------- 行為 ---------- */
  var view = { halfW: 8, storeX: 3.4 };
  var walkers = [];
  var pulse = 0;                                   // 門燈閃一下

  function setup(w) {
    var dir = Math.random() < 0.5 ? -1 : 1;
    w.dir = dir;
    w.lane = rand(1.0, 3.4);
    w.speed = rand(1.0, 1.7);
    w.phase = rand(0, 6.28);
    w.scale = rand(0.82, 1.12);
    w.plan = Math.random();                        // <0.28 進店不出來、<0.5 進店逛一下再出來、其餘路過
    w.state = 'walk';
    w.timer = 0;
    w.g.scale.setScalar(w.scale);
    w.g.rotation.y = Math.atan2(dir, 0);
    w.g.visible = true;
  }
  function spawnAtEdge(w) {
    setup(w);
    w.g.position.set(-w.dir * (view.halfW + 1.8), 0, w.lane);
  }
  function respawnLater(w) {
    w.state = 'wait';
    w.timer = rand(0.2, 3);
    w.g.visible = false;
  }
  function turnTo(w, dx, dz, dt) {
    var target = Math.atan2(dx, dz);
    var d = target - w.g.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    w.g.rotation.y += d * Math.min(1, dt * 9);
  }
  function stepTo(w, tx, tz, dt) {
    var dx = tx - w.g.position.x, dz = tz - w.g.position.z;
    var len = Math.hypot(dx, dz) || 1;
    var v = w.speed * SPEED * dt;
    w.g.position.x += dx / len * Math.min(v, len);
    w.g.position.z += dz / len * Math.min(v, len);
    turnTo(w, dx, dz, dt);
    return len;
  }
  function animateLimbs(w, dt, moving) {
    var ud = w.g.userData;
    if (moving) w.phase += dt * w.speed * SPEED * 6.2;
    var s = moving ? Math.sin(w.phase) * 0.75 * SWING : 0;
    ud.legs[0].rotation.x = s;  ud.legs[1].rotation.x = -s;
    ud.arms[0].rotation.x = -s * 0.7; ud.arms[1].rotation.x = s * 0.7;
    w.g.position.y = moving ? Math.abs(Math.sin(w.phase)) * 0.045 * SWING : 0;
  }

  function update(w, dt) {
    var p = w.g.position;
    if (w.state === 'wait') {
      w.timer -= dt;
      if (w.timer <= 0) spawnAtEdge(w);
      return;
    }
    if (w.state === 'inside') {
      w.timer -= dt;
      if (w.timer <= 0) {                           // 從店門走出來
        w.dir = Math.random() < 0.5 ? -1 : 1;
        w.lane = rand(1.2, 3.2);
        p.set(view.storeX + rand(-0.25, 0.25), 0, -0.7);
        w.g.rotation.y = 0;
        w.g.visible = true;
        w.state = 'out';
        pulse = 1;
      }
      return;
    }
    if (w.state === 'walk') {
      p.x += w.dir * w.speed * SPEED * dt;
      p.z += (w.lane - p.z) * Math.min(1, dt * 2);
      turnTo(w, w.dir, 0, dt);
      animateLimbs(w, dt, true);
      var ahead = (view.storeX - p.x) * w.dir;      // 還剩多遠到店門口（正值＝還沒走到）
      if (w.plan < 0.5 && ahead > 0 && ahead < p.z * 1.1 + 0.4) w.state = 'toDoor';
      if (Math.abs(p.x) > view.halfW + 2.2 && p.x * w.dir > 0) respawnLater(w);
      return;
    }
    if (w.state === 'toDoor') {
      var left = stepTo(w, view.storeX, DOOR_Z, dt);
      animateLimbs(w, dt, true);
      if (p.z < 0.9 && !w.pulsed) { pulse = 1; w.pulsed = true; }
      if (left < 0.05 || p.z <= DOOR_Z + 0.02) {
        w.pulsed = false;
        w.g.visible = false;
        if (w.plan < 0.28) { respawnLater(w); }
        else { w.state = 'inside'; w.timer = rand(2, 5) / SPEED; }
      }
      return;
    }
    if (w.state === 'out') {
      var d = stepTo(w, view.storeX + w.dir * 1.4, w.lane, dt);
      animateLimbs(w, dt, true);
      if (p.z >= w.lane - 0.05 || d < 0.05) { w.state = 'walk'; w.plan = 1; }
    }
  }

  function targetCount() {
    return Math.max(6, Math.min(16, Math.round(view.halfW * 1.15)));
  }
  function syncWalkers() {
    var n = targetCount();
    while (walkers.length < n) {
      var w = { g: makePerson(), pulsed: false };
      scene.add(w.g);
      spawnAtEdge(w);
      w.g.position.x = rand(-view.halfW, view.halfW);              // 預先散布在畫面上
      walkers.push(w);
    }
    while (walkers.length > n) scene.remove(walkers.pop().g);
  }

  /* ---------- 尺寸 ---------- */
  function resize() {
    var w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 在人行道（z≈2.2）處，畫面左右各可見多少單位
    view.halfW = Math.tan(camera.fov * Math.PI / 360) * (camera.position.z - 2.2) * camera.aspect;
    view.storeX = -view.halfW * 0.32;                 // 店面偏左，避開右下角的「立即預約」按鈕
    store.position.x = view.storeX;
    doorLight.position.set(view.storeX, 1.9, 1.5);
    syncWalkers();
    draw();
  }

  /* ---------- 繪製迴圈 ---------- */
  var running = false, last = 0, visible = true, shown = false;
  function draw() { renderer.render(scene, camera); }
  function frame(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    for (var i = 0; i < walkers.length; i++) update(walkers[i], dt);
    pulse = Math.max(0, pulse - dt * 1.6);
    doorLight.intensity = 1.0 + pulse * 1.3;
    doorGlow.material.color.setHex(pulse > 0.05 ? 0xffd79a : 0xffc27a);
    draw();
    if (!shown) {                                   // 第一張畫面畫好後，才換掉 2D 備援
      shown = true;
      host.classList.add('ready');
      if (flat) flat.style.display = 'none';
    }
    requestAnimationFrame(frame);
  }
  function setRunning(on) {
    if (on && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    else if (!on) running = false;
  }
  function refresh() { setRunning(visible && !document.hidden); }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; refresh(); }).observe(host);
  }
  document.addEventListener('visibilitychange', refresh);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(host);
  else window.addEventListener('resize', resize);

  renderer.domElement.addEventListener('webglcontextlost', function (e) {   // 失去 GPU 時退回 2D
    e.preventDefault(); running = false; host.classList.remove('ready');
    if (flat) flat.style.display = '';
  });

  resize();
  refresh();
})();
