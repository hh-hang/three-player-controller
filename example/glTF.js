import {
    ACESFilmicToneMapping,
    AmbientLight,
    CircleGeometry,
    DoubleSide,
    Float32BufferAttribute,
    Timer,
    EquirectangularReflectionMapping,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    Raycaster,
    Scene,
    SphereGeometry,
    Vector2,
    Vector3,
    WebGLRenderer,
} from "three";
import { MapControls } from "three/examples/jsm/Addons.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { playerController } from "../src/PlayerController";
import { FootIK } from "../src/foot-ik";
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { CSM } from "three/examples/jsm/csm/CSM.js";
import { createVolumeCloud, disposeVolumeCloud, updateVolumeCloud } from "./volumeCloud.js";

let player;
const scene = new Scene();

let camera;
let renderer;
let controls;
let gltfLoader;
let guiParams = null;
let footIK = null;
let footIKDebugParams = null;
let gui = null;

let stats = null;
let csm = null;
let currentBlobUrl = null;
let platform = null;
let platformCloud = null;
let dynamicPlatforms = [];
const dynamicPlatformXPath = [
    new Vector3(20.94, 3.70, 14.89),
    new Vector3(-1.32, 7.65, 14.83),
    new Vector3(-19.85, 14.38, 8.77),
];
const dynamicPlatformXSegments = dynamicPlatformXPath.slice(0, -1).map((point, index) => ({
    from: point,
    to: dynamicPlatformXPath[index + 1],
    length: point.distanceTo(dynamicPlatformXPath[index + 1]),
}));
const dynamicPlatformXLength = dynamicPlatformXSegments.reduce((sum, segment) => sum + segment.length, 0);
const animTimer = new Timer();

let globalScale = 1;
let previewMesh = null;
let previewMode = false;
let previewHintEl = null;

// CSM 基准参数
const CSM_BASE = { maxFar: 30, lightNear: 0.1, lightFar: 50, lightMargin: 30, lightIntensity: 10 };
const previewRaycaster = new Raycaster();
const previewMouse = new Vector2();

const modelUrl = "./glb/crash_junction.glb";
const pos = new Vector3(21.5, 4, 15);

// 人物模型配置
function easeEndsLinearMiddle(progress, easeRatio = 0.18) {
    const ease = Math.min(Math.max(easeRatio, 0.001), 0.49);
    const maxSpeed = 1 / (1 - ease);
    if (progress < ease) return (maxSpeed * progress * progress) / (2 * ease);
    if (progress > 1 - ease) return 1 - (maxSpeed * (1 - progress) * (1 - progress)) / (2 * ease);
    return maxSpeed * (progress - ease / 2);
}

// 根据整条路径的总长度定位平台
function setPositionOnXPath(mesh, progress) {
    if (!dynamicPlatformXSegments.length || dynamicPlatformXLength <= 0) return;

    let targetDistance = progress * dynamicPlatformXLength;
    for (const segment of dynamicPlatformXSegments) {
        if (targetDistance <= segment.length) {
            mesh.position.lerpVectors(segment.from, segment.to, targetDistance / segment.length);
            return;
        }
        targetDistance -= segment.length;
    }

    mesh.position.copy(dynamicPlatformXPath[dynamicPlatformXPath.length - 1]);
}

const PLAYER_MODELS = {
    josh: {
        url: "./glb/josh.glb",
        scale: 0.001,
        idleAnim: "idle1",
        walkAnim: "walk",
        runAnim: "run",
        jumpAnim: ["jump", "Jump_Loop", "Jump_Land"],
        flyAnim: "fly",
        flyIdleAnim: "flyIdle",
        flyHoverForwardAnim: "flyHoverForward",
        flyHoverBackAnim: "flyHoverBack",
        flyHoverLeftAnim: "flyHoverLeft",
        flyHoverRightAnim: "flyHoverRight",
        flyHoverUpAnim: "flyHoverUp",
        flyHoverDownAnim: "flyHoverDown",
        drivingAnim: "Driving_Loop",
        headBoneName: "mixamorigHead",
        rotateY: Math.PI,
    },
    maw: {
        url: "./glb/maw.glb",
        scale: 0.005,
        idleAnim: "idle",
        walkAnim: "walk",
        runAnim: "run",
        jumpAnim: "jump",
        flyAnim: "flying",
        flyIdleAnim: "flyidle",
        headBoneName: "mixamorigHead",
        rotateY: Math.PI,
    },
    ual: {
        url: "./glb/ual.glb",
        scale: 0.001,
        idleAnim: "Idle_Loop",
        walkAnim: "Walk_Loop",
        runAnim: "Sprint_Loop",
        jumpAnim: ["Jump_Start", "Jump_Loop", "Jump_Land"],
        flyAnim: "fly",
        flyIdleAnim: "flyIdle",
        flyHoverForwardAnim: "flyHoverForward",
        flyHoverBackAnim: "flyHoverBack",
        flyHoverLeftAnim: "flyHoverLeft",
        flyHoverRightAnim: "flyHoverRight",
        flyHoverUpAnim: "flyHoverUp",
        flyHoverDownAnim: "flyHoverDown",
        drivingAnim: "Driving_Loop",
        headBoneName: "Head",
        rotateY: Math.PI,
        firstPersonCameraOffset: [0, 0.15, 0.12],
    },
};

