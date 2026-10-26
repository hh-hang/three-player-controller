import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createPlayer, setupBrowser, box, addMesh, addFloor, advance, near, assertFinitePlayer } from "./helpers/controller-fixture.mjs";

beforeEach(setupBrowser);

test("落地后保持接地且高度不漂移", async t => {
    const { player } = await createPlayer(t);
    addFloor(player);
    await advance(player, 1);
    assert.equal(player.playerIsOnGround, true);
    const height = player.playerCapsule.position.y;
    near(height, player.getCapsuleGroundHeight());
    await advance(player, 5, 60, () => {
        near(player.playerCapsule.position.y, height);
        assert.equal(player.playerIsOnGround, true);
    });
    near(player.playerVelocity.y, 0);
    assertFinitePlayer(player);
});

test("跳跃时自由上升并且只触发一次落地", async t => {
    const { player } = await createPlayer(t);
    addFloor(player);
    await advance(player, 1);
    const baseline = player.playerCapsule.position.y;
    const transitions = [];
    player.onGroundChange = grounded => transitions.push(grounded);
    player.setInput({ jump: true });
    assert.equal(player.playerIsOnGround, false);
    player.setInput({ jump: false });
    let peak = baseline;
    await advance(player, 1.5, 60, () => { peak = Math.max(peak, player.playerCapsule.position.y); });
    assert.ok(peak > baseline + 0.5, "the ground probe must not pull an ascending jump back down");
    assert.deepEqual(transitions, [false, true]);
    near(player.playerCapsule.position.y, baseline);
    near(player.playerVelocity.y, 0);
});

test("斜向移动时沿墙滑动且不穿墙", async t => {
    const { player } = await createPlayer(t);
    addFloor(player);
    addMesh(player, box([0.2, 5, 20], [1, 2.5, 0]));
    await advance(player, 1);
    player.setInput({ moveX: 1, moveY: 1 });
    await advance(player, 2, 60, () => {
        assert.ok(player.playerCapsule.position.x <= 0.601, "capsule must remain outside the wall");
        assertFinitePlayer(player);
    });
    assert.ok(player.playerCapsule.position.x > 0.5, "the test must actually reach the wall");
    assert.ok(player.playerCapsule.position.z < -2, "forward motion should continue along the wall");
});

test("持续顶住墙角时不穿墙且位姿和速度保持有限值", async t => {
    const { player } = await createPlayer(t);
    addFloor(player);
    addMesh(player, box([0.2, 5, 20], [1, 2.5, 0]));
    addMesh(player, box([20, 5, 0.2], [0, 2.5, -1]));
    await advance(player, 1);
    player.setInput({ moveX: 1, moveY: 1, shift: true });
    await advance(player, 3, 60, () => {
        assert.ok(player.playerCapsule.position.x <= 0.601);
        assert.ok(player.playerCapsule.position.z >= -0.601);
        assertFinitePlayer(player);
    });
    assert.ok(player.playerCapsule.position.x > 0.5 && player.playerCapsule.position.z < -0.5);
});

test("走出边缘后清除支撑并开始下落", async t => {
    const { player } = await createPlayer(t);
    addMesh(player, box([2, 0.2, 4], [0, -0.1, 0]));
    await advance(player, 1);
    player.setInput({ moveX: 1 });
    await advance(player, 1.5);
    assert.equal(player.playerIsOnGround, false);
    assert.equal(player.getGroundSupport(), null);
    assert.ok(player.playerVelocity.y < 0);
    assert.ok(player.playerCapsule.position.y < 0);
});

for (const [gap, supported] of [[0.1, true], [0.5, false]]) {
    test(`地面体积探测${supported ? "覆盖细缝并保持接地" : "不会跨越宽缺口提供支撑"}`, async t => {
        const { player } = await createPlayer(t, { position: [0, 1.5, 0] });
        for (const side of [-1, 1]) {
            addMesh(player, box([2, 0.2, 4], [side * (1 + gap / 2), -0.1, 0]));
        }
        await advance(player, 1);
        assert.equal(player.playerIsOnGround, supported);
        if (supported) near(player.playerCapsule.position.y, player.getCapsuleGroundHeight());
        else assert.ok(player.playerCapsule.position.y < 0);
    });
}

test("关闭体积探测时缝隙中心初始无支撑", async t => {
    const { player } = await createPlayer(t, { position: [0, 1.5, 0], enableGroundVolumeProbe: false });
    for (const side of [-1, 1]) addMesh(player, box([2, 0.2, 4], [side * 1.05, -0.1, 0]));
    // 在胶囊下落并接触缝隙侧壁前检查接地状态。
    await player.update(1 / 60);
    assert.equal(player.playerIsOnGround, false);
    assert.equal(player.getGroundSupport(), null);
    assert.ok(player.playerVelocity.y < 0);
});

test("时间缩放可暂停和加速模拟且不产生无效物理步", async t => {
    const { player } = await createPlayer(t);
    addFloor(player);
    await advance(player, 1);
    player.timeScale = 0;
    const position = player.playerCapsule.position.clone();
    const time = player.animation.mixer.time;
    await advance(player, 1, 30);
    near(player.playerCapsule.position.distanceTo(position), 0);
    near(player.animation.mixer.time, time);
    player.timeScale = 2;
    await advance(player, 1, 30);
    near(player.animation.mixer.time - time, 2, 1e-8);
    assertFinitePlayer(player);
});

test("30、60、120 FPS 下相同时长的移动距离、动画时间和落地时间接近", async t => {
    const results = [];
    for (const fps of [30, 60, 120]) {
        const { player } = await createPlayer(t);
        addFloor(player);
        await advance(player, 1, fps);
        player.setInput({ moveY: 1 });
        const animationTime = player.animation.mixer.time;
        await advance(player, 2, fps);
        const distance = -player.playerCapsule.position.z;
        near(player.animation.mixer.time - animationTime, 2, 1e-8, `${fps} FPS animation time`);
        player.setInput({ moveY: 0 });
        await advance(player, 1, fps);
        player.setInput({ jump: true });
        player.setInput({ jump: false });
        let landingTime = null;
        for (let frame = 1; frame <= fps * 2; frame++) {
            await player.update(1 / fps);
            if (player.playerIsOnGround) { landingTime = frame / fps; break; }
        }
        assert.notEqual(landingTime, null);
        results.push({ distance, landingTime });
    }
    for (const result of results) {
        near(result.distance, results[1].distance, 0.1, "travel distance across frame rates");
        near(result.landingTime, results[1].landingTime, 0.05, "landing time across frame rates");
    }
});

test("长时间停顿后的追赶有上限且无效时间步不破坏状态", async t => {
    const { player } = await createPlayer(t);
    addFloor(player);
    await advance(player, 1);
    const time = player.animation.mixer.time;
    await player.update(5);
    const simulated = player.animation.mixer.time - time;
    assert.ok(simulated > 0 && simulated <= 0.10000001, "a resumed tab must not simulate a multi-second jump at once");
    const position = player.playerCapsule.position.clone();
    const animationTime = player.animation.mixer.time;
    for (const dt of [0, -1, NaN, Infinity]) await player.update(dt);
    near(player.playerCapsule.position.distanceTo(position), 0);
    near(player.animation.mixer.time, animationTime);
    assertFinitePlayer(player);
});
