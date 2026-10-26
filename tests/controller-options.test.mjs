import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import * as THREE from "three";
import { playerController } from "../dist/index.mjs";

class TrackedTarget extends EventTarget {
    listeners = new Map();
    addEventListener(type, listener, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
        super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
        this.listeners.get(type)?.delete(listener);
        super.removeEventListener(type, listener, options);
    }
    count(type) { return this.listeners.get(type)?.size ?? 0; }
}

let frames;
beforeEach(() => {
    globalThis.window = Object.assign(new TrackedTarget(), { innerWidth: 1280, innerHeight: 720 });
    globalThis.document = {
        pointerLockElement: null,
        exitPointerLock() { this.pointerLockElement = null; },
    };
    Object.defineProperty(globalThis, "navigator", {
        configurable: true, value: { userAgent: "controller-test" },
    });
    frames = new Map();
    let nextFrame = 0;
    globalThis.requestAnimationFrame = callback => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
});

function flushFrames() {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback());
}

function dispatch(type, values = {}) {
    window.dispatchEvent(Object.assign(new Event(type), values));
}

function makeFixture() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    scene.add(camera);
    camera.position.set(12, 16, 22);
    camera.rotation.set(0.1, 0.2, 0.05, "XYZ");
    camera.setViewOffset(1280, 720, 10, 0, 1280, 720);
    const domElement = new TrackedTarget();
    domElement.requestPointerLock = () => { document.pointerLockElement = domElement; };
    const controls = {
        domElement, target: new THREE.Vector3(2, 3, 4),
        enabled: true, enablePan: true, enableRotate: true, enableZoom: true,
        rotateSpeed: 0.7, maxPolarAngle: 2.1, minDistance: 2.5,
        mouseButtons: { LEFT: 2, MIDDLE: 1, RIGHT: 0 },
        touches: { ONE: 1, TWO: 2 }, updateCount: 0,
        update() { this.updateCount++; },
    };
    const model = new THREE.Group();
    model.add(new THREE.Mesh(new THREE.BoxGeometry(40, 180, 30), new THREE.MeshBasicMaterial()));
    const head = new THREE.Bone();
    head.name = "Head";
    head.position.y = 90;
    model.add(head);
    const options = {
        scene, camera, controls, isShowMobileControls: false,
        playerModelConfig: {
            model, animations: ["idle", "walk", "run", "jump"].map(name => new THREE.AnimationClip(name, 1, [])),
            scale: 1, idleAnim: "idle", walkAnim: "walk", runAnim: "run", jumpAnim: "jump",
            headBoneName: "Head",
        },
    };
    return { player: new playerController(), options, scene, camera, controls, head, domElement };
}

function controlSettings(controls) {
    const { enabled, enablePan, enableRotate, enableZoom, rotateSpeed, maxPolarAngle, minDistance, mouseButtons, touches } = controls;
    return structuredClone({ enabled, enablePan, enableRotate, enableZoom, rotateSpeed, maxPolarAngle, minDistance, mouseButtons, touches });
}

function pose(camera) {
    return {
        position: camera.getWorldPosition(new THREE.Vector3()),
        quaternion: camera.getWorldQuaternion(new THREE.Quaternion()),
    };
}

function assertPose(camera, expected) {
    const actual = pose(camera);
    assert.ok(actual.position.distanceTo(expected.position) < 1e-8);
    assert.ok(actual.quaternion.angleTo(expected.quaternion) < 1e-7);
}

test("相机和输入开关默认开启且保持原有移动和输入行为", async () => {
    const { player, options, controls, domElement } = makeFixture();
    await player.init(options);
    flushFrames();
    assert.equal(player.manageCamera, true);
    assert.equal(player.bindKeyboardEvents, true);
    assert.equal(player.bindLookEvents, true);
    assert.equal(window.count("keydown"), 1);
    assert.equal(domElement.count("wheel"), 1);
    dispatch("keydown", { code: "KeyW" });
    assert.equal(player.input.fwd, true);
    await player.update(1 / 60);
    assert.ok(controls.updateCount > 0);
    dispatch("keyup", { code: "KeyW" });
    assert.equal(player.input.fwd, false);
    player.destroy();
    assert.equal(window.count("keydown"), 0);
    assert.equal(domElement.count("wheel"), 0);
});