// 车辆配置
const VEHICLE_TUNING = {
    followVehicleDirection: true,
    debug: { showPhysicsBox: false, showWheelRays: false, showWheelTravel: false, showWheelSpheres: false },
    chassis: {
        density: 1,
        linearDamping: 0.05,
        angularDamping: 0.5,
        clearance: 0.25,
        sizeScale: { x: 0.9, y: 0.65, z: 0.9 },
    },
    suspension: {
        restLength: 0.15,
        maxTravel: 0.15,
        stiffness: 25,
        compression: 2.1,
        relaxation: 2.5,
        maxForce: 6000,
        frictionSlip: 8,
        sideFrictionStiffness: 1,
        rollInfluence: 0.12,
    },
    steering: {
        maxSteerAngle: Math.PI / 5,
        steerTime: 0.45,
        steerReturnTimeSlow: 0.55,
        steerReturnTimeFast: 0.4,
        highSpeedSteerScale: 0.3,
    },
    grip: {
        maxG: 1.2,
        sideFrictionIdle: 1,
        sideFrictionFrontMin: 0.55,
        sideFrictionRearMin: 0.45,
        handbrakeRearFriction: 0.35,
        handbrakeRearDriveScale: 0.65,
        handbrakeReleaseTime: 0.15,
        wheelbaseRatio: 0.55,
    },
    power: {
        maxSpeed: 100,
        acceleration: 5,
        deceleration: 5,
    },
};

const VEHICLE_CONFIG = {
    url: "./glb/sedan.glb",
    scale: 0.1,
    wheelsNames: ["Wheel_LF", "Wheel_RF", "Wheel_LR", "Wheel_RR"],
    followVehicleDirection: VEHICLE_TUNING.followVehicleDirection,
    debug: VEHICLE_TUNING.debug,
    chassis: VEHICLE_TUNING.chassis,
    suspension: VEHICLE_TUNING.suspension,
    steering: VEHICLE_TUNING.steering,
    grip: VEHICLE_TUNING.grip,
    power: VEHICLE_TUNING.power,
    driverSeatPosition: new Vector3(-0.6, 1.0, 0.4),
    driverSeatRotation: -Math.PI / 2,
};

init();

function setupCSMMaterial(material) {
    if (!material || !csm) return;
    const mats = Array.isArray(material) ? material : [material];
    mats.forEach((m) => {
        csm.setupMaterial(m);
        // 材质可能已在异步加载期间编译，注入 CSM 后必须刷新 shader。
        m.needsUpdate = true;
    });
}

function createCSM(shadowMapSize, scale) {
    const c = new CSM({
        maxFar: CSM_BASE.maxFar * scale,
        cascades: 3,
        mode: "practical",
        parent: scene,
        shadowMapSize,
        shadowBias: -0.00001,
        lightDirection: new Vector3(-1, -2, -1).normalize(),
        lightIntensity: CSM_BASE.lightIntensity,
        lightNear: CSM_BASE.lightNear * scale,
        lightFar: CSM_BASE.lightFar * scale,
        camera,
        fade: true,
        lightMargin: CSM_BASE.lightMargin * scale,
    });
    c.lights.forEach((light, index) => {
        const biasMult = Math.pow(2, index);
        light.shadow.bias = -0.0001 * biasMult;
        light.shadow.normalBias = 0.002 * biasMult;
    });
    return c;
}

function recreateCSM(scale) {
    csm.remove();
    csm.dispose();
    const maxTextureSize = renderer.capabilities.maxTextureSize;
    csm = createCSM(Math.min(2048, maxTextureSize), scale);
    // 重新绑定场景内所有网格的材质
    scene.traverse((child) => {
        if (child.isMesh) setupCSMMaterial(child.material);
    });
}

function getModelScale(key) {
    return PLAYER_MODELS[key].scale * globalScale;
}

async function loadPlayerModelConfig(key) {
    const m = PLAYER_MODELS[key];
    const gltf = await gltfLoader.loadAsync(m.url);
    const { url, ...rest } = m;
    return {
        ...rest,
        model: gltf.scene,
        animations: gltf.animations,
        scale: rest.scale * globalScale,
    };
}

async function loadVehicleConfig(extra = {}) {
    const gltf = await gltfLoader.loadAsync(VEHICLE_CONFIG.url);
    const { url, ...rest } = VEHICLE_CONFIG;
    return {
        ...rest,
        model: gltf.scene,
        ...extra,
    };
}

// 加载车辆。
async function spawnSceneSedan() {
    await player.loadVehicleModel(await loadVehicleConfig({
        scale: VEHICLE_CONFIG.scale * globalScale,
        position: pos.clone().add(new Vector3(0, -0.2, -0.5)),
    }));

    const sedan = player.getAllVehicles().at(-1);
    sedan?.vehicleGroup?.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = true;
        child.receiveShadow = true;
        setupCSMMaterial(child.material);
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
            if (!material) return;
            material.metalness = 0.8;
            material.roughness = 0;
        });
    });
    applyVehicleTuning();
}

// Foot IK 使用通用骨骼名识别，模型切换后由插件自动重新绑定。
function attachFootIK() {
    const p = guiParams;
    footIK = new FootIK({
        enabled: p?.footIKEnabled ?? true,
        debug: (p?.footIKEnabled ?? true) && (p?.footIKDebug ?? false),
        maxPelvisRaise: p?.maxPelvisRaise ?? 36,
        maxPelvisDrop: p?.maxPelvisDrop ?? 36,
        maxFootRaise: p?.maxFootRaise ?? 60,
        maxFootDrop: p?.maxFootDrop ?? 36,
        soleHalfWidth: p?.soleHalfWidth ?? 7,
        soleToeExtend: p?.soleToeExtend ?? 7,
        soleHeelExtend: p?.soleHeelExtend ?? 3,
        soleSkinThickness: p?.soleSkinThickness ?? 1.6,
        straightPoleEnabled: p?.straightPoleEnabled ?? true,
    });
    player.use(footIK);
    if (p) footIKDebugParams = p;
}

