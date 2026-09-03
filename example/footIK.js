import {
    ACESFilmicToneMapping,
    AmbientLight,
    BoxGeometry,
    DirectionalLight,
    Group,
    LineBasicMaterial,
    LineSegments,
    Mesh,
    MeshStandardMaterial,
    VSMShadowMap,
    PerspectiveCamera,
    Scene,
    BufferGeometry,
    Float32BufferAttribute,
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

const scene = new Scene();

let camera;
let renderer;
let controls;
let player;
let footIK;
let sky;
let gui;
let footIKDebugParams;
let stats;
let leftMouseSlowMotion = false;
let rightMouseSlowMotion = false;
let savedPlayerTimeScale = 1;

init();

async function init() {
    const container = document.querySelector("#container");

    // 渲染器
    renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.8;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = VSMShadowMap;
    renderer.setAnimationLoop(animate);
    container.appendChild(renderer.domElement);

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
    camera = new PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.01, 500);
    camera.position.set(-6, 6, 9);

    // 控制器
    controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxDistance = 80;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.target.set(0, 0.8, 0);

    // 环境光
    scene.add(new AmbientLight(0xffffff, 1.8));

    // 平行光
    const sun = new DirectionalLight(0xffffff, 2);
    sun.position.set(6, 10, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 35;
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 10;
    sun.shadow.camera.bottom = -10;
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    sky = new Sky();
    sky.scale.setScalar(450000);
    scene.add(sky);
    const skyUniforms = sky.material.uniforms;
    skyUniforms["turbidity"].value = 10;
    skyUniforms["rayleigh"].value = 2;
    skyUniforms["mieCoefficient"].value = 0.005;
    skyUniforms["mieDirectionalG"].value = 0.99;
    updateSkySun(sun);

    // 测试场景
    const staticCollider = buildTestCourse();
    scene.add(staticCollider);
    addGroundGrid(scene);

    // 人物控制器
    const gltfLoader = new GLTFLoader();
    const playerGltf = await gltfLoader.loadAsync("./glb/ual.glb");

    player = new playerController();
    await player.init({
        scene,
        camera,
        controls,
        colliders: [
            { motion: "static", shape: { kind: "mesh", source: staticCollider } },
        ],
        initPos: new Vector3(-7.5, 0.25, -3.5),
        minCamDistance: 10,
        maxCamDistance: 300,
        camLookAtHeightRatio: 0.5,
        enableSpringCamera: true,
        playerModelConfig: {
            model: playerGltf.scene,
            animations: playerGltf.animations,
            scale: 0.005,
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
            speed: 100,
            runSpeed: 600,
            headBoneName: "Head",
            firstPersonCameraOffset: [0, 0.15, 0.12],
            rotateY: Math.PI / 2,
        },
        // keyMap: { toggleFly: null }, // 关闭飞行
    });
    enableModelShadows(player.playerModel);

    // 骨骼配置
    const skeleton = {
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
    };

    footIK = new FootIK({
        skeleton,
        soleSkinThickness: 1.6,
        predictivePlacement: true,
    });
    player.use(footIK);

    createDebugPanel();

    window.addEventListener("resize", onResize);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", releaseRightMouseSlowMotion);
    renderer.domElement.addEventListener("contextmenu", event => event.preventDefault());

    window.hideLoader?.();
}

// 创建调试面板
function createDebugPanel() {
    const footIKOptions = footIK?.getOptions() ?? {};
    const roundedValue = (value, fallback, decimals = 1) => {
        const factor = 10 ** decimals;
        return Math.round((value ?? fallback) * factor) / factor;
    };
    const params = {
        colliderDebug: false,
        playerCapsuleDebug: false,
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
        soleToeExtend: roundedValue(footIKOptions.soleToeExtend, 4),
        soleHeelExtend: roundedValue(footIKOptions.soleHeelExtend, 3),
        soleSkinThickness: roundedValue(footIKOptions.soleSkinThickness, 3),
        maxPredictionClearance: roundedValue(footIKOptions.maxPredictionClearance, 50, 0),
    };
    footIKDebugParams = params;

    const applyFootIKOptions = (patch) => {
        footIK?.configure(patch);
    };

    footIK?.setDebugEnabled(params.footIKDebug && params.footIKEnabled);

    gui = new GUI({ title: "Foot IK Controls", width: 320 });
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
    collisionFolder.add(params, "playerCapsuleDebug").name("Capsule").onChange((value) => {
        player?.setPlayerCapsuleDebug?.(value);
    });
    collisionFolder.open();

    const footIKFolder = gui.addFolder("Foot IK");
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
    footIKFolder.open();
}

// 更新天空太阳方向。
function updateSkySun(light) {
    sky.material.uniforms["sunPosition"].value.copy(light.position).normalize();
}

// 创建测试场景
function buildTestCourse() {
    const root = new Group();
    const groundMat = new MeshStandardMaterial({ color: 0xd8d5cf, roughness: 0.9 });
    const stairMats = [
        new MeshStandardMaterial({ color: 0xb8b0a1, roughness: 0.75 }),
        new MeshStandardMaterial({ color: 0xc3a28f, roughness: 0.75 }),
        new MeshStandardMaterial({ color: 0xa8b4c4, roughness: 0.75 }),
    ];
    const rampMats = [
        new MeshStandardMaterial({ color: 0xadbca8, roughness: 0.8 }),
        new MeshStandardMaterial({ color: 0x9fb7b4, roughness: 0.8 }),
        new MeshStandardMaterial({ color: 0xc0b48c, roughness: 0.8 }),
    ];
    const speedBumpMats = [
        new MeshStandardMaterial({ color: 0xe5b73b, roughness: 0.72 }),
        new MeshStandardMaterial({ color: 0x4b4a46, roughness: 0.82 }),
    ];
    const wallMat = new MeshStandardMaterial({ color: 0x9a9691, roughness: 0.88 });

    addBox(root, new Vector3(0, -0.06, 0), new Vector3(20, 0.12, 12), groundMat);
    createBoundaryWalls(root, wallMat);

    createStairs(root, new Vector3(-6.5, 0, -3.5), 0.08, stairMats[0]);
    createStairs(root, new Vector3(-1.2, 0, -3.5), 0.12, stairMats[1]);
    createStairs(root, new Vector3(4.1, 0, -3.5), 0.16, stairMats[2]);

    createSpeedBumpCourse(root, -0.25, speedBumpMats);

    createRamp(root, new Vector3(-6.1, 0, 3), 10, rampMats[0]);
    createRamp(root, new Vector3(-0.3, 0, 3), 18, rampMats[1]);
    createRamp(root, new Vector3(5.8, 0, 3), 28, rampMats[2]);

    return root;
}

// 创建地面网格
function addGroundGrid(root) {
    const width = 20;
    const depth = 12;
    const step = 1;
    const points = [];

    for (let x = -width / 2; x <= width / 2 + 0.0001; x += step) {
        points.push(new Vector3(x, 0, -depth / 2), new Vector3(x, 0, depth / 2));
    }
    for (let z = -depth / 2; z <= depth / 2 + 0.0001; z += step) {
        points.push(new Vector3(-width / 2, 0, z), new Vector3(width / 2, 0, z));
    }

    const geometry = new BufferGeometry().setFromPoints(points);
    const material = new LineBasicMaterial({ color: 0xbcb7af });
    const grid = new LineSegments(geometry, material);
    grid.position.y = 0.004;
    root.add(grid);
    return grid;
}

// 创建一组边界墙
function createBoundaryWalls(root, material) {
    const wallHeight = 1.2;
    const wallThickness = 0.16;
    const halfWidth = 10;
    const halfDepth = 6;
    const centerY = wallHeight / 2;

    addBox(root, new Vector3(0, centerY, -halfDepth), new Vector3(halfWidth * 2, wallHeight, wallThickness), material);
    addBox(root, new Vector3(0, centerY, halfDepth), new Vector3(halfWidth * 2, wallHeight, wallThickness), material);
    addBox(root, new Vector3(-halfWidth, centerY, 0), new Vector3(wallThickness, wallHeight, halfDepth * 2), material);
    addBox(root, new Vector3(halfWidth, centerY, 0), new Vector3(wallThickness, wallHeight, halfDepth * 2), material);
}

// 创建一组楼梯
function createStairs(root, start, stepHeight, material) {
    const stepCount = 7;
    const stepDepth = 0.42;
    const width = 1.9;

    for (let i = 0; i < stepCount; i++) {
        const height = stepHeight * (i + 1);
        addBox(
            root,
            new Vector3(start.x + i * stepDepth, height / 2, start.z),
            new Vector3(stepDepth, height, width),
            material,
        );
    }
}

// 在楼梯和斜坡之间创建 10 个高度统一、宽度不超过 0.32 的长方体。
function createSpeedBumpCourse(root, centerZ, materials) {
    const height = 0.140;
    const depth = 1.7;
    const widths = [0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.26, 0.28, 0.30, 0.32];
    const gaps = [0.32, 0.58, 0.41, 0.75, 0.36, 0.63, 0.48, 0.71, 0.54];
    const totalWidth = widths.reduce((sum, width) => sum + width, 0)
        + gaps.reduce((sum, gap) => sum + gap, 0);
    let cursorX = -totalWidth / 2;

    widths.forEach((width, index) => {
        addBox(
            root,
            new Vector3(cursorX + width / 2, height / 2, centerZ),
            new Vector3(width, height, depth),
            materials[index % materials.length],
        );
        cursorX += width + (gaps[index] ?? 0);
    });
}

// 创建一个斜坡
function createRamp(root, position, angleDeg, material) {
    const length = 3.4;
    const width = 1.8;
    const height = Math.tan(angleDeg * Math.PI / 180) * length;
    const ramp = new Mesh(createRampGeometry(length, height, width), material);
    ramp.position.copy(position);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    root.add(ramp);
    return ramp;
}

// 创建斜坡碰撞几何体。
function createRampGeometry(length, height, width) {
    const halfLength = length / 2;
    const halfWidth = width / 2;
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
    const flatGeometry = geometry.toNonIndexed();
    flatGeometry.computeVertexNormals();
    return flatGeometry;
}

function addBox(root, position, scale, material) {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
    mesh.position.copy(position);
    mesh.scale.copy(scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
}

// 启用模型阴影
function enableModelShadows(root) {
    root?.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow = true;
        obj.receiveShadow = true;
    });
}

// 每帧调用
function animate() {
    if (player) {
        player.update();
    } else {
        controls.update();
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

// 鼠标右键慢动作
function onMouseDown(event) {
    if (!player) return;
    if (event.button == 2) {
        rightMouseSlowMotion = true;
    }
    if (event.button == 0) {
        leftMouseSlowMotion = true;
    }
    updatePlayerTimeScale();
}

// 鼠标右键慢动作释放
function onMouseUp(event) {
    if (event.button == 2) {
        rightMouseSlowMotion = false;
    }
    if (event.button == 0) {
        leftMouseSlowMotion = false;
    }
    updatePlayerTimeScale();

}

// 集中更新 player.timeScale
function releaseRightMouseSlowMotion() {
    rightMouseSlowMotion = false;
    leftMouseSlowMotion = false;
    updatePlayerTimeScale();
}

// 更新 player.timeScale
function updatePlayerTimeScale() {
    if (!player) return;

    if (leftMouseSlowMotion) {
        player.timeScale = 0;
    } else if (rightMouseSlowMotion) {
        player.timeScale = 0.1;
    } else {
        player.timeScale = savedPlayerTimeScale;
    }
}

// 窗口尺寸变化
function onResize() {
    const container = document.querySelector("#container");
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}