test("相机和输入开关关闭时不修改外部相机、Controls 和指针锁定", async () => {
    const { player, options, camera, controls, domElement, scene } = makeFixture();
    const settings = controlSettings(controls);
    const originalPose = pose(camera);
    const originalView = { ...camera.view };
    document.pointerLockElement = domElement;
    await player.init({ ...options, manageCamera: false, bindKeyboardEvents: false, bindLookEvents: false, isFirstPerson: true });
    assert.equal(frames.size, 0);
    assert.equal(window.count("keydown"), 0);
    assert.equal(domElement.count("wheel"), 0);
    player.setInput({ moveY: 1, shift: true, lookDeltaX: 10, lookDeltaY: 10, toggleView: true });
    player.setPlayerScale(0.5);
    player.setMouseSensitivity(8);
    player.setMinCamDistance(50);
    player.setEnableZoom(true);
    player.setOverShoulderView(true);
    await player.switchPlayerModel({ ...options.playerModelConfig, scale: 0.5 });
    await player.update(1 / 60);
    assert.equal(player.input.fwd, true);
    assert.equal(controls.updateCount, 0);
    assertPose(camera, originalPose);
    assert.equal(camera.rotation.order, "XYZ");
    assert.deepEqual(camera.view, originalView);
    assert.deepEqual(controlSettings(controls), settings);
    player.destroy();
    assert.equal(camera.parent, scene);
    assert.equal(document.pointerLockElement, domElement);
    assert.deepEqual(controlSettings(controls), settings);
});

test("应用管理相机时仍可启用内置键盘输入", async () => {
    const { player, options, camera, controls } = makeFixture();
    const originalPose = pose(camera);
    const settings = controlSettings(controls);
    await player.init({ ...options, manageCamera: false });
    dispatch("keydown", { code: "KeyW" });
    dispatch("keydown", { code: "ShiftLeft" });
    dispatch("keydown", { code: "KeyV" });
    dispatch("blur");
    player.setInput({ moveX: 1 });
    await player.update(1 / 60);
    assert.equal(player.input.rgt, true);
    assert.equal(player.isFirstPerson, false);
    assertPose(camera, originalPose);
    assert.deepEqual(controlSettings(controls), settings);
    player.destroy();
});

test("关闭键盘时清除按键状态且鼠标视角、滚轮、外部输入和动画继续工作", async () => {
    const { player, options, camera, controls, domElement } = makeFixture();
    await player.init({ ...options, bindKeyboardEvents: false });
    flushFrames();
    assert.equal(window.count("keydown"), 0);
    assert.equal(domElement.count("wheel"), 1);
    assert.equal(document.pointerLockElement, domElement);
    assert.equal(controls.enableRotate, true);
    assert.equal(controls.enablePan, true);
    assert.equal(window.count("mousemove"), 1);
    const beforeLook = pose(camera);
    dispatch("mousemove", { movementX: 10, movementY: 0 });
    assert.ok(pose(camera).position.distanceTo(beforeLook.position) > 0);
    player.setBindKeyboardEvents(true);
    player.setBindKeyboardEvents(true);
    assert.equal(window.count("keydown"), 1);
    assert.equal(domElement.count("wheel"), 1);
    dispatch("keydown", { code: "KeyW" });
    dispatch("keydown", { code: "Space" });
    player.setBindKeyboardEvents(false);
    assert.equal(player.input.fwd, false);
    assert.equal(player.input.space, false);
    assert.equal(player.isupdate, true);
    assert.equal(window.count("keydown"), 0);
    assert.equal(domElement.count("wheel"), 1);
    assert.equal(document.pointerLockElement, domElement);
    assert.equal(controls.enableRotate, true);
    assert.equal(window.count("mousemove"), 1);
    player.setEnableZoom(true);
    const distance = player.cam.maxDist;
    domElement.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { deltaY: -100, deltaMode: 0 }));
    assert.ok(player.cam.maxDist < distance);
    const time = player.animation.mixer.time;
    player.setInput({ moveY: 1 });
    await player.update(1 / 60);
    assert.equal(player.input.fwd, true);
    assert.ok(player.animation.mixer.time > time);
    player.destroy();
    assert.equal(window.count("mousemove"), 0);
    assert.equal(domElement.count("wheel"), 0);
});

