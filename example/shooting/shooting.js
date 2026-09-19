import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import Stats from "three/examples/jsm/libs/stats.module.js";

import { createSceneSetup } from "./core/SceneSetup.js";
import { LocalPlayer } from "./player/LocalPlayer.js";
import { DecalSystem } from "./weapon/DecalSystem.js";
import { WeaponController, MODE } from "./weapon/WeaponController.js";
import { ShootingEffects } from "./weapon/effects.js";
import { HUD } from "./ui/HUD.js";
import { ZombieManager } from "./zombie/ZombieManager.js";

const base = import.meta.env.BASE_URL;

const initPos = new THREE.Vector3(33.21, 4.6, 2.6);

const NORMAL_MAX_CAM = 220;
const MOUSE_SENSITIVITY = 5;
const PLAYER_MODEL_URL = base + "./glb/swat.glb";
const FIRST_PERSON_PITCH_OFFSET_BY_MODEL = {
    [base + "./glb/swat.glb"]: Math.PI * (16 / 180),
};

async function init() {
    const container = document.querySelector("#container");

    let tiles, localPlayer, weapon, zombieManager;

    // ==================== 1. 场景基础 ====================
    const { scene, renderer, camera, controls, bakeProbes } = createSceneSetup({ container });

    // 添加音频监听器
    const listener = new THREE.AudioListener();
    camera.add(listener);

    camera.position.copy(initPos);
    camera.lookAt(initPos.x, initPos.y, initPos.z + 1);
    controls.target.set(initPos.x, initPos.y, initPos.z + 1);

    const stats = new Stats();
    Object.assign(stats.dom.style, {
        position: "fixed",
        bottom: "0px",
        left: "0px",
        top: "auto",
        zIndex: "9998",
        display: "block",
    });
    document.body.appendChild(stats.dom);

    const timer = new THREE.Timer();
    let _prevGunEngaged = false;
    renderer.setAnimationLoop(() => {
        timer.update();
        const elapsed = timer.getElapsed();
        const dt = timer.getDelta();

        if (localPlayer && weapon && zombieManager) {
            const spineIK = localPlayer.spineIK;
            const gunEngaged = weapon.isGunEngaged();

            // 开火/瞄准时切 mouseMode 5（锁定朝向跟相机），其余情况用 1
            if (gunEngaged !== _prevGunEngaged) {
                localPlayer.setThirdMouseMode(gunEngaged ? 5 : 1);
                _prevGunEngaged = gunEngaged;
            }

            // 恢复脊椎骨骼到上一帧的干净动画姿态
            if (gunEngaged) spineIK.restoreBones();

            // 驱动动画与物理（传入 dt，使上半身 mixer 与主 mixer 同步）
            localPlayer ? localPlayer.update(dt) : controls.update();

            // 应用脊椎 IK 与朝向（在 player.update() 后、weapon.update() 前）
            if (gunEngaged) {
                if (localPlayer.getIsFirstPerson()) {
                    localPlayer.applyHipsCorrection();
                    spineIK.applyAim1P(camera, localPlayer.pitchTarget1P);
                } else {
                    // console.log('应用 3P IK');
                    localPlayer.applyHipsCorrection();
                    spineIK.applyAim3P(camera, true);
                }
            }

            // 更新武器状态（特效、射线命中、连射节拍）——骨骼此时已含 IK
            weapon.update(elapsed, dt);

            // 丧尸 AI
            zombieManager.update(dt, localPlayer.getPosition());

        } else {
            controls?.update();
        }

        renderer.render(scene, camera);
        stats.update();
    });


    // ==================== 2. 资源加载器 ====================
    const gltfLoader = new GLTFLoader();

    const draco = new DRACOLoader();
    draco.setDecoderPath("https://unpkg.com/three@0.186.0/examples/jsm/libs/draco/");
    gltfLoader.setDRACOLoader(draco);

    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath("https://unpkg.com/three@0.186.0/examples/jsm/libs/basis/");
    ktx2.detectSupport(renderer);
    gltfLoader.setKTX2Loader(ktx2);

    // ==================== 3. 场景模型 ====================
    const { scene: mapScene } = await gltfLoader.loadAsync(
        base + "./glb/horror_corridor.glb"
    );
    mapScene.name = "sceneGLB";
    mapScene.scale.set(0.09, 0.09, 0.09);
    scene.add(mapScene);
    scene.updateMatrixWorld(true);
    bakeProbes();

    document.addEventListener("contextmenu", (e) => e.preventDefault());

    const playerGltf = await gltfLoader.loadAsync(PLAYER_MODEL_URL);

    // ==================== 4. 本地玩家 ====================
    localPlayer = new LocalPlayer({ scene, camera, controls });
    await localPlayer.init({
        playerModelConfig: {
            model: playerGltf.scene,
            animations: playerGltf.animations,
            scale: 0.01,
            idleAnim: "idle1",
            walkAnim: "walk",
            runAnim: "run",
            jumpAnim: "jump",
            flyAnim: "flying",
            flyIdleAnim: "flyidle",
            headBoneName: "mixamorigHead",
            firstPersonPitchOffset: FIRST_PERSON_PITCH_OFFSET_BY_MODEL[PLAYER_MODEL_URL] ?? 0,
            rotateY: - Math.PI / 2,
        },
        initPos: initPos,
        minCamDistance: 10,
        maxCamDistance: NORMAL_MAX_CAM,
        enableOverShoulderView: true,
        mouseSensitivity: MOUSE_SENSITIVITY,
        camLookAtHeightRatio: 0.9,
        keyMap: { toggleFly: null },
        colliders: [
            { motion: "static", shape: { kind: "mesh", source: mapScene } },
        ],
    });

    localPlayer.getPlayerModel()?.traverse((c) => {
        if (c.isMesh) {
            c.frustumCulled = false;
            c.castShadow = true;
            c.receiveShadow = true;
        }
    });

    // ==================== 5. HUD ====================
    const weaponSlots = [
        { key: "1", mode: "primary", label: "Rifle" },
        { key: "4", mode: "normal", label: "Fists" },
    ];
    const hud = new HUD(weaponSlots);
    hud.build();

    // ==================== 6. 特效 ====================
    let effects = new ShootingEffects(scene, {
        listener,
        flashScale: 0.15,
        smokeSize: 0.8
    });
    await effects.load(
        base + "./img/muzzle_flash.png",
        base + "./img/smoke.png",
        base + "./audio/gun_shot.mp3",
        base + "./audio/reload.mp3",
    );

    // ==================== 7. 弹痕系统 ====================
    const decalSystem = new DecalSystem(scene, 60, 0.25);
    await decalSystem.loadMaterials(["img/bullet_hole.png"], base);

    // ==================== 8. 丧尸管理器 ====================
    zombieManager = new ZombieManager(scene, {
        loader: gltfLoader,
        colliders: localPlayer.getColliderMeshes(),
        modelUrl: base + "./glb/zombie.glb",
        scale: 0.01,
        walkAnim: "walking",
        idleAnim: "Idle",
        punchAnim: "punching",
        runAnim: "running",
        rotateY: Math.PI,
        speed: 120,
    });

    // ==================== 9. 武器控制器 ====================
    weapon = new WeaponController({
        scene,
        camera,
        localPlayer,
        decalSystem,
        effects,
        hud,
        zombieManager,
    });

    await weapon.load(gltfLoader, base);
    weapon.setupAnimations();
    weapon.bindInput();
    weapon.switchMode(MODE.PRIMARY);

    // 让 LocalPlayer 的 1P 俯仰驱动能感知武器状态
    localPlayer.setGunEngagedGetter(() => weapon.isGunEngaged());

    // 初始刷新武器槽高亮
    hud.update(weapon.getMode());

    // ==================== 10. 鼠标拾取 ====================
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const getMousePickingPoint = (event) => {
        const rect = container.getBoundingClientRect();
        // 将鼠标位置归一化为设备坐标 (NDC)
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        // 检测场景中所有的物体（包含 3D Tiles 和玩家模型）
        const intersects = raycaster.intersectObjects(scene.children, true);

        if (intersects.length > 0) {
            return intersects[0].point;
        }
        return null;
    };

    container.addEventListener("mousedown", (e) => {
        // 只有当鼠标没有被锁定（非第一人称控制状态）时才执行点击拾取
        if (document.pointerLockElement !== renderer.domElement) {
            const point = getMousePickingPoint(e);
            if (point) {
                console.log("鼠标点击的 3D 坐标:", point);
                // 你可以在这里添加逻辑，比如在点击位置生成丧尸：
                // zombieManager.spawnZombie(point);
            }
        }
    });

    // ==================== 丧尸波次 ====================
    await Promise.all([
        zombieManager.startWave({ origin: new THREE.Vector3(2.012, 4.6, -0.78), count: 5, radius: 1 }),
        zombieManager.startWave({ origin: new THREE.Vector3(-3.731, 4.6, -1.824), count: 2, radius: 1 }),
        zombieManager.startWave({ origin: new THREE.Vector3(11.911, 4.6, -4.010), count: 2, radius: 1 }),
        zombieManager.startWave({ origin: new THREE.Vector3(13.567, 4.6, 7.001), count: 2, radius: 1 }),
    ]);

    window.hideLoader?.();

    // ==================== Start Screen ====================
    await new Promise((resolve) => {
        const screen = document.getElementById("start-screen");
        screen.addEventListener("mousedown", (e) => e.stopPropagation());
        screen.addEventListener("mouseup", (e) => e.stopPropagation());
        screen.addEventListener("click", (e) => e.stopPropagation());
        screen.style.display = "flex";
        document.getElementById("start-btn").addEventListener("click", () => {
            screen.remove();
            document.body.style.cursor = "none";
            document.body.requestPointerLock?.();
            resolve();
        }, { once: true });
    });

    // ==================== 窗口缩放 ====================
    window.addEventListener("resize", () => {
        const cont = document.querySelector("#container");
        if (!cont) return;
        camera.aspect = cont.clientWidth / cont.clientHeight;
        renderer.setSize(cont.clientWidth, cont.clientHeight);
        camera.updateProjectionMatrix();
    });
}

init();
