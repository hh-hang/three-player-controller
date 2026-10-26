import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Vector3 } from "three";
import { createPlayer, setupBrowser, box, addMesh, advance, near, assertFinitePlayer } from "./helpers/controller-fixture.mjs";

beforeEach(setupBrowser);

async function onPlatform(t) {
    const fixture = await createPlayer(t, { position: [1, 2, 0.5] });
    const platform = box([6, 0.2, 6], [0, -0.1, 0]);
    const handle = addMesh(fixture.player, platform, "kinematic");
    await advance(fixture.player, 1);
    assert.ok(fixture.player.activeKinematicCollider);
    return { ...fixture, platform, handle };
}

test("平移平台携带站立角色且相对位置不漂移", async t => {
    const { player, platform } = await onPlatform(t);
    const local = player.playerCapsule.position.clone().sub(platform.position);
    await advance(player, 2, 60, (_, dt) => {
        platform.position.x += 0.5 * dt;
        platform.position.z -= 0.25 * dt;
    });
    near(player.playerCapsule.position.clone().sub(platform.position).distanceTo(local), 0, 1e-5);
    assert.equal(player.playerIsOnGround, true);
});

test("偏离中心的角色随平台旋转并同步偏航", async t => {
    const { player, platform } = await onPlatform(t);
    const initial = player.playerCapsule.position.clone();
    const initialYaw = player.playerCapsule.rotation.y;
    await advance(player, 2, 60, (_, dt) => { platform.rotation.y += Math.PI / 4 * dt; });
    const expected = new Vector3(initial.x, 0, initial.z).applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    near(player.playerCapsule.position.x, expected.x, 1e-5);
    near(player.playerCapsule.position.z, expected.z, 1e-5);
    near(player.playerCapsule.rotation.y - initialYaw, Math.PI / 2, 1e-5);
    assertFinitePlayer(player);
});

for (const fps of [30, 60, 120]) {
    test(`${fps} FPS 下上升平台保持角色站立高度稳定`, async t => {
        const { player, platform } = await onPlatform(t);
        await advance(player, 2, fps, (_, dt) => {
            platform.position.y += 0.3 * dt;
        });
        const top = platform.position.y + 0.1;
        near(player.playerCapsule.position.y, top + player.getCapsuleGroundHeight(), 0.002,
            "ground snapping must not apply platform vertical displacement twice");
        assert.equal(player.playerIsOnGround, true);
        assertFinitePlayer(player);
    });
}

test("跳离平台后立即停止携带", async t => {
    const { player, platform } = await onPlatform(t);
    const x = player.playerCapsule.position.x;
    player.setInput({ jump: true });
    player.setInput({ jump: false });
    await advance(player, 0.2, 60, (_, dt) => { platform.position.x += 5 * dt; });
    near(player.playerCapsule.position.x, x);
    assert.equal(player.activeKinematicCollider, null);
    assert.equal(player.getGroundSupport(), null);
    assert.ok(player.playerCapsule.position.y > player.getCapsuleGroundHeight());
});

test("下降平台保持角色接地", async t => {
    const { player, platform } = await onPlatform(t);
    await advance(player, 2, 60, (_, dt) => { platform.position.y -= 0.3 * dt; });
    near(player.playerCapsule.position.y, platform.position.y + 0.1 + player.getCapsuleGroundHeight(), 0.002);
    assert.equal(player.playerIsOnGround, true);
});

test("平台将角色带向墙壁时仍正确处理人物碰撞", async t => {
    const { player, platform } = await onPlatform(t);
    addMesh(player, box([0.2, 5, 20], [2, 2.5, 0]));
    await advance(player, 3, 60, (_, dt) => { platform.position.x += 0.5 * dt; });
    near(player.playerCapsule.position.x, 1.6, 0.001, "platform movement must not push the capsule through a wall");
    assert.equal(player.playerIsOnGround, true);
    assertFinitePlayer(player);
});

test("走出平台后清除携带状态", async t => {
    const { player, platform } = await onPlatform(t);
    player.setInput({ moveX: 1 });
    await advance(player, 2, 60, (_, dt) => { platform.position.z += 0.1 * dt; });
    assert.equal(player.playerIsOnGround, false);
    assert.equal(player.activeKinematicCollider, null);
    assert.equal(player.getGroundSupport(), null);
});

test("移除平台后清除支撑且不再携带角色", async t => {
    const { player, platform, handle } = await onPlatform(t);
    const x = player.playerCapsule.position.x;
    player.removeCollider(handle);
    platform.position.x += 10;
    await advance(player, 0.2);
    assert.equal(player.activeKinematicCollider, null);
    assert.equal(player.playerIsOnGround, false);
    near(player.playerCapsule.position.x, x);
    assertFinitePlayer(player);
});
