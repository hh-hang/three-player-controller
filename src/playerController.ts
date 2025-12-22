import * as THREE from "three";
import { MeshBVH, MeshBVHHelper } from "three-mesh-bvh";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { GLTF } from "three/examples/jsm/Addons.js";

let controllerInstance: PlayerController | null = null; // 单例实例
const clock = new THREE.Clock();

class PlayerController {
    loader: GLTFLoader = new GLTFLoader();

    //  基本配置与参数
    scene!: THREE.Scene;
    camera!: THREE.PerspectiveCamera;
    controls!: OrbitControls;
    initPos!: THREE.Vector3;
    playerModel!: {
        url: string;
        idleAnim: string;
        walkAnim: string;
        runAnim: string;
        jumpAnim: string;
        leftWalkAnim?: string;
        rightWalkAnim?: string;
        backwardAnim?: string;
        scale: number;
    };
    visualizeDepth!: number;
    gravity!: number;
    jumpHeight!: number;
    highJumpHeight!: number;
    playerSpeed!: number;
    mouseSensity!: number;

    playerRadius: number = 45;
    playerHeight: number = 180;
    isFirstPerson: boolean = false;
    boundingBoxMinY: number = 0;
    // 测试参数
    displayPlayer: boolean = false;
    displayCollider: boolean = false;
    displayVisualizer: boolean = false;

    //  场景对象
    collider: THREE.Mesh | null = null;
    visualizer: MeshBVHHelper | null = null;
    player!: THREE.Mesh & { capsuleInfo?: any };
    person: THREE.Object3D | null = null;

    //  状态开关
    playerIsOnGround: boolean = false;
    isupdate: boolean = true;

    //  输入状态
    fwdPressed: boolean = false;
    bkdPressed: boolean = false;
    lftPressed: boolean = false;
    rgtPressed: boolean = false;
    spacePressed: boolean = false;
    ctPressed: boolean = false;
    shiftPressed: boolean = false;
    sustainSpacePressed: boolean = false;
    spaceLongPressTimer: number | null = null;

    // 第三人称
    _camCollisionLerp: number = 0.18; // 平滑系数
    _camEpsilon: number = 0.35; // 摄像机与障碍物之间的安全距离（米）
    _minCamDistance: number = 1.0; // 摄像机最小距离
    _maxCamDistance: number = 4.4; // 摄像机最大距离

    //  物理/运动
    playerVelocity = new THREE.Vector3(); // 玩家速度向量
    readonly upVector = new THREE.Vector3(0, 1, 0);

    //  临时复用向量/矩阵
    readonly tempVector = new THREE.Vector3();
    readonly tempVector2 = new THREE.Vector3();
    readonly tempBox = new THREE.Box3();
    readonly tempMat = new THREE.Matrix4();
    readonly tempSegment = new THREE.Line3();

    //  动画相关
    personMixer?: THREE.AnimationMixer;
    droneMixer?: THREE.AnimationMixer;
    personActions?: Map<string, THREE.AnimationAction>;
    droneActions?: Map<string, THREE.AnimationAction>;
    idleAction!: THREE.AnimationAction;
    walkAction!: THREE.AnimationAction;
    leftWalkAction!: THREE.AnimationAction;
    rightWalkAction!: THREE.AnimationAction;
    backwardAction!: THREE.AnimationAction;
    jumpAction!: THREE.AnimationAction;
    runAction!: THREE.AnimationAction;
    controlDroneAction!: THREE.AnimationAction;
    actionState!: THREE.AnimationAction;

    //  复用向量：用于相机朝向 / 移动
    readonly camDir = new THREE.Vector3();
    readonly moveDir = new THREE.Vector3();
    readonly targetQuat = new THREE.Quaternion();
    readonly targetMat = new THREE.Matrix4();
    readonly rotationSpeed = 10;
    readonly DIR_FWD = new THREE.Vector3(0, 0, -1);
    readonly DIR_BKD = new THREE.Vector3(0, 0, 1);
    readonly DIR_LFT = new THREE.Vector3(-1, 0, 0);
    readonly DIR_RGT = new THREE.Vector3(1, 0, 0);

    readonly _personToCam = new THREE.Vector3();

