import * as THREE from "three";
import type { playerController } from "../PlayerController";
import type { ColliderDesc, ColliderHandle, DynamicColliderDesc } from "../collision/colliderDesc";
import type { MotionType } from "../collision/CollisionWorld";
import {
    attachBoundsTree,
    buildKinematicMergedMesh,
    buildStaticMergedMesh,
} from "../collision/colliderBuild";
import type { KinematicColliderEntry } from "../types";

let warnedDynamicMesh = false;

/**
 * 统一碰撞体注册：按 ColliderDesc 创建 / 移除，并维护运动学跟随。
 * 静态 / 运动学 mesh 走合并 + BVH；动态球 / 盒交给 DynamicBodySystem。
 */
export class ColliderRegistry {
    private ctrl: playerController;
    kinematicColliders: KinematicColliderEntry[] = []; // 需每帧跟随的运动学项
    /** id → handle 元数据 */
    private handles = new Map<number, ColliderHandle>();
    /** 静态构建代数：异步 BVH 完成时若代数变了则丢弃 */
    private buildGens = new Map<number, number>();
    private _contentScale = new THREE.Vector3();
    private _contentOffsetMatrix = new THREE.Matrix4();
    /** 静态 / 运动学 mesh 碰撞线框开关。 */
    private debugVisible = false;

    constructor(ctrl: playerController) {
        this.ctrl = ctrl;
    }

    /** 返回碰撞 mesh 调试开关。 */
    getDebugVisible(): boolean {
        return this.debugVisible;
    }

    /** 切换静态 / 运动学 mesh 碰撞线框。 */
    setDebugVisible(visible: boolean): void {
        this.debugVisible = visible;
        this.syncDebugVisibility();
    }

    /** 同步已就绪碰撞 mesh 的调试显隐。 */
    syncDebugVisibility(): void {
        const synced = new Set<THREE.Mesh>();
        for (const handle of this.handles.values()) {
            const mesh = handle.collisionMesh;
            if (!mesh || synced.has(mesh)) continue;
            synced.add(mesh);
            this.syncDebugMesh(mesh);
        }
    }

    /** 按 desc 创建碰撞体；校验 motion/shape 约束后分派到 mesh/box/sphere。 */
    add(desc: ColliderDesc): ColliderHandle {
        if (desc.motion === "static" && (desc as { follow?: unknown }).follow != null) {
            throw new Error("静态碰撞体不能设置 follow。");
        }
        if (desc.motion === "dynamic" && (desc as { follow?: unknown }).follow != null) {
            throw new Error("动态碰撞体不能设置 follow。");
        }
        if (desc.shape.kind === "mesh") {
            const hasSource = "source" in desc.shape && desc.shape.source != null;
            const hasMesh = "mesh" in desc.shape && desc.shape.mesh != null;
            if (hasSource === hasMesh) {
                throw new Error("网格形状必须且只能提供 source 或 mesh 中的一项。");
            }
            if (desc.motion === "dynamic" && !warnedDynamicMesh) {
                warnedDynamicMesh = true;
                console.warn(
                    "[three-player-controller] dynamic + mesh 允许但不推荐：三角网格无体积，易卡顿/穿透；动态物请优先 box/sphere。",
                );
            }
        }

        switch (desc.shape.kind) {
            case "mesh":
                return this.addMesh(desc);
            case "box":
                return this.addBox(desc);
            case "sphere":
                return this.addSphere(desc);
            default:
                throw new Error("无法识别 shape.kind 指定的形状类型。");
        }
    }

