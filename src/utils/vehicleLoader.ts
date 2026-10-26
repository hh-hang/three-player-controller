import * as THREE from "three";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createVehicleController, DEFAULT_MAX_SUSPENSION_TRAVEL, DEFAULT_WHEEL_PHYSICS } from "./vehicleController";
import { VehicleRigidBody } from "./vehiclePhysics/VehicleRigidBody";
import { getBbox } from "./bbox";
import type { VehicleOptions, VehicleInstance } from "../types";
import { assertDirectionFollowSpeed } from "./cameraHeading";

export type VehicleLoaderContext = {
    loader: GLTFLoader;
    scene: THREE.Scene;
    vehicleParams: {
        debug: { showPhysicsBox: boolean; showWheelRays: boolean; showWheelTravel: boolean; showWheelSpheres: boolean };
        chassis: { density: number; linearDamping: number; angularDamping: number; sizeScale?: { x?: number; y?: number; z?: number } };
        model: { rotation: number };
        power: { acceleration: number; deceleration: number; maxSpeed: number };
        steering: { maxSteerAngle: number; steerTime: number; steerReturnTimeSlow: number; steerReturnTimeFast: number; highSpeedSteerScale: number };
        grip: {
            maxG: number;
            sideFrictionIdle: number;
            sideFrictionFrontMin: number;
            sideFrictionRearMin: number;
            handbrakeRearFriction: number;
            handbrakeRearDriveScale: number;
            handbrakeReleaseTime: number;
            wheelbaseRatio: number;
        };
        suspension: {
            restLength?: number;
            maxTravel: number;
            stiffness: number;
            compression: number;
            relaxation: number;
            maxForce: number;
            frictionSlip: number;
            sideFrictionStiffness: number;
            rollInfluence: number;
        };
        followVehicleDirection: boolean;
        vehicleDirectionFollowSpeed: number;
    };
    vehicleLength: number;
};

const MIN_BOX_HEIGHT = 1e-3;

function mergeOpts<T extends object>(base: T, over?: Partial<T>): T {
    return over ? { ...base, ...over } : { ...base };
}

// ==================== 主函数 ====================