test("关闭键盘绑定保留外部移动轴、冲刺和跳跃状态", async () => {
    const { player, options } = makeFixture();
    await player.init(options);
    player.setInput({ moveX: 0.7, shift: true, jump: true });
    dispatch("keydown", { code: "KeyW" });
    dispatch("keydown", { code: "ShiftLeft" });
    dispatch("keydown", { code: "Space" });
    player.setBindKeyboardEvents(false);
    assert.equal(player.input.fwd, false);
    assert.equal(player.input.rgt, true);
    assert.equal(player.input.shift, true);
    assert.equal(player.input.space, true);
    assert.equal(player.input.getMoveAxes().x, 0.7);
    player.setInput({ shift: false, jump: false });
    assert.equal(player.input.shift, false);
    assert.equal(player.input.space, false);
    player.destroy();
});

test("初始化关闭视角输入时保留键盘、相机跟随和外部视角输入", async () => {
    const { player, options, camera, controls, domElement } = makeFixture();
    await player.init({ ...options, bindLookEvents: false });
    flushFrames();
    assert.equal(player.bindLookEvents, false);
    assert.equal(window.count("keydown"), 1);
    assert.equal(window.count("mousemove"), 0);
    assert.equal(window.count("click"), 0);
    assert.equal(domElement.count("wheel"), 0);
    assert.equal(document.pointerLockElement, null);
    assert.equal(controls.enableRotate, false);
    assert.equal(controls.enablePan, false);
    const playerBefore = player.playerCapsule.position.clone();
    const cameraBefore = camera.position.clone();
    dispatch("keydown", { code: "KeyW" });
    await player.update(1 / 60);
    assert.ok(player.playerCapsule.position.distanceTo(playerBefore) > 0);
    assert.ok(camera.position.distanceTo(cameraBefore) > 0);
    const beforeLook = pose(camera);
    player.setInput({ lookDeltaX: 10, lookDeltaY: 0 });
    assert.ok(pose(camera).position.distanceTo(beforeLook.position) > 0);
    assert.equal(player.isupdate, true);
    player.destroy();
});

test("运行时关闭视角输入释放指针锁定且恢复时不重复绑定", async () => {
    const { player, options, camera, controls, domElement } = makeFixture();
    await player.init(options);
    flushFrames();
    player.setEnableZoom(true);
    player.setBindLookEvents(false);
    player.setBindLookEvents(false);
    assert.equal(document.pointerLockElement, null);
    assert.equal(window.count("keydown"), 1);
    assert.equal(window.count("mousemove"), 0);
    assert.equal(domElement.count("wheel"), 0);
    const beforeLook = pose(camera);
    const distance = player.cam.maxDist;
    dispatch("mousemove", { movementX: 30, movementY: 10 });
    const click = new Event("click");
    Object.defineProperty(click, "target", { value: domElement });
    window.dispatchEvent(click);
    domElement.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { deltaY: -100, deltaMode: 0 }));
    assertPose(camera, beforeLook);
    assert.equal(player.cam.maxDist, distance);
    assert.equal(document.pointerLockElement, null);
    player.setBindLookEvents(true);
    player.setBindLookEvents(true);
    assert.equal(controls.enableRotate, true);
    assert.equal(window.count("mousemove"), 1);
    assert.equal(window.count("click"), 1);
    assert.equal(domElement.count("wheel"), 1);
    assert.equal(document.pointerLockElement, domElement);
    dispatch("mousemove", { movementX: 30, movementY: 10 });
    assert.ok(pose(camera).position.distanceTo(beforeLook.position) > 0);
    player.destroy();
    assert.equal(window.count("mousemove"), 0);
    assert.equal(window.count("click"), 0);
});

test("应用管理相机时切换视角绑定不修改外部 Controls 配置", async () => {
    const { player, options, controls } = makeFixture();
    await player.init({ ...options, manageCamera: false, bindLookEvents: false });
    const settings = controlSettings(controls);
    player.setBindLookEvents(true);
    player.setBindLookEvents(false);
    assert.deepEqual(controlSettings(controls), settings);
    assert.equal(window.count("mousemove"), 0);
    player.setManageCamera(true);
    assert.equal(controls.enableRotate, false);
    player.setBindLookEvents(true);
    assert.equal(controls.enableRotate, settings.enableRotate);
    player.setManageCamera(false);
    assert.deepEqual(controlSettings(controls), settings);
    assert.equal(window.count("mousemove"), 0);
    player.destroy();
});

