import * as THREE from "three";
import TWEEN from "@tweenjs/tween.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { playerController } from "three-player-controller";

// ===== 全局变量 / 初始化 =====
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const player = playerController();
const tweenGroup = new TWEEN.Group();
const scene = new THREE.Scene();

let camera;
let renderer;
let controls;
let gltfLoader;

let isUpdatePlayer = false; // 是否更新玩家位置
const modelUrl = "./glb/burnout_revenge_-_central_route_crash_junction.glb";

const pos = new THREE.Vector3(21.88, 3, 10.98);

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio * 1);
}

window.addEventListener('load', async () => {
    await init();
});

window.addEventListener('beforeunload', () => {
    dispose();
});

async function init() {
    initCamera();
    initRenderer();
    initControls();
    await initBackground();
    initGltfLoader();
    await initGLBScene(modelUrl);

    // 首次渲染
    renderer.render(scene, camera);
    isUpdatePlayer = true; // 启用玩家更新

    // 初始化玩家控制器
    player.init({
    scene,
    camera,
    controls,
    playerModel: {
        url: "./glb/person.glb",
        scale: 0.001,
        idleAnim: "Idle_2",
        walkAnim: "Walking_11",
        runAnim: "Running_9",
        jumpAnim: "Jump_3",
    },
    initPos: pos,
    });

    window.addEventListener("resize", onWindowResize, false);
}

function dispose() {
    try {
    tweenGroup.removeAll();
    if (player && typeof player.destroy === 'function') player.destroy();
    if (renderer) renderer.dispose();
    if (controls) controls.dispose();
    if (renderer && typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();

    scene.traverse((child) => {
        if (!child) return;
        if (child.material) {
        if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose && m.dispose());
        } else {
            child.material.dispose && child.material.dispose();
        }
        }
        if (child.geometry) {
        child.geometry.dispose && child.geometry.dispose();
        }
    });

    window.removeEventListener("resize", onWindowResize, false);
    console.log("销毁完成");
    } catch (e) {
    console.error("销毁失败", e);
    }
}

// ===== 相机 =====
function initCamera() {
    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.rotation.order = "YXZ";
    camera.position.copy(pos);
    camera.lookAt(pos.x, pos.y, pos.z + 1);
}

// ===== 渲染器 =====
function initRenderer() {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.6;
    renderer.shadowMap.enabled = true;
    // renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setAnimationLoop(render);
    const container = document.getElementById("container");
    if (container) container.appendChild(renderer.domElement);
}

// ===== 控制器 =====
function initControls() {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxDistance = 2000;
    controls.dampingFactor = 0.1;
    controls.rotateSpeed = 1;
    controls.maxPolarAngle = Math.PI / 2;
    controls.target.set(pos.x, pos.y, pos.z + 1);
}

// ===== HDR 背景 & 环境光 =====
async function initBackground() {
    const color = 0xffffff;
    const intensity = 10;
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(50, 50, 50);
    light.target.position.set(0, 0, 0);
    light.castShadow = true;
    light.shadow.camera.top = 40;
    light.shadow.camera.bottom = -40;
    light.shadow.camera.left = -40;
    light.shadow.camera.right = 40;
    light.shadow.mapSize.width = 7680;
    light.shadow.mapSize.height = 7680;
    light.shadow.camera.near = 0;
    light.shadow.camera.far = 100;

    scene.add(light);
    scene.add(light.target);

    const ambient = new THREE.AmbientLight(0xffffff, 3.0);
    scene.add(ambient);

    return new Promise((resolve, reject) => {
    try {
        new HDRLoader().load("./sky/1.hdr", (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.background = texture;
        // scene.environment = texture;
        resolve();
        }, undefined, (err) => {
        console.warn("HDR 加载失败：", err);
        resolve(); 
        });
    } catch (e) {
        console.warn("HDRLoader 异常：", e);
        resolve();
    }
    });
}

// ===== GLTF 加载器配置 =====
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

// ===== 加载 GLB 场景 =====
async function initGLBScene(url) {
    try {
    const gltf = await gltfLoader.loadAsync(url);
    const model = gltf.scene;
    model.name = "sceneGLB";
    model.scale.set(10, 10, 10);
    model.traverse((child) => {
        if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true; // 接收阴影
        child.material.side = 0;
        }
    });
    scene.add(model);
    } catch (e) {
    console.error("GLB 加载失败：", e);
    }
}

// ===== 渲染循环 =====
function render() {
    if (isUpdatePlayer) {
    if (player && typeof player.update === 'function') player.update(); // 更新玩家
    } else {
    controls.update();
    }
    renderer.render(scene, camera);
    tweenGroup.update();
}
