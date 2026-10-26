import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Vector3 } from "three";
import { createPlayer, setupBrowser, box, addFloor, advance, near, assertFinitePlayer } from "./helpers/controller-fixture.mjs";

beforeEach(setupBrowser);

test("动态盒在真实 BVH 地板上落稳且位姿保持有限值", async t => {
    const { player } = await createPlayer(t, { position: [5, 2, 0] });
    addFloor(player);
    const handle = player.addCollider({
        motion: "dynamic", shape: { kind: "box", halfExtents: new Vector3(0.5, 0.5, 0.5), position: new Vector3(0, 2, 0) },
        mesh: box([1, 1, 1], [0, 2, 0]),
        restitution: 0, gravity: -9.8,
    });
    const body = player.getDynamicBodies().find(body => body.colliderId === handle.id);
    await advance(player, 4, 30);
    near(body.position.y, 0.5, 0.03);
    assert.ok(body.velocity.length() < 0.1, "settled box must not gain energy at rest");
    for (const value of [...body.position.toArray(), ...body.quaternion.toArray(), ...body.velocity.toArray()]) assert.ok(Number.isFinite(value));
});

test("动态盒支撑携带角色且移除后清除支撑", async t => {
    const { player } = await createPlayer(t, { position: [0, 3, 0] });
    const handle = player.addCollider({
        motion: "dynamic", shape: { kind: "box", halfExtents: new Vector3(2, 0.25, 2), position: new Vector3(0, 0.25, 0) },
        mesh: box([1, 1, 1], [0, 0.25, 0]),
        gravity: 0, linearDamping: 0, angularDamping: 0,
    });
    const body = player.getDynamicBodies().find(body => body.colliderId === handle.id);
    await advance(player, 1);
    assert.equal(player.getActiveDynamicBody(), body);
    const initialX = player.playerCapsule.position.x;
    body.wakeUp();
    body.velocity.x = 0.5;
    await advance(player, 1, 30);
    near(player.playerCapsule.position.x - initialX, 0.5, 0.03);
    assert.equal(player.playerIsOnGround, true);
    player.removeCollider(handle);
    await advance(player, 0.2);
    assert.equal(player.getActiveDynamicBody(), null);
    assert.equal(player.getGroundSupport(), null);
    assert.equal(player.playerIsOnGround, false);
    assertFinitePlayer(player);
});