    /** 按句柄或 id 移除；同步释放 mesh / 动态刚体与 CollisionWorld 登记。 */
    remove(handle: ColliderHandle | number): void {
        const id = typeof handle === "number" ? handle : handle.id;
        if (id < 0) return;
        const meta = this.handles.get(id);
        const kin = this.kinematicColliders.find(e => e.worldId === id);
        if (kin) {
            kin.buildId += 1; // 作废进行中的异步 BVH
            this.ctrl.scene.remove(kin.mesh);
            kin.mesh.geometry.dispose();
            (kin.mesh.material as THREE.Material).dispose();
            if (this.ctrl.activeKinematicCollider === kin) this.ctrl.activeKinematicCollider = null;
            this.kinematicColliders = this.kinematicColliders.filter(e => e !== kin);
        } else if (meta?.collisionMesh) {
            this.ctrl.scene.remove(meta.collisionMesh);
            meta.collisionMesh.geometry.dispose();
            (meta.collisionMesh.material as THREE.Material).dispose();
        }

        // 动态刚体：remove 内部会卸 CollisionWorld
        const body = this.ctrl.dynamics.findByColliderId(id);
        if (body) {
            this.ctrl.dynamics.remove(body);
            this.handles.delete(id);
            this.buildGens.delete(id);
            return;
        }

        this.ctrl.collisionWorld.remove(id);
        this.handles.delete(id);
        this.buildGens.delete(id);
    }

    /** 清除碰撞体；可按 motion 过滤。 */
    clear(filter?: { motion?: MotionType }): void {
        for (const id of this.ctrl.collisionWorld.idsByMotion(filter?.motion)) {
            this.remove(id);
        }
    }

    /** 按 follow/source Object3D 查找运动学项。 */
    findKinematicBySource(source: THREE.Object3D): KinematicColliderEntry | undefined {
        return this.kinematicColliders.find(e => e.source === source);
    }

    /**
     * 每帧同步运动学碰撞网格到 follow 的 matrixWorld。
     * 若人物站在平台上，用 prev→current 算出本帧应带走的 deltaPos / deltaRotY。
     */
    updateKinematicFollow(): void {
        const playerWorldPos = this.ctrl.playerCapsule?.position;
        for (const entry of this.kinematicColliders) {
            if (playerWorldPos) {
                const prevInv = new THREE.Matrix4().copy(entry.prevWorldMatrix).invert();
                const playerInLocal = playerWorldPos.clone().applyMatrix4(prevInv);
                this.writeKinematicMeshMatrix(entry);
                const playerInNewWorld = playerInLocal.clone().applyMatrix4(entry.mesh.matrixWorld);
                entry.deltaPos.subVectors(playerInNewWorld, playerWorldPos);
            } else {
                this.writeKinematicMeshMatrix(entry);
                entry.deltaPos.set(0, 0, 0);
            }
            const prevEuler = new THREE.Euler().setFromRotationMatrix(entry.prevWorldMatrix, "YXZ");
            const curEuler = new THREE.Euler().setFromRotationMatrix(entry.mesh.matrixWorld, "YXZ");
            entry.deltaRotY = curEuler.y - prevEuler.y;
        }
    }

    /** 将 follow 世界矩阵（含 contentOffset / bakeInverse / contentScale）写入碰撞 mesh。 */
    private writeKinematicMeshMatrix(entry: KinematicColliderEntry): void {
        entry.source.updateMatrixWorld(true);
        entry.mesh.matrix.copy(entry.source.matrixWorld);
        if (entry.contentOffset.lengthSq() > 0) {
            entry.mesh.matrix.multiply(
                this._contentOffsetMatrix.makeTranslation(
                    entry.contentOffset.x,
                    entry.contentOffset.y,
                    entry.contentOffset.z,
                ),
            );
        }
        entry.mesh.matrix.multiply(entry.bakeInverse);
        const s = entry.contentScale;
        if (s !== 1) {
            entry.mesh.matrix.scale(this._contentScale.set(s, s, s));
        }
        entry.mesh.updateMatrixWorld(true);
    }

    /**
     * 运行时等比缩放已烘焙的运动学 mesh 碰撞（不重建 BVH）。
     * source 为注册时的 follow / vehicleGroup。
     */
    scaleKinematicContent(source: THREE.Object3D, ratio: number): void {
        if (!source || !Number.isFinite(ratio) || ratio === 1) return;
        const entry = this.kinematicColliders.find(e => e.source === source);
        if (!entry) return;
        entry.contentScale *= ratio;
        entry.contentOffset.multiplyScalar(ratio);
        this.writeKinematicMeshMatrix(entry);
        entry.prevWorldMatrix.copy(entry.mesh.matrixWorld);
    }

