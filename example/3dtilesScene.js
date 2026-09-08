import tellux from "tellux";
import {
    AxesHelper,
    Box3,
    DirectionalLight,
    Group,
    HemisphereLight,
    Matrix4,
    Quaternion,
    Sphere,
    Vector3,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import Stats from "three/examples/jsm/libs/stats.module.js";
import { playerController } from "../src/PlayerController";

// Google Photorealistic 3D Tiles
const GOOGLE_PHOTOREALISTIC_ASSET_ID = 2275207;
const CESIUM_ION_TOKEN =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJmMzgwMGY3ZS1jOTMwLTQyNmQtOTkyNS03MDE4ZjlkYmY0MTYiLCJpZCI6MjIzMDk3LCJpYXQiOjE3MTg3NjgwNTN9.FcpK7jiFPzWZL8m6VxRbG7ly8LMecpXnDAMZJX_UehM";

// 出生城市
const CITIES = {
    paris: { longitude: 2.2945, latitude: 48.8584, height: 100, hourUTC: 12 },
    tokyo: { longitude: 139.7671, latitude: 35.6812, height: 40, hourUTC: 4 },
    newyork: { longitude: -74.006, latitude: 40.7128, height: 20, hourUTC: 17 },
    london: { longitude: -0.1246, latitude: 51.5007, height: 40, hourUTC: 14 },
    sydney: { longitude: 151.2153, latitude: -33.8568, height: 40, hourUTC: 3 },
    dubai: { longitude: 55.2744, latitude: 25.1972, height: 40, hourUTC: 8 },
    rome: { longitude: 12.4922, latitude: 41.8902, height: 40, hourUTC: 11 },
    saopaulo: { longitude: -46.6559, latitude: -23.5615, height: 1000, hourUTC: 16 },
};
const CITY_OPTIONS = {
    "New York": "newyork",
    Paris: "paris",
    Tokyo: "tokyo",
    London: "london",
    Sydney: "sydney",
    Dubai: "dubai",
    Rome: "rome",
    "São Paulo": "saopaulo",
};

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// 动态碰撞：靠近才建，远离再拆
const TILE_ENTER_RADIUS = 100;
const TILE_EXIT_RADIUS = 150;
const MAX_TILE_ADDS_PER_UPDATE = 1;
const MAX_TILE_REMOVES_PER_UPDATE = 4;

// 人物速度；飞行时按住 Shift 进入极速
const BASE_WALK_SPEED = 200;
const BASE_RUN_SPEED = 600;
const BASE_FLY_SPEED = 2100;
const TURBO_SPEED_SCALE = 3;

// 大气与体积云：启动时关闭，检测到玩家落地后再开启
const CLOUD_COVERAGE = 0.35;

const container = document.querySelector("#container");
if (!(container instanceof HTMLElement)) {
    throw new Error("Missing #container");
}

const attributionsElement = document.querySelector("#google-attributions");

const guiParams = {
    city: "newyork",
    playerCapsuleDebug: false,
    colliderDebug: false,
    localAxes: false,
};

// Tellux 视图
const viewer = new tellux.Viewer(container, {
    dracoDecoderPath: "https://unpkg.com/three@0.184.0/examples/jsm/libs/draco/gltf/",
    useDefaultRenderLoop: false,
    camera: {
        longitude: CITIES.newyork.longitude,
        latitude: CITIES.newyork.latitude,
        height: 80,
        heading: 0,
        pitch: -20,
        near: 0.1,
    },
    scene: {
        atmosphere: {
            show: false,
            lighting: {
                mode: "post-process",
                sunLight: true,
                skyLight: true,
            },
            sky: {
                sun: true,
                moon: true,
                stars: true,
            },
        },
        clouds: {
            show: false,
            coverage: CLOUD_COVERAGE,
        },
        postProcess: {
            lensFlare: { enabled: false },
            smaa: { enabled: false },
        },
    },
});

// 关闭默认地球交互，改由人物控制器接管相机
viewer.controls.enabled = false;
viewer.camera.allowUnderground = true;
viewer.tileset.group.visible = false;

// 环境光
const hemiLight = new HemisphereLight(0xc8e0ff, 0x3d2b1f, 1.1);
// 平行光
const sunLight = new DirectionalLight(0xfff4e0, 1.6);
sunLight.position.set(40, 80, 20);
viewer.scene.threeScene.add(hemiLight, sunLight);

// 控制器
const orbitControls = new OrbitControls(viewer.camera.threeCamera, viewer.renderer.domElement);
orbitControls.enablePan = false;

// 局部坐标轴
const localAxes = new AxesHelper(5000);
localAxes.name = "local-axes";
localAxes.visible = false;
localAxes.renderOrder = 10;
localAxes.traverse((object) => {
    if (!object.material || Array.isArray(object.material)) return;
    object.material.depthTest = false;
    object.material.depthWrite = false;
});
viewer.scene.threeScene.add(localAxes);

// 帧率
const stats = new Stats();
Object.assign(stats.dom.style, {
    position: "fixed",
    left: "0",
    bottom: "0",
    top: "auto",
    zIndex: "9998",
});
document.body.appendChild(stats.dom);

let activeLayer = null;
let localFrame = null;
let tileCollision = null;
let player = null;
let skipCollisionAfterRebase = false;
let attributionFrame = 0;
let running = true;
let turboMode = false;
let atmosphereCloudsEnabled = false;

// 局部坐标系下每帧把世界到 ECEF 的矩阵写进大气。
function setAtmosphereWorldToECEFMatrix(targetViewer, matrix) {
    const atmosphere = targetViewer.atmosphere;
    if (!atmosphere) return;

    if (typeof atmosphere.setWorldToECEFMatrix === "function") {
        atmosphere.setWorldToECEFMatrix(matrix);
        return;
    }

    const targets = [
        atmosphere.aerialPerspectiveEffect,
        atmosphere.cloudsEffect,
        atmosphere.sunLightSource,
        atmosphere.moonLightSource,
        atmosphere.skyLightSource,
        atmosphere.starsMaterial,
    ];

    for (const target of targets) {
        copyWorldToECEFMatrix(target, matrix);
    }
}

// 把矩阵写到大气、云或天体上的 worldToECEFMatrix。
function copyWorldToECEFMatrix(target, matrix) {
    if (!target) return;
    const dest = target.worldToECEFMatrix;
    if (dest?.copy) {
        dest.copy(matrix);
        return;
    }
    if (dest?.value?.copy) dest.value.copy(matrix);
}

// 玩家落地后开启大气、体积云与大气光照。
function enableAtmosphereAndClouds() {
    if (localFrame) setAtmosphereWorldToECEFMatrix(viewer, localFrame.localToEcef);
    viewer.scene.atmosphere.show = true;
    viewer.scene.clouds.show = true;
    viewer.scene.clouds.coverage = CLOUD_COVERAGE;
    viewer.scene.syncRuntimeEffects();
    viewer.postProcessing?.applyEffects();
    if (viewer.atmosphere?.setAtmosphereVisible) {
        viewer.atmosphere.setAtmosphereVisible(true);
    }
    viewer.atmosphere?.updateLightSources?.();
    hemiLight.visible = false;
    sunLight.visible = false;
    atmosphereCloudsEnabled = true;
}

// 每帧检测：玩家在地面且碰撞已生效时，再开大气与光照。
function tryEnableAtmosphereAndClouds() {
    if (atmosphereCloudsEnabled || !player || !localFrame || skipCollisionAfterRebase) return;
    if (!player.getIsOnGround()) return;
    enableAtmosphereAndClouds();
}

// 以人物附近 ECEF 点建立局部 Y-up 坐标系，走远后 rebase。
class LocalFrameManager {
    // 建局部 ENU 根节点，并按出生点设原点
    constructor(ellipsoid, origin) {
        this.ellipsoid = ellipsoid;
        this.rebaseDistance = 10_000;
        this.group = new Group();
        this.group.name = "local-frame";
        this.group.matrixAutoUpdate = false;
        this.localToEcef = new Matrix4();
        this.ecefToLocal = new Matrix4();
        this.objectFrame = new Matrix4();
        this.deltaMatrix = new Matrix4();
        this.deltaQuat = new Quaternion();
        this.scratchEcef = new Vector3();
        this.scratchCartographic = { lat: 0, lon: 0, height: 0 };
        this.setOrigin(origin);
    }

    // 把 3D Tiles 挂到局部坐标系下
    attachTilesetGroup(tilesetGroup, scene) {
        tilesetGroup.parent?.remove(tilesetGroup);
        if (this.group.parent !== scene) scene.add(this.group);
        this.group.add(tilesetGroup);
        this.group.updateMatrixWorld(true);
    }

    // 按经纬高重设局部原点
    setOrigin(origin) {
        const height = origin.height ?? 0;
        this.ellipsoid.getObjectFrame(
            origin.latitude * DEG2RAD,
            origin.longitude * DEG2RAD,
            height,
            0,
            0,
            0,
            this.objectFrame
        );
        this.localToEcef.copy(this.objectFrame);
        this.ecefToLocal.copy(this.objectFrame).invert();
        this.group.matrix.copy(this.ecefToLocal);
        this.group.updateMatrixWorld(true);
    }

    // 局部点转到 ECEF
    localToEcefPoint(local, target = new Vector3()) {
        return target.copy(local).applyMatrix4(this.localToEcef);
    }

    // 人物离原点太远时平移局部系，并同步胶囊、相机和速度
    maybeRebase(target) {
        const position = target.getPosition();
        if (!position || position.length() < this.rebaseDistance) return false;

        this.localToEcefPoint(position, this.scratchEcef);
        this.ellipsoid.getPositionToCartographic(this.scratchEcef, this.scratchCartographic);

        this.deltaMatrix.copy(this.localToEcef);
        this.setOrigin({
            latitude: this.scratchCartographic.lat * RAD2DEG,
            longitude: this.scratchCartographic.lon * RAD2DEG,
            height: this.scratchCartographic.height,
        });
        this.deltaMatrix.premultiply(this.ecefToLocal);
        this.deltaQuat.setFromRotationMatrix(this.deltaMatrix);

        const capsule = target.getPlayerCapsule();
        if (capsule) this.applyDelta(capsule, this.deltaMatrix);
        if (!this.isDescendant(target.camera, capsule)) {
            this.applyDelta(target.camera, this.deltaMatrix);
        }
        target.controls?.target.applyMatrix4(this.deltaMatrix);
        target.playerVelocity?.applyQuaternion(this.deltaQuat);
        return true;
    }

    // 判断 object 是否挂在 ancestor 下面
    isDescendant(object, ancestor) {
        if (!ancestor) return false;
        let current = object;
        while (current) {
            if (current === ancestor) return true;
            current = current.parent;
        }
        return false;
    }

    // 用 rebase 增量改物体位姿
    applyDelta(object, delta) {
        object.updateMatrixWorld(true);
        object.matrix.premultiply(delta);
        object.matrix.decompose(object.position, object.quaternion, object.scale);
        object.updateMatrixWorld(true);
    }
}

// 登记已加载瓦片，只给当前可见且靠近人物的瓦片建运动学 mesh 碰撞。
class TileCollisionManager {
    // 绑定瓦片集和人物，并备好事件回调
    constructor(tileset, targetPlayer) {
        this.tileset = tileset;
        this.player = targetPlayer;
        this.attached = false;
        this.tracked = new Map();
        this.scratchCenter = new Vector3();
        this.scratchScale = new Vector3();
        this.scratchBox = new Box3();
        this.scratchSphere = new Sphere();
        this.onLoadModel = (event) => this.track(event.scene, this.isTileVisible(event.tile, event.scene));
        this.onDisposeModel = (event) => this.untrack(event.scene);
        this.onVisibilityChange = (event) => this.setVisible(event.scene, event.visible, event.tile);
    }

    // 监听加载 / 卸载 / 可见性，并补登记已在场的瓦片
    attach() {
        if (this.attached) return;
        this.attached = true;
        this.tileset.addEventListener("load-model", this.onLoadModel);
        this.tileset.addEventListener("dispose-model", this.onDisposeModel);
        this.tileset.addEventListener("tile-visibility-change", this.onVisibilityChange);
        this.tileset.forEachLoadedModel((scene, tile) => this.track(scene, this.isTileVisible(tile, scene)));
    }

    // 去掉瓦片事件，不再跟踪新变化
    detach() {
        if (!this.attached) return;
        this.attached = false;
        this.tileset.removeEventListener("load-model", this.onLoadModel);
        this.tileset.removeEventListener("dispose-model", this.onDisposeModel);
        this.tileset.removeEventListener("tile-visibility-change", this.onVisibilityChange);
    }

    // 拆掉全部碰撞并停止跟踪
    dispose() {
        this.detach();
        for (const entry of this.tracked.values()) this.removeCollider(entry);
        this.tracked.clear();
    }

    // 只给当前可见且靠近的瓦片建碰撞；隐藏的（含 REPLACE 父级）立刻拆
    update(playerPos) {
        let adds = 0;
        let removes = 0;
        for (const entry of this.tracked.values()) {
            if (!entry.visible) {
                this.removeCollider(entry);
                continue;
            }
            const distance = this.distanceToTile(entry, playerPos);
            if (!entry.handle && distance < TILE_ENTER_RADIUS) {
                if (adds >= MAX_TILE_ADDS_PER_UPDATE) continue;
                const handle = this.player.addCollider({
                    motion: "kinematic",
                    useWorker: true,
                    shape: { kind: "mesh", source: entry.scene },
                    follow: entry.scene,
                });
                if (handle.id < 0) continue;
                entry.handle = handle;
                adds += 1;
            } else if (entry.handle && distance > TILE_EXIT_RADIUS) {
                if (removes >= MAX_TILE_REMOVES_PER_UPDATE) continue;
                this.removeCollider(entry);
                removes += 1;
            }
        }
    }

    // 人物到瓦片包围球表面的距离；负值表示人在球内
    distanceToTile(entry, playerPos) {
        entry.scene.updateWorldMatrix(true, false);
        this.scratchCenter.copy(entry.localCenter).applyMatrix4(entry.scene.matrixWorld);
        entry.scene.getWorldScale(this.scratchScale);
        const worldRadius = entry.localRadius * (this.scratchScale.x || 1);
        return playerPos.distanceTo(this.scratchCenter) - worldRadius;
    }

    // 以 traversal.visible 为准，没有则看 scene 是否还挂在树上
    isTileVisible(tile, scene) {
        if (typeof tile?.traversal?.visible === "boolean") return tile.traversal.visible;
        return Boolean(scene?.parent);
    }

    // 同步可见性；藏起来就拆碰撞，避免粗父级残留
    setVisible(scene, visible, tile) {
        const entry = this.tracked.get(scene) ?? this.track(scene, visible);
        if (!entry) return;
        entry.visible = visible;
        if (!visible) this.removeCollider(entry);
        if (tile) entry.tile = tile;
    }

    // 登记瓦片局部中心和半径，已跟踪则只改可见性
    track(scene, visible = Boolean(scene.parent)) {
        const existing = this.tracked.get(scene);
        if (existing) {
            existing.visible = visible;
            return existing;
        }
        scene.updateWorldMatrix(true, true);
        this.scratchBox.setFromObject(scene);
        if (this.scratchBox.isEmpty()) return null;
        this.scratchBox.getBoundingSphere(this.scratchSphere);
        const localCenter = scene.worldToLocal(this.scratchSphere.center.clone());
        scene.getWorldScale(this.scratchScale);
        const scale = this.scratchScale.x || 1;
        const entry = {
            scene,
            localCenter,
            localRadius: this.scratchSphere.radius / scale,
            visible,
            handle: null,
        };
        this.tracked.set(scene, entry);
        return entry;
    }

    // 瓦片卸载时拆碰撞并移出跟踪表
    untrack(scene) {
        const entry = this.tracked.get(scene);
        if (!entry) return;
        this.removeCollider(entry);
        this.tracked.delete(scene);
    }

    // 从人物控制器移除该瓦片的运动学碰撞
    removeCollider(entry) {
        if (!entry.handle) return;
        this.player.removeCollider(entry.handle);
        entry.handle = null;
    }
}

// 当前选中的出生城市
function currentCity() {
    return guiParams.city in CITIES ? guiParams.city : "newyork";
}

// 局部坐标系中的出生点
function spawnLocalPosition() {
    return new Vector3(0, 100, 0);
}

// 渲染 Google / Cesium 版权信息
function renderAttributions() {
    if (!attributionsElement) return;
    const attributions = activeLayer?.tileset.getAttributions() ?? [];
    attributionsElement.replaceChildren();
    for (const attribution of attributions) {
        if (attribution.type === "image") {
            const image = document.createElement("img");
            image.src = String(attribution.value);
            image.alt = "";
            attributionsElement.append(image);
            continue;
        }
        if (attribution.value) {
            const item = document.createElement("span");
            item.innerHTML = String(attribution.value);
            attributionsElement.append(item);
        }
    }
}

// 每帧刷新版权条
function scheduleAttributionUpdate() {
    renderAttributions();
    attributionFrame = window.requestAnimationFrame(scheduleAttributionUpdate);
}

// 创建或更新局部坐标系
function ensureLocalFrame(origin = CITIES[currentCity()]) {
    if (!localFrame) {
        localFrame = new LocalFrameManager(viewer.tileset.ellipsoid, origin);
        viewer.scene.threeScene.add(localFrame.group);
        return;
    }
    localFrame.setOrigin(origin);
}

// 把当前 3D Tiles 挂到局部坐标系
function attachTilesetToLocalFrame() {
    if (!activeLayer || !localFrame) return;
    localFrame.attachTilesetGroup(activeLayer.tileset.group, viewer.scene.threeScene);
}

// 应用步行 / 奔跑 / 飞行速度，极速时放大飞行速度
function applySpeedMode(target = player) {
    if (!target) return;
    const speedScale = turboMode ? TURBO_SPEED_SCALE : 1;
    target.setPlayerSpeed(BASE_WALK_SPEED);
    target.setPlayerRunSpeed(BASE_RUN_SPEED);
    target.setPlayerFlySpeed(BASE_FLY_SPEED * speedScale);
}

// 飞行时按住 Shift 切换极速
function syncTurboMode() {
    if (!player) return;
    const next = player.isFlying && player.input.shift;
    if (next === turboMode) return;
    turboMode = next;
    applySpeedMode(player);
}

// 极速时拉宽视野
function updateTurboFov() {
    const camera = viewer.camera.threeCamera;
    const targetFov = turboMode ? 120 : 60;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov += (targetFov - camera.fov) * 0.01;
        camera.updateProjectionMatrix();
    }
}

