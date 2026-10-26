import * as THREE from "three";
import type { playerController } from "../PlayerController";
import { dampCameraHeading } from "../utils/cameraHeading";

export class CameraSystem {
    private ctrl: playerController; // 主控制器引用

    collisionLerp = 0.18; // 碰撞插值速度
    epsilon = 35; // 安全距离偏移
    minDist = 100; // 最小相机距离
    maxDist = 440; // 最大相机距离
    originMaxDist = 440; // 配置的默认最远距离
    sensitivity = 5; // 鼠标灵敏度
    mouseMode: 0 | 1 | 2 | 3 | 4 | 5 = 1; // 鼠标控制模式
    zoomEnabled = false; // 是否允许缩放
    lookAtHeightRatio = 0.8; // 第三人称看向点高度比例（0=底部，1=顶部）
    overShoulderOffsetRatio = 0.2; // 第三人称相机过肩视角横向偏移比例

    private lookAtPoint = new THREE.Vector3(); // 预分配的看向点向量

    enableSpringCamera = false;
    springCameraTime = 0.05;
    followPlayerDirection = false; // 移动时相机跟随人物朝向
    playerDirectionFollowSpeed = 3; // 朝向跟随响应速度，越大越快
    private _springVelocity = new THREE.Vector3();
    private _springResult = new THREE.Vector3();
    private playerForward = new THREE.Vector3();
    private playerRotation = new THREE.Quaternion();
    private zoomWheelElement: HTMLElement | SVGElement | null = null;
    private readonly boundZoomWheel: EventListener = (event) => this.onZoomWheel(event as WheelEvent);
    private _flySprintMaxDistBoost = false;
    private _flySprintSavedMaxDist = 0;
    private positionRequest: number | null = null;
    private savedControls: {
        parent: THREE.Object3D | null;
        rotationOrder: THREE.EulerOrder;
        view: THREE.PerspectiveCamera["view"];
        controls: Pick<playerController["controls"],
            "enabled" | "enablePan" | "enableRotate" | "enableZoom" | "rotateSpeed"
            | "maxPolarAngle" | "minDistance" | "mouseButtons" | "touches">;
    } | null = null;

    raycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3()); // 相机碰撞射线
    centerRay = new THREE.Raycaster(); // 屏幕中心射线
    centerMouse = new THREE.Vector2(); // 屏幕中心坐标
    playerToCam = new THREE.Vector3(); // 玩家到相机向量

    constructor(ctrl: playerController) {
        this.ctrl = ctrl;
        (this.raycaster as any).firstHitOnly = true;
    }

    /** 只在开始接管时记录应用配置；重复初始化不覆盖快照。 */
    captureControls() {
        if (!this.ctrl.manageCamera || this.savedControls) return;
        const { camera, controls } = this.ctrl;
        this.savedControls = {
            parent: camera.parent,
            rotationOrder: camera.rotation.order,
            view: camera.view ? { ...camera.view } : null,
            controls: {
                enabled: controls.enabled,
                enablePan: controls.enablePan,
                enableRotate: controls.enableRotate,
                enableZoom: controls.enableZoom,
                rotateSpeed: controls.rotateSpeed,
                maxPolarAngle: controls.maxPolarAngle,
                minDistance: controls.minDistance,
                mouseButtons: { ...controls.mouseButtons },
                touches: { ...controls.touches },
            },
        };
        camera.rotation.reorder("YXZ");
    }

    /** 同步内置视角输入；键盘绑定开关不影响鼠标旋转、平移或滚轮。 */
    syncInputEvents() {
        if (this.ctrl.manageCamera && this.savedControls) {
            const enabled = this.ctrl.isupdate && this.ctrl.bindLookEvents;
            this.ctrl.controls.enableRotate = enabled && this.savedControls.controls.enableRotate;
            this.ctrl.controls.enablePan = enabled && this.savedControls.controls.enablePan;
            if (enabled) { this.connectZoomWheel(); return; }
        }
        this.disconnectZoomWheel();
    }

    releasePointerLock() {
        if (this.ctrl.manageCamera && document.pointerLockElement === this.ctrl.controls.domElement) {
            document.exitPointerLock();
        }
    }

    /** 根据当前输入开关、视角和鼠标模式判断是否需要指针锁定。 */
    private needsPointerLock() {
        const c = this.ctrl;
        return c.manageCamera && c.isupdate && c.bindLookEvents
            && (c.isFirstPerson || this.mouseMode === 0 || this.mouseMode === 1 || this.mouseMode === 5);
    }

    // 通用弹簧阻尼：把 controls.target 朝 dest 平滑跟随，返回本帧的目标点
    springTarget(dest: THREE.Vector3, delta: number): THREE.Vector3 {
        if (!this.enableSpringCamera) return dest;
        const cur = this.ctrl.controls.target;
        const v = this._springVelocity;
        const out = this._springResult;
        const smoothTime = Math.max(0.0001, this.springCameraTime);
        const omega = 2 / smoothTime;
        const x = omega * delta;
        const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
        const axes = ['x', 'y', 'z'] as const;
        for (const a of axes) {
            const change = cur[a] - dest[a];
            const temp = (v[a] + omega * change) * delta;
            v[a] = (v[a] - omega * temp) * exp;
            let o = dest[a] + (change + temp) * exp;
            if ((dest[a] - cur[a] > 0) === (o > dest[a])) {
                o = dest[a];
                v[a] = 0;
            }
            out[a] = o;
        }
        return out;
    }

    // 第三人称相机看向点
    getLookAtPoint(): THREE.Vector3 {
        if (this.ctrl.controllerMode === 1 && this.ctrl.vehicle.active) {
            return this.lookAtPoint.copy(this.ctrl.vehicle.active.vehicleGroup.position);
        }
        const capsuleInfo = this.ctrl.playerCapsule.capsuleInfo;
        const r = capsuleInfo.radius;
        const sy = this.ctrl.playerCapsule.scale.y || 1;
        const totalH = (-capsuleInfo.segment.end.y) * sy + 2 * r;
        const y = this.ctrl.playerCapsule.position.y + r - totalH * (1 - this.lookAtHeightRatio);
        return this.lookAtPoint.copy(this.ctrl.playerCapsule.position).setY(y);
    }

    // 设置越肩视角
    setOverShoulder(enable: boolean) {
        if (!this.ctrl.manageCamera) return;
        if (!enable || this.ctrl.controllerMode === 1) { this.ctrl.camera.clearViewOffset(); return; }
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.ctrl.camera.setViewOffset(w, h, w * this.overShoulderOffsetRatio, 0, w, h);
    }

    // 切换视角模式
    changeView() {
        if (!this.ctrl.manageCamera) return;
        this.ctrl.onBeforeViewChange?.(this.ctrl.isFirstPerson);
        this.ctrl.isFirstPerson = !this.ctrl.isFirstPerson;
        if (this.ctrl.isFirstPerson) {
            // 切到第一人称，先对齐胶囊体朝向
            const playerFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.ctrl.playerCapsule.quaternion);
            const flatDir = new THREE.Vector3(playerFwd.x, 0, playerFwd.z).normalize();
            if (flatDir.lengthSq() > 0.001) {
                const yAngle = Math.atan2(flatDir.x, flatDir.z);
                this.ctrl.playerCapsule.rotation.set(0, yAngle, 0);
            }
            this.setFirstPerson();
            this.setOverShoulder(false);
        } else {
            // 切到第三人称，放置相机到玩家背后
            this.ctrl.controls.enabled = true;
            this.ctrl.scene.attach(this.ctrl.camera);
            const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ctrl.playerCapsule.quaternion);
            const angle = Math.atan2(dir.z, dir.x);
            const s = this.ctrl.playerModelConfig.scale;
            const rawOffset = new THREE.Vector3(Math.cos(angle) * 400 * s, 200 * s, Math.sin(angle) * 400 * s);
            this.ctrl.controls.target.copy(this.getLookAtPoint());
            this.ctrl.camera.position.copy(this.ctrl.controls.target).add(rawOffset.normalize().multiplyScalar(this.maxDist));
            // 滚轮由 CameraSystem 改写 maxDist，禁用自带的直接位移缩放。
            this.ctrl.controls.enableZoom = false;
            this.setOverShoulder(this.ctrl.enableOverShoulderView);
        }
        this.setPointerLock();
        this.ctrl.onViewChange?.(this.ctrl.isFirstPerson);
    }

    // 进入第一人称
    setFirstPerson(vertAngle = 0) {
        if (!this.ctrl.manageCamera) return;
        this.ctrl.controls.enabled = false;
        const s = this.ctrl.playerModelConfig.scale;
        const sharedOffset = this.ctrl.playerModelConfig.firstPersonCameraOffset;
        // 有头骨节点挂到头骨，否则挂到胶囊体
        if (this.ctrl.playerModelHead) {
            const [x, y, z] = sharedOffset ?? [0, 10, 20];
            this.ctrl.playerModelHead.attach(this.ctrl.camera);
            this.ctrl.camera.position.set(x, y, z);
        } else {
            const [x, y, z] = sharedOffset ?? [0, 40, 30];
            this.ctrl.playerCapsule.attach(this.ctrl.camera);
            this.ctrl.camera.position.set(x * s, y * s, z * s);
        }
        this.ctrl.camera.rotation.set(
            THREE.MathUtils.clamp(vertAngle, -1.1, 1.4),
            Math.PI,
            0,
        );
        this.ctrl.controls.enableZoom = false;
    }

    // 指针锁定控制
    setPointerLock() {
        if (this.needsPointerLock()) {
            const lockTarget = this.ctrl.controls.domElement;
            if (!lockTarget?.requestPointerLock) return;
            lockTarget.requestPointerLock()?.then(() => {
                // 授权完成时重新检查当前需求，释放模式切换后迟到的锁定。
                if (!this.needsPointerLock() && document.pointerLockElement === lockTarget) document.exitPointerLock();
            }).catch(() => { /* 浏览器拒绝锁定时仍允许普通轨道操作。 */ });
        } else {
            this.releasePointerLock();
        }
    }

    // 初始相机位置
    setCamPos() {
        if (!this.ctrl.manageCamera) return;
        if (this.positionRequest !== null) cancelAnimationFrame(this.positionRequest);
        this.positionRequest = requestAnimationFrame(() => {
            this.positionRequest = null;
            if (!this.ctrl.manageCamera || !this.savedControls) return;
            if (!this.ctrl.isFirstPerson) {
                const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ctrl.playerCapsule.quaternion);
                const angle = Math.atan2(dir.z, dir.x);
                const s = this.ctrl.playerModelConfig.scale;
                const rawOffset = new THREE.Vector3(Math.cos(angle) * 400 * s, 200 * s, Math.sin(angle) * 400 * s);
                this.ctrl.controls.target.copy(this.getLookAtPoint());
                this.ctrl.camera.position.copy(this.ctrl.controls.target).add(rawOffset.normalize().multiplyScalar(this.maxDist));
                this.ctrl.controls.enableZoom = false;
            } else {
                this.setFirstPerson();
            }
            this.ctrl.camera.updateProjectionMatrix();
        });
    }

    // 初始化轨道控制
    initControls() {
        if (!this.ctrl.manageCamera) return;
        this.captureControls();
        this.ctrl.controls.enableZoom = false;
        this.ctrl.controls.rotateSpeed = this.sensitivity * 0.05;
        this.ctrl.controls.maxPolarAngle = Math.PI;
        this.ctrl.controls.mouseButtons = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
        // 防止相机轨道半径归零穿越目标点
        this.ctrl.controls.minDistance = this.minDist;
        if (this.ctrl.mobileControls) {
            this.ctrl.controls.touches = { ONE: null as any, TWO: null as any };
        }
        this.syncInputEvents();
    }

    /** 切换第三人称滚轮缩放；关闭时恢复配置的默认最远距离。 */
    setZoomEnabled(enabled: boolean) {
        this.zoomEnabled = enabled;
        if (this.ctrl.manageCamera) this.ctrl.controls.enableZoom = false;
        this._flySprintMaxDistBoost = false;
        this.maxDist = enabled
            ? Math.max(this.maxDist, this.minDist)
            : this.originMaxDist;
    }

    /** 非弹簧第三人称飞行加速时拉远相机，否则恢复默认最远距离。 */
    applyFlySprintMaxDist(): void {
        const boost = !this.enableSpringCamera
            && !this.ctrl.isFirstPerson
            && this.ctrl.controllerMode === 0
            && this.ctrl.isFlying
            && this.ctrl.input.shift;

        if (!this.zoomEnabled) {
            this._flySprintMaxDistBoost = false;
            this.maxDist = this.originMaxDist * (boost ? 2 : 1);
            return;
        }

        if (boost && !this._flySprintMaxDistBoost) {
            this._flySprintSavedMaxDist = this.maxDist;
            this.maxDist *= 2;
            this._flySprintMaxDistBoost = true;
        } else if (!boost && this._flySprintMaxDistBoost) {
            this.maxDist = this._flySprintSavedMaxDist;
            this._flySprintMaxDistBoost = false;
        }
    }

    clearFlySprintMaxDistBoost(): void {
        this._flySprintMaxDistBoost = false;
    }

    /** 绑定到渲染画布，使普通鼠标与 Pointer Lock 状态共用同一滚轮入口。 */
    private connectZoomWheel() {
        const element = this.ctrl.controls.domElement;
        if (!element) return;
        if (this.zoomWheelElement === element) return;
        this.disconnectZoomWheel();
        element.addEventListener("wheel", this.boundZoomWheel, { passive: false });
        this.zoomWheelElement = element;
    }

    private disconnectZoomWheel() {
        this.zoomWheelElement?.removeEventListener("wheel", this.boundZoomWheel);
        this.zoomWheelElement = null;
    }

    /** 滚轮改变目标最远距离。 */
    private onZoomWheel(event: WheelEvent) {
        if (!this.ctrl.manageCamera || !this.ctrl.isupdate || !this.ctrl.bindLookEvents || !this.zoomEnabled || this.ctrl.isFirstPerson || event.deltaY === 0) return;
        event.preventDefault();

        // 与 OrbitControls 一致地归一化像素、行和页三种 wheel delta。
        let deltaY = event.deltaY;
        if (event.deltaMode === 1) deltaY *= 16;
        else if (event.deltaMode === 2) deltaY *= 100;
        if (event.ctrlKey) deltaY *= 10;

        const scale = Math.pow(0.95, Math.abs(deltaY * 0.01));
        const nextDistance = deltaY < 0
            ? this.maxDist * scale
            : this.maxDist / scale;
        this.maxDist = Math.max(nextDistance, this.minDist);
    }

    // 交还相机与 Controls，保持当前世界位姿。
    resetControls() {
        if (this.positionRequest !== null) cancelAnimationFrame(this.positionRequest);
        this.positionRequest = null;
        this.disconnectZoomWheel();
        const saved = this.savedControls;
        if (!saved) return;
        this.releasePointerLock();
        const { camera, controls } = this.ctrl;
        if (this.ctrl.isFirstPerson) {
            const position = camera.getWorldPosition(new THREE.Vector3());
            controls.target.copy(position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()), this.maxDist);
        }
        if (camera.parent !== saved.parent) {
            if (saved.parent) saved.parent.attach(camera);
            else {
                camera.updateWorldMatrix(true, false);
                camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
                camera.removeFromParent();
            }
        }
        camera.rotation.reorder(saved.rotationOrder);
        camera.view = saved.view ? { ...saved.view } : null;
        camera.updateProjectionMatrix();
        Object.assign(controls, saved.controls);
        this.savedControls = null;
        this._springVelocity.set(0, 0, 0);
    }

    // 处理鼠标朝向
    setToward(dx: number, dy: number, speed: number) {
        this.ctrl.onTowardChange?.(dx, dy, speed);
        if (!this.ctrl.manageCamera || !this.ctrl.enableToward) return;
        const sens = this.sensitivity;
        if (this.ctrl.controllerMode === 0) {
            // 步行第一人称
            if (this.ctrl.isFirstPerson) {
                this.ctrl.playerCapsule.rotateY(-dx * speed * sens);
                this.ctrl.camera.rotation.x = THREE.MathUtils.clamp(
                    this.ctrl.camera.rotation.x + (-dy * speed * sens),
                    -Math.PI * (60 / 180), Math.PI * (80 / 180),
                );
            } else {
                // 步行第三人称
                this.orbit(this.getLookAtPoint(), -dx * speed * sens, -dy * speed * sens);
            }
        } else {
            const v = this.ctrl.vehicle.active;
            if (!v) return;
            // 载具第一人称
            if (this.ctrl.isFirstPerson) {
                this.ctrl.camera.rotation.y = THREE.MathUtils.clamp(this.ctrl.camera.rotation.y + (-dx * speed * sens), Math.PI * (3 / 4), Math.PI * (5 / 4));
                this.ctrl.camera.rotation.x = THREE.MathUtils.clamp(this.ctrl.camera.rotation.x + (-dy * speed * sens), 0, Math.PI * (1 / 3));
            } else {
                // 载具第三人称
                this.orbit(v.vehicleGroup.position, -dx * speed * sens, -dy * speed * sens);
            }
        }
    }

    // 手动轨道旋转
    private orbit(target: THREE.Vector3, deltaX: number, deltaY: number) {
        const distance = this.ctrl.camera.position.distanceTo(target);
        const cur = this.ctrl.camera.position.clone().sub(target);
        let theta = Math.atan2(cur.x, cur.z) + deltaX;
        let phi = Math.acos(THREE.MathUtils.clamp(cur.y / distance, -1, 1)) + deltaY;
        // 限制仰角避免万向节死锁
        phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
        this.ctrl.camera.position.set(
            target.x + distance * Math.sin(phi) * Math.sin(theta),
            target.y + distance * Math.cos(phi),
            target.z + distance * Math.sin(phi) * Math.cos(theta),
        );
        this.ctrl.camera.lookAt(target);
    }

    /** 第三人称移动时沿最短角度转到人物身后，保留镜头仰角和距离。 */
    updatePlayerDirection(delta: number) {
        const c = this.ctrl;
        if (!c.manageCamera || c.isFirstPerson || c.controllerMode !== 0 || !this.followPlayerDirection) return;
        if (!(c.input.fwd || c.input.bkd || c.input.lft || c.input.rgt)) return;
        c.playerCapsule.getWorldQuaternion(this.playerRotation);
        this.playerForward.set(0, 0, 1).applyQuaternion(this.playerRotation).setY(0);
        dampCameraHeading(c.camera.position, c.controls.target, this.playerForward.x, this.playerForward.z, this.playerDirectionFollowSpeed, delta);
    }

    /** 载具第三人称：按行驶方向平滑转向后更新轨道控制和相机避障。 */
    updateThirdPersonVehicle(delta: number) {
        if (!this.ctrl.manageCamera || this.ctrl.isFirstPerson || this.ctrl.controllerMode !== 1) return;
        const v = this.ctrl.vehicle.active;
        if (!v) return;

        const lookTarget = this.springTarget(v.vehicleGroup.position, delta).clone();
        this.ctrl.camera.position.sub(this.ctrl.controls.target);
        this.ctrl.controls.target.copy(lookTarget);
        this.ctrl.camera.position.add(lookTarget);
        if ((this.ctrl.input.fwd || this.ctrl.input.bkd) && v.followVehicleDirection) {
            const vel = v.chassisBody.linvel();
            if (Math.hypot(vel.x, vel.z) > 0.3) {
                dampCameraHeading(this.ctrl.camera.position, this.ctrl.controls.target, vel.x, vel.z, v.vehicleDirectionFollowSpeed, delta);
            }
        }
        this.ctrl.controls.update();
        const vehicleBaseDistance = Math.max(this.minDist, v.size.l * 0.8);
        const desiredDist = Math.max(this.maxDist, vehicleBaseDistance);
        this.updateWithRaycast(this.ctrl.controls.target, desiredDist);
    }

    // 收集相机射线碰撞。开车时跳过当前车辆网格。
    private collectCameraHits() {
        const skipIds = this.ctrl.controllerMode === 1 && this.ctrl.vehicle.active?.meshColliderId != null
            ? [this.ctrl.vehicle.active.meshColliderId]
            : undefined;
        const hits: THREE.Intersection[] = [];
        for (const mesh of this.ctrl.getColliderMeshes({ skipIds })) {
            const meshHits = this.raycaster.intersectObject(mesh, false);
            if (meshHits[0] && (!hits[0] || meshHits[0].distance < hits[0].distance)) {
                hits[0] = meshHits[0];
            }
        }
        return hits;
    }

    // 射线防穿墙
    updateWithRaycast(origin: THREE.Vector3, maxDist: number = this.maxDist, minDist = this.minDist) {
        if (!this.ctrl.manageCamera) return;
        this.playerToCam.subVectors(this.ctrl.camera.position, origin);
        const direction = this.playerToCam.clone().normalize();
        this.raycaster.set(origin, direction);
        this.raycaster.far = maxDist;

        const hits = this.collectCameraHits();
        // 有遮挡：贴近安全距离
        if (hits.length > 0) {
            const safeDist = Math.max(hits[0].distance - this.epsilon, minDist);
            this.ctrl.camera.position.lerp(origin.clone().add(direction.multiplyScalar(safeDist)), this.collisionLerp);
        } else {
            // 无遮挡：尝试拉到最大距离
            this.raycaster.far = maxDist;
            const maxHits = this.collectCameraHits();
            const safeDist = maxHits.length > 0 ? Math.min(maxDist, maxHits[0].distance - this.epsilon) : maxDist;
            this.ctrl.camera.position.lerp(origin.clone().add(direction.multiplyScalar(safeDist)), this.collisionLerp);
        }
    }

    // 屏幕中心检测
    getCenterHit(): THREE.Intersection | undefined {
        this.ctrl.camera.updateMatrixWorld();
        this.centerRay.setFromCamera(this.centerMouse, this.ctrl.camera);
        this.centerRay.layers.set(1);
        this.centerRay.layers.enable(2);

        const meshes = this.ctrl.getColliderMeshes();
        const checkTargets = meshes.length
            ? [...meshes, ...this.ctrl.scene.children]
            : this.ctrl.scene.children;
        const hits = this.centerRay.intersectObjects(checkTargets, true);
        hits.sort((a, b) => a.distance - b.distance);
        if (hits[0]) return hits[0];

        // 无命中返回1000距离的虚拟点
        const fallbackPoint = this.centerRay.ray.at(1000, new THREE.Vector3());
        return {
            distance: 1000, point: fallbackPoint, object: this.ctrl.camera,
            uv: null as any, normal: null as any, face: null as any,
            faceIndex: null as any, instanceId: undefined,
        } as THREE.Intersection;
    }
}
