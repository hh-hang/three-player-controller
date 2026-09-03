import {
    ACESFilmicToneMapping,
    AmbientLight,
    BoxGeometry,
    BufferGeometry,
    Timer,
    Color,
    CylinderGeometry,
    DirectionalLight,
    DoubleSide,
    ExtrudeGeometry,
    Float32BufferAttribute,
    Group,
    Matrix4,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    PlaneGeometry,
    RepeatWrapping,
    ShaderMaterial,
    Shape,
    SphereGeometry,
    SRGBColorSpace,
    Scene,
    TextureLoader,
    VSMShadowMap,
    Vector3,
    WebGLRenderer,
} from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { MapControls } from "three/examples/jsm/Addons.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import Stats from "three/examples/jsm/libs/stats.module.js";
import { playerController } from "../src/PlayerController";
import { FootIK } from "../src/foot-ik";

const TILE_SIZE = 1;
const SLOPE_ANGLES = [20, 30, 40];

const DECK_Y = -0.06;
const DECK_THICK = 0.12;

// 车辆停放（仅大场景）
const VEHICLE_SPAWNS = [
    new Vector3(-1, 0, -11),
    new Vector3(-1, 0, 11),
];

// 车辆调参（加载与 GUI 共用）
const VEHICLE_TUNING = {
    followVehicleDirection: true,
    debug: { showPhysicsBox: false, showWheelRays: false, showWheelTravel: false, showWheelSpheres: false },
    chassis: {
        density: 1,
        linearDamping: 0.05,
        angularDamping: 0.5,
        clearance: 0.8,
        sizeScale: { x: 0.9, y: 0.55, z: 0.9 },
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

// 半埋障碍带
const OBSTACLE_X0 = -9;
const OBSTACLE_COUNT = 6;
const OBSTACLE_SPACING = 1.8;

const PROP_SPHERE_R = 0.2;
const ACCENT_GRAY = 0xc8c8c8;
const PROP_GRID = 4;
const PROP_BOX_SIZE = 0.38;
const PROP_ACCENT_COLOR = 0x7eb0d4;

const KINE_SHUTTLE_SPEED = 0.9;
const KINE_SPIN_SPEED = 0.35;
const STATIC_STRIP_COUNT = 6;
const STATIC_STRIP_GAP_RADIUS_RATIO = 0.5;
const STATIC_STRIP_DEPTH_RADIUS_RATIO = 3;

const MINI_SCALE = 0.1; // 小场景相对大场景的比例
const PLAYER_SCALE_NORMAL = 0.005; // 大场景人物缩放
const VEHICLE_SCALE_NORMAL = 0.5; // 大场景车辆缩放
// 梯形连接段长度：相对宽端开口宽度（宽矩形 / 收腰）
const TRAP_WIDE_LEN_RATIO = 0.45;
const TRAP_SLOPE_LEN_RATIO = 0.4;
// 收腰段：青通道 tint
const TRAP_TINT_COLOR = 0x88c8e0;

// 按比例生成场景布局
function createShowcaseLayout(scale = 1) {
    const s = scale;
    return {
        scale: s,
        platform: { x: -5 * s, z: 0, sizeX: 30 * s, sizeZ: 28 * s },
        wallH: 2.0 * s,
        wallT: 0.35 * s,
        deckY: DECK_Y * s,
        deckThick: DECK_THICK * s,
        l1Top: 1.2 * s,
        obstacleX0: OBSTACLE_X0 * s,
        obstacleCount: OBSTACLE_COUNT,
        obstacleSpacing: OBSTACLE_SPACING * s,
        obstacleZ: 3.2 * s,
        obstacleCylR: 0.15 * s,
        obstacleCylLen: 2.5 * s,
        obstacleBoxSize: new Vector3(0.25 * s, 0.275 * s, 2.5 * s),
        stairWidth: 1 * s,
        rampWidth: 1 * s,
        kineThickness: 0.12 * s,
        kineTopOffset: 0.4 * s,
        tileSize: TILE_SIZE * s,
    };
}

// 染色材质
function tintMaterial(baseMat, hex) {
    const mat = baseMat.clone();
    mat.color?.setHex?.(hex);
    return mat;
}

const scene = new Scene();
const animTimer = new Timer();
let scaledAnimTime = 0;

let camera;
let renderer;
let controls;
let player;
let footIK;
let footIKDebugParams;
let stats;
const kinematicPlatforms = [];
let trapScaleRange = null; // 收腰段：wideWestX 处 scale=1，westX 处 scale=0.1
const glowPortals = [];
let zoneScale = 1; // 当前场景总缩放（1 → MINI_SCALE）
const scaleGateWorldPos = new Vector3(); // 缩放判定用的世界坐标缓冲

init();

// 初始化
async function init() {
    const container = document.querySelector("#container");

    // 渲染器
    renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = VSMShadowMap;
    renderer.setAnimationLoop(animate);
    container.appendChild(renderer.domElement);
    animTimer.connect(document);

    // 帧率
    stats = new Stats();
    Object.assign(stats.dom.style, {
        position: "fixed",
        bottom: "0px",
        left: "0px",
        top: "auto",
        zIndex: "9998",
        display: "block",
    });
    document.body.appendChild(stats.dom);

    // 相机
    camera = new PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.01, 800);
    camera.position.set(14, 10, 10);

    // 控制器
    controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxDistance = 260;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.target.set(0, 1, 0);

    // 环境光
    scene.add(new AmbientLight(0xffffff, 1.5));

    // 平行光
    const sun = new DirectionalLight(0xffffff, 2);
    sun.position.set(16, 48, 24);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 220;
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 24;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    const sky = new Sky();
    sky.scale.setScalar(450000);
    scene.add(sky);
    const skyUniforms = sky.material.uniforms;
    skyUniforms["turbidity"].value = 10;
    skyUniforms["rayleigh"].value = 2;
    skyUniforms["mieCoefficient"].value = 0.001;
    skyUniforms["mieDirectionalG"].value = 0.99;
    skyUniforms["sunPosition"].value.copy(sun.position.clone().normalize());

    // 测试场景
    const prototypeMat = await loadTiledMaterial("./textures/showcase/prototype.png");
    const mainLayout = createShowcaseLayout();
    const miniLayout = createShowcaseLayout(MINI_SCALE);
    // 矩形西墙全开，开口贴合南北墙外缘，与梯形宽端相接
    const mainWestOpening = {
        zCenter: 0,
        width: mainLayout.platform.sizeZ + 2 * mainLayout.wallT,
    };
    // 小场景南北墙外缘宽度：梯形窄端西口与小矩形东侧共用
    const miniOpening = {
        zCenter: 0,
        width: miniLayout.platform.sizeZ + 2 * miniLayout.wallT,
    };

    const world = new Group();
    world.name = "ShowcaseWorld";
    const mainWorld = buildShowcaseWorld(prototypeMat, mainLayout, { westGap: mainWestOpening });
    mainWorld.name = "MainWorld";
    world.add(mainWorld);

    const mainWestX = mainLayout.platform.x - mainLayout.platform.sizeX * 0.5;
    const trapLayout = createTrapezoidLayout(
        mainWestX,
        mainLayout.platform.sizeZ,
        miniLayout.platform.sizeZ,
    );
    const trapWorld = buildTrapezoidArena(prototypeMat, mainLayout, trapLayout, miniLayout.wallH);
    trapWorld.name = "TrapezoidWorld";
    world.add(trapWorld);
    trapScaleRange = { eastX: trapLayout.wideWestX, westX: trapLayout.westX };

    const miniWorld = buildShowcaseWorld(prototypeMat, miniLayout, {
        omitEast: true,
    });
    miniWorld.name = "MiniWorld";
    const miniLocalEast = miniLayout.platform.x + miniLayout.platform.sizeX * 0.5;
    // 小场景台面东缘对齐梯形窄端西口
    miniWorld.position.set(trapLayout.westX - miniLocalEast, 0, 0);
    world.add(miniWorld);
    scene.add(world);

    // 豁口发光门帘：宽矩形/收腰交界 + 梯形西口（进入小场景）
    const slopeEastOpening = { zCenter: 0, width: trapLayout.halfWide * 2 };
    glowPortals.push(
        createGlowGapPortal(mainLayout, slopeEastOpening, trapLayout.wideWestX),
        createGlowGapPortal(miniLayout, miniOpening, trapLayout.westX),
    );
    for (const portal of glowPortals) scene.add(portal);

    // 加载玩家模型
    const gltfLoader = new GLTFLoader();
    const playerGltf = await gltfLoader.loadAsync("./glb/ual.glb");

    // 初始化玩家控制器
    player = new playerController();
    await player.init({
        scene,
        camera,
        controls,
        colliders: [
            { motion: "static", shape: { kind: "mesh", source: world } },
        ],
        initPos: new Vector3(6.5, 0.4, 0.5),
        minCamDistance: 8,
        maxCamDistance: 300,
        camLookAtHeightRatio: 0.5,
        enableOverShoulderView: true,
        camOverShoulderOffsetRatio: 0,
        enableSpringCamera: true,
        springCameraTime: 0.1,
        enableZoom: true,
        playerModelConfig: {
            model: playerGltf.scene,
            animations: playerGltf.animations,
            scale: PLAYER_SCALE_NORMAL,
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
            firstPersonCameraOffset: [0, 0.15, 0.12],
            rotateY: -Math.PI / 2,
            speed: 100,
            runSpeed: 600,
        },
    });
    enableModelShadows(player.playerModel);
    const staticStripBridge = createStaticStripPlatforms(prototypeMat, mainLayout, scene, {
        centerX: getBalancedKinematicMeetCenterX(mainLayout, trapLayout.wideWestX),
    });
    const miniStripBridge = createStaticStripPlatforms(prototypeMat, miniLayout, miniWorld, {
        centerX: getBalancedKinematicMeetCenterX(miniLayout),
    });

    // 初始化脚部 IK
    footIK = new FootIK({
        enabled: true,
        soleHalfWidth: 4,
        soleToeExtend: 4,
        soleSkinThickness: 1.6,
        predictivePlacement: true,
        skeleton: {
            hips: "pelvis",
            legs: {
                left: {
                    upper: "thigh_l",
                    lower: "calf_l",
                    foot: "foot_l",
                    toe: "ball_l",
                },
                right: {
                    upper: "thigh_r",
                    lower: "calf_r",
                    foot: "foot_r",
                    toe: "ball_r",
                },
            },
        },
    });
    player.use(footIK);

    await spawnShowcaseVehicles(gltfLoader);
    spawnVehiclePropBodies(prototypeMat, mainLayout);
    spawnLayoutPropBodies(prototypeMat, miniLayout, miniWorld.position);
    createKinematicPlatforms(prototypeMat, mainLayout, scene, {
        meetCenterX: staticStripBridge.centerX,
        middleStripSpan: staticStripBridge.span,
        slopeMeetCenterX: trapLayout.wideWestX,
        slopeWestX: trapLayout.westX,
    });
    createKinematicPlatforms(prototypeMat, miniLayout, miniWorld, {
        meetCenterX: miniStripBridge.centerX,
        middleStripSpan: miniStripBridge.span,
    });

    createDebugPanel();

    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", (e) => {
        if (e.code !== "KeyR" || e.repeat) return;
        player?.resetVehicle();
    });
    window["hideLoader"]?.();
}