// 绑定当前瓦片图层的动态碰撞
function bindTileCollision() {
    if (!activeLayer || !player) return;
    tileCollision?.dispose();
    tileCollision = new TileCollisionManager(activeLayer.tileset, player);
    tileCollision.attach();
}

// 切换城市或重新出生
function respawn() {
    ensureLocalFrame(CITIES[currentCity()]);
    attachTilesetToLocalFrame();
    viewer.clock.hourUTC = CITIES[currentCity()].hourUTC;
    player?.reset(spawnLocalPosition());
    player?.setSkipCapsuleCollision(true);
    skipCollisionAfterRebase = true;
}

// 加载 Google Photorealistic 3D Tiles
function loadPhotorealisticTiles() {
    tileCollision?.dispose();
    tileCollision = null;
    activeLayer?.remove();
    ensureLocalFrame(CITIES[currentCity()]);
    activeLayer = viewer.load3DTileset({
        type: "cesium-ion",
        id: "photorealistic-3d-tiles",
        assetId: GOOGLE_PHOTOREALISTIC_ASSET_ID,
        apiToken: CESIUM_ION_TOKEN,
        creasedNormals: true,
        materialMode: "unlit",
    });
    attachTilesetToLocalFrame();
    if (player) bindTileCollision();
}

// 玩家控制器
async function ensurePlayer() {
    if (player) return player;

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync("./glb/josh.glb");
    player = new playerController();
    await player.init({
        scene: viewer.scene.threeScene,
        camera: viewer.camera.threeCamera,
        controls: orbitControls,
        initPos: spawnLocalPosition(),
        minCamDistance: 5,
        maxCamDistance: 200,
        playerModelConfig: {
            model: gltf.scene,
            animations: gltf.animations ?? [],
            scale: 0.01,
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
            headBoneName: "mixamorigHead",
            rotateY: Math.PI,
            acceleration: 500,
            deceleration: 10000000,
        },
    });
    player.setPlayerCapsuleDebug(guiParams.playerCapsuleDebug);
    player.setColliderDebug(guiParams.colliderDebug);
    applySpeedMode(player);
    // 启用实际太阳光、天空光和环境反射。
    viewer.atmosphere?.setPostProcessMaterialLights?.(true);
    return player;
}