/** 动态球视觉 */
function createDemoSphereMesh(color = 0x88c0d0) {
    const geo = new SphereGeometry(1, 24, 16);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const band = Math.sin(x * 8 + y * 2) > 0;
        const dark = band ? 0.35 : 1;
        colors[i * 3] = r * dark;
        colors[i * 3 + 1] = g * dark;
        colors[i * 3 + 2] = b * dark;
    }
    geo.setAttribute("color", new Float32BufferAttribute(colors, 3));
    const mesh = new Mesh(
        geo,
        new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

// 创建动态平台
function createDynamicPlatform({
    position,
    radius = 0.16,
    cloudScale = [0.32, 0.15, 0.32],
    motion = null,
}) {
    // 网格
    const mesh = new Mesh(
        new CircleGeometry(radius, 32),
        new MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.7, metalness: 0, roughness: 0.5, side: DoubleSide }),
    );
    mesh.position.copy(position);
    mesh.rotation.x = -Math.PI / 2;
    mesh.material.visible = false;
    scene.add(mesh);
    player.addCollider({
        motion: "kinematic",
        shape: { kind: "mesh", source: mesh },
        follow: mesh,
    });

    // 体积云
    const cloud = createVolumeCloud({
        scale: cloudScale,
        opacity: 0.28,
        steps: 80,
    });
    cloud.position.set(0, 0, 0);
    cloud.rotation.x = Math.PI / 2;
    mesh.add(cloud);

    // 缓存数据
    const entry = {
        mesh,
        cloud,
        basePosition: position.clone(),
        motion,
    };
    dynamicPlatforms.push(entry);
    return entry;
}

// 更新动态平台
function updateDynamicPlatforms() {
    const t = animTimer.getElapsed();
    dynamicPlatforms.forEach((entry) => {
        const { mesh, basePosition, motion, cloud } = entry;
        if (motion) {
            // 还原基点
            if (motion.axis === "y") {
                mesh.position.copy(basePosition);
                const amount = Math.sin(t * motion.speed) * motion.distance;
                // 纵向往返
                mesh.position.y = basePosition.y + amount + motion.distance;
            } else if (motion.axis === "x") {
                if (player.getActiveKinematicCollider()?.source === mesh && player.getIsOnGround()) {
                    entry.motionElapsed = (entry.motionElapsed ?? 0) + player.getCurrentDelta();

                    const phase = (entry.motionElapsed * motion.speed / Math.PI) % 2;
                    const rawProgress = phase <= 1 ? phase : 2 - phase;
                    const progress = easeEndsLinearMiddle(rawProgress);

                    setPositionOnXPath(mesh, progress);
                }
            }
        }
        // 更新体积云
        updateVolumeCloud(cloud, camera);
    });
}

// 移除平台
function removeDynamicPlatforms() {
    dynamicPlatforms.forEach(({ mesh, cloud }) => {
        // 清理碰撞
        player?.removeKinematicCollider(mesh);
        disposeVolumeCloud(cloud);
        scene.remove(mesh);
    });
    dynamicPlatforms = [];
    platform = null;
    platformCloud = null;
}

async function init() {
    const cont = document.querySelector("#container");

    // 渲染器
    renderer = new WebGLRenderer({ antialias: true });
    renderer.setSize(cont.clientWidth, cont.clientHeight);
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setAnimationLoop(animate);
    cont.appendChild(renderer.domElement);

    // 相机
    camera = new PerspectiveCamera(60, cont.clientWidth / cont.clientHeight, 0.01, 1000);
    camera.position.copy(pos);
    camera.lookAt(pos.x, pos.y, pos.z + 1);

    // 控制器
    controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxDistance = 2000;
    controls.dampingFactor = 0.1;
    controls.rotateSpeed = 1;
    controls.maxPolarAngle = Math.PI / 2;
    controls.target.set(pos.x, pos.y, pos.z + 1);

    const maxTextureSize = renderer.capabilities.maxTextureSize;
    const shadowMapSize = Math.min(2048, maxTextureSize);
    // 级联阴影
    csm = createCSM(shadowMapSize, 1);
    csm.lights.forEach((light, index) => {
        const biasMult = Math.pow(2, index);
        light.shadow.bias = -0.0001 * biasMult;
        light.shadow.normalBias = 0.002 * biasMult;
    });

    // 环境光
    const ambient = new AmbientLight(0xffffff, 5);
    scene.add(ambient);

    // 背景
    new HDRLoader().load(
        "./img/env.hdr",
        (texture) => {
            texture.mapping = EquirectangularReflectionMapping;
            scene.background = texture;
        },
        undefined,
        (err) => console.warn("HDR 加载失败：", err)
    );

    // 帧率显示
    stats = new Stats();
    Object.assign(stats.dom.style, {
        position: "fixed",
        bottom: "0",
        left: "0",
        top: "auto",
        zIndex: "9998",
    });
    document.body.appendChild(stats.dom);

    // 加载场景
    initGltfLoader();
    const sceneModel = await initGLBScene(modelUrl);
    renderer.render(scene, camera);

    // 人物控制器
    player = new playerController();
    await player.init({
        scene,
        camera,
        controls,
        playerModelConfig: {
            ...(await loadPlayerModelConfig("josh")),
            speed: 150,
            runSpeed: 600,
        },
        initPos: pos,
        minCamDistance: 8,
        maxCamDistance: 300,
        camLookAtHeightRatio: 0.5,
        enableSpringCamera: true,
        springCameraTime: 0.1,
        enableOverShoulderView: true,
        camOverShoulderOffsetRatio: 0,
        enableZoom: true,
        colliders: [
            { motion: "static", shape: { kind: "mesh", source: sceneModel } },
        ],
    });
    attachFootIK();

    // 先完成角色材质的 CSM 注入，避免等待车辆时用非 CSM shader 提前编译。
    player.getPlayerModel()?.traverse((child) => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            setupCSMMaterial(child.material);
        }
    });

    await spawnSceneSedan();

    // 创建动态平台
    const liftPlatform = createDynamicPlatform({
        position: new Vector3(22, 2.76, 9.7),
        motion: { axis: "y", distance: 4, speed: 0.5 },
    });
    platform = liftPlatform.mesh;
    platformCloud = liftPlatform.cloud;

    createDynamicPlatform({
        position: dynamicPlatformXPath[0],
        motion: { axis: "x", distance: 3, speed: 0.1 },
    });

    // 调试
    initGUI();

    window.addEventListener("keydown", (e) => {
        if (e.code !== "KeyR" || e.repeat) return;
        player.resetVehicle();
    });

    window.addEventListener("resize", onWindowResize, false);

    // 关闭加载页面
    window.hideLoader();
}