    /** 运行时平移已烘焙的运动学 mesh 碰撞，不重建 BVH。 */
    translateKinematicContent(source: THREE.Object3D, localOffset: THREE.Vector3): void {
        if (!source || !Number.isFinite(localOffset.lengthSq()) || localOffset.lengthSq() === 0) return;
        const entry = this.kinematicColliders.find(e => e.source === source);
        if (!entry) return;
        entry.contentOffset.add(localOffset);
        this.writeKinematicMeshMatrix(entry);
        entry.prevWorldMatrix.copy(entry.mesh.matrixWorld);
    }

    /** 本帧物理用完后再提交平台矩阵，供下一帧算 delta。 */
    commitKinematicPrev(): void {
        for (const entry of this.kinematicColliders) {
            entry.prevWorldMatrix.copy(entry.mesh.matrixWorld);
        }
    }

    /** 是否已有至少一份带 BVH 的静态 mesh。 */
    isStaticUsable(): boolean {
        for (const col of this.ctrl.collisionWorld.query(
            { mask: 0xffff },
            { motion: "static", kinds: ["mesh"] },
        )) {
            if (col.shape.kind === "mesh" && (col.shape.mesh.geometry as any).boundsTree) {
                return true;
            }
        }
        return false;
    }

    /** 运动学项是否已就绪（BVH 可用）。 */
    isKinematicUsable(entry: KinematicColliderEntry): boolean {
        return entry.ready && Boolean((entry.mesh.geometry as any).boundsTree);
    }

    /** 写入 handles 并返回公开句柄。 */
    private makeHandle(
        id: number,
        motion: MotionType,
        follow: THREE.Object3D | null,
        source: THREE.Object3D | null,
        collisionMesh: THREE.Mesh | null,
    ): ColliderHandle {
        const h: ColliderHandle = { id, motion, follow, source, collisionMesh };
        this.handles.set(id, h);
        return h;
    }

    /** mesh：按 motion 走动态登记 / 运动学 / 静态合并。 */
    private addMesh(desc: ColliderDesc): ColliderHandle {
        const shape = desc.shape as Extract<ColliderDesc["shape"], { kind: "mesh" }>;
        if (desc.motion === "dynamic") {
            // 允许但不推荐：登记已有 mesh，不合并、不建刚体求解
            const mesh = "mesh" in shape && shape.mesh
                ? shape.mesh
                : (() => {
                    throw new Error("动态碰撞体使用网格形状时必须传入已有 mesh，或改用 box / sphere 形状。");
                })();
            const entry = this.ctrl.collisionWorld.add({
                motion: "dynamic",
                shape: { kind: "mesh", mesh },
                groups: desc.groups,
                mask: desc.mask,
                userData: desc.userData,
            });
            return this.makeHandle(entry.id, "dynamic", null, null, mesh);
        }

        if (desc.motion === "kinematic") {
            return this.addKinematicMesh(desc);
        }

        // static：已有 BVH mesh 直接登记，否则合并 source 再挂 BVH
        const source = "source" in shape && shape.source
            ? shape.source
            : null;
        const readyMesh = "mesh" in shape && shape.mesh ? shape.mesh : null;

        if (readyMesh) {
            const entry = this.ctrl.collisionWorld.add({
                motion: "static",
                shape: { kind: "mesh", mesh: readyMesh },
                groups: desc.groups,
                mask: desc.mask,
                ready: Boolean((readyMesh.geometry as any).boundsTree),
                userData: desc.userData,
            });
            this.syncDebugMesh(readyMesh);
            return this.makeHandle(entry.id, "static", null, null, readyMesh);
        }

        const built = buildStaticMergedMesh(source!);
        if (!built) {
            console.warn("静态 mesh 合并失败：无可用几何");
            return { id: -1, motion: "static", follow: null, source: null, collisionMesh: null };
        }

        const world = this.ctrl.collisionWorld.add({
            motion: "static",
            shape: { kind: "mesh", mesh: built.mesh },
            groups: desc.groups,
            mask: desc.mask,
            ready: false, // BVH 完成前不参与查询
            userData: desc.userData,
        });
        const handle = this.makeHandle(
            world.id,
            "static",
            null,
            Array.isArray(source) ? (source[0] ?? null) : source,
            built.mesh,
        );
        this.buildGens.set(world.id, 1);
        const gen = 1;

        attachBoundsTree(built.geometry, {
            useWorker: desc.useWorker,
            workerPool: this.ctrl.getBvhWorkerPool(),
            maxDepth: 100,
            onStale: () => this.buildGens.get(world.id) !== gen || this.ctrl.collisionWorld.get(world.id) == null,
            onReady: () => {
                if (this.buildGens.get(world.id) !== gen) return;
                this.ctrl.collisionWorld.setReady(world.id, true);
                this.syncDebugMesh(built.mesh);
            },
        });
        return handle;
    }