    readonly _originTmp = new THREE.Vector3();
    readonly _raycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    readonly _raycasterPersonToCam = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3());

    // 射线检测时只返回第一个碰撞
    constructor() {
        (this._raycaster as any).firstHitOnly = true;
        (this._raycasterPersonToCam as any).firstHitOnly = true;
    }

    // 初始化
    async init(
        opts: {
            scene: THREE.Scene;
            camera: THREE.PerspectiveCamera;
            controls: OrbitControls;
            playerModel: {
                url: string;
                idleAnim: string;
                walkAnim: string;
                runAnim: string;
                jumpAnim: string;
                leftWalkAnim?: string;
                rightWalkAnim?: string;
                backwardAnim?: string;
                scale: number;
                gravity?: number;
                jumpHeight?: number;
                highJumpHeight?: number;
                speed?: number;
            };
            initPos?: THREE.Vector3;
            mouseSensity?: number;
        },
        callback?: () => void
    ) {
        this.scene = opts.scene;
        this.camera = opts.camera;
        this.controls = opts.controls;
        this.playerModel = opts.playerModel;
        this.initPos = opts.initPos ? opts.initPos : new THREE.Vector3(0, 0, 0);
        this.mouseSensity = opts.mouseSensity ? opts.mouseSensity : 5;

        const s = this.playerModel.scale;
        this.visualizeDepth = 0 * s;
        this.gravity = opts.playerModel.gravity ? opts.playerModel.gravity * s : -2400 * s;
        this.jumpHeight = opts.playerModel.jumpHeight ? opts.playerModel.jumpHeight * s : 300 * s;
        this.highJumpHeight = opts.playerModel.highJumpHeight ? opts.playerModel.highJumpHeight * s : 1000 * s;
        this.playerSpeed = opts.playerModel.speed ? opts.playerModel.speed * s : 400 * s;

        this._camCollisionLerp = 0.18;
        this._camEpsilon = 35 * s;
        this._minCamDistance = 100 * s;
        this._maxCamDistance = 440 * s;
        // 创建bvh
        await this.createBVH();

        // 创建玩家
        this.createPlayer();

        // 加载玩家模型
        await this.loadPersonGLB();

        // 等待资源加载完毕再设置摄像机
        if (this.isFirstPerson && this.player) {
            this.player.add(this.camera);
        }
        this.onAllEvent(); // 绑定事件
        this.setCameraPos();
        this.setControls();
        if (callback) callback();
    }

    // 第一/三视角切换
    changeView() {
        this.isFirstPerson = !this.isFirstPerson;
        if (this.isFirstPerson) {
            this.player.attach(this.camera);
            this.camera.position.set(0, 40 * this.playerModel.scale, 30 * this.playerModel.scale);
            this.camera.rotation.set(0, Math.PI, 0);
            document.body.requestPointerLock(); // 锁定鼠标
        } else {
            this.scene.attach(this.camera);
            const worldPos = this.player.position.clone();
            const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.quaternion);
            const angle = Math.atan2(dir.z, dir.x);
            const offset = new THREE.Vector3(Math.cos(angle) * 400 * this.playerModel.scale, 200 * this.playerModel.scale, Math.sin(angle) * 400 * this.playerModel.scale);
            this.camera.position.copy(worldPos).add(offset);
            this.controls.target.copy(worldPos);
            document.body.requestPointerLock(); // 锁定鼠标
        }
    }

    // 摄像机/控制器设置
    setCameraPos() {
        if (this.isFirstPerson) {
            this.camera.position.set(0, 40 * this.playerModel.scale, 30 * this.playerModel.scale);
        } else {
            const worldPos = this.player.position.clone();
            const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.quaternion);
            const angle = Math.atan2(dir.z, dir.x);
            const offset = new THREE.Vector3(Math.cos(angle) * 400 * this.playerModel.scale, 200 * this.playerModel.scale, Math.sin(angle) * 400 * this.playerModel.scale);
            this.camera.position.copy(worldPos).add(offset);
        }
        this.camera.updateProjectionMatrix();
    }

    // 设置控制器
    setControls() {
        this.controls.enabled = false;
        this.controls.maxPolarAngle = Math.PI * (230 / 360);
    }

    // 重置控制器
    resetControls() {
        this.controls.enabled = true;
        this.controls.enablePan = true;
        this.controls.maxPolarAngle = Math.PI / 2;
        this.controls.rotateSpeed = 1;
        this.controls.enableZoom = true;
        this.controls.mouseButtons = {
            LEFT: 0,
            MIDDLE: 1,
            RIGHT: 2,
        };
    }

    // 初始化加载器
    async initLoader() {
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath("https://unpkg.com/three@0.180.0/examples/jsm/libs/draco/gltf/");
        dracoLoader.setDecoderConfig({ type: "js" });
        this.loader.setDRACOLoader(dracoLoader);
    }

    // 人物与动画加载
    async loadPersonGLB() {
        try {
            const gltf: GLTF = await this.loader.loadAsync(this.playerModel.url);
            this.person = gltf.scene;
            const sc = this.playerModel.scale;
            const h = this.playerHeight * sc;
            this.person.scale.set(sc, sc, sc);
            this.person.position.set(0, -h * 0.75, 0);
            this.player.add(this.person);
            this.reset();

            // 创建人物 mixer 与 actions
            this.personMixer = new THREE.AnimationMixer(this.person);
            const animations = gltf.animations ?? [];
            this.personActions = new Map<string, THREE.AnimationAction>();
            // 取出动作并注册到 map
            const findClip = (name: string) => animations.find((a: any) => a.name === name);
            const regs: [string, string][] = [
                [this.playerModel.idleAnim, "idle"],
                [this.playerModel.walkAnim, "walking"],
                [this.playerModel.leftWalkAnim || this.playerModel.walkAnim, "left_walking"],
                [this.playerModel.rightWalkAnim || this.playerModel.walkAnim, "right_walking"],
                [this.playerModel.backwardAnim || this.playerModel.walkAnim, "walking_backward"],
                [this.playerModel.jumpAnim, "jumping"],
                [this.playerModel.runAnim, "running"],
            ];

            // 注册动作并设置循环模式
            for (const [key, clipName] of regs) {
                const clip = findClip(key);
                if (!clip) continue;
                const action = this.personMixer.clipAction(clip);

                if (clipName === "jumping") {
                    action.setLoop(THREE.LoopOnce, 1); // 播放一次
                    action.clampWhenFinished = true;
                    action.setEffectiveTimeScale(1.2); // 播放速度
                } else {
                    action.setLoop(THREE.LoopRepeat, Infinity); // 循环播放
                    action.clampWhenFinished = false;
                    action.setEffectiveTimeScale(1);
                }

                action.enabled = true; // 激活
                action.setEffectiveWeight(0); // 初始权重为0
                this.personActions.set(clipName, action);
            }

            // 把actions激活
            this.idleAction = this.personActions.get("idle")!;
            this.walkAction = this.personActions.get("walking")!;
            this.leftWalkAction = this.personActions.get("left_walking")!;
            this.rightWalkAction = this.personActions.get("right_walking")!;
            this.backwardAction = this.personActions.get("walking_backward")!;
            this.jumpAction = this.personActions.get("jumping")!;
            this.runAction = this.personActions.get("running")!;

            // 激活空闲动作
            this.idleAction.setEffectiveWeight(1);
            this.idleAction.play();
            this.actionState = this.idleAction;

            this.personMixer.addEventListener("finished", (ev: any) => {
                const finishedAction: THREE.AnimationAction = ev.action;

                if (finishedAction === this.jumpAction) {
                    // jump 播放结束后的逻辑
                    if (this.fwdPressed) {
                        if (this.shiftPressed) this.playPersonAnimationByName("running");
                        else this.playPersonAnimationByName("walking");
                        return;
                    }
                    if (this.bkdPressed) {
                        this.playPersonAnimationByName("walking_backward");
                        return;
                    }
                    if (this.rgtPressed || this.lftPressed) {
                        this.playPersonAnimationByName("walking");
                        return;
                    }
                    this.playPersonAnimationByName("idle");
                }
            });
        } catch (error) {}
    }

    // 平滑切换人物动画
    playPersonAnimationByName(name: string, fade = 0.18) {
        if (!this.personActions) return;
        if (this.ctPressed) return;

        const next = this.personActions.get(name);
        if (!next) return;

        // 如果是同一个action，直接返回
        if (this.actionState === next) return;

        const prev = this.actionState;

        // 对于一次性动作先reset()
        next.reset();
        next.setEffectiveWeight(1);
        next.play();

        if (prev && prev !== next) {
            // 让 prev 淡出，next 淡入
            prev.fadeOut(fade);
            next.fadeIn(fade);
        } else {
            // 时直接淡入
            next.fadeIn(fade);
        }

        this.actionState = next;
    }

    // 创建玩家胶囊体
    createPlayer() {
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(1, 0, 0),
            shadowSide: THREE.DoubleSide,
            depthTest: false,
        });
        material.transparent = true;
        material.opacity = this.displayPlayer ? 0.5 : 0;
        material.wireframe = true;

        const r = this.playerRadius * this.playerModel.scale;
        const h = this.playerHeight * this.playerModel.scale;
        this.player = new THREE.Mesh(new RoundedBoxGeometry(r * 2, h, r * 2, 1, 75), material) as typeof this.player;

        this.player.geometry.translate(0, -h * 0.25, 0);
        this.player.capsuleInfo = {
            radius: r,
            segment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, -h * 0.5, 0)),
        };

        this.player.name = "capsule";
        this.scene.add(this.player);
        this.reset();
    }

    // 每帧更新
    async update(delta: number = clock.getDelta()) {
        if (!this.isupdate || !this.player) return;

        delta = Math.min(delta, 1 / 30);
        this.updateMixers(delta);

        // 非路径行走逻辑
        if (!this.collider) return;
        this.camera.getWorldDirection(this.camDir);
        let angle = Math.atan2(this.camDir.z, this.camDir.x) + Math.PI / 2;
        angle = 2 * Math.PI - angle;

        this.moveDir.set(0, 0, 0);
        if (this.fwdPressed) this.moveDir.add(this.DIR_FWD);
        if (this.bkdPressed) this.moveDir.add(this.DIR_BKD);
        if (this.lftPressed) this.moveDir.add(this.DIR_LFT);
        if (this.rgtPressed) this.moveDir.add(this.DIR_RGT);

        // 跳跃（短按）
        if (this.spacePressed && this.playerIsOnGround) {
            // 设置跳跃动作
            this.playPersonAnimationByName("jumping");
            // 延迟施加跳跃速度（与动画起跳同步）
            setTimeout(() => {
                this.playerVelocity.y = this.jumpHeight;
                this.playerIsOnGround = false;
                this.spacePressed = false;
                this.player.position.addScaledVector(this.playerVelocity, delta);
                this.player.updateMatrixWorld();
            }, 200);
        }

        // 强行拉回（长按）
        if (this.sustainSpacePressed && this.playerIsOnGround) {
            this.playPersonAnimationByName("jumping");
            setTimeout(() => {
                this.playerVelocity.y = this.highJumpHeight;
                this.playerIsOnGround = false;
                this.spacePressed = false;
                this.player.position.addScaledVector(this.playerVelocity, delta);
                this.player.updateMatrixWorld();
            }, 200);
        }

        // 设置速度
        this.playerSpeed = this.shiftPressed ? 900 * this.playerModel.scale : 400 * this.playerModel.scale;
        if (this.moveDir.lengthSq() > 1e-6) {
            this.moveDir.normalize().applyAxisAngle(this.upVector, angle);
            this.player.position.addScaledVector(this.moveDir, this.playerSpeed * delta);
        }

        // 向下射线检测地面高度 超过阈值判定为没在地面 加上重力
        let playerDistanceFromGround = Infinity;
        this._originTmp.set(this.player.position.x, this.player.position.y, this.player.position.z);
        this._raycaster.ray.origin.copy(this._originTmp);
        const intersects = this._raycaster.intersectObject(this.collider as THREE.Object3D, false);
        if (intersects.length > 0) {
            playerDistanceFromGround = this.player.position.y - intersects[0].point.y;
        }

        const h = this.playerHeight * this.playerModel.scale * 0.75; // 阈值
        if (playerDistanceFromGround > h) {
            // 重力
            this.playerVelocity.y += delta * this.gravity;
            this.player.position.addScaledVector(this.playerVelocity, delta);
            console.log("delta * this.gravity", delta * this.gravity);
        } else {
            // 在地面
            console.log("在地面");
            this.playerVelocity.set(0, 0, 0);
            this.playerIsOnGround = true;
        }
        this.player.updateMatrixWorld();

        // 碰撞检测
        const capsuleInfo = this.player.capsuleInfo;
        this.tempBox.makeEmpty();
        this.tempMat.copy(this.collider!.matrixWorld).invert();
        this.tempSegment.copy(capsuleInfo.segment);
        this.tempSegment.start.applyMatrix4(this.player.matrixWorld).applyMatrix4(this.tempMat);
        this.tempSegment.end.applyMatrix4(this.player.matrixWorld).applyMatrix4(this.tempMat);

        this.tempBox.expandByPoint(this.tempSegment.start);
        this.tempBox.expandByPoint(this.tempSegment.end);
        this.tempBox.expandByScalar(capsuleInfo.radius);

        const bvh = this.collider?.geometry;
        (bvh as any)?.boundsTree?.shapecast({
            // 检测包围盒碰撞
            intersectsBounds: (box: THREE.Box3) => box.intersectsBox(this.tempBox),
            // 检测三角形碰撞
            intersectsTriangle: (tri: any) => {
                const triPoint = this.tempVector;
                const capsulePoint = this.tempVector2;
                const distance = tri.closestPointToSegment(this.tempSegment, triPoint, capsulePoint);
                // 距离小于人物半径，发生碰撞
                if (distance < capsuleInfo.radius) {
                    const depth = capsuleInfo.radius - distance;
                    const direction = capsulePoint.sub(triPoint).normalize();
                    this.tempSegment.start.addScaledVector(direction, depth);
                    this.tempSegment.end.addScaledVector(direction, depth);
                }
            },
        });

        // 设置玩家位置
        const newPosition = this.tempVector.copy(this.tempSegment.start).applyMatrix4(this.collider!.matrixWorld);
        const deltaVector = this.tempVector2.subVectors(newPosition, this.player.position);

        // 应用位移
        const len = deltaVector.length();
        const offset = Math.max(0, len - 1e-5);
        if (offset > 0 && len > 0) {
            const n = deltaVector.multiplyScalar(1 / len);
            this.player.position.addScaledVector(n, offset);
        }

        // 第三人称-朝向
        if (!this.isFirstPerson && this.moveDir.lengthSq() > 0) {
            this.camDir.y = 0;
            this.camDir.normalize();
            this.camDir.negate();
            this.moveDir.normalize();
            this.moveDir.negate();
            const lookTarget = this.player.position.clone().add(this.moveDir);
            this.targetMat.lookAt(this.player.position, lookTarget, this.player.up);
            this.targetQuat.setFromRotationMatrix(this.targetMat);
            const alpha = Math.min(1, this.rotationSpeed * delta);
            this.player.quaternion.slerp(this.targetQuat, alpha);
        }

        // 第三人称-相机跟随
        if (!this.isFirstPerson) {
            const lookTarget = this.player.position.clone();
            lookTarget.y += 30 * this.playerModel.scale;
            this.camera.position.sub(this.controls.target); // 减去控制器向量
            this.controls.target.copy(lookTarget); // 设置控制器目标
            this.camera.position.add(lookTarget); // 设置相机位置
            this.controls.update(); // 更新控制器

            // 当视线被遮挡时判断
            this._personToCam.subVectors(this.camera.position, this.player.position); // 计算从player指向camera的向量（camera - player）
            const origin = this.player.position.clone().add(new THREE.Vector3(0, 0, 0)); // 射线起点
            const direction = this._personToCam.clone().normalize(); // 方向
            const desiredDist = this._personToCam.length(); // 与期望距离
            this._raycasterPersonToCam.set(origin, direction);
            this._raycasterPersonToCam.far = desiredDist;

            // 做相交检测
            const intersects = this._raycasterPersonToCam.intersectObject(this.collider as THREE.Object3D, false);
            if (intersects.length > 0) {
                // 相机拉近
                const hit = intersects[0]; // 找到第一个命中
                const safeDist = Math.max(hit.distance - this._camEpsilon, this._minCamDistance); // 计算安全距离（hit.distance是从origin到碰撞点的距离）
                const targetCamPos = origin.clone().add(direction.clone().multiplyScalar(safeDist)); // 目标相机位置 = origin + direction * safeDist
                this.camera.position.lerp(targetCamPos, this._camCollisionLerp); // 平滑移动相机到targetCamPos
            } else {
                // 相机恢复
                const dis = this.player.position.distanceTo(this.camera.position); // 计算当前人物到相机距离
                this._raycasterPersonToCam.far = this._maxCamDistance;
                // 检查预设相机位置是否有遮挡
                const intersectsMaxDis = this._raycasterPersonToCam.intersectObject(this.collider as THREE.Object3D, false);
                // 距离小于最大距离且没有遮挡 恢复相机
                if (dis < this._maxCamDistance) {
                    let safeDist = this._maxCamDistance;
                    if (intersectsMaxDis.length) {
                        const hitMax = intersectsMaxDis[0]; // 找到第一个命中
                        safeDist = hitMax.distance - this._camEpsilon;
                    }
                    const targetCamPos = origin.clone().add(direction.clone().multiplyScalar(safeDist));
                    this.camera.position.lerp(targetCamPos, this._camCollisionLerp);
                }
            }
        }

        // 掉出场景重置
        if (this.player.position.y < this.boundingBoxMinY - 1) {
            // 检测当前位置与碰撞体是否相交
            this._originTmp.set(this.player.position.x, 10000, this.player.position.z);
            this._raycaster.ray.origin.copy(this._originTmp);
            const intersects = this._raycaster.intersectObject(this.collider as THREE.Object3D, false);
            if (intersects.length > 0) {
                // 出现碰撞 说明玩家为bug意外掉落
                console.log("玩家为bug意外掉落");
                this.reset(new THREE.Vector3(this.player.position.x, intersects[0].point.y + 5, this.player.position.z));
            } else {
                // 无碰撞 正常掉落
                console.log("玩家正常掉落");
                this.reset(new THREE.Vector3(this.player.position.x, this.player.position.y + 15, this.player.position.z));
            }
        }
    }

    // 重置 / 销毁
    reset(position?: THREE.Vector3) {
        if (!this.player) return;
        this.playerVelocity.set(0, 0, 0);
        this.player.position.copy(position ? position : this.initPos);
    }

    // 销毁
    destroy() {
        this.offAllEvent();
        if (this.player) {
            this.player.remove(this.camera);
            this.scene.remove(this.player);
        }
        (this.player as any) = null;
        if (this.person) {
            this.scene.remove(this.person);
            this.person = null;
        }

        this.resetControls();

        // 清理 BVH 可视化
        if (this.visualizer) {
            this.scene.remove(this.visualizer);
            this.visualizer = null;
        }
        if (this.collider) {
            this.scene.remove(this.collider);
            this.collider = null;
        }

        controllerInstance = null;
    }

    // 事件绑定
    onAllEvent() {
        this.isupdate = true;
        document.body.requestPointerLock();
        window.addEventListener("keydown", this._boundOnKeydown);
        window.addEventListener("keyup", this._boundOnKeyup);
        window.addEventListener("mousemove", this._mouseMove);
        window.addEventListener("click", this._mouseClick);
    }

    // 事件解绑
    offAllEvent() {
        this.isupdate = false;
        document.exitPointerLock();
        window.removeEventListener("keydown", this._boundOnKeydown);
        window.removeEventListener("keyup", this._boundOnKeyup);
        window.removeEventListener("mousemove", this._mouseMove);
        window.removeEventListener("click", this._mouseClick);
    }

    // 键盘按下事件
    private _boundOnKeydown = async (e: KeyboardEvent) => {
        if (e.ctrlKey && (e.code === "KeyW" || e.code === "KeyA" || e.code === "KeyS" || e.code === "KeyD")) {
            e.preventDefault();
        }
        switch (e.code) {
            case "KeyW":
                this.fwdPressed = true;
                this.setAnimationByPressed();
                break;
            case "KeyS":
                this.bkdPressed = true;
                this.setAnimationByPressed();
                break;
            case "KeyD":
                this.rgtPressed = true;
                this.setAnimationByPressed();
                break;
            case "KeyA":
                this.lftPressed = true;
                this.setAnimationByPressed();
                break;
            case "ShiftLeft":
                this.shiftPressed = true;
                this.setAnimationByPressed();
                break;
            case "Space":
                if (!this.spacePressed) this.spacePressed = true;
                if (!this.spaceLongPressTimer) {
                    this.spaceLongPressTimer = setTimeout(() => {
                        this.sustainSpacePressed = true;
                    }, 2000);
                }
                break;
            case "ControlLeft":
                this.ctPressed = true;
                break;

            case "KeyV":
                this.changeView();
                break;
        }
    };

    // 键盘抬起事件
    private _boundOnKeyup = (e: KeyboardEvent) => {
        switch (e.code) {
            case "KeyW":
                this.fwdPressed = false;
                this.setAnimationByPressed();
                break;
            case "KeyS":
                this.bkdPressed = false;
                this.setAnimationByPressed();
                break;
            case "KeyD":
                this.rgtPressed = false;
                this.setAnimationByPressed();
                break;
            case "KeyA":
                this.lftPressed = false;
                this.setAnimationByPressed();
                break;
            case "ShiftLeft":
                this.shiftPressed = false;
                this.setAnimationByPressed();
                break;
            case "Space":
                // 清除定时器
                if (this.spaceLongPressTimer) {
                    clearTimeout(this.spaceLongPressTimer);
                    this.spaceLongPressTimer = null;
                }
                this.spacePressed = false;
                this.sustainSpacePressed = false;
                break;
            case "ControlLeft":
                this.ctPressed = false;
                break;
        }
    };

    // 根据按键设置人物动画
    setAnimationByPressed = () => {
        if (this.playerIsOnGround) {
            if (!this.fwdPressed && !this.bkdPressed && !this.lftPressed && !this.rgtPressed) {
                this.playPersonAnimationByName("idle");
                return;
            }
            if (this.fwdPressed) {
                if (this.shiftPressed) {
                    this.playPersonAnimationByName("running");
                } else {
                    this.playPersonAnimationByName("walking");
                }
                return;
            }
            // 第三人称下动画统一使用 前进 动画
            if (!this.isFirstPerson && (this.lftPressed || this.rgtPressed || this.bkdPressed)) {
                if (this.shiftPressed) {
                    this.playPersonAnimationByName("running");
                } else {
                    this.playPersonAnimationByName("walking");
                }
                return;
            }
            // 第一人称下根据方向播放不同动画
            if (this.lftPressed) {
                this.playPersonAnimationByName("left_walking");
                return;
            }
            if (this.rgtPressed) {
                this.playPersonAnimationByName("right_walking");
                return;
            }
            if (this.bkdPressed) {
                this.playPersonAnimationByName("walking_backward");
                return;
            }
        }
    };

    // 鼠标移动事件
    private _mouseMove = (e: MouseEvent) => {
        // 记录状态
        if (document.pointerLockElement !== document.body) return;
        if (this.isFirstPerson) {
            const yaw = -e.movementX * 0.0001 * this.mouseSensity;
            const pitch = -e.movementY * 0.0001 * this.mouseSensity;
            this.player.rotateY(yaw);
            this.camera.rotation.x = THREE.MathUtils.clamp(this.camera.rotation.x + pitch, -1.3, 1.4);
        } else {
            const sensitivity = 0.0001 * this.mouseSensity;
            const deltaX = -e.movementX * sensitivity;
            const deltaY = -e.movementY * sensitivity;
            // 获取目标点
            const target = this.player.position.clone();
            // 计算相机到目标的距离
            const distance = this.camera.position.distanceTo(target);
            // 计算当前角度
            const currentPosition = this.camera.position.clone().sub(target);
            let theta = Math.atan2(currentPosition.x, currentPosition.z);
            let phi = Math.acos(currentPosition.y / distance);
            // 应用旋转
            theta += deltaX;
            phi += deltaY;
            // 限制phi角度
            phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
            // 计算新的相机位置
            const newX = distance * Math.sin(phi) * Math.sin(theta);
            const newY = distance * Math.cos(phi);
            const newZ = distance * Math.sin(phi) * Math.cos(theta);

            this.camera.position.set(target.x + newX, target.y + newY, target.z + newZ);
            this.camera.lookAt(target);
        }
    };

    private _mouseClick = (e: MouseEvent) => {
        if (document.pointerLockElement !== document.body) document.body.requestPointerLock();
    };

    // 更新模型动画
    private updateMixers(delta: number) {
        if (this.personMixer) this.personMixer.update(delta);
        if (this.droneMixer) this.droneMixer.update(delta);
    }

    // BVH构建
    async createBVH(meshUrl: string = ""): Promise<void> {
        await this.initLoader(); // 初始化加载器

        const ensureAttributesMinimal = (geom: THREE.BufferGeometry): THREE.BufferGeometry | null => {
            if (!geom.attributes.position) {
                // console.warn("跳过无 position 的几何体", geom);
                return null;
            }
            if (!geom.attributes.normal) geom.computeVertexNormals();
            if (!geom.attributes.uv) {
                const count = geom.attributes.position.count;
                const dummyUV = new Float32Array(count * 2);
                geom.setAttribute("uv", new THREE.BufferAttribute(dummyUV, 2));
            }
            return geom;
        };

        const collected: THREE.BufferGeometry[] = [];
        if (meshUrl == "") {
            if (this.collider) {
                this.scene.remove(this.collider);
                this.collider = null;
            }

            this.scene.traverse((c) => {
                const mesh = c as THREE.Mesh;
                if (mesh?.isMesh && mesh.geometry && c.name !== "capsule") {
                    try {
                        let geom = (mesh.geometry as THREE.BufferGeometry).clone();
                        geom.applyMatrix4(mesh.matrixWorld);
                        if (geom.index) geom = geom.toNonIndexed();
                        const safe = ensureAttributesMinimal(geom);
                        if (safe) collected.push(safe);
                    } catch (e) {
                        console.warn("处理网格时出错：", mesh, e);
                    }
                }
            });

            if (!collected.length) {
                return;
            }

            // 统一属性集合
            type AttrMeta = { itemSize: number; arrayCtor: any; examples: number };
            const attrMap = new Map<string, AttrMeta>();
            const attrConflict = new Set<string>();

            for (const g of collected) {
                for (const name of Object.keys(g.attributes)) {
                    const attr = g.attributes[name] as THREE.BufferAttribute;
                    const ctor = (attr.array as any).constructor;
                    const itemSize = attr.itemSize;
                    if (!attrMap.has(name)) {
                        attrMap.set(name, { itemSize, arrayCtor: ctor, examples: 1 });
                    } else {
                        const m = attrMap.get(name)!;
                        if (m.itemSize !== itemSize || m.arrayCtor !== ctor) attrConflict.add(name);
                        else m.examples++;
                    }
                }
            }

            if (attrConflict.size) {
                for (const g of collected) {
                    for (const name of Array.from(attrConflict)) {
                        if (g.attributes[name]) g.deleteAttribute(name);
                    }
                }
                for (const name of attrConflict) attrMap.delete(name);
            }

            const attrNames = Array.from(attrMap.keys());
            for (const g of collected) {
                const count = g.attributes.position.count;
                for (const name of attrNames) {
                    if (!g.attributes[name]) {
                        const meta = attrMap.get(name)!;
                        const len = count * meta.itemSize;
                        const array = new meta.arrayCtor(len);
                        g.setAttribute(name, new THREE.BufferAttribute(array, meta.itemSize));
                    }
                }
            }
        } else {
            const gltf: GLTF = await this.loader.loadAsync(meshUrl, (xhr) => {});
            const mesh = gltf.scene.children[0] as THREE.Mesh;
            mesh.name = "BVH加载模型";

            // 推入几何体
            let geom = mesh.geometry.clone();
            geom.applyMatrix4(mesh.matrixWorld);
            if (geom.index) geom = geom.toNonIndexed();
            const safe = ensureAttributesMinimal(geom);
            if (safe) collected.push(safe);
        }

        // 合并几何体
        const merged = BufferGeometryUtils.mergeGeometries(collected, false);
        if (!merged) {
            console.error("合并几何失败");
            return;
        }

        // 构建bvh
        (merged as any).boundsTree = new MeshBVH(merged);
        this.collider = new THREE.Mesh(
            merged,
            // new THREE.MeshBasicMaterial({
            //     color: "red",
            //     opacity: 0.2,
            //     transparent: true,
            //     wireframe: false,
            // })
            new THREE.MeshBasicMaterial({
                opacity: 0.5,
                transparent: true,
                wireframe: true,
            })
        );

        if (this.displayCollider) this.scene.add(this.collider);
        if (this.displayVisualizer) {
            if (this.visualizer) this.scene.remove(this.visualizer);
            this.visualizer = new MeshBVHHelper(this.collider, this.visualizeDepth);
            this.scene.add(this.visualizer);
        }
        this.boundingBoxMinY = (this.collider as any).geometry.boundingBox.min.y;
        console.log("bvh加载模型成功", this.collider);
    }
}

