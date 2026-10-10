(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const socket = typeof window.io === "function" ? window.io() : null;

  const menu = $("menu");
  const hud = $("hud");
  const pauseScreen = $("pauseScreen");
  const endScreen = $("endScreen");
  const errorMessage = $("errorMessage");
  const gameContainer = $("game");

  let scene, camera, renderer, clock, flashlight;
  let keyObject, exitObject, monsterObject;
  let running = false, paused = false, ended = false;
  let hasKey = false, flashlightOn = true;
  let health = 100;
  let yaw = 0, pitch = 0;
  let lastTouchX = null, lastTouchY = null;
  let roomCode = null, isHost = false, multiplayer = false;
  let serverKeyFound = false;
  let lastNetworkUpdate = 0;
  const otherPlayers = {};
  let monsterTarget = null;

  // Mini-Map
  let minimapCanvas = null;
  let minimapCtx = null;
  const MINIMAP_SIZE = 200;
  const WORLD_SIZE = 30;

  const move = {
    forward: false,
    backward: false,
    left: false,
    right: false
  };

  const player = { x: -12, z: -12, speed: 3.4, radius: 0.28 };
  const walls = [];
  const objects = [];

  const wallMap = [
    "111111111111111",
    "100000100000001",
    "101110101110101",
    "101000100010101",
    "101011111010101",
    "100010000010001",
    "111010111110101",
    "100010100000101",
    "101110101110101",
    "101000001000001",
    "101011111011101",
    "100000100000001",
    "101110101110101",
    "100000000000001",
    "111111111111111"
  ];

  const CELL = 2;
  const MAP_OFFSET = 14;

  function message(text) {
    const el = $("message");
    if (el) el.textContent = text;
  }

  function menuMessage(text) {
    const el = $("menuMessage");
    if (el) el.textContent = text;
  }

  function showError(text) {
    if (!errorMessage) return;
    errorMessage.textContent = text;
    errorMessage.classList.remove("hidden");
  }

  function hideError() {
    errorMessage?.classList.add("hidden");
  }

  function playerName() {
    return ($("playerName")?.value || "Player").trim().slice(0, 18) || "Player";
  }

  function updateHUD() {
    if ($("keyCount")) $("keyCount").textContent = hasKey ? "1 / 1" : "0 / 1";
    if ($("health")) $("health").textContent = String(health);
    if ($("flashlightBtn")) {
      $("flashlightBtn").textContent = flashlightOn ? "LIGHT ON" : "LIGHT OFF";
    }
  }

  function cellToWorld(row, col) {
    return { x: col * CELL - MAP_OFFSET, z: row * CELL - MAP_OFFSET };
  }

  function material(color, roughness = 0.9, metalness = 0) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
  }

  function addBox(x, y, z, w, h, d, mat, isWall = false) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    objects.push(mesh);

    if (isWall) walls.push({ x, z, halfX: w / 2, halfZ: d / 2 });
    return mesh;
  }

  function clearScene() {
    if (!scene) return;

    for (const child of [...scene.children]) {
      scene.remove(child);
      child.traverse?.(obj => {
        obj.geometry?.dispose();
        if (obj.material) {
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach(mat => mat.dispose());
        }
      });
    }

    walls.length = 0;
    objects.length = 0;
    for (const id of Object.keys(otherPlayers)) delete otherPlayers[id];
    keyObject = null;
    exitObject = null;
    monsterObject = null;
  }

  function buildMaze() {
    const size = wallMap.length * CELL;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      material(0x252a30)
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    objects.push(floor);

    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      material(0x101319)
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = 4.2;
    scene.add(ceiling);
    objects.push(ceiling);

    const wallMat = material(0x424956);
    const trimMat = material(0x941d31);

    for (let r = 0; r < wallMap.length; r++) {
      for (let c = 0; c < wallMap[r].length; c++) {
        if (wallMap[r][c] !== "1") continue;
        const p = cellToWorld(r, c);
        addBox(p.x, 2.1, p.z, CELL, 4.2, CELL, wallMat, true);
        addBox(p.x, 3.95, p.z, CELL * 0.98, 0.07, CELL * 0.98, trimMat);
      }
    }

    const start = cellToWorld(1, 1);
    player.x = start.x;
    player.z = start.z;

    const exitPos = cellToWorld(13, 13);
    exitObject = new THREE.Group();
    exitObject.position.set(exitPos.x, 0, exitPos.z);

    const green = material(0x168b62, 0.6, 0.15);
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.7, 0.25), green);
    left.position.set(-0.8, 1.35, 0);
    const right = left.clone();
    right.position.x = 0.8;
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.18, 0.25), green);
    top.position.y = 2.65;

    const portal = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 2.4),
      new THREE.MeshBasicMaterial({
        color: 0x18ff9a,
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide
      })
    );
    portal.position.set(0, 1.3, 0.04);
    exitObject.add(left, right, top, portal);
    scene.add(exitObject);

    const exitLight = new THREE.PointLight(0x14ff91, 2, 8);
    exitLight.position.set(exitPos.x, 2, exitPos.z);
    scene.add(exitLight);

    const keyPos = cellToWorld(1, 7);
    keyObject = new THREE.Group();
    keyObject.position.set(keyPos.x, 0.8, keyPos.z);

    const gold = new THREE.MeshStandardMaterial({
      color: 0xffd34d,
      metalness: 0.8,
      roughness: 0.25,
      emissive: 0x553000
    });

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.07, 8, 18), gold);
    ring.rotation.x = Math.PI / 2;

    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.55, 8), gold);
    stem.rotation.z = Math.PI / 2;
    stem.position.x = 0.3;

    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), gold);
    tooth.position.set(0.48, -0.15, 0);
    keyObject.add(ring, stem, tooth);
    scene.add(keyObject);

    const keyLight = new THREE.PointLight(0xffc847, 1.5, 5);
    keyLight.position.copy(keyObject.position);
    scene.add(keyLight);

    monsterObject = new THREE.Group();
    const monsterMat = new THREE.MeshStandardMaterial({
      color: 0x861b32,
      emissive: 0x260008,
      roughness: 0.7
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5, 0.55), monsterMat);
    body.position.y = 0.9;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 14, 12),
      monsterMat
    );
    head.position.y = 1.9;
    monsterObject.add(body, head);
    monsterObject.position.set(2, 0, 0);
    scene.add(monsterObject);
  }

  function setupLighting() {
    scene.add(new THREE.HemisphereLight(0x7786a8, 0x151018, 0.3));

    const red = new THREE.PointLight(0xff183f, 1.4, 9);
    red.position.set(0, 2.5, 0);
    scene.add(red);

    flashlight = new THREE.SpotLight(0xffe8c2, 8, 13, Math.PI / 7, 0.65, 1.5);
    flashlight.position.set(0, 0, 0);
    flashlight.target.position.set(0, 0, -1);
    camera.add(flashlight);
    camera.add(flashlight.target);
    scene.add(camera);
  }

  function initGame() {
    if (!window.THREE) {
      showError("Three.js failed to load. Check your internet connection.");
      return false;
    }

    hideError();

    if (renderer) {
      gameContainer.innerHTML = "";
      renderer.dispose();
      renderer = null;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070c);
    scene.fog = new THREE.FogExp2(0x05070c, 0.035);

    camera = new THREE.PerspectiveCamera(
      75, window.innerWidth / window.innerHeight, 0.1, 100
    );
    camera.rotation.order = "YXZ";

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    gameContainer.appendChild(renderer.domElement);

    clock = new THREE.Clock();
    hasKey = false;
    serverKeyFound = false;
    flashlightOn = true;
    health = 100;
    yaw = 0;
    pitch = 0;
    ended = false;
    Object.keys(move).forEach(k => move[k] = false);

    clearScene();
    buildMaze();
    setupLighting();
    updateHUD();
    initMinimap();
    message("Find the golden key, then reach the green exit.");
    return true;
  }

  function collides(x, z) {
    const radius = player.radius;
    for (const wall of walls) {
      const cx = Math.max(wall.x - wall.halfX, Math.min(x, wall.x + wall.halfX));
      const cz = Math.max(wall.z - wall.halfZ, Math.min(z, wall.z + wall.halfZ));
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  function movePlayer(delta) {
    if (!running || paused || ended) return;

    let forward = (move.forward ? 1 : 0) - (move.backward ? 1 : 0);
    let sideways = (move.right ? 1 : 0) - (move.left ? 1 : 0);
    if (!forward && !sideways) return;

    const len = Math.hypot(forward, sideways);
    forward /= len;
    sideways /= len;

    const speed = player.speed * delta;
    const dx = (-Math.sin(yaw) * forward + Math.cos(yaw) * sideways) * speed;
    const dz = (-Math.cos(yaw) * forward - Math.sin(yaw) * sideways) * speed;

    const nx = player.x + dx;
    const nz = player.z + dz;

    if (!collides(nx, player.z)) player.x = nx;
    if (!collides(player.x, nz)) player.z = nz;

    camera.position.set(player.x, 1.65, player.z);
    camera.rotation.set(pitch, yaw, 0, "YXZ");

    if (multiplayer && socket?.connected && performance.now() - lastNetworkUpdate > 60) {
      lastNetworkUpdate = performance.now();
      socket.emit("playerMove", { x: player.x, z: player.z, yaw });
    }
  }

  function collectKey() {
    if (!running || paused || ended || hasKey || !keyObject?.visible) return;

    const distance = Math.hypot(
      player.x - keyObject.position.x,
      player.z - keyObject.position.z
    );

    if (distance > 2) {
      message("Move closer to the golden key.");
      return;
    }

    if (multiplayer && socket) {
      socket.emit("collectKey", 1);
      message("Trying to collect the key...");
      return;
    }

    hasKey = true;
    keyObject.visible = false;
    updateHUD();
    message("Key collected! Find the green exit.");
  }

  function checkExit() {
    if (!exitObject || ended) return;

    const distance = Math.hypot(
      player.x - exitObject.position.x,
      player.z - exitObject.position.z
    );

    if (distance < 1.5) {
      if (!hasKey) {
        message("The exit is locked. Find the golden key first!");
      } else if (multiplayer && socket) {
        socket.emit("playerEscaped");
      } else {
        finishGame(true);
      }
    }
  }

  function checkCollectibles() {
    if (!keyObject?.visible || hasKey) return;
    if (Math.hypot(player.x - keyObject.position.x, player.z - keyObject.position.z) < 1.25) {
      collectKey();
    }
  }

  function finishGame(won) {
    if (ended) return;
    ended = true;
    running = false;
    paused = false;

    if ($("endTitle")) $("endTitle").textContent = won ? "YOU ESCAPED!" : "GAME OVER";
    if ($("endText")) {
      $("endText").textContent = won
        ? "You found the key and escaped the maze."
        : "Try again and escape the maze.";
    }

    endScreen?.classList.remove("hidden");
    hud?.classList.add("hidden");
  }

  function startGame() {
    if (!initGame()) return;

    menu?.classList.add("hidden");
    pauseScreen?.classList.add("hidden");
    endScreen?.classList.add("hidden");
    hud?.classList.remove("hidden");

    running = true;
    paused = false;
    camera.position.set(player.x, 1.65, player.z);
    camera.rotation.set(pitch, yaw, 0, "YXZ");

    animate();
    if (isMobile()) message("Use the arrows to move and drag the screen to look around.");
  }

  function animate() {
    if (!renderer || !scene || !camera) return;
    requestAnimationFrame(animate);

    const delta = Math.min(clock.getDelta(), 0.05);

    if (running && !paused && !ended) {
      movePlayer(delta);

      if (keyObject?.visible) {
        keyObject.rotation.y += delta * 1.4;
        keyObject.position.y = 0.8 + Math.sin(performance.now() * 0.003) * 0.12;
      }

      if (monsterObject && monsterTarget) {
        monsterObject.position.x += (monsterTarget.x - monsterObject.position.x) * Math.min(delta * 5, 1);
        monsterObject.position.z += (monsterTarget.z - monsterObject.position.z) * Math.min(delta * 5, 1);
      }

      checkCollectibles();
      checkExit();
    }

    drawMinimap();
    renderer.render(scene, camera);
  }

  function isMobile() {
    return window.matchMedia("(max-width: 900px), (pointer: coarse)").matches;
  }

  function pauseGame() {
    if (!running || ended) return;
    paused = true;
    Object.keys(move).forEach(k => move[k] = false);
    pauseScreen?.classList.remove("hidden");
  }

  function resumeGame() {
    pauseScreen?.classList.add("hidden");
    paused = false;
    running = true;
    clock?.getDelta();
  }

  function backToMenu() {
    running = false;
    paused = false;
    ended = false;
    pauseScreen?.classList.add("hidden");
    endScreen?.classList.add("hidden");
    hud?.classList.add("hidden");
    menu?.classList.remove("hidden");
    Object.keys(move).forEach(k => move[k] = false);
  }

  function toggleFlashlight() {
    flashlightOn = !flashlightOn;
    if (flashlight) flashlight.visible = flashlightOn;
    updateHUD();
  }

  function bindMoveButton(id, direction) {
    const button = $(id);
    if (!button) return;

    const stop = event => {
      event.preventDefault();
      move[direction] = false;
    };

    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      if (!running || paused || ended) return;
      move[direction] = true;
      try { button.setPointerCapture(event.pointerId); } catch (_) {}
    });

    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("lostpointercapture", stop);
    button.addEventListener("contextmenu", event => event.preventDefault());
  }

  function setupControls() {
    bindMoveButton("moveForward", "forward");
    bindMoveButton("moveBackward", "backward");
    bindMoveButton("moveLeft", "left");
    bindMoveButton("moveRight", "right");

    $("collectBtn")?.addEventListener("pointerdown", event => {
      event.preventDefault();
      collectKey();
    });

    $("lookBtn")?.addEventListener("click", () => {
      message("Drag the screen to look around.");
    });

    $("flashlightBtn")?.addEventListener("click", toggleFlashlight);
    $("pauseBtn")?.addEventListener("click", pauseGame);
    $("resumeBtn")?.addEventListener("click", resumeGame);
    $("restartBtn")?.addEventListener("click", startGame);
    $("menuBtn")?.addEventListener("click", backToMenu);
    $("playAgainBtn")?.addEventListener("click", startGame);
    $("playBtn")?.addEventListener("click", () => {
      multiplayer = false;
      roomCode = null;
      startGame();
    });

    $("createRoomBtn")?.addEventListener("click", createRoom);
    $("joinRoomBtn")?.addEventListener("click", joinRoom);
    $("copyCodeBtn")?.addEventListener("click", () => {
      if (roomCode) {
        navigator.clipboard.writeText(roomCode).then(() => {
          menuMessage("Code copied: " + roomCode);
        }).catch(() => {
          menuMessage("Room code: " + roomCode);
        });
      }
    });

    $("startMultiplayerBtn")?.addEventListener("click", () => {
      if (socket && roomCode && isHost) socket.emit("startGame");
    });

    gameContainer?.addEventListener("pointerdown", event => {
      if (!running || paused || ended || event.target.closest("button")) return;
      lastTouchX = event.clientX;
      lastTouchY = event.clientY;
    });

    gameContainer?.addEventListener("pointermove", event => {
      if (!running || paused || ended || lastTouchX === null || lastTouchY === null) return;

      const dx = event.clientX - lastTouchX;
      const dy = event.clientY - lastTouchY;
      lastTouchX = event.clientX;
      lastTouchY = event.clientY;

      yaw -= dx * 0.004;
      pitch = Math.max(-1.25, Math.min(1.25, pitch - dy * 0.003));
      if (camera) camera.rotation.set(pitch, yaw, 0, "YXZ");
    });

    const stopLook = () => {
      lastTouchX = null;
      lastTouchY = null;
    };

    gameContainer?.addEventListener("pointerup", stopLook);
    gameContainer?.addEventListener("pointercancel", stopLook);

    window.addEventListener("keydown", event => {
      if (event.repeat) return;
      switch (event.code) {
        case "KeyW": case "ArrowUp": move.forward = true; break;
        case "KeyS": case "ArrowDown": move.backward = true; break;
        case "KeyA": case "ArrowLeft": move.left = true; break;
        case "KeyD": case "ArrowRight": move.right = true; break;
        case "KeyF": if (running && !paused) toggleFlashlight(); break;
        case "KeyE": collectKey(); break;
        case "Escape": if (running && !paused) pauseGame(); else if (paused) resumeGame(); break;
      }
    });

    window.addEventListener("keyup", event => {
      switch (event.code) {
        case "KeyW": case "ArrowUp": move.forward = false; break;
        case "KeyS": case "ArrowDown": move.backward = false; break;
        case "KeyA": case "ArrowLeft": move.left = false; break;
        case "KeyD": case "ArrowRight": move.right = false; break;
      }
    });

    window.addEventListener("blur", () => {
      Object.keys(move).forEach(k => move[k] = false);
      stopLook();
    });
  }

  // ============ Mini-Map ============
  function initMinimap() {
    minimapCanvas = $("minimap");
    if (!minimapCanvas) return;
    minimapCtx = minimapCanvas.getContext("2d");
  }

  function worldToMap(x, z) {
    const mapX = ((x + MAP_OFFSET) / WORLD_SIZE) * MINIMAP_SIZE;
    const mapZ = ((z + MAP_OFFSET) / WORLD_SIZE) * MINIMAP_SIZE;
    return { x: mapX, y: mapZ };
  }

  function drawMinimap() {
    if (!minimapCtx || !minimapCanvas) return;

    const ctx2 = minimapCtx;
    const W = MINIMAP_SIZE;
    const H = MINIMAP_SIZE;

    ctx2.clearRect(0, 0, W, H);
    ctx2.fillStyle = "rgba(10, 14, 20, 0.9)";
    ctx2.fillRect(0, 0, W, H);

    const cellSize = (CELL / WORLD_SIZE) * W;

    // الحيطان
    ctx2.fillStyle = "#424956";
    for (let r = 0; r < wallMap.length; r++) {
      for (let c = 0; c < wallMap[r].length; c++) {
        if (wallMap[r][c] !== "1") continue;
        const p = cellToWorld(r, c);
        const mp = worldToMap(p.x, p.z);
        ctx2.fillRect(
          mp.x - cellSize / 2,
          mp.y - cellSize / 2,
          cellSize,
          cellSize
        );
      }
    }

    // الوحش
    if (monsterObject) {
      const mp = worldToMap(monsterObject.position.x, monsterObject.position.z);
      ctx2.fillStyle = "#ff183f";
      ctx2.beginPath();
      ctx2.arc(mp.x, mp.y, 5, 0, Math.PI * 2);
      ctx2.fill();
    }

    // اللاعب (نتا)
    const meMp = worldToMap(player.x, player.z);
    ctx2.fillStyle = "#36b8d8";
    ctx2.beginPath();
    ctx2.arc(meMp.x, meMp.y, 5, 0, Math.PI * 2);
    ctx2.fill();

    // اتجاه النظر
    ctx2.strokeStyle = "#36b8d8";
    ctx2.lineWidth = 2;
    ctx2.beginPath();
    ctx2.moveTo(meMp.x, meMp.y);
    ctx2.lineTo(
      meMp.x + Math.sin(yaw) * 12,
      meMp.y + Math.cos(yaw) * 12
    );
    ctx2.stroke();

    // اللاعبون الآخرون (صحابك)
    for (const id in otherPlayers) {
      const p = otherPlayers[id];
      if (!p) continue;
      const mp = worldToMap(p.position.x, p.position.z);
      ctx2.fillStyle = "#a875e8";
      ctx2.beginPath();
      ctx2.arc(mp.x, mp.y, 5, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.shadowBlur = 10;
      ctx2.shadowColor = "#a875e8";
      ctx2.fill();
      ctx2.shadowBlur = 0;
    }

    // إطار
    ctx2.strokeStyle = "#6c5ce7";
    ctx2.lineWidth = 2;
    ctx2.strokeRect(0, 0, W, H);
  }

  // ============ Multiplayer ============
  function createRoom() {
    if (!socket) return menuMessage("Socket.IO is missing. Check index.html.");
    socket.emit("createRoom", playerName(), result => {
      if (!result?.ok) return menuMessage(result?.message || "Could not create room.");

      roomCode = result.code;
      isHost = true;
      multiplayer = true;

      const roomInfo = $("roomInfo");
      if (roomInfo) {
        roomInfo.classList.remove("hidden");
        const codeDisplay = $("roomCodeDisplay");
        if (codeDisplay) codeDisplay.textContent = roomCode;
      }

      $("startMultiplayerBtn")?.classList.remove("hidden");
      $("playersList")?.classList.remove("hidden");
      menuMessage("Share the code with your friends!");
    });
  }

  function joinRoom() {
    if (!socket) return menuMessage("Socket.IO is missing. Check index.html.");

    const code = ($("roomCode")?.value || "").trim().toUpperCase();
    if (!code) return menuMessage("Enter a room code.");

    socket.emit("joinRoom", { code, name: playerName() }, result => {
      if (!result?.ok) return menuMessage(result?.message || "Could not join room.");

      roomCode = result.code;
      isHost = Boolean(result.host);
      multiplayer = true;

      const roomInfo = $("roomInfo");
      if (roomInfo) {
        roomInfo.classList.remove("hidden");
        const codeDisplay = $("roomCodeDisplay");
        if (codeDisplay) codeDisplay.textContent = roomCode;
      }

      $("playersList")?.classList.remove("hidden");

      if (isHost) {
        $("startMultiplayerBtn")?.classList.remove("hidden");
        menuMessage("Room created. Start when ready.");
      } else {
        $("startMultiplayerBtn")?.classList.add("hidden");
        menuMessage("Joined! Wait for the host to start...");
      }
    });
  }

  function createOtherPlayer(id, color) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 1.2, 0.4),
      new THREE.MeshStandardMaterial({ color: color || 0x36b8d8 })
    );
    body.position.y = 0.8;

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xe0b99a })
    );
    head.position.y = 1.55;
    group.add(body, head);
    scene.add(group);
    otherPlayers[id] = group;
  }

  function updatePlayersList(players) {
    const ul = $("playersUl");
    if (!ul) return;
    ul.innerHTML = "";
    players.forEach(p => {
      const li = document.createElement("li");
      li.textContent = p.name + (p.id === socket.id ? " (you)" : "");
      li.style.color = p.color || "#fff";
      ul.appendChild(li);
    });
  }

  function setupSocketEvents() {
    if (!socket) return;

    socket.on("connect_error", () => {
      menuMessage("Cannot connect to the server. Check server.js.");
    });

    socket.on("playerJoined", data => {
      if (data?.players) updatePlayersList(data.players);
      if (data?.name && data.id !== socket.id && !data.left) {
        menuMessage(data.name + " joined the room!");
      }
    });

    socket.on("gameStarted", () => {
      menuMessage("");
      startGame();
    });

    socket.on("worldUpdate", state => {
      if (!state) return;

      const keys = state.keys || [];
      const key = keys.find(k => k.id === 1) || keys[0];

      if (key && key.found) {
        serverKeyFound = true;
        hasKey = true;
        if (keyObject) keyObject.visible = false;
        updateHUD();
      }

      if (state.monster) {
        monsterTarget = { x: state.monster.x, z: state.monster.z };
      }

      const players = state.players || {};

      if (Object.keys(players).length > 0 && $("playersList") && !$("playersList").classList.contains("hidden")) {
        updatePlayersList(Object.values(players).map(p => ({
          id: p.id,
          name: p.name,
          color: p.color
        })));
      }

      // حدّث اللاعبين الآخرين فقط (ماشي نتا)
      for (const [id, p] of Object.entries(players)) {
        if (id === socket.id) continue;
        if (!otherPlayers[id] && scene) createOtherPlayer(id, p.color);
        if (otherPlayers[id]) {
          otherPlayers[id].position.set(p.x, 0, p.z);
          otherPlayers[id].rotation.y = p.yaw || 0;
        }
      }

      // حيد اللاعبين اللي خرجو
      for (const id of Object.keys(otherPlayers)) {
        if (!players[id]) {
          scene?.remove(otherPlayers[id]);
          delete otherPlayers[id];
        }
      }
    });

    socket.on("keyCollected", data => {
      hasKey = true;
      serverKeyFound = true;
      if (keyObject) keyObject.visible = false;
      updateHUD();
      message("Key collected! Find the green exit.");
    });

    socket.on("playerCaught", id => {
      if (id !== socket.id || ended) return;
      health = Math.max(0, health - 25);
      updateHUD();
      if (health <= 0) finishGame(false);
      else message("The monster caught you! Keep moving!");
    });

    socket.on("gameWon", data => {
      finishGame(true);
      if (data?.playerName && $("endText")) {
        $("endText").textContent = data.playerName + " escaped the maze!";
      }
    });
  }

  function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  }

  window.addEventListener("resize", onResize);

  try {
    setupControls();
    setupSocketEvents();
  } catch (error) {
    showError("Controls error: " + error.message);
  }
})();