// 加载车辆模型
export async function loadVehicleModel(
    opts: VehicleOptions,
    ctx: VehicleLoaderContext,
): Promise<VehicleInstance> {
    const { loader, scene, vehicleParams, vehicleLength } = ctx;

    const scale = opts.scale ?? 1;
    const debug = mergeOpts(vehicleParams.debug, opts.debug);
    const chassis = mergeOpts(vehicleParams.chassis, opts.chassis);
    const power = mergeOpts(vehicleParams.power, opts.power);
    const steering = mergeOpts(vehicleParams.steering, opts.steering);
    const grip = mergeOpts(vehicleParams.grip, opts.grip);
    const sus = mergeOpts(vehicleParams.suspension, opts.suspension);
    const density = Math.max(1e-8, chassis.density);
    const linearDamping = chassis.linearDamping;
    const angularDamping = chassis.angularDamping;
    const maxSpeed = power.maxSpeed * scale;
    const acceleration = power.acceleration * scale;
    const deceleration = power.deceleration * scale;
    const followVehicleDirection = opts.followVehicleDirection ?? vehicleParams.followVehicleDirection;
    const vehicleDirectionFollowSpeed = opts.vehicleDirectionFollowSpeed ?? vehicleParams.vehicleDirectionFollowSpeed;
    assertDirectionFollowSpeed(vehicleDirectionFollowSpeed);

    let model: THREE.Object3D;
    if (opts.model) {
        model = opts.model;
    } else {
        const gltf = await loader.loadAsync(opts.url);
        model = gltf.scene;
    }

    // 计算模型缩放比
    const { size: originalSize } = getBbox(model);
    const modelScale = vehicleLength / Math.max(originalSize.x, originalSize.y, originalSize.z);

    // 查找轮子节点
    const wheelObjects: THREE.Object3D[] = [];
    for (const name of opts.wheelsNames) {
        let found = false;
        model.traverse(child => {
            if (child.name === name && !found) { wheelObjects.push(child); found = true; }
        });
        if (!found) console.warn(`未找到轮子: ${name}`);
    }

    // 临时挂载获取世界坐标
    const tempGroup = new THREE.Group();
    scene.add(tempGroup);
    model.scale.multiplyScalar(modelScale * scale);
    model.rotateY(opts.modelRotation ?? vehicleParams.model.rotation);
    const { center } = getBbox(model);
    model.position.set(-center.x, -center.y, -center.z);
    tempGroup.add(model);
    tempGroup.updateMatrixWorld(true);

    // 收集轮子世界变换信息
    let wheelRadius = 0, wheelSizeInit = false;
    const wheelsInfo: any[] = [];

    for (const wheel of wheelObjects) {
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        wheel.getWorldPosition(worldPos);
        wheel.getWorldQuaternion(worldQuat);
        wheel.getWorldScale(worldScale);

        // 只计算一次轮子尺寸
        if (!wheelSizeInit) {
            const { size: ws } = getBbox(wheel);
            wheelRadius = Math.max(ws.x, ws.y, ws.z) / 2;
            wheelSizeInit = true;
        }

        wheelsInfo.push({
            axleCs: new THREE.Vector3(0, 0, -1),
            position: worldPos,
            quaternion: worldQuat,
            scale: worldScale,
            radius: wheelRadius,
            object: wheel,
        });
    }

    tempGroup.remove(model);
    scene.remove(tempGroup);

    if (wheelsInfo.length !== 4) {
        throw new Error(`车辆需要 4 个有效车轮节点，当前找到 ${wheelsInfo.length} 个。`);
    }

    // 创建车辆根节点
    const vehicleGroup = new THREE.Group();
    scene.add(vehicleGroup);
    vehicleGroup.add(model);
    vehicleGroup.updateMatrixWorld(true);

    // 轮子包装组（独立旋转）
    const wheelWrappers: THREE.Group[] = [];
    for (let i = 0; i < wheelsInfo.length; i++) {
        const wheel = wheelsInfo[i];
        const wheelWrapper = new THREE.Group();
        wheelWrapper.position.copy(vehicleGroup.worldToLocal(wheel.position.clone()));

        const wheelObj = wheel.object;
        wheelObj.parent?.remove(wheelObj);
        wheelObj.position.set(0, 0, 0);
        wheelObj.quaternion.copy(wheel.quaternion);
        wheelObj.scale.copy(wheel.scale);
        wheelObj.updateMatrixWorld();

        wheelWrapper.add(wheelObj);
        vehicleGroup.add(wheelWrapper);
        wheelWrappers.push(wheelWrapper);
    }

    const shiftContent = (offset: THREE.Vector3) => {
        model.position.sub(offset);
        for (const wrapper of wheelWrappers) wrapper.position.sub(offset);
    };

    // 拆轮后按车身包围盒重定原点，物理盒不含轮胎
    vehicleGroup.updateMatrixWorld(true);
    const { center: bodyCenter, size: bodySize } = getBbox(model);
    shiftContent(vehicleGroup.worldToLocal(bodyCenter.clone()));
    vehicleGroup.updateMatrixWorld(true);

    const { bbox: bodyBbox } = getBbox(model);
    const localMin = vehicleGroup.worldToLocal(bodyBbox.min.clone());
    const localMax = vehicleGroup.worldToLocal(bodyBbox.max.clone());

    let minTireBottom = Infinity;
    let minHubY = Infinity;
    for (const wrapper of wheelWrappers) {
        minHubY = Math.min(minHubY, wrapper.position.y);
        minTireBottom = Math.min(minTireBottom, wrapper.position.y - wheelRadius);
    }

    let boxTop = localMax.y;
    const chassisTopClearance = (boxTop - minTireBottom) / Math.max(scale, 1e-8);
    // 默认盒底罩到轮心，弹簧压死后由盒子托住，避免只靠轮网格撑地
    let boxBottom = Math.min(localMin.y, minHubY);
    if (opts.chassis?.clearance != null) {
        boxBottom = minTireBottom + opts.chassis.clearance * scale;
        boxBottom = Math.max(boxBottom, minTireBottom);
    }
    if (boxBottom > boxTop - MIN_BOX_HEIGHT) boxBottom = boxTop - MIN_BOX_HEIGHT;
    const chassisClearance = (boxBottom - minTireBottom) / Math.max(scale, 1e-8);

    // X/Z 绕水平中心；Y 从盒底向上缩，离地间隙不变
    const sizeScale = chassis.sizeScale;
    const sx = Math.max(1e-3, sizeScale?.x ?? 1);
    const sy = Math.max(1e-3, sizeScale?.y ?? 1);
    const sz = Math.max(1e-3, sizeScale?.z ?? 1);
    const boxHeight = Math.max(MIN_BOX_HEIGHT, (boxTop - boxBottom) * sy);
    boxTop = boxBottom + boxHeight;

    const boxCenterY = (boxTop + boxBottom) * 0.5;
    if (Math.abs(boxCenterY) > 1e-8) {
        shiftContent(new THREE.Vector3(0, boxCenterY, 0));
        vehicleGroup.updateMatrixWorld(true);
    }

    // 硬点用模型轮心。静止长度不传时按轮直径 × 0.2，且不低于静载下沉。
    const stiffness = sus.stiffness ?? DEFAULT_WHEEL_PHYSICS.suspensionStiffness;
    const staticSag = 9.81 * scale / (4 * Math.max(1e-4, stiffness));
    const restLengthOpt = sus.restLength;
    // 传入值按 scale 1 的米；未传时轮半径已含 scale，不再乘
    const restFromOptOrWheel = restLengthOpt != null ? restLengthOpt * scale : wheelRadius * 2 * 0.2;
    const suspensionRestLength = Math.max(restFromOptOrWheel, staticSag * 1.2);
    const maxSuspensionTravel = (sus.maxTravel ?? DEFAULT_MAX_SUSPENSION_TRAVEL) * scale;
    const rollInfluence = sus.rollInfluence ?? DEFAULT_WHEEL_PHYSICS.rollInfluence;
    for (let i = 0; i < wheelsInfo.length; i++) {
        wheelsInfo[i].position = wheelWrappers[i].position.clone();
        wheelsInfo[i].suspensionRestLength = suspensionRestLength;
        wheelsInfo[i].maxSuspensionTravel = maxSuspensionTravel;
        wheelsInfo[i].radius = wheelRadius;
    }

    // 按左前、右前、左后、右后轮中心推算车辆前向
    const frontCenter = wheelWrappers[0].position.clone().add(wheelWrappers[1].position).multiplyScalar(0.5);
    const rearCenter = wheelWrappers[2].position.clone().add(wheelWrappers[3].position).multiplyScalar(0.5);
    const forwardLocal = frontCenter.sub(rearCenter);
    forwardLocal.y = 0;
    if (forwardLocal.lengthSq() < 1e-8) forwardLocal.set(1, 0, 0);
    else forwardLocal.normalize();

    const halfExtents = new THREE.Vector3(
        bodySize.x * 0.5 * sx,
        boxHeight * 0.5,
        bodySize.z * 0.5 * sz,
    );
    const volume = 8 * halfExtents.x * halfExtents.y * halfExtents.z;
    const mass = volume * density;

    // position.y 对齐最低轮底
    minTireBottom = Infinity;
    for (const wrapper of wheelWrappers) {
        minTireBottom = Math.min(minTireBottom, wrapper.position.y - wheelRadius);
    }
    const spawnPosition = opts.position.clone();
    spawnPosition.y -= minTireBottom;

    const chassisBody = new VehicleRigidBody({
        position: spawnPosition,
        mass,
        halfExtents,
        linearDamping,
        angularDamping,
        gravityScale: scale,
    });

    // 物理调试盒
    const physicsBoxMesh = new THREE.Mesh(
        new THREE.BoxGeometry(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.3 }),
    );
    physicsBoxMesh.userData.excludeFromCollider = true;
    if (debug.showPhysicsBox) vehicleGroup.add(physicsBoxMesh);

    vehicleGroup.position.copy(spawnPosition);
    vehicleGroup.updateMatrixWorld(true);

    const wheelPhysics = {
        suspensionStiffness: sus.stiffness ?? DEFAULT_WHEEL_PHYSICS.suspensionStiffness,
        suspensionCompression: sus.compression ?? DEFAULT_WHEEL_PHYSICS.suspensionCompression,
        suspensionRelaxation: sus.relaxation ?? DEFAULT_WHEEL_PHYSICS.suspensionRelaxation,
        maxSuspensionForce: sus.maxForce ?? DEFAULT_WHEEL_PHYSICS.maxSuspensionForce,
        frictionSlip: sus.frictionSlip ?? DEFAULT_WHEEL_PHYSICS.frictionSlip,
        sideFrictionStiffness: sus.sideFrictionStiffness ?? DEFAULT_WHEEL_PHYSICS.sideFrictionStiffness,
        rollInfluence,
    };

    const { vehicle, updateWheelVisuals, destroy, wheelRayDebug, wheelTravelDebug } = createVehicleController(
        chassisBody,
        wheelWrappers,
        wheelsInfo,
        wheelPhysics,
    );
    vehicleGroup.add(wheelRayDebug);
    vehicleGroup.add(wheelTravelDebug);
    wheelRayDebug.visible = debug.showWheelRays;
    wheelTravelDebug.visible = debug.showWheelTravel;

    return {
        vehicleGroup,
        chassisBody,
        vehicleController: vehicle,
        updateWheelVisuals,
        destroyVehicleController: destroy,
        scale,
        driverSeatPosition: opts.driverSeatPosition.clone(),
        driverSeatRotation: opts.driverSeatRotation ?? 0,
        forwardLocal,
        sideFrictionStiffness: wheelPhysics.sideFrictionStiffness,
        steering,
        grip,
        size: { l: Math.max(bodySize.x, bodySize.z), w: Math.min(bodySize.x, bodySize.z), h: bodySize.y },
        halfExtents,
        chassisClearance,
        chassisTopClearance,
        chassisSizeScaleX: sx,
        chassisSizeScaleY: sy,
        chassisSizeScaleZ: sz,
        maxSpeed,
        acceleration,
        deceleration,
        followVehicleDirection,
        vehicleDirectionFollowSpeed,
        physicsBoxMesh,
        wheelRayDebug,
        wheelTravelDebug,
    };
}