// 初始化glb加载器
function initGltfLoader() {
    gltfLoader = new GLTFLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("https://unpkg.com/three@0.180.0/examples/jsm/libs/draco/");
    gltfLoader.setDRACOLoader(dracoLoader);
    const ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath("https://unpkg.com/three@0.180.0/examples/jsm/libs/basis/");
    ktx2Loader.detectSupport(renderer);
    gltfLoader.setKTX2Loader(ktx2Loader);
}

// 加载场景
async function initGLBScene(url, modelScale = [10, 10, 10]) {
    try {
        const gltf = await gltfLoader.loadAsync(url);
        const model = gltf.scene;
        model.name = "sceneGLB";
        model.scale.set(...modelScale);
        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                setupCSMMaterial(child.material);
            }
        });
        scene.add(model);
        return model;
    } catch (e) {
        console.error("GLB 加载失败：", e);
        return null;
    }
}

// 更换场景
async function replaceScene(file) {
    const blobUrl = URL.createObjectURL(file);

    // 退出指针锁定
    if (document.pointerLockElement) {
        await new Promise((resolve) => {
            document.addEventListener("pointerlockchange", resolve, { once: true });
            document.exitPointerLock();
        });
    }

    // 移除旧场景并释放 GPU 资源
    const old = scene.getObjectByName("sceneGLB");
    if (old) {
        old.traverse((child) => {
            if (child.isMesh) {
                child.geometry?.dispose();
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m) => m?.dispose());
            }
        });
        scene.remove(old);
    }

    // 销毁旧玩家
    removeDynamicPlatforms();
    player?.destroy();
    player = null;
    footIK = null;
    footIKDebugParams = null;

    // 加载新场景
    await initGLBScene(blobUrl, [1, 1, 1]);

    // 释放上一个 blob URL，保存新的
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = blobUrl;

    // 进入预览模式
    await enterPreviewMode(guiParams?.playerModel ?? "josh");
}

// 进入预览模式
async function enterPreviewMode(playerModelKey) {
    previewMode = true;

    const modelConfig = PLAYER_MODELS[playerModelKey];
    const gltf = await gltfLoader.loadAsync(modelConfig.url);
    previewMesh = gltf.scene;
    previewMesh.scale.setScalar(modelConfig.scale * globalScale);
    previewMesh.visible = false;
    previewMesh.traverse((child) => {
        if (child.isMesh) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
                m.transparent = true;
                m.opacity = 0.5;
                m.depthWrite = false;
            });
        }
    });
    scene.add(previewMesh);

    if (!previewHintEl) {
        previewHintEl = document.createElement("div");
        Object.assign(previewHintEl.style, {
            position: "fixed", bottom: "20px", left: "50%",
            transform: "translateX(-50%)", background: "rgba(0,0,0,0.65)",
            color: "#fff", padding: "12px 24px", borderRadius: "8px",
            fontSize: "14px", zIndex: "9999", textAlign: "center",
            display: "flex", flexDirection: "column", alignItems: "center", gap: "8px",
        });
        const tip = document.createElement("span");
        tip.textContent = "移动鼠标预览人物位置 · 双击确认放置";
        const sliderRow = document.createElement("div");
        Object.assign(sliderRow.style, { display: "flex", alignItems: "center", gap: "8px" });
        const label = document.createElement("span");
        label.textContent = "人物比例：";
        // 对数刻度：slider在log10空间线性滑动，0.01~1000 各数量级间距相同
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "-2";   // log10(0.01)
        slider.max = "3";    // log10(1000)
        slider.step = "0.01";
        slider.value = String(Math.log10(globalScale));
        slider.style.width = "160px";
        const sliderVal = document.createElement("span");
        sliderVal.textContent = globalScale.toFixed(2);
        slider.addEventListener("input", () => {
            globalScale = Math.pow(10, parseFloat(slider.value));
            sliderVal.textContent = globalScale.toFixed(2);
            if (previewMesh) {
                previewMesh.scale.setScalar(modelConfig.scale * globalScale);
            }
        });
        sliderRow.append(label, slider, sliderVal);
        previewHintEl.append(tip, sliderRow);
        document.body.appendChild(previewHintEl);
    } else {
        // 重置滑块值
        const slider = previewHintEl.querySelector("input[type=range]");
        const sliderVal = previewHintEl.querySelector("span:last-child");
        if (slider) { slider.value = String(Math.log10(globalScale)); }
        if (sliderVal) { sliderVal.textContent = globalScale.toFixed(2); }
    }
    previewHintEl.style.display = "flex";

    renderer.domElement.addEventListener("mousemove", onPreviewMouseMove);
    renderer.domElement.addEventListener("dblclick", onPreviewDblClick);
}