    /** 运动学 mesh：已有 mesh 或从 source 合并，并加入 kinematicColliders 跟随列表。 */
    private addKinematicMesh(desc: ColliderDesc): ColliderHandle {
        const shape = desc.shape as Extract<ColliderDesc["shape"], { kind: "mesh" }>;
        const follow =
            ("follow" in desc ? desc.follow : undefined)
            ?? (("source" in shape && !Array.isArray(shape.source)) ? shape.source : undefined)
            ?? null;

        if ("mesh" in shape && shape.mesh) {
            const mesh = shape.mesh;
            mesh.matrixAutoUpdate = false;
            if (follow) {
                follow.updateMatrixWorld(true);
                mesh.matrix.copy(follow.matrixWorld);
                mesh.updateMatrixWorld(true);
            }
            const entry: KinematicColliderEntry = {
                source: follow ?? mesh,
                mesh,
                contentScale: 1,
                contentOffset: new THREE.Vector3(),
                bakeInverse: new THREE.Matrix4(),
                prevWorldMatrix: new THREE.Matrix4().copy(follow?.matrixWorld ?? mesh.matrixWorld),
                deltaPos: new THREE.Vector3(),
                deltaRotY: 0,
                ready: Boolean((mesh.geometry as any).boundsTree),
                buildId: 1,
                worldId: 0,
            };
            const world = this.ctrl.collisionWorld.add({
                motion: "kinematic",
                shape: { kind: "mesh", mesh },
                groups: desc.groups,
                mask: desc.mask,
                ready: entry.ready,
                userData: entry,
            });
            entry.worldId = world.id;
            this.kinematicColliders.push(entry);
            this.syncDebugMesh(mesh);
            return this.makeHandle(world.id, "kinematic", follow, follow, mesh);
        }

        const sourceObj = shape.source;
        const root = Array.isArray(sourceObj) ? sourceObj[0] : sourceObj;
        if (!root) throw new Error("运动学网格必须提供 source。");

        // 同一 follow/source 已注册则复用，避免重复合并
        const existing = this.kinematicColliders.find(e => e.source === (follow ?? root));
        if (existing) {
            return this.handles.get(existing.worldId)
                ?? this.makeHandle(existing.worldId, "kinematic", follow ?? root, root, existing.mesh);
        }

        const built = buildKinematicMergedMesh(root);
        if (!built) {
            console.warn("运动学 mesh 合并失败：无可用几何");
            return { id: -1, motion: "kinematic", follow: follow ?? root, source: root, collisionMesh: null };
        }

        const followTarget = follow ?? root;
        followTarget.updateMatrixWorld(true);
        // verts 已在世界空间收心
        const bakeInverse = new THREE.Matrix4()
            .copy(followTarget.matrixWorld)
            .invert()
            .multiply(built.mesh.matrix);
        const entry: KinematicColliderEntry = {
            source: followTarget,
            mesh: built.mesh,
            contentScale: 1,
            contentOffset: new THREE.Vector3(),
            bakeInverse,
            prevWorldMatrix: new THREE.Matrix4().copy(built.mesh.matrixWorld),
            deltaPos: new THREE.Vector3(),
            deltaRotY: 0,
            ready: !desc.useWorker, // Worker 时先不可用，onReady 再打开
            buildId: 1,
            worldId: 0,
        };
        const world = this.ctrl.collisionWorld.add({
            motion: "kinematic",
            shape: { kind: "mesh", mesh: built.mesh },
            groups: desc.groups,
            mask: desc.mask,
            ready: entry.ready,
            userData: entry,
        });
        entry.worldId = world.id;
        this.kinematicColliders.push(entry);
        const handle = this.makeHandle(world.id, "kinematic", followTarget, root, built.mesh);
        const buildId = entry.buildId;

        attachBoundsTree(built.geometry, {
            useWorker: desc.useWorker,
            workerPool: this.ctrl.getBvhWorkerPool(),
            onStale: () => entry.buildId !== buildId || !this.kinematicColliders.includes(entry),
            onReady: () => {
                if (entry.buildId !== buildId || !this.kinematicColliders.includes(entry)) return;
                entry.ready = true;
                this.ctrl.collisionWorld.setReady(entry.worldId, true);
                this.syncDebugMesh(built.mesh);
            },
        });
        return handle;
    }