test("交还相机时保留第一人称世界位姿并恢复外部配置", async () => {
    const { player, options, scene, camera, controls, head, domElement } = makeFixture();
    const settings = controlSettings(controls);
    const originalView = { ...camera.view };
    await player.init(options);
    flushFrames();
    player.changeView();
    assert.equal(camera.parent, head);
    head.rotation.set(0.2, 0.3, 0.1);
    const beforeRelease = pose(camera);
    player.setManageCamera(false);
    assert.equal(camera.parent, scene);
    assertPose(camera, beforeRelease);
    assert.deepEqual(controlSettings(controls), settings);
    assert.deepEqual(camera.view, originalView);
    assert.equal(domElement.count("wheel"), 0);
    assert.equal(document.pointerLockElement, null);
    head.rotation.y += 1;
    await player.update(1 / 60);
    assertPose(camera, beforeRelease);
    player.setManageCamera(true);
    flushFrames();
    assert.equal(camera.parent, head);
    assert.equal(domElement.count("wheel"), 1);
    const beforeDestroy = pose(camera);
    player.destroy();
    assert.equal(camera.parent, scene);
    assertPose(camera, beforeDestroy);
    assert.deepEqual(controlSettings(controls), settings);
});

test("交还相机时取消延迟定位且原有暂停和恢复接口正常工作", async () => {
    const { player, options, camera } = makeFixture();
    await player.init(options);
    assert.equal(frames.size, 1);
    const beforeRelease = pose(camera);
    player.setManageCamera(false);
    assert.equal(frames.size, 0);
    flushFrames();
    assertPose(camera, beforeRelease);
    player.offAllEvent();
    assert.equal(player.isupdate, false);
    assert.equal(player.bindKeyboardEvents, false);
    assert.equal(player.bindLookEvents, false);
    player.onAllEvent();
    assert.equal(player.isupdate, true);
    assert.equal(player.bindKeyboardEvents, true);
    assert.equal(player.bindLookEvents, true);
    player.destroy();
});

test("销毁时将第一人称相机恢复为原先无父节点的状态", async () => {
    const { player, options, camera } = makeFixture();
    camera.removeFromParent();
    await player.init({ ...options, isFirstPerson: true });
    flushFrames();
    const beforeDestroy = pose(camera);
    player.destroy();
    assert.equal(camera.parent, null);
    assertPose(camera, beforeDestroy);
});

test("关闭视角、暂停全部事件、交还相机或销毁后释放迟到的指针锁定", async () => {
    for (const release of [player => player.setBindLookEvents(false), player => player.offAllEvent(), player => player.setManageCamera(false), player => player.destroy()]) {
        const { player, options, domElement } = makeFixture();
        let grant;
        domElement.requestPointerLock = () => new Promise(resolve => { grant = resolve; });
        await player.init(options);
        release(player);
        document.pointerLockElement = domElement;
        grant();
        await Promise.resolve();
        assert.equal(document.pointerLockElement, null);
        if (player.playerCapsule) player.destroy();
    }
});

test("切换到自由鼠标模式或退出第一人称后释放迟到的指针锁定", async () => {
    for (const mode of [2, 3, 4]) {
        for (const firstPerson of [false, true]) {
            const { player, options, domElement } = makeFixture();
            let grant;
            domElement.requestPointerLock = () => new Promise(resolve => { grant = resolve; });
            await player.init({ ...options, thirdMouseMode: firstPerson ? mode : 0, isFirstPerson: firstPerson });
            flushFrames();
            if (firstPerson) player.changeView();
            else player.setThirdMouseMode(mode);
            document.pointerLockElement = domElement;
            grant();
            await Promise.resolve();
            assert.equal(document.pointerLockElement, null);
            player.destroy();
        }
    }
});

test("迟到的指针锁定仍满足当前视角需求时保持锁定", async () => {
    for (const firstPerson of [false, true]) {
        const { player, options, domElement } = makeFixture();
        let grant;
        domElement.requestPointerLock = () => new Promise(resolve => { grant = resolve; });
        await player.init({ ...options, thirdMouseMode: firstPerson ? 3 : 0, isFirstPerson: firstPerson });
        flushFrames();
        document.pointerLockElement = domElement;
        grant();
        await Promise.resolve();
        assert.equal(document.pointerLockElement, domElement);
        player.destroy();
    }
});