// 退出预览模式
function exitPreviewMode() {
    previewMode = false;
    controls.enableZoom = true;

    if (previewMesh) {
        previewMesh.traverse((child) => {
            if (child.isMesh) {
                child.geometry?.dispose();
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m) => m?.dispose());
            }
        });
        scene.remove(previewMesh);
        previewMesh = null;
    }

    if (previewHintEl) previewHintEl.style.display = "none";

    renderer.domElement.removeEventListener("mousemove", onPreviewMouseMove);
    renderer.domElement.removeEventListener("dblclick", onPreviewDblClick);
}

// 预览：鼠标移动 → 射线交点跟随
function onPreviewMouseMove(e) {
    if (!previewMode || !previewMesh) return;
    previewMouse.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
    );
    previewRaycaster.setFromCamera(previewMouse, camera);
    const sceneModel = scene.getObjectByName("sceneGLB");
    if (!sceneModel) return;
    const hits = previewRaycaster.intersectObject(sceneModel, true);
    if (hits.length > 0) {
        previewMesh.position.copy(hits[0].point);
        previewMesh.visible = true;
    } else {
        previewMesh.visible = false;
    }
}

// 预览：双击 → 确认位置，初始化玩家
async function onPreviewDblClick() {
    if (!previewMode || !previewMesh?.visible) return;
    const initPos = previewMesh.position.clone();
    const spawnKey = guiParams?.playerModel ?? "josh";
    const spawnScale = getModelScale(spawnKey);
    initPos.y += 180 * spawnScale * 0.75;
    exitPreviewMode();

    recreateCSM(globalScale);

    player = new playerController();
    const sceneModel = scene.getObjectByName("sceneGLB");
    await player.init({
        scene,
        camera,
        controls,
        playerModelConfig: {
            ...(await loadPlayerModelConfig(spawnKey)),
            speed: guiParams?.playerSpeed ?? 150,
            runSpeed: guiParams?.playerRunSpeed ?? 600,
        },
        initPos,
        minCamDistance: guiParams?.minCamDistance ?? 8,
        maxCamDistance: guiParams?.maxCamDistance ?? 300,
        camLookAtHeightRatio: guiParams?.camLookAtHeightRatio ?? 0.5,
        enableSpringCamera: guiParams?.enableSpringCamera ?? true,
        springCameraTime: guiParams?.springCameraTime ?? 0.1,
        enableOverShoulderView: guiParams?.enableOverShoulderView ?? true,
        camOverShoulderOffsetRatio: guiParams?.camOverShoulderOffsetRatio ?? 0,
        thirdMouseMode: guiParams?.thirdMouseMode ?? 1,
        enableZoom: guiParams?.enableZoom ?? true,
        colliders: [
            { motion: "static", shape: { kind: "mesh", source: sceneModel } },
        ],
    });
    attachFootIK();

    player.getPlayerModel()?.traverse((child) => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            setupCSMMaterial(child.material);
        }
    });
}

// 每帧调用
function animate(timestamp) {
    animTimer.update(timestamp);

    if (player) {
        player.update();
    } else {
        controls.update();
    }

    updateDynamicPlatforms();

    csm?.update();
    updateFootIKDebugPanel();

    renderer.render(scene, camera);

    stats?.update();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio * 1);
}

// 调试
function applyVehicleTuning() {
    const t = VEHICLE_TUNING;
    const vehicles = player?.getAllVehicles?.() ?? [];
    for (const v of vehicles) {
        player?.setVehicleChassisSizeScale?.(v, t.chassis.sizeScale);
        player?.setVehicleClearance?.(v, t.chassis.clearance);
        const he = v.halfExtents;
        const volume = 8 * he.x * he.y * he.z;
        v.chassisBody.setMass(volume * Math.max(1e-8, t.chassis.density));
        v.chassisBody.linearDamping = t.chassis.linearDamping;
        v.chassisBody.angularDamping = t.chassis.angularDamping;

        Object.assign(v.steering, t.steering);
        Object.assign(v.grip, t.grip);
        v.maxSpeed = t.power.maxSpeed * v.scale;
        v.acceleration = t.power.acceleration * v.scale;
        v.deceleration = t.power.deceleration * v.scale;
        v.followVehicleDirection = t.followVehicleDirection;

        const sus = t.suspension;
        const staticSag = 9.81 * v.scale / (4 * Math.max(1e-4, sus.stiffness));
        const rest = Math.max(sus.restLength * v.scale, staticSag * 1.2);
        v.sideFrictionStiffness = sus.sideFrictionStiffness;

        const wheelCount = v.vehicleController.numWheels();
        for (let i = 0; i < wheelCount; i++) {
            v.vehicleController.setWheelSuspensionRestLength(i, rest);
            v.vehicleController.setWheelMaxSuspensionTravel(i, sus.maxTravel * v.scale);
            v.vehicleController.setWheelSuspensionStiffness(i, sus.stiffness);
            v.vehicleController.setWheelSuspensionCompression(i, sus.compression);
            v.vehicleController.setWheelSuspensionRelaxation(i, sus.relaxation);
            v.vehicleController.setWheelMaxSuspensionForce(i, sus.maxForce);
            v.vehicleController.setWheelFrictionSlip(i, sus.frictionSlip);
            v.vehicleController.setWheelSideFrictionStiffness(i, sus.sideFrictionStiffness);
            v.vehicleController.setWheelRollInfluence(i, sus.rollInfluence);
        }

        if (v.physicsBoxMesh) {
            if (t.debug.showPhysicsBox) v.vehicleGroup.add(v.physicsBoxMesh);
            else v.vehicleGroup.remove(v.physicsBoxMesh);
        }
        if (v.wheelRayDebug) v.wheelRayDebug.visible = t.debug.showWheelRays;
        if (v.wheelTravelDebug) v.wheelTravelDebug.visible = t.debug.showWheelTravel;
        if (v.wheelSphereDebug) v.wheelSphereDebug.visible = t.debug.showWheelSpheres;
    }
    if (player?.vehicle?.params?.debug) {
        Object.assign(player.vehicle.params.debug, t.debug);
    }
}