// 加载 tiling 纹理材质
async function loadTiledMaterial(url) {
    const texture = await new TextureLoader().loadAsync(url);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(1, 1);
    texture.anisotropy = 8;
    return new MeshStandardMaterial({
        map: texture,
        roughness: 0.85,
        metalness: 0.05,
    });
}

// 按世界尺度写入 UV
function applyWorldTileUV(geometry, origin = { x: 0, y: 0, z: 0 }, tileSize = TILE_SIZE) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = flat.getAttribute("position");
    const uv = new Float32BufferAttribute(new Float32Array(pos.count * 2), 2);
    const tile = Math.max(tileSize, 1e-6);

    for (let t = 0; t < pos.count; t += 3) {
        const ax = pos.getX(t);
        const ay = pos.getY(t);
        const az = pos.getZ(t);
        const bx = pos.getX(t + 1);
        const by = pos.getY(t + 1);
        const bz = pos.getZ(t + 1);
        const cx = pos.getX(t + 2);
        const cy = pos.getY(t + 2);
        const cz = pos.getZ(t + 2);

        const e1x = bx - ax;
        const e1y = by - ay;
        const e1z = bz - az;
        const e2x = cx - ax;
        const e2y = cy - ay;
        const e2z = cz - az;
        const nx = Math.abs(e1y * e2z - e1z * e2y);
        const ny = Math.abs(e1z * e2x - e1x * e2z);
        const nz = Math.abs(e1x * e2y - e1y * e2x);

        for (let i = 0; i < 3; i++) {
            const idx = t + i;
            const x = pos.getX(idx) + origin.x;
            const y = pos.getY(idx) + origin.y;
            const z = pos.getZ(idx) + origin.z;
            let u = 0;
            let v = 0;
            if (ny >= nx && ny >= nz) {
                u = x;
                v = z;
            } else if (nx >= ny && nx >= nz) {
                u = z;
                v = y;
            } else {
                u = x;
                v = y;
            }
            uv.setXY(idx, u / tile, v / tile);
        }
    }

    flat.setAttribute("uv", uv);
    flat.computeVertexNormals();
    return flat;
}

// 创建展示场景
function buildShowcaseWorld(baseMat, layout, options = {}) {
    const root = new Group();
    const { platform, deckY, deckThick, tileSize } = layout;

    addBox(
        root,
        new Vector3(platform.x, deckY, platform.z),
        new Vector3(platform.sizeX, deckThick, platform.sizeZ),
        baseMat,
        tileSize,
    );
    createPlatformWalls(root, baseMat, layout, options);
    createClimbGroups(root, baseMat, layout);
    createHalfBuriedObstacles(root, baseMat, layout);

    return root;
}

// 平台围墙
function createPlatformWalls(root, baseMat, layout, options = {}) {
    const { platform, wallH, wallT, tileSize } = layout;
    const { x, z, sizeX, sizeZ } = platform;
    const halfX = sizeX * 0.5;
    const halfZ = sizeZ * 0.5;
    const y = wallH * 0.5;
    const westX = x - halfX - wallT * 0.5;
    const westGap = options.westGap;

    // 北 / 南
    addBox(root, new Vector3(x, y, z + halfZ + wallT * 0.5), new Vector3(sizeX + wallT * 2, wallH, wallT), baseMat, tileSize);
    addBox(root, new Vector3(x, y, z - halfZ - wallT * 0.5), new Vector3(sizeX + wallT * 2, wallH, wallT), baseMat, tileSize);

    // 东墙
    if (!options.omitEast) {
        addBox(root, new Vector3(x + halfX + wallT * 0.5, y, z), new Vector3(wallT, wallH, sizeZ), baseMat, tileSize);
    }

    // 西墙：可选中部豁口
    if (!westGap || westGap.width <= 0) {
        addBox(root, new Vector3(westX, y, z), new Vector3(wallT, wallH, sizeZ), baseMat, tileSize);
        return;
    }

    const gapHalf = westGap.width * 0.5;
    const gapCenter = westGap.zCenter;
    const southEnd = z - halfZ;
    const northEnd = z + halfZ;
    const gapSouth = gapCenter - gapHalf;
    const gapNorth = gapCenter + gapHalf;

    const southLen = gapSouth - southEnd;
    if (southLen > 1e-4) {
        addBox(
            root,
            new Vector3(westX, y, southEnd + southLen * 0.5),
            new Vector3(wallT, wallH, southLen),
            baseMat,
            tileSize,
        );
    }
    const northLen = northEnd - gapNorth;
    if (northLen > 1e-4) {
        addBox(
            root,
            new Vector3(westX, y, gapNorth + northLen * 0.5),
            new Vector3(wallT, wallH, northLen),
            baseMat,
            tileSize,
        );
    }
}

