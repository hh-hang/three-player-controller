import assert from "node:assert/strict";
import * as THREE from "three";
import { playerController } from "../../dist/index.mjs";

/** 模拟浏览器事件环境；几何、BVH、移动和骨骼使用真实实现。 */
export function setupBrowser() {
    globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 720 });
    globalThis.document = { pointerLockElement: null, exitPointerLock() { this.pointerLockElement = null; } };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "controller-test" } });
    let nextFrame = 0;
    globalThis.requestAnimationFrame = () => ++nextFrame;
    globalThis.cancelAnimationFrame = () => {};
}

export function makeModel() {
    const model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(40, 180, 30), new THREE.MeshBasicMaterial());
    body.position.y = 90;
    model.add(body);
    const hips = new THREE.Bone();
    hips.name = "hips";
    hips.position.y = 90;
    model.add(hips);
    const skeleton = { hips, legs: {} };
    for (const [side, x] of [["left", -18], ["right", 18]]) {
        const [upper, lower, foot, toe] = ["Upper", "Lower", "Foot", "Toe"].map(part => {
            const bone = new THREE.Bone();
            bone.name = side + part;
            return bone;
        });
        upper.position.x = x;
        lower.position.set(0, -45, 5);
        foot.position.set(0, -45, -5);
        toe.position.z = 10;
        hips.add(upper); upper.add(lower); lower.add(foot); foot.add(toe);
        skeleton.legs[side] = { upper, lower, foot, toe };
    }
    const animations = ["idle", "walk", "run", "jump"].map(name => new THREE.AnimationClip(name, 1, []));
    return { model, animations, skeleton };
}

export async function createPlayer(t, { scale = 0.01, position = [0, 2, 0], ...options } = {}) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 1000);
    camera.position.set(0, 3, 5); // 默认看向 -Z，固定移动方向基准。
    const controls = { domElement: new EventTarget(), target: new THREE.Vector3(), update() {} };
    const character = makeModel();
    const player = new playerController();
    await player.init({
        scene, camera, controls, manageCamera: false, bindKeyboardEvents: false,
        isShowMobileControls: false, initPos: new THREE.Vector3(...position),
        ...options,
        playerModelConfig: {
            model: character.model, animations: character.animations, scale,
            idleAnim: "idle", walkAnim: "walk", runAnim: "run", jumpAnim: "jump",
            ...options.playerModelConfig,
        },
    });
    t.after(() => { if (player.playerCapsule) player.destroy(); });
    return { player, scene, camera, controls, ...character };
}

export function box(size, position) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.position.set(...position);
    mesh.updateMatrixWorld(true);
    return mesh;
}

export function addMesh(player, mesh, motion = "static") {
    return player.addCollider({ motion, shape: { kind: "mesh", source: mesh }, useWorker: false });
}

export function addFloor(player, size = 40) {
    return addMesh(player, box([size, 0.2, size], [0, -0.1, 0]));
}

export async function advance(player, seconds, fps = 60, beforeFrame) {
    const frameCount = Math.round(seconds * fps);
    for (let frame = 0; frame < frameCount; frame++) {
        beforeFrame?.(frame, 1 / fps);
        await player.update(1 / fps);
    }
}

export function near(actual, expected, tolerance = 1e-5, message = "") {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        `${message}: expected ${expected} ± ${tolerance}, received ${actual}`);
}

export function assertFinitePlayer(player) {
    for (const value of [...player.playerCapsule.position.toArray(), ...player.playerCapsule.quaternion.toArray(), ...player.playerVelocity.toArray()]) {
        assert.ok(Number.isFinite(value), "player transform and velocity must stay finite");
    }
}

export function bonePose(model) {
    const poses = new Map();
    model.traverse(node => {
        if (node.isBone) poses.set(node, { position: node.position.clone(), quaternion: node.quaternion.clone() });
    });
    return poses;
}

export function assertBonePose(poses, tolerance = 1e-6) {
    for (const [bone, pose] of poses) {
        near(bone.position.distanceTo(pose.position), 0, tolerance, `${bone.name} position`);
        near(bone.quaternion.angleTo(pose.quaternion), 0, tolerance, `${bone.name} rotation`);
    }
}