function initGUI() {
    const options = footIK.getOptions();
    const playerScale = player.playerModelConfig.scale;
    const toBasePlayerValue = (value) => value / playerScale;
    const params = {
        playerModel: "josh",
        showShadow: renderer.shadowMap.enabled,
        colliderDebug: false,
        playerCapsuleDebug: false,
        mouseSensitivity: player.cam.sensitivity,
        gravity: toBasePlayerValue(player.gravity),
        jumpHeight: toBasePlayerValue(player.jumpHeight),
        playerSpeed: toBasePlayerValue(player.playerSpeed),
        playerRunSpeed: toBasePlayerValue(player.playerRunSpeed),
        flySpeed: toBasePlayerValue(player.playerFlySpeed),
        playerAcceleration: player.playerAcceleration,
        playerDeceleration: player.playerDeceleration,
        timeScale: player.timeScale,
        minCamDistance: toBasePlayerValue(player.cam.minDist),
        maxCamDistance: toBasePlayerValue(player.cam.maxDist),
        camLookAtHeightRatio: player.cam.lookAtHeightRatio,
        enableOverShoulderView: player.enableOverShoulderView,
        camOverShoulderOffsetRatio: player.cam.overShoulderOffsetRatio,
        enableSpringCamera: player.cam.enableSpringCamera,
        springCameraTime: player.cam.springCameraTime,
        thirdMouseMode: player.cam.mouseMode,
        enableZoom: player.cam.zoomEnabled,
        footIKEnabled: options.enabled,
        footIKDebug: options.debug,
        straightPoleEnabled: options.straightPoleEnabled,
        leftFootPhase: "",
        leftFootLand: "--",
        leftFootIKWeight: 0,
        rightFootPhase: "",
        rightFootLand: "--",
        rightFootIKWeight: 0,
        maxPelvisRaise: options.maxPelvisRaise,
        maxPelvisDrop: options.maxPelvisDrop,
        maxFootRaise: options.maxFootRaise,
        maxFootDrop: options.maxFootDrop,
        soleHalfWidth: options.soleHalfWidth,
        soleToeExtend: options.soleToeExtend,
        soleHeelExtend: options.soleHeelExtend,
        soleSkinThickness: options.soleSkinThickness,
        maxSteerDeg: VEHICLE_TUNING.steering.maxSteerAngle * 180 / Math.PI,
    };
    guiParams = params;
    footIKDebugParams = params;

    const applyFootIKOptions = (options) => footIK?.configure(options);

    gui = new GUI({ title: "Showcase Controls", width: 320 });
    Object.assign(gui.domElement.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        maxHeight: "calc(100vh - 24px)",
        overflowY: "auto",
    });
    gui.domElement.addEventListener("pointerdown", (event) => event.stopPropagation());

    const sceneFolder = gui.addFolder("Scene");
    sceneFolder.add(params, "playerModel", Object.keys(PLAYER_MODELS))
        .name("Character Model")
        .onChange(async (modelKey) => {
            await player?.switchPlayerModel(await loadPlayerModelConfig(modelKey));
            player?.getPlayerModel()?.traverse((child) => {
                if (!child.isMesh) return;
                child.castShadow = true;
                child.receiveShadow = true;
                setupCSMMaterial(child.material);
                if (modelKey !== "ual") return;
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach((material) => {
                    if (!material) return;
                    material.metalness = 0.8;
                    material.roughness = 0;
                });
            });
        });
    sceneFolder.add(params, "showShadow").name("Shadows").onChange((value) => {
        renderer.shadowMap.enabled = value;
        scene.traverse((child) => {
            if (!child.isMesh) return;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach((material) => {
                if (material) material.needsUpdate = true;
            });
        });
    });
    sceneFolder.open();

    const collisionFolder = gui.addFolder("Collision Debug");
    collisionFolder.add(params, "colliderDebug").name("Static / Kinematic Meshes").onChange((value) => {
        player?.setColliderDebug(value);
    });
    collisionFolder.open();

    const characterFolder = gui.addFolder("Character");
    characterFolder.add(params, "playerCapsuleDebug").name("Capsule").onChange((value) => {
        player?.setPlayerCapsuleDebug?.(value);
    });

    const movementFolder = characterFolder.addFolder("Movement");
    movementFolder.add(params, "gravity", -6000, 0, 50).name("Gravity").decimals(0).onChange((value) => player?.setGravity(value));
    movementFolder.add(params, "jumpHeight", 0, 2000, 10).name("Jump Height").decimals(0).onChange((value) => player?.setJumpHeight(value));
    movementFolder.add(params, "playerSpeed", 0, 20000, 10).name("Walk Speed").decimals(0).onChange((value) => player?.setPlayerSpeed(value));
    movementFolder.add(params, "playerRunSpeed", 0, 20000, 10).name("Run Speed").decimals(0).onChange((value) => player?.setPlayerRunSpeed(value));
    movementFolder.add(params, "flySpeed", 0, 20000, 10).name("Fly Speed").decimals(0).onChange((value) => player?.setPlayerFlySpeed(value));
    movementFolder.add(params, "playerAcceleration", 1, 20000, 1).name("Acceleration").decimals(0).onChange((value) => {
        if (player) player.playerAcceleration = value;
    });
    movementFolder.add(params, "playerDeceleration", 1, 20000, 1).name("Deceleration").decimals(0).onChange((value) => {
        if (player) player.playerDeceleration = value;
    });
    movementFolder.add(params, "timeScale", 0, 3, 0.05).name("Time Scale").decimals(2).onChange((value) => {
        if (player) player.timeScale = value;
    });
    movementFolder.close();

    const characterCameraFolder = characterFolder.addFolder("Camera");
    characterCameraFolder.add(params, "mouseSensitivity", 1, 20, 0.1).name("Mouse Sensitivity").decimals(1).onChange((value) => player?.setMouseSensitivity(value));
    characterCameraFolder.add(params, "minCamDistance", 0, 200, 1).name("Min Distance").decimals(0).onChange((value) => player?.setMinCamDistance(value));
    characterCameraFolder.add(params, "maxCamDistance", 50, 1000, 1).name("Max Distance").decimals(0).onChange((value) => player?.setMaxCamDistance(value));
    characterCameraFolder.add(params, "camLookAtHeightRatio", 0, 1, 0.01).name("Look-at Height Ratio").decimals(2).onChange((value) => player?.setCamLookAtHeightRatio(value));
    characterCameraFolder.add(params, "enableOverShoulderView").name("Over-Shoulder View").onChange((value) => player?.setOverShoulderView(value));
    characterCameraFolder.add(params, "camOverShoulderOffsetRatio", -0.2, 0.2, 0.01).name("Over-Shoulder Offset").decimals(2).onChange((value) => player?.setCamOverShoulderOffsetRatio(value));
    characterCameraFolder.add(params, "enableSpringCamera").name("Spring Camera").onChange((value) => {
        if (player) player.cam.enableSpringCamera = value;
    });
    characterCameraFolder.add(params, "springCameraTime", 0.01, 1, 0.01).name("Spring Time").decimals(2).onChange((value) => {
        if (player) player.cam.springCameraTime = value;
    });
    characterCameraFolder.add(params, "thirdMouseMode", { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }).name("Mouse Mode").onChange((value) => player?.setThirdMouseMode(Number(value)));
    characterCameraFolder.add(params, "enableZoom").name("Enable Zoom").onChange((value) => player?.setEnableZoom(value));
    characterCameraFolder.close();

    const footIKFolder = characterFolder.addFolder("Foot IK");
    footIKFolder.add(params, "footIKEnabled").name("Enabled").onChange((value) => {
        footIK?.setEnabled(value);
        footIK?.setDebugEnabled(value && params.footIKDebug);
    });
    footIKFolder.add(params, "footIKDebug").name("Debug Markers").onChange((value) => {
        footIK?.setDebugEnabled(value && params.footIKEnabled);
    });
    footIKFolder.add(params, "straightPoleEnabled").name("Straight Pole").onChange((value) => {
        applyFootIKOptions({ straightPoleEnabled: value });
    });

    const footIKRuntimeFolder = footIKFolder.addFolder("Runtime");
    footIKRuntimeFolder.add(params, "leftFootPhase").name("Left Phase").listen().disable();
    footIKRuntimeFolder.add(params, "leftFootLand").name("Left Land").listen().disable();
    footIKRuntimeFolder.add(params, "leftFootIKWeight").name("Left IK Weight").decimals(3).listen().disable();
    footIKRuntimeFolder.add(params, "rightFootPhase").name("Right Phase").listen().disable();
    footIKRuntimeFolder.add(params, "rightFootLand").name("Right Land").listen().disable();
    footIKRuntimeFolder.add(params, "rightFootIKWeight").name("Right IK Weight").decimals(3).listen().disable();
    footIKRuntimeFolder.close();

    const pelvisFolder = footIKFolder.addFolder("Pelvis");
    pelvisFolder.add(params, "maxPelvisRaise", 0, 60, 1).name("Max Raise").decimals(0).onChange((value) => applyFootIKOptions({ maxPelvisRaise: value }));
    pelvisFolder.add(params, "maxPelvisDrop", 0, 60, 1).name("Max Drop").decimals(0).onChange((value) => applyFootIKOptions({ maxPelvisDrop: value }));
    pelvisFolder.close();

    const footReachFolder = footIKFolder.addFolder("Foot Reach");
    footReachFolder.add(params, "maxFootRaise", 0, 60, 1).name("Max Raise").decimals(0).onChange((value) => applyFootIKOptions({ maxFootRaise: value }));
    footReachFolder.add(params, "maxFootDrop", 0, 60, 1).name("Max Drop").decimals(0).onChange((value) => applyFootIKOptions({ maxFootDrop: value }));
    footReachFolder.close();

    const soleFolder = footIKFolder.addFolder("Sole Layout");
    soleFolder.add(params, "soleHalfWidth", 0, 24, 0.1).name("Half Width").decimals(1).onChange((value) => applyFootIKOptions({ soleHalfWidth: value }));
    soleFolder.add(params, "soleToeExtend", 0, 24, 0.1).name("Toe Extend").decimals(1).onChange((value) => applyFootIKOptions({ soleToeExtend: value }));
    soleFolder.add(params, "soleHeelExtend", 0, 24, 0.1).name("Heel Extend").decimals(1).onChange((value) => applyFootIKOptions({ soleHeelExtend: value }));
    soleFolder.add(params, "soleSkinThickness", 0, 16, 0.1).name("Skin Thickness").decimals(1).onChange((value) => applyFootIKOptions({ soleSkinThickness: value }));
    soleFolder.close();
    footIKFolder.close();
    characterFolder.open();

    const t = VEHICLE_TUNING;
    const vehicleFolder = gui.addFolder("Vehicle");

    const chassisFolder = vehicleFolder.addFolder("Chassis");
    chassisFolder.add(t.chassis, "clearance", 0, 2, 0.05).name("Clearance").decimals(2).onChange(applyVehicleTuning);
    chassisFolder.add(t.chassis.sizeScale, "x", 0.1, 1.5, 0.05).name("Size Scale X").decimals(2).onChange(applyVehicleTuning);
    chassisFolder.add(t.chassis.sizeScale, "y", 0.1, 1.5, 0.05).name("Size Scale Y").decimals(2).onChange(applyVehicleTuning);
    chassisFolder.add(t.chassis.sizeScale, "z", 0.1, 1.5, 0.05).name("Size Scale Z").decimals(2).onChange(applyVehicleTuning);
    chassisFolder.close();

    const vehicleCameraFolder = vehicleFolder.addFolder("Camera");
    vehicleCameraFolder.add(t, "followVehicleDirection").name("Follow Vehicle Heading").onChange(applyVehicleTuning);
    vehicleCameraFolder.close();

    const vehicleDebugFolder = vehicleFolder.addFolder("Debug");
    vehicleDebugFolder.add(t.debug, "showPhysicsBox").name("Chassis Collider").onChange(applyVehicleTuning);
    vehicleDebugFolder.add(t.debug, "showWheelRays").name("Wheel Rays").onChange(applyVehicleTuning);
    vehicleDebugFolder.add(t.debug, "showWheelTravel").name("Suspension Travel").onChange(applyVehicleTuning);
    vehicleDebugFolder.add(t.debug, "showWheelSpheres").name("Wheel Colliders").onChange(applyVehicleTuning);
    vehicleDebugFolder.close();

    const drivingFolder = vehicleFolder.addFolder("Driving");
    drivingFolder.add(t.power, "maxSpeed", 0, 200, 1).name("Max Speed").onChange(applyVehicleTuning);
    drivingFolder.add(t.power, "acceleration", 0, 10, 0.1).name("Acceleration").onChange(applyVehicleTuning);
    drivingFolder.add(t.power, "deceleration", 0, 10, 0.1).name("Braking Deceleration").onChange(applyVehicleTuning);
    drivingFolder.close();

    const handlingFolder = vehicleFolder.addFolder("Handling");
    handlingFolder.add(params, "maxSteerDeg", 5, 60, 0.5).name("Max Steering Angle (deg)").onChange((degrees) => {
        t.steering.maxSteerAngle = degrees * Math.PI / 180;
        applyVehicleTuning();
    });
    handlingFolder.add(t.steering, "steerTime", 0.1, 1.5, 0.05).name("Steering Response Time").decimals(2).onChange(applyVehicleTuning);
    handlingFolder.add(t.steering, "highSpeedSteerScale", 0.1, 1, 0.01).name("High-Speed Steering Scale").decimals(2).onChange(applyVehicleTuning);
    handlingFolder.add(t.grip, "maxG", 0.1, 3, 0.05).name("Max Lateral G").onChange(applyVehicleTuning);
    handlingFolder.close();

    const suspensionFolder = vehicleFolder.addFolder("Suspension");
    suspensionFolder.add(t.suspension, "restLength", 0.05, 0.5, 0.01).name("Rest Length").decimals(2).onChange(applyVehicleTuning);
    suspensionFolder.add(t.suspension, "maxTravel", 0.05, 0.5, 0.01).name("Max Travel").decimals(2).onChange(applyVehicleTuning);
    suspensionFolder.add(t.suspension, "stiffness", 0.1, 50, 0.1).name("Stiffness").decimals(1).onChange(applyVehicleTuning);
    suspensionFolder.close();

    vehicleFolder.open();
}

function updateFootIKDebugPanel() {
    if (!footIK || !footIKDebugParams) return;
    footIKDebugParams.leftFootPhase = footIK.getFootPhaseDebugText("left");
    footIKDebugParams.leftFootLand = formatFootLandTime(footIK.getFootTimeToLand("left"));
    footIKDebugParams.leftFootIKWeight = footIK.getFootIKWeight("left");
    footIKDebugParams.rightFootPhase = footIK.getFootPhaseDebugText("right");
    footIKDebugParams.rightFootLand = formatFootLandTime(footIK.getFootTimeToLand("right"));
    footIKDebugParams.rightFootIKWeight = footIK.getFootIKWeight("right");
}

function formatFootLandTime(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)}s` : "--";
}