    /** 按当前开关同步单个碰撞 mesh。 */
    private syncDebugMesh(mesh: THREE.Mesh): void {
        if (this.debugVisible && (mesh.geometry as any).boundsTree) {
            if (!this.ctrl.scene.children.includes(mesh)) this.ctrl.scene.add(mesh);
        } else {
            this.ctrl.scene.remove(mesh);
        }
    }

    /**
     * box：
     * - dynamic 且 simulate 默认 true → 创建 DynamicBoxBody
     * - dynamic 且 simulate: false → 仅登记（车辆底盘）
     * - static / kinematic → 仅登记
     */
    private addBox(desc: ColliderDesc): ColliderHandle {
        if (desc.motion === "dynamic" && (desc as DynamicColliderDesc).simulate !== false) {
            const body = this.ctrl.dynamics.addBox(desc as DynamicColliderDesc);
            if (desc.groups != null) this.ctrl.collisionWorld.setGroups(body.colliderId, desc.groups);
            if (desc.mask != null) this.ctrl.collisionWorld.setMask(body.colliderId, desc.mask);
            if (desc.userData != null) this.ctrl.collisionWorld.setUserData(body.colliderId, desc.userData);
            return this.makeHandle(body.colliderId, "dynamic", null, null, null);
        }

        const shape = desc.shape as Extract<ColliderDesc["shape"], { kind: "box" }>;
        const half = shape.halfExtents.clone();
        const entry = this.ctrl.collisionWorld.add({
            motion: desc.motion,
            shape: { kind: "box", halfExtents: half },
            groups: desc.groups,
            mask: desc.mask,
            userData: desc.userData,
        });
        return this.makeHandle(entry.id, desc.motion, null, null, null);
    }

    /**
     * sphere：dynamic 时创建 DynamicSphereBody；
     * static/kinematic 仅登记形状（供查询矩阵，无球刚体步进）。
     */
    private addSphere(desc: ColliderDesc): ColliderHandle {
        if (desc.motion === "dynamic") {
            const body = this.ctrl.dynamics.addSphere(desc as DynamicColliderDesc);
            if (desc.groups != null) this.ctrl.collisionWorld.setGroups(body.colliderId, desc.groups);
            if (desc.mask != null) this.ctrl.collisionWorld.setMask(body.colliderId, desc.mask);
            if (desc.userData != null) this.ctrl.collisionWorld.setUserData(body.colliderId, desc.userData);
            return this.makeHandle(body.colliderId, "dynamic", null, null, null);
        }

        const shape = desc.shape as Extract<ColliderDesc["shape"], { kind: "sphere" }>;
        const entry = this.ctrl.collisionWorld.add({
            motion: desc.motion,
            shape: { kind: "sphere", radius: shape.radius },
            groups: desc.groups,
            mask: desc.mask,
            userData: desc.userData,
        });
        return this.makeHandle(entry.id, desc.motion, null, null, null);
    }
}
