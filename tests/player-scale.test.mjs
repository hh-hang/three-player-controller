import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Vector3 } from "three";
import { FootIK } from "../dist/foot-ik.mjs";
import { createPlayer, setupBrowser, addFloor, advance, near, assertFinitePlayer } from "./helpers/controller-fixture.mjs";

beforeEach(setupBrowser);

test("设置绝对缩放时胶囊、接地阈值和移动参数保持同比例", async t => {
    const { player } = await createPlayer(t);
    addFloor(player);
    await advance(player, 1);
    const original = {
        radius: player.playerCapsule.capsuleInfo.radius,
        height: player.getCapsuleGroundHeight(), speed: player.playerSpeed,
        run: player.playerRunSpeed, gravity: player.gravity, jump: player.jumpHeight,
    };
    for (const scale of [0.005, 0.02, 0.003, 0.01]) {
        player.setPlayerScale(scale);
        const ratio = scale / 0.01;
        near(player.playerCapsule.capsuleInfo.radius, original.radius * ratio);
        near(player.getCapsuleGroundHeight(), original.height * ratio);
        near(player.playerSpeed, original.speed * ratio);
        near(player.playerRunSpeed, original.run * ratio);
        near(player.gravity, original.gravity * ratio);
        near(player.jumpHeight, original.jump * ratio);
        await advance(player, 1);
        assert.equal(player.playerIsOnGround, true);
        near(player.playerCapsule.position.y, player.getCapsuleGroundHeight());
        assertFinitePlayer(player);
    }
});

test("反复缩小和放大后保持原始胶囊尺寸", async t => {
    const { player } = await createPlayer(t);
    const baseline = player.getCapsuleGroundHeight();
    for (let cycle = 0; cycle < 50; cycle++) {
        player.setPlayerScale(0.001);
        player.setPlayerScale(0.03);
        player.setPlayerScale(0.01);
    }
    near(player.getCapsuleGroundHeight(), baseline, 1e-10);
    near(player.playerCapsule.scale.x, 1, 1e-10);
    near(player.playerCapsule.capsuleInfo.radius, 0.3, 1e-10);
});

test("缩放时 FootIK 基准配置保持不变且脚部仍能贴地", async t => {
    const { player, skeleton } = await createPlayer(t);
    addFloor(player);
    await advance(player, 1);
    const footIK = new FootIK({ skeleton, soleSkinThickness: 0, plantedHeightSpeed: 200, penetrationLiftSpeed: 200 });
    player.use(footIK);
    const options = footIK.getOptions();
    for (const scale of [0.005, 0.02, 0.01]) {
        player.setPlayerScale(scale);
        await advance(player, 1);
        assert.deepEqual(footIK.getOptions(), options, "getOptions reports base units, independent of runtime scale");
        near(skeleton.legs.left.foot.getWorldPosition(new Vector3()).y, 0, 0.015);
        assertFinitePlayer(player);
    }
});