// 导出API
export function playerController() {
    if (!controllerInstance) controllerInstance = new PlayerController();
    const c = controllerInstance;
    return {
        init: (
            opts: {
                scene: THREE.Scene;
                camera: THREE.PerspectiveCamera;
                controls: OrbitControls;
                playerModel: {
                    url: string;
                    idleAnim: string;
                    walkAnim: string;
                    runAnim: string;
                    jumpAnim: string;
                    leftWalkAnim?: string;
                    rightWalkAnim?: string;
                    backwardAnim?: string;
                    scale: number;
                };
                initPos?: THREE.Vector3;
                mouseSensity?: number;
            },
            callback?: () => void
        ) => c.init(opts, callback),
        changeView: () => c.changeView(),
        createBVH: (url: string = "") => c.createBVH(url),
        createPlayer: () => c.createPlayer(),
        reset: (pos?: THREE.Vector3) => c.reset(pos),
        update: (dt?: number) => c.update(dt),
        destroy: () => c.destroy(),
        displayCollider: c.displayCollider,
        displayPlayer: c.displayPlayer,
        displayVisualizer: c.displayVisualizer,
    };
}

// 打开所有事件
export function onAllEvent(): void {
    if (!controllerInstance) controllerInstance = new PlayerController();
    controllerInstance.onAllEvent();
}

// 关闭所有事件
export function offAllEvent(): void {
    if (!controllerInstance) return;
    controllerInstance.offAllEvent();
}