// 梯形连接段尺寸（东贴大场景，西贴小场景）
function createTrapezoidLayout(eastX, eastWidth, westWidth) {
    const wideLen = eastWidth * TRAP_WIDE_LEN_RATIO;
    const slopeLen = eastWidth * TRAP_SLOPE_LEN_RATIO;
    const wideWestX = eastX - wideLen;
    const westX = wideWestX - slopeLen;
    return {
        eastX,
        westX,
        wideWestX,
        halfWide: eastWidth * 0.5,
        halfNarrow: westWidth * 0.5,
    };
}

function getTrapezoidOutline(trap) {
    const { eastX, westX, wideWestX, halfWide, halfNarrow } = trap;
    return [
        { x: eastX, z: halfWide },
        { x: wideWestX, z: halfWide },
        { x: westX, z: halfNarrow },
        { x: westX, z: -halfNarrow },
        { x: wideWestX, z: -halfWide },
        { x: eastX, z: -halfWide },
    ];
}

function getWideSectionOutline(trap) {
    const { eastX, wideWestX, halfWide } = trap;
    return [
        { x: eastX, z: halfWide },
        { x: wideWestX, z: halfWide },
        { x: wideWestX, z: -halfWide },
        { x: eastX, z: -halfWide },
    ];
}

function getSlopeSectionOutline(trap) {
    const { wideWestX, westX, halfWide, halfNarrow } = trap;
    return [
        { x: wideWestX, z: halfWide },
        { x: westX, z: halfNarrow },
        { x: westX, z: -halfNarrow },
        { x: wideWestX, z: -halfWide },
    ];
}

function isSlopeSectionEdge(a, b) {
    return Math.abs(b.x - a.x) > 1e-4 && Math.abs(b.z - a.z) > 1e-4;
}

// 宽矩形 + 收腰梯形
function buildTrapezoidArena(baseMat, layout, trap, westWallH) {
    const root = new Group();
    const trapMat = tintMaterial(baseMat, TRAP_TINT_COLOR);
    addPolygonFloor(root, getWideSectionOutline(trap), layout, baseMat);
    addPolygonFloor(root, getSlopeSectionOutline(trap), layout, trapMat);
    addOutlineWalls(root, getTrapezoidOutline(trap), layout, baseMat, trapMat, trap, westWallH);
    return root;
}