// 创建调试面板
function initGUI() {
    const gui = new GUI({ title: "3D Tiles Scene", width: 260 });
    if (window.matchMedia("(hover: none) and (pointer: coarse), (max-width: 768px)").matches) gui.close();
    Object.assign(gui.domElement.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: "9999",
    });
    gui.domElement.addEventListener("pointerdown", (e) => e.stopPropagation());

    gui.add(guiParams, "city", CITY_OPTIONS).name("City").onChange(() => {
        respawn();
    });
    gui.add(guiParams, "playerCapsuleDebug").name("Capsule Debug").onChange((value) => {
        player?.setPlayerCapsuleDebug(value);
    });
    gui.add(guiParams, "colliderDebug").name("Collider Debug").onChange((value) => {
        player?.setColliderDebug(value);
    });
    gui.add(guiParams, "localAxes").name("Local Axes").onChange((value) => {
        localAxes.visible = value;
    });
}

// 启动示例
async function start() {
    await viewer.ready;
    ensureLocalFrame(CITIES[currentCity()]);
    loadPhotorealisticTiles();
    await ensurePlayer();
    bindTileCollision();
    respawn();
    initGUI();
    // 关闭加载页面
    window.hideLoader?.();
}

// 每帧调用
function loop(time) {
    if (!running) return;
    if (player) {
        if (skipCollisionAfterRebase) {
            player.setSkipCapsuleCollision(false);
            skipCollisionAfterRebase = false;
        }
        syncTurboMode();
        void player.update();
        syncTurboMode();
        if (localFrame?.maybeRebase(player)) {
            player.setSkipCapsuleCollision(true);
            skipCollisionAfterRebase = true;
        }
        const pos = player.getPosition();
        if (pos) tileCollision?.update(pos);
        tryEnableAtmosphereAndClouds();
    }
    updateTurboFov();
    // 局部坐标系下同步大气世界到 ECEF 的变换
    if (localFrame) setAtmosphereWorldToECEFMatrix(viewer, localFrame.localToEcef);
    viewer.render(time);
    stats.update();
    requestAnimationFrame(loop);
}

window.viewer = viewer;
scheduleAttributionUpdate();
void start();
requestAnimationFrame(loop);

// 页面卸载时释放资源
window.addEventListener("beforeunload", () => {
    running = false;
    window.cancelAnimationFrame(attributionFrame);
    tileCollision?.dispose();
    player?.destroy();
    stats.dom.remove();
    viewer.destroy();
});