function addPolygonFloor(root, points, layout, material) {
    const { deckY, deckThick, tileSize } = layout;
    const shape = new Shape();
    shape.moveTo(points[0].x, -points[0].z);
    for (let i = 1; i < points.length; i++) {
        shape.lineTo(points[i].x, -points[i].z);
    }
    shape.closePath();

    const geo = new ExtrudeGeometry(shape, { depth: deckThick, bevelEnabled: false, steps: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, deckY - deckThick * 0.5, 0);
    const floor = new Mesh(applyWorldTileUV(geo, { x: 0, y: 0, z: 0 }, tileSize), material);
    floor.name = "TrapezoidFloor";
    return addShadowMesh(root, floor);
}

// 沿多边形外缘砌墙，跳过东西两端开口；收腰段墙高从大场景线性降到小场景
function addOutlineWalls(root, points, layout, wideMat, slopeMat, trap, westWallH) {
    const n = points.length;
    let cx = 0;
    let cz = 0;
    for (const p of points) {
        cx += p.x;
        cz += p.z;
    }
    cx /= n;
    cz /= n;

    const heightAt = (p) => (
        Math.abs(p.x - trap.wideWestX) < 1e-4 || p.x > trap.wideWestX
            ? layout.wallH
            : westWallH
    );

    for (let i = 0; i < n; i++) {
        const a = points[i];
        const b = points[(i + 1) % n];
        const isEastGap = Math.abs(a.x - trap.eastX) < 1e-4 && Math.abs(b.x - trap.eastX) < 1e-4;
        const isWestGap = Math.abs(a.x - trap.westX) < 1e-4 && Math.abs(b.x - trap.westX) < 1e-4;
        if (isEastGap || isWestGap) continue;

        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;

        const midX = (a.x + b.x) * 0.5;
        const midZ = (a.z + b.z) * 0.5;
        let nx = -dz / len;
        let nz = dx / len;
        if (nx * (cx - midX) + nz * (cz - midZ) > 0) {
            nx = -nx;
            nz = -nz;
        }

        const hA = heightAt(a);
        const hB = heightAt(b);
        const material = isSlopeSectionEdge(a, b) ? slopeMat : wideMat;
        if (Math.abs(hA - hB) > 1e-4) {
            addTaperedWall(root, layout, material, a, b, hA, hB, nx, nz);
        } else {
            addOrientedWall(root, layout, material, midX, midZ, len, nx, nz, dx, dz);
        }
    }
}

function addTaperedWall(root, layout, material, a, b, hA, hB, nx, nz) {
    const { wallT, tileSize } = layout;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const along = new Vector3((b.x - a.x) / len, 0, (b.z - a.z) / len);
    const up = new Vector3(0, 1, 0);
    const out = new Vector3(nx, 0, nz);

    // 外法线与 along×up 反向时会变成左手系，正面被剔掉；改为从另一端挤出
    let origin = a;
    let startH = hA;
    let endH = hB;
    const xAxis = along.clone();
    if (xAxis.clone().cross(up).dot(out) < 0) {
        xAxis.negate();
        origin = b;
        startH = hB;
        endH = hA;
    }

    const shape = new Shape();
    shape.moveTo(0, 0);
    shape.lineTo(len, 0);
    shape.lineTo(len, endH);
    shape.lineTo(0, startH);
    shape.closePath();

    const geo = new ExtrudeGeometry(shape, { depth: wallT, bevelEnabled: false, steps: 1 });
    const m = new Matrix4().makeBasis(xAxis, up, out);
    m.setPosition(origin.x, 0, origin.z);
    geo.applyMatrix4(m);

    const mesh = new Mesh(applyWorldTileUV(geo, { x: 0, y: 0, z: 0 }, tileSize), material);
    return addShadowMesh(root, mesh);
}

function addOrientedWall(root, layout, material, midX, midZ, length, nx, nz, dx, dz) {
    const { wallH, wallT, tileSize } = layout;
    const pos = new Vector3(midX + nx * wallT * 0.5, wallH * 0.5, midZ + nz * wallT * 0.5);
    const geo = new BoxGeometry(wallT, wallH, length);
    geo.rotateY(Math.atan2(dx, dz));
    const mesh = new Mesh(applyWorldTileUV(geo, pos, tileSize), material);
    mesh.position.copy(pos);
    return addShadowMesh(root, mesh);
}

// 创建豁口半透明发光门帘
function createGlowGapPortal(layout, westGap, doorX) {
    const group = new Group();
    group.name = "GlowGapPortal";

    const mat = new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: {
            uTime: { value: 0 },
            uColor: { value: new Color(0x66e0ff) },
            uIntensity: { value: 1.35 },
        },
        vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform vec3 uColor;
            uniform float uIntensity;
            varying vec2 vUv;

            void main() {
                float edgeX = smoothstep(0.0, 0.12, vUv.x) * smoothstep(0.0, 0.12, 1.0 - vUv.x);
                float edgeY = smoothstep(0.0, 0.08, vUv.y) * smoothstep(0.0, 0.1, 1.0 - vUv.y);
                float veil = edgeX * edgeY;
                float wave = 0.55 + 0.45 * sin(vUv.y * 14.0 - uTime * 2.4);
                float scan = 0.35 + 0.65 * pow(abs(sin(vUv.x * 3.14159 + uTime * 1.6)), 2.0);
                float alpha = veil * (0.22 + 0.38 * wave * scan);
                vec3 col = uColor * (uIntensity + 0.55 * wave);
                gl_FragColor = vec4(col, alpha);
            }
        `,
    });

    const mesh = new Mesh(
        new PlaneGeometry(westGap.width, layout.wallH),
        mat,
    );
    mesh.name = "GlowGapCurtain";
    mesh.rotation.y = Math.PI * 0.5;
    mesh.position.set(doorX, layout.wallH * 0.5, westGap.zCenter);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    group.add(mesh);
    group.userData.material = mat;
    return group;
}

// 更新发光门帘时间
function updateGlowPortal(t) {
    for (const portal of glowPortals) {
        const mat = portal?.userData?.material;
        if (mat?.uniforms?.uTime) mat.uniforms.uTime.value = t;
    }
}

// 两数是否视为同一缩放
function isNearScale(a, b) {
    return Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-4, 1e-8);
}

// 收腰段 X：wideWestX → 1，westX → MINI_SCALE；宽矩形段保持 1
function zoneScaleFromX(x) {
    if (!trapScaleRange) return 1;
    const { eastX: narrowStartX, westX } = trapScaleRange;
    if (x > narrowStartX) return 1;
    const span = narrowStartX - westX;
    if (span <= 1e-6) return x <= westX ? MINI_SCALE : 1;
    const t = Math.min(1, Math.max(0, (narrowStartX - x) / span));
    return 1 + t * (MINI_SCALE - 1);
}

function playerScaleForZone(z = zoneScale) {
    return PLAYER_SCALE_NORMAL * z;
}

function vehicleScaleForZone(z = zoneScale) {
    return VEHICLE_SCALE_NORMAL * z;
}

function isDriving() {
    return player?.controllerMode === 1 && Boolean(player.getActiveVehicle?.());
}

function getScaleGatePosition() {
    if (isDriving()) {
        const v = player.getActiveVehicle();
        if (v?.vehicleGroup) return v.vehicleGroup.position;
    }
    const cap = player?.playerCapsule;
    if (cap) return cap.getWorldPosition(scaleGateWorldPos);
    return player?.getPosition?.() ?? null;
}

function recomputePlayerGroundThresholds() {
    const cap = player?.playerCapsule;
    const info = cap?.capsuleInfo;
    if (!info) return;
    const sy = cap.scale.y || 1;
    const ride = player.rideHeight * player.playerModelConfig.scale;
    player.snapH = (-info.segment.end.y) * sy + info.radius + ride;
    player.maxH = player.snapH + ride;
}

// 应用人物缩放；驾驶中保持胶囊局部缩放，由车身缩放带动
function applyPlayerScale(targetScale) {
    if (!player?.setPlayerScale || isNearScale(player.playerModelConfig.scale, targetScale)) return;
    if (!isDriving()) {
        player.setPlayerScale(targetScale);
        return;
    }
    const cap = player.playerCapsule;
    const savedScale = cap.scale.clone();
    player.setPlayerScale(targetScale);
    cap.scale.copy(savedScale);
    recomputePlayerGroundThresholds();
}

// 按收腰段 X 连续缩放：越往 -X 越小
function updateTrapScale() {
    if (!player || !trapScaleRange) return;
    const pos = getScaleGatePosition();
    if (!pos) return;

    zoneScale = zoneScaleFromX(pos.x);
    applyPlayerScale(playerScaleForZone(zoneScale));

    const vehicles = player.getAllVehicles?.() ?? [];
    if (!vehicles.length || !player.setVehicleScale) return;
    for (const v of vehicles) {
        const target = vehicleScaleForZone(zoneScaleFromX(v.vehicleGroup.position.x));
        if (!isNearScale(v.scale, target)) player.setVehicleScale(v, target);
    }
}

// 半埋圆柱 + 半埋长方体
function createHalfBuriedObstacles(root, baseMat, layout) {
    const accentMat = tintMaterial(baseMat, ACCENT_GRAY);
    const {
        obstacleX0,
        obstacleCount,
        obstacleSpacing,
        obstacleZ,
        obstacleCylR,
        obstacleCylLen,
        obstacleBoxSize,
        deckY,
        deckThick,
        tileSize,
    } = layout;
    const deckTop = deckY + deckThick * 0.5;

    for (let i = 0; i < obstacleCount; i++) {
        const x = obstacleX0 - i * obstacleSpacing;

        const cylPos = new Vector3(x, deckTop, -obstacleZ);
        const cylGeo = applyWorldTileUV(
            new CylinderGeometry(obstacleCylR, obstacleCylR, obstacleCylLen, 24),
            cylPos,
            tileSize,
        );
        cylGeo.rotateX(Math.PI / 2);
        const cyl = new Mesh(cylGeo, accentMat);
        cyl.position.copy(cylPos);
        addShadowMesh(root, cyl);

        addBox(root, new Vector3(x, deckTop, obstacleZ), obstacleBoxSize.clone(), accentMat, tileSize);
    }
}

// 加载展示车辆
async function spawnShowcaseVehicles(gltfLoader) {
    const gltf = await gltfLoader.loadAsync("./glb/suv.glb");
    for (const spawnPos of VEHICLE_SPAWNS) {
        const model = gltf.scene.clone(true);
        await player.loadVehicleModel({
            model,
            scale: VEHICLE_SCALE_NORMAL,
            position: spawnPos.clone(),
            wheelsNames: ["Wheel_LF", "Wheel_RF", "Wheel_LR", "Wheel_RR"],
            driverSeatPosition: new Vector3(-0.4, 1.0, 0.3),
            driverSeatRotation: -Math.PI / 2,
            modelRotation: -Math.PI / 2,
            followVehicleDirection: VEHICLE_TUNING.followVehicleDirection,
            debug: VEHICLE_TUNING.debug,
            chassis: VEHICLE_TUNING.chassis,
            suspension: VEHICLE_TUNING.suspension,
            steering: VEHICLE_TUNING.steering,
            grip: VEHICLE_TUNING.grip,
            power: VEHICLE_TUNING.power,
        });

        const vehicle = player.getAllVehicles().at(-1);
        vehicle?.vehicleGroup?.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
                if (!mat) continue;
                mat.metalness = 0.8;
                mat.roughness = 0.0;
            }
        });
    }
}

// 车辆前方动态刚体
function spawnVehiclePropBodies(baseMat, layout) {
    const vehicles = player?.getAllVehicles?.() ?? [];
    if (vehicles.length < 2) return;
    const propMat = tintMaterial(baseMat, PROP_ACCENT_COLOR);
    spawnSphereGrid(vehicles[0], propMat, layout);
    spawnBoxWall(vehicles[1], propMat, layout);
}

// 按布局生成动态球阵与箱墙
function spawnLayoutPropBodies(baseMat, layout, worldOffset) {
    const propMat = tintMaterial(baseMat, PROP_ACCENT_COLOR);
    const s = layout.scale;
    const forward = new Vector3(-1, 0, 0);
    const right = new Vector3(0, 0, 1);
    const xMid = layout.obstacleX0 - (layout.obstacleCount - 1) * layout.obstacleSpacing * 0.5;
    const deckTop = (worldOffset.y ?? 0) + layout.deckY + layout.deckThick * 0.5;
    const ox = worldOffset.x;
    const oz = worldOffset.z ?? 0;

    const gravity = player.gravity * s;
    spawnSphereGridAt({
        mat: propMat,
        center: new Vector3(ox + xMid, 0, oz + VEHICLE_SPAWNS[0].z * s),
        forward,
        right,
        radius: PROP_SPHERE_R * s,
        deckTop,
        gravity,
    });
    spawnBoxWallAt({
        mat: propMat,
        center: new Vector3(ox + xMid, 0, oz + VEHICLE_SPAWNS[1].z * s),
        right,
        boxSize: PROP_BOX_SIZE * s,
        deckTop,
        gravity,
    });
}

// 车辆前向 / 右向轴
function getVehicleAxes(vehicle) {
    vehicle.vehicleGroup.updateMatrixWorld(true);
    const forward = vehicle.forwardLocal.clone().transformDirection(vehicle.vehicleGroup.matrixWorld).normalize();
    const right = new Vector3(0, 1, 0).cross(forward).normalize();
    return { origin: vehicle.vehicleGroup.position, forward, right };
}

// 障碍带中线处的放置中心
function getPropCenter(vehicle, layout) {
    const { origin, forward, right } = getVehicleAxes(vehicle);
    const center = origin.clone();
    center.x = layout.obstacleX0 - (layout.obstacleCount - 1) * layout.obstacleSpacing * 0.5;
    return { forward, right, center };
}

// 4×4 贴地球阵（相对车辆）
function spawnSphereGrid(vehicle, mat, layout) {
    const { forward, right, center } = getPropCenter(vehicle, layout);
    spawnSphereGridAt({
        mat,
        center,
        forward,
        right,
        radius: PROP_SPHERE_R * layout.scale,
        deckTop: layout.deckY + layout.deckThick * 0.5,
    });
}

// 4×4 贴地球阵
function spawnSphereGridAt({ mat, center, forward, right, radius, deckTop, gravity = undefined }) {
    const spacing = radius * 2;
    const start = center.clone().addScaledVector(forward, -(PROP_GRID - 1) * spacing * 0.5);
    const geo = new SphereGeometry(1, 24, 16);

    for (let row = 0; row < PROP_GRID; row++) {
        for (let col = 0; col < PROP_GRID; col++) {
            const pos = start.clone()
                .addScaledVector(forward, row * spacing)
                .addScaledVector(right, (col - (PROP_GRID - 1) * 0.5) * spacing);
            pos.y = deckTop + radius;
            const mesh = new Mesh(geo, mat);
            mesh.scale.setScalar(radius);
            addShadowMesh(scene, mesh);
            player.addCollider({
                motion: "dynamic",
                shape: { kind: "sphere", radius, position: pos },
                mesh,
                restitution: 0.35,
                friction: 0.55,
                ...(gravity != null ? { gravity } : null),
            });
        }
    }
}

// 4×4 箱墙（相对车辆）
function spawnBoxWall(vehicle, mat, layout) {
    const { right, center } = getPropCenter(vehicle, layout);
    spawnBoxWallAt({
        mat,
        center,
        right,
        boxSize: PROP_BOX_SIZE * layout.scale,
        deckTop: layout.deckY + layout.deckThick * 0.5,
    });
}

// 4×4 箱墙
function spawnBoxWallAt({ mat, center, right, boxSize, deckTop, gravity = undefined }) {
    const half = boxSize * 0.5;
    const start = center.clone();
    const geo = new BoxGeometry(1, 1, 1);
    const halfExtents = new Vector3(half, half, half);

    for (let row = 0; row < PROP_GRID; row++) {
        for (let col = 0; col < PROP_GRID; col++) {
            const pos = start.clone()
                .addScaledVector(right, (col - (PROP_GRID - 1) * 0.5) * boxSize);
            pos.y = deckTop + boxSize * (row + 0.5);
            const mesh = new Mesh(geo, mat);
            mesh.scale.setScalar(boxSize);
            addShadowMesh(scene, mesh);
            player.addCollider({
                motion: "dynamic",
                shape: {
                    kind: "box",
                    halfExtents: halfExtents.clone(),
                    position: pos,
                },
                mesh,
                restitution: 0.12,
                friction: 0.7,
                density: 1.2,
                ...(gravity != null ? { gravity } : null),
            });
        }
    }
}

// 六棱柱攀爬尺寸
function getHexClimbMetrics(layout) {
    const stairWidth = layout.stairWidth;
    const rampWidth = layout.rampWidth;
    const armSpan = stairWidth + rampWidth;
    const platformSides = 6;
    const platformApothem = armSpan / (2 * Math.tan(Math.PI / platformSides));
    const platformCircumRadius = platformApothem / Math.cos(Math.PI / platformSides);
    const sideLength = 2 * platformApothem * Math.tan(Math.PI / platformSides);
    return {
        stairWidth,
        rampWidth,
        armSpan,
        platformSides,
        platformApothem,
        platformCircumRadius,
        sideLength,
        topHeight: layout.l1Top,
    };
}

// 悬空静态条板
function createStaticStripPlatforms(baseMat, layout, parent, options = {}) {
    const { sideLength, topHeight } = getHexClimbMetrics(layout);
    const capsuleRadius = (player?.playerCapsule?.capsuleInfo?.radius
        ?? 30 * PLAYER_SCALE_NORMAL) * layout.scale;
    const gap = capsuleRadius * STATIC_STRIP_GAP_RADIUS_RATIO;
    const stripDepth = capsuleRadius * STATIC_STRIP_DEPTH_RADIUS_RATIO;
    const span = STATIC_STRIP_COUNT * stripDepth
        + (STATIC_STRIP_COUNT - 1) * gap;
    const centerX = options.centerX ?? 0;
    const stripSize = new Vector3(
        stripDepth,
        layout.kineThickness,
        sideLength,
    );
    const y = topHeight + layout.kineTopOffset - layout.kineThickness * 0.5;
    const firstX = centerX + span * 0.5 - stripDepth * 0.5;
    const root = new Group();
    root.name = "StaticStripPlatforms";
    const mat = tintMaterial(baseMat, ACCENT_GRAY);

    for (let i = 0; i < STATIC_STRIP_COUNT; i++) {
        const x = firstX - i * (stripDepth + gap);
        const strip = addBox(
            root,
            new Vector3(x, y, 0),
            stripSize,
            mat,
            layout.tileSize,
        );
        strip.name = `StaticStripPlatform${i + 1}`;
    }

    parent.add(root);
    player.addCollider({
        motion: "static",
        shape: { kind: "mesh", source: root },
    });
    return { centerX, span };
}

/** 取两台运动学平台起点中心的中点。 */
function getBalancedKinematicMeetCenterX(layout, spinStartBoundaryX) {
    const { sideLength, platformApothem } = getHexClimbMetrics(layout);
    const half = sideLength * 0.5;
    const farEastX = -platformApothem - half;
    const deckWestX = layout.platform.x - layout.platform.sizeX * 0.5;
    const farWestX = deckWestX + half;
    const spinStartX = Number.isFinite(spinStartBoundaryX)
        ? spinStartBoundaryX + half
        : farWestX;
    return (farEastX + spinStartX) * 0.5;
}

// 运动学往返平台
function createKinematicPlatforms(baseMat, layout, parent, options = {}) {
    const { sideLength, topHeight, platformApothem } = getHexClimbMetrics(layout);
    const size = new Vector3(sideLength, layout.kineThickness, sideLength);
    const y = topHeight + layout.kineTopOffset - layout.kineThickness * 0.5;
    const half = sideLength * 0.5;
    const mat = tintMaterial(baseMat, PROP_ACCENT_COLOR);
    const prefix = layout.scale === 1 ? "Kine" : "MiniKine";

    const farEastX = -platformApothem - half;
    const deckWestX = layout.platform.x - layout.platform.sizeX * 0.5;
    const farWestX = deckWestX + half;
    const slopeMeetCenterX = options.slopeMeetCenterX;
    const slopeWestX = options.slopeWestX;
    const defaultMeetX = getBalancedKinematicMeetCenterX(layout, slopeMeetCenterX);
    const meetCenterX = options.meetCenterX ?? defaultMeetX;
    const middleStripSpan = Math.max(0, options.middleStripSpan ?? 0);

    // 同一相位 p：p=1 时前两台分别停靠在静态条板两侧；p=0 时后两台在收腰起点衔接。
    const farEast = new Vector3(farEastX, y, 0);
    // 有静态条板时，两台平台分别停靠在条板组东西两侧；否则保持原来的相邻停靠。
    const meetEast = new Vector3(meetCenterX + middleStripSpan * 0.5 + half, y, 0);
    const spinFrom = Number.isFinite(slopeMeetCenterX)
        ? new Vector3(slopeMeetCenterX + half, y, 0)
        : new Vector3(farWestX, y, 0);
    const spinTo = new Vector3(meetCenterX - middleStripSpan * 0.5 - half, y, 0);

    addKinematicShuttle({
        parent,
        name: `${prefix}Shuttle`,
        from: farEast,
        to: meetEast,
        size,
        mat,
        spinSpeed: 0,
        tileSize: layout.tileSize,
    });
    addKinematicShuttle({
        parent,
        name: `${prefix}ShuttleSpin`,
        from: spinFrom,
        to: spinTo,
        size,
        mat,
        spinSpeed: KINE_SPIN_SPEED,
        tileSize: layout.tileSize,
    });

    if (Number.isFinite(slopeMeetCenterX) && Number.isFinite(slopeWestX)) {
        const slopeScaleFrom = 1;
        const slopeScaleTo = MINI_SCALE;
        addKinematicShuttle({
            parent,
            name: `${prefix}ShuttleSlope`,
            // 起点东边缘贴收腰段，终点西边缘以缩小后的半宽贴小场景边界。
            from: new Vector3(slopeMeetCenterX - half * slopeScaleFrom, y, 0),
            to: new Vector3(
                slopeWestX + half * slopeScaleTo,
                y * slopeScaleTo,
                0,
            ),
            size,
            mat,
            spinSpeed: 0,
            tileSize: layout.tileSize,
            zoneScale: true,
            scaleFrom: slopeScaleFrom,
            scaleTo: slopeScaleTo,
        });
    }
}

// 创建单个往返平台
function addKinematicShuttle({
    parent,
    name,
    from,
    to,
    size,
    mat,
    spinSpeed,
    tileSize,
    zoneScale = false,
    scaleFrom = 1,
    scaleTo = scaleFrom,
}) {
    const mesh = addBox(parent, from.clone(), size, mat, tileSize);
    mesh.name = name;
    mesh.scale.setScalar(scaleFrom);
    player.addCollider({
        motion: "kinematic",
        shape: { kind: "mesh", source: mesh },
        follow: mesh,
    });
    const entry = {
        mesh,
        from: from.clone(),
        to: to.clone(),
        spinSpeed,
        zoneScale,
        scaleFrom,
        scaleTo,
        lastZoneScale: scaleFrom,
    };
    kinematicPlatforms.push(entry);
}

/** 收腰段运动学平台。 */
function applyKinematicZoneScale(entry, targetScale) {
    if (!entry?.mesh || !Number.isFinite(targetScale)) return;
    if (isNearScale(entry.lastZoneScale, targetScale)) return;
    entry.mesh.scale.setScalar(targetScale);
    entry.lastZoneScale = targetScale;
}

// 两端缓入缓出
function easeEndsLinearMiddle(progress, easeRatio = 0.18) {
    const ease = Math.min(Math.max(easeRatio, 0.001), 0.49);
    const maxSpeed = 1 / (1 - ease);
    if (progress < ease) return (maxSpeed * progress * progress) / (2 * ease);
    if (progress > 1 - ease) return 1 - (maxSpeed * (1 - progress) * (1 - progress)) / (2 * ease);
    return maxSpeed * (progress - ease / 2);
}

// 更新运动学平台
function updateKinematicPlatforms(t) {
    const phase = (t * KINE_SHUTTLE_SPEED / Math.PI) % 2;
    const raw = phase <= 1 ? phase : 2 - phase;
    const p = easeEndsLinearMiddle(raw);

    for (const entry of kinematicPlatforms) {
        entry.mesh.position.lerpVectors(entry.from, entry.to, p);
        if (entry.zoneScale) {
            const targetScale = entry.scaleFrom + (entry.scaleTo - entry.scaleFrom) * p;
            applyKinematicZoneScale(entry, targetScale);
        }
        if (entry.spinSpeed) entry.mesh.rotation.y = t * entry.spinSpeed;
    }
}

// 创建攀爬组与中心平台
function createClimbGroups(root, baseMat, layout) {
    const {
        topHeight,
        stairWidth,
        rampWidth,
        platformSides,
        platformApothem,
        platformCircumRadius,
    } = getHexClimbMetrics(layout);
    const stepCount = 7;
    const stepHeight = topHeight / stepCount;
    const tileSize = layout.tileSize;

    const platformPos = new Vector3(0, topHeight * 0.5, 0);
    const platformGeo = applyWorldTileUV(
        new CylinderGeometry(platformCircumRadius, platformCircumRadius, topHeight, platformSides),
        platformPos,
        tileSize,
    );
    const platform = new Mesh(platformGeo, baseMat);
    platform.position.copy(platformPos);
    addShadowMesh(root, platform);

    for (let index = 0; index < 3; index++) {
        const arm = new Group();
        arm.rotation.y = index * (Math.PI * 2 / 3);
        root.add(arm);

        const angleDeg = SLOPE_ANGLES[index];
        const stairZ = -stairWidth * 0.5;
        const rampZ = rampWidth * 0.5;
        const runLength = topHeight / Math.tan(angleDeg * Math.PI / 180);
        const stepDepth = runLength / stepCount;

        createStairsToPlatform(arm, {
            platformRadius: platformApothem,
            stepHeight,
            stepCount,
            stepDepth,
            width: stairWidth,
            z: stairZ,
            baseMat,
            tileSize,
        });

        createRampToPlatform(arm, {
            platformRadius: platformApothem,
            angleDeg,
            length: runLength,
            width: rampWidth,
            z: rampZ,
            baseMat,
            tileSize,
        });
    }
}

// 创建一组楼梯
function createStairsToPlatform(root, { platformRadius, stepHeight, stepCount, stepDepth, width, z, baseMat, tileSize }) {
    const stairRun = stepCount * stepDepth;
    const outer = platformRadius + stairRun;

    for (let i = 0; i < stepCount; i++) {
        const height = stepHeight * (i + 1);
        const x = outer - (i + 0.5) * stepDepth;
        addBox(
            root,
            new Vector3(x, height / 2, z),
            new Vector3(stepDepth, height, width),
            baseMat,
            tileSize,
        );
    }
}

// 创建一个斜坡
function createRampToPlatform(root, { platformRadius, angleDeg, length, width, z, baseMat, tileSize }) {
    const height = Math.tan(angleDeg * Math.PI / 180) * length;
    const origin = new Vector3(platformRadius + length * 0.5, 0, z);
    const rotY = Math.PI;
    const ramp = new Mesh(createRampGeometry(length, height, width, origin, rotY, tileSize), baseMat);
    ramp.position.copy(origin);
    ramp.rotation.y = rotY;
    return addShadowMesh(root, ramp);
}

// 创建斜坡几何体。
function createRampGeometry(length, height, width, origin = { x: 0, y: 0, z: 0 }, rotY = 0, tileSize = TILE_SIZE) {
    const halfLength = length / 2;
    const halfWidth = width / 2;
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const tile = Math.max(tileSize, 1e-6);
    const vertices = [
        -halfLength, 0, -halfWidth,
        halfLength, 0, -halfWidth,
        halfLength, height, -halfWidth,
        -halfLength, 0, halfWidth,
        halfLength, 0, halfWidth,
        halfLength, height, halfWidth,
    ];
    const indices = [
        0, 1, 4, 0, 4, 3,
        1, 2, 5, 1, 5, 4,
        0, 3, 5, 0, 5, 2,
        0, 2, 1,
        3, 4, 5,
    ];
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    const flat = geometry.toNonIndexed();
    const pos = flat.getAttribute("position");
    const uv = new Float32BufferAttribute(new Float32Array(pos.count * 2), 2);

    for (let t = 0; t < pos.count; t += 3) {
        const ax = pos.getX(t);
        const ay = pos.getY(t);
        const az = pos.getZ(t);
        const bx = pos.getX(t + 1);
        const by = pos.getY(t + 1);
        const bz = pos.getZ(t + 1);
        const cx = pos.getX(t + 2);
        const cy = pos.getY(t + 2);
        const cz = pos.getZ(t + 2);

        const e1x = bx - ax;
        const e1y = by - ay;
        const e1z = bz - az;
        const e2x = cx - ax;
        const e2y = cy - ay;
        const e2z = cz - az;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        const nnx = nx / nLen;
        const nny = ny / nLen;
        const nnz = nz / nLen;

        for (let i = 0; i < 3; i++) {
            const idx = t + i;
            const lx = pos.getX(idx);
            const ly = pos.getY(idx);
            const lz = pos.getZ(idx);
            const x = origin.x + lx * cosY + lz * sinY;
            const y = origin.y + ly;
            const z = origin.z - lx * sinY + lz * cosY;
            let u = 0;
            let v = 0;

            if (Math.abs(nnz) > 0.7) {
                u = Math.hypot(lx + halfLength, ly);
                v = y;
            } else if (Math.abs(nnx) > 0.7) {
                u = z;
                v = y;
            } else if (Math.abs(nny) > 0.7 && nny < 0) {
                u = x;
                v = z;
            } else {
                u = Math.hypot(lx + halfLength, ly);
                v = z;
            }
            uv.setXY(idx, u / tile, v / tile);
        }
    }

    flat.setAttribute("uv", uv);
    flat.computeVertexNormals();
    return flat;
}

// 添加盒子
function addBox(root, position, size, material, tileSize = TILE_SIZE) {
    const geo = applyWorldTileUV(new BoxGeometry(size.x, size.y, size.z), position, tileSize);
    const mesh = new Mesh(geo, material);
    mesh.position.copy(position);
    return addShadowMesh(root, mesh);
}

// 统一启用网格阴影并挂到场景节点
function addShadowMesh(root, mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
}

// 启用模型阴影
function enableModelShadows(root) {
    root?.traverse((obj) => {
        if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
        }
    });
}

// 将调参写回场上全部车辆
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

        const n = v.vehicleController.numWheels();
        for (let i = 0; i < n; i++) {
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

// 创建调试面板
function createDebugPanel() {
    const footIKOptions = footIK?.getOptions() ?? {};
    const roundedValue = (value, fallback, decimals = 1) => {
        const factor = 10 ** decimals;
        return Math.round((value ?? fallback) * factor) / factor;
    };
    const playerScale = Math.max(1e-8, player?.playerModelConfig?.scale ?? PLAYER_SCALE_NORMAL);
    const toBasePlayerValue = (value, fallback, decimals = 0) => (
        roundedValue(Number.isFinite(value) ? value / playerScale : undefined, fallback, decimals)
    );
    const params = {
        colliderDebug: false,
        playerCapsuleDebug: false,
        dynamicBodyDebug: false,
        mouseSensitivity: roundedValue(player?.cam?.sensitivity, 5, 1),
        gravity: toBasePlayerValue(player?.gravity, -2400),
        jumpHeight: toBasePlayerValue(player?.jumpHeight, 600),
        playerSpeed: toBasePlayerValue(player?.playerSpeed, 100),
        playerRunSpeed: toBasePlayerValue(player?.playerRunSpeed, 600),
        flySpeed: toBasePlayerValue(player?.playerFlySpeed, 2100),
        playerAcceleration: roundedValue(player?.playerAcceleration, 30, 0),
        playerDeceleration: roundedValue(player?.playerDeceleration, 30, 0),
        timeScale: roundedValue(player?.timeScale, 1, 2),
        minCamDistance: toBasePlayerValue(player?.cam?.minDist, 8),
        maxCamDistance: toBasePlayerValue(player?.cam?.maxDist, 300),
        camLookAtHeightRatio: roundedValue(player?.cam?.lookAtHeightRatio, 0.5, 2),
        enableOverShoulderView: player?.enableOverShoulderView ?? true,
        camOverShoulderOffsetRatio: roundedValue(player?.cam?.overShoulderOffsetRatio, 0, 2),
        enableSpringCamera: player?.cam?.enableSpringCamera ?? true,
        springCameraTime: roundedValue(player?.cam?.springCameraTime, 0.1, 2),
        thirdMouseMode: player?.cam?.mouseMode ?? 1,
        enableZoom: player?.cam?.zoomEnabled ?? true,
        footIKEnabled: footIKOptions.enabled ?? true,
        footIKDebug: footIKOptions.debug ?? false,
        predictivePlacement: footIKOptions.predictivePlacement ?? false,
        leftFootPhase: "",
        leftFootLand: "--",
        leftFootIKWeight: 0,
        leftPrediction: "disabled",
        rightFootPhase: "",
        rightFootLand: "--",
        rightFootIKWeight: 0,
        rightPrediction: "disabled",
        maxPelvisRaise: roundedValue(footIKOptions.maxPelvisRaise, 50, 0),
        maxPelvisDrop: roundedValue(footIKOptions.maxPelvisDrop, 50, 0),
        maxFootRaise: roundedValue(footIKOptions.maxFootRaise, 50, 0),
        maxFootDrop: roundedValue(footIKOptions.maxFootDrop, 50, 0),
        soleHalfWidth: roundedValue(footIKOptions.soleHalfWidth, 7),
        soleToeExtend: roundedValue(footIKOptions.soleToeExtend, 7),
        soleHeelExtend: roundedValue(footIKOptions.soleHeelExtend, 3),
        soleSkinThickness: roundedValue(footIKOptions.soleSkinThickness, 3),
        maxPredictionClearance: roundedValue(footIKOptions.maxPredictionClearance, 50, 0),
        maxSteerDeg: VEHICLE_TUNING.steering.maxSteerAngle * 180 / Math.PI,
    };
    footIKDebugParams = params;

    const applyFootIKOptions = (patch) => {
        footIK?.configure(patch);
    };

    footIK?.setDebugEnabled(params.footIKDebug && params.footIKEnabled);

    const gui = new GUI({ title: "Showcase Controls", width: 320 });
    Object.assign(gui.domElement.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        maxHeight: "calc(100vh - 24px)",
        overflowY: "auto",
    });
    gui.domElement.addEventListener("pointerdown", (e) => e.stopPropagation());

    const collisionFolder = gui.addFolder("Collision Debug");
    collisionFolder.add(params, "colliderDebug").name("Static / Kinematic Meshes").onChange((value) => {
        player?.setColliderDebug(value);
    });
    collisionFolder.add(params, "dynamicBodyDebug").name("Dynamic Bodies").onChange((value) => {
        player?.setDynamicBodyDebug?.(value);
    });
    collisionFolder.open();

    const characterFolder = gui.addFolder("Character");
    characterFolder.add(params, "playerCapsuleDebug").name("Capsule").onChange((value) => {
        player?.setPlayerCapsuleDebug?.(value);
    });

    const movementFolder = characterFolder.addFolder("Movement");
    movementFolder.add(params, "gravity", -6000, 0, 50).name("Gravity").decimals(0).onChange((value) => {
        player?.setGravity(value);
    });
    movementFolder.add(params, "jumpHeight", 0, 2000, 10).name("Jump Height").decimals(0).onChange((value) => {
        player?.setJumpHeight(value);
    });
    movementFolder.add(params, "playerSpeed", 0, 20000, 10).name("Walk Speed").decimals(0).onChange((value) => {
        player?.setPlayerSpeed(value);
    });
    movementFolder.add(params, "playerRunSpeed", 0, 20000, 10).name("Run Speed").decimals(0).onChange((value) => {
        player?.setPlayerRunSpeed(value);
    });
    movementFolder.add(params, "flySpeed", 0, 20000, 10).name("Fly Speed").decimals(0).onChange((value) => {
        player?.setPlayerFlySpeed(value);
    });
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
    characterCameraFolder.add(params, "mouseSensitivity", 1, 20, 0.1).name("Mouse Sensitivity").decimals(1).onChange((value) => {
        player?.setMouseSensitivity(value);
    });
    characterCameraFolder.add(params, "minCamDistance", 0, 200, 1).name("Min Distance").decimals(0).onChange((value) => {
        player?.setMinCamDistance(value);
    });
    characterCameraFolder.add(params, "maxCamDistance", 50, 1000, 1).name("Max Distance").decimals(0).onChange((value) => {
        player?.setMaxCamDistance(value);
    });
    characterCameraFolder.add(params, "camLookAtHeightRatio", 0, 1, 0.01).name("Look-at Height Ratio").decimals(2).onChange((value) => {
        player?.setCamLookAtHeightRatio(value);
    });
    characterCameraFolder.add(params, "enableOverShoulderView").name("Over-Shoulder View").onChange((value) => {
        player?.setOverShoulderView(value);
    });
    characterCameraFolder.add(params, "camOverShoulderOffsetRatio", -0.2, 0.2, 0.01).name("Over-Shoulder Offset").decimals(2).onChange((value) => {
        player?.setCamOverShoulderOffsetRatio(value);
    });
    characterCameraFolder.add(params, "enableSpringCamera").name("Spring Camera").onChange((value) => {
        if (player) player.cam.enableSpringCamera = value;
    });
    characterCameraFolder.add(params, "springCameraTime", 0.01, 1, 0.01).name("Spring Time").decimals(2).onChange((value) => {
        if (player) player.cam.springCameraTime = value;
    });
    characterCameraFolder.add(params, "thirdMouseMode", { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }).name("Mouse Mode").onChange((value) => {
        player?.setThirdMouseMode(Number(value));
    });
    characterCameraFolder.add(params, "enableZoom").name("Enable Zoom").onChange((value) => {
        player?.setEnableZoom(value);
    });
    characterCameraFolder.close();

    const footIKFolder = characterFolder.addFolder("Foot IK");
    footIKFolder.add(params, "footIKEnabled").name("Enabled").onChange((value) => {
        footIK?.setEnabled(value);
        footIK?.setDebugEnabled(value && params.footIKDebug);
    });
    footIKFolder.add(params, "footIKDebug").name("Debug Markers").onChange((value) => {
        footIK?.setDebugEnabled(value && params.footIKEnabled);
    });
    footIKFolder.add(params, "predictivePlacement").name("Predictive Placement").onChange((value) => {
        footIK?.configure({ predictivePlacement: value });
    });

    const footIKRuntimeFolder = footIKFolder.addFolder("Runtime");
    footIKRuntimeFolder.add(params, "leftFootPhase").name("Left Phase").listen().disable();
    footIKRuntimeFolder.add(params, "leftFootLand").name("Left Land").listen().disable();
    footIKRuntimeFolder.add(params, "leftFootIKWeight").name("Left IK Weight").decimals(3).listen().disable();
    footIKRuntimeFolder.add(params, "leftPrediction").name("Left Prediction").listen().disable();
    footIKRuntimeFolder.add(params, "rightFootPhase").name("Right Phase").listen().disable();
    footIKRuntimeFolder.add(params, "rightFootLand").name("Right Land").listen().disable();
    footIKRuntimeFolder.add(params, "rightFootIKWeight").name("Right IK Weight").decimals(3).listen().disable();
    footIKRuntimeFolder.add(params, "rightPrediction").name("Right Prediction").listen().disable();
    footIKRuntimeFolder.close();

    const pelvisFolder = footIKFolder.addFolder("Pelvis");
    pelvisFolder.add(params, "maxPelvisRaise", 0, 60, 1).name("Max Raise").decimals(0).onChange((value) => {
        applyFootIKOptions({ maxPelvisRaise: value });
    });
    pelvisFolder.add(params, "maxPelvisDrop", 0, 60, 1).name("Max Drop").decimals(0).onChange((value) => {
        applyFootIKOptions({ maxPelvisDrop: value });
    });
    pelvisFolder.close();

    const footReachFolder = footIKFolder.addFolder("Foot Reach");
    footReachFolder.add(params, "maxFootRaise", 0, 60, 1).name("Max Raise").decimals(0).onChange((value) => {
        applyFootIKOptions({ maxFootRaise: value });
    });
    footReachFolder.add(params, "maxFootDrop", 0, 60, 1).name("Max Drop").decimals(0).onChange((value) => {
        applyFootIKOptions({ maxFootDrop: value });
    });
    footReachFolder.close();

    const soleFolder = footIKFolder.addFolder("Sole Layout");
    soleFolder.add(params, "soleHalfWidth", 0, 24, 0.1).name("Half Width").decimals(1).onChange((value) => {
        applyFootIKOptions({ soleHalfWidth: value });
    });
    soleFolder.add(params, "soleToeExtend", 0, 24, 0.1).name("Toe Extend").decimals(1).onChange((value) => {
        applyFootIKOptions({ soleToeExtend: value });
    });
    soleFolder.add(params, "soleHeelExtend", 0, 24, 0.1).name("Heel Extend").decimals(1).onChange((value) => {
        applyFootIKOptions({ soleHeelExtend: value });
    });
    soleFolder.add(params, "soleSkinThickness", 0, 16, 0.1).name("Skin Thickness").decimals(1).onChange((value) => {
        applyFootIKOptions({ soleSkinThickness: value });
    });
    soleFolder.close();

    const predictionFolder = footIKFolder.addFolder("Prediction");
    predictionFolder.add(params, "maxPredictionClearance", 0, 80, 1).name("Max Clearance").decimals(0).onChange((value) => {
        applyFootIKOptions({ maxPredictionClearance: value });
    });
    predictionFolder.close();
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
    handlingFolder.add(params, "maxSteerDeg", 5, 60, 0.5).name("Max Steering Angle (deg)").onChange((deg) => {
        t.steering.maxSteerAngle = deg * Math.PI / 180;
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

// 窗口尺寸变化
function onResize() {
    const container = document.querySelector("#container");
    if (!container || !camera || !renderer) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

// 每帧调用
function animate(timestamp) {
    animTimer.update(timestamp);
    const rawDelta = Math.min(animTimer.getDelta(), 1 / 40);
    if (player) {
        scaledAnimTime += rawDelta * player.timeScale;
        updateGlowPortal(scaledAnimTime);
        updateKinematicPlatforms(scaledAnimTime);
        updateTrapScale();
        player.update(rawDelta);
    } else {
        updateGlowPortal(animTimer.getElapsed());
        controls?.update();
    }
    updateFootIKDebugPanel();
    renderer.render(scene, camera);
    stats?.update();
}

// 更新 Foot IK 运行状态只读字段。
function updateFootIKDebugPanel() {
    if (!footIKDebugParams || !footIK) return;
    footIKDebugParams.leftFootPhase = footIK.getFootPhaseDebugText("left");
    footIKDebugParams.leftFootLand = formatFootLandTime(footIK.getFootTimeToLand("left"));
    footIKDebugParams.leftFootIKWeight = footIK.getFootIKWeight("left");
    footIKDebugParams.leftPrediction = footIK.getPredictiveFootDebugText("left");
    footIKDebugParams.rightFootPhase = footIK.getFootPhaseDebugText("right");
    footIKDebugParams.rightFootLand = formatFootLandTime(footIK.getFootTimeToLand("right"));
    footIKDebugParams.rightFootIKWeight = footIK.getFootIKWeight("right");
    footIKDebugParams.rightPrediction = footIK.getPredictiveFootDebugText("right");
}

function formatFootLandTime(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)}s` : "--";
}
