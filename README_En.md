[中文](README.md) | English

# three-player-controller

[![NPM Package][npm]][npm-url]
[![Github][github]][github-url]
[![CesiumJS](https://img.shields.io/badge/CesiumJS-player_controller-blue)](https://github.com/hh-hang/cesium-player-controller)

A lightweight first-person / third-person player controller for three.js. It provides character capsule collision, animation, camera obstacle avoidance, moving platforms, dynamic rigid bodies, vehicle control, and Foot IK, with `three-mesh-bvh` accelerating collision queries in complex scenes.

## Features

- First-person / third-person switching
- Walking, running, jumping, and flying
- Character capsule collision and ground detection
- Camera obstacle avoidance, over-shoulder view, and spring camera
- Static / kinematic / dynamic colliders
- Dynamic spheres, boxes, and rigid-body collision
- Asynchronous BVH construction with Worker
- Streaming collider construction for 3D Tiles
- Built-in vehicle physics, suspension, steering, grip, and handbrake
- Foot IK plugin
- Custom animations and Locomotion Sets
- Mobile virtual joystick and buttons
- Custom key bindings and external input

# Examples

[![Online Demo](https://github.com/hh-hang/three-player-controller/blob/master/example/public/img/readme/preview.png)](https://hh-hang.github.io/three-player-controller/index.html)

- [Showcase](https://hh-hang.github.io/three-player-controller/showcase.html)
- [Foot IK](https://hh-hang.github.io/three-player-controller/footIK.html)
- [FPS Game](https://hh-hang.github.io/three-player-controller/shooting/shooting.html)
- [glTF Scene](https://hh-hang.github.io/three-player-controller/glTF.html)
- [3DTiles Scene](https://hh-hang.github.io/three-player-controller/3dtilesScene.html)
- [3DGS Scene](https://hh-hang.github.io/three-player-controller/3dgs.html)

# Installation

```bash
npm install three-player-controller three-mesh-bvh
```

# Run Locally

```bash
git clone https://github.com/hh-hang/three-player-controller.git
cd three-player-controller
npm install
npm run dev
```

Open `http://localhost:5173/three-player-controller/` in your browser.

# Quick Start

```ts
import * as THREE from "three";                                                
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";       
import { playerController } from "three-player-controller"; 

const scene = new THREE.Scene();                                           

const camera = new THREE.PerspectiveCamera(
    60,                                                                      
    window.innerWidth / window.innerHeight,                                   
    0.1,                                                                  
    1000,
);

const renderer = new THREE.WebGLRenderer();                                    
renderer.setSize(window.innerWidth, window.innerHeight);                       
document.body.appendChild(renderer.domElement);                                

const controls = new OrbitControls(camera, renderer.domElement);        

// Load the player model
const loader = new GLTFLoader();                                              
const playerGltf = await loader.loadAsync("./glb/player.glb");

// Create the player controller
const player = new playerController();     

// Initialize player control
await player.init({
    scene,                                  // three.js scene instance
    camera,                                 // three.js camera instance
    controls,                               // external camera controller

    // Player model, animation, and movement settings
    playerModelConfig: {                                                       
        model: playerGltf.scene,            // root node of the externally loaded model
        animations: playerGltf.animations,  // animation clips
        scale: 0.001,                       // model scale
        idleAnim: "idle",                   // idle animation name
        walkAnim: "walk",                   // walk animation name
        runAnim: "run",                     // run animation name
        jumpAnim: "jump",                   // jump animation name; or ["start", "loop", "land"] for three-stage playback
    },

    // Initial player spawn point
    initPos: new THREE.Vector3(0, 0, 0),                                       

    // Colliders registered during initialization
    colliders: [                                                               
        {
            motion: "static",               // static collider
            shape: {                        // collision shape settings
                kind: "mesh",               // use a Mesh collision shape
                source: scene,              // collect geometry from this object and build the BVH automatically
            },
        },
    ],
});

function animate() {
    requestAnimationFrame(animate);                                            
    player.update();                                                          
    renderer.render(scene, camera);                                          
}

animate();                                                                  
```

> `player.update()` already drives the camera controller passed to the player. Do not call `controls.update()` again in the render loop, or it may conflict with the internal camera logic.

### Complete Parameter Example

#### `init()`

```ts
await player.init({
    // Required
    scene,    // three.js scene instance
    camera,   // three.js camera instance
    controls, // external camera controller, usually OrbitControls

    playerModelConfig: {                              // player model, animation, and movement settings
        model: playerGltf.scene,                      // root node of the externally loaded model
        animations: playerGltf.animations,            // animation clips
        scale: 0.001,                                  // model scale
        idleAnim: "idle",                              // idle animation name
        walkAnim: "walk",                              // walk animation name
        runAnim: "run",                                // run animation name
        jumpAnim: "jump",                              // jump animation name; or ["start", "loop", "land"] for three-stage playback

        // Directional / flight animations (optional; corresponding defaults are reused when omitted)
        leftWalkAnim: "leftWalk",                      // left-strafe animation; defaults to walkAnim
        rightWalkAnim: "rightWalk",                    // right-strafe animation; defaults to walkAnim
        backwardAnim: "walkBack",                      // backward animation; defaults to walkAnim
        flyAnim: "fly",                                // flight animation; defaults to idleAnim
        flyIdleAnim: "flyIdle",                        // fly-idle animation; defaults to idleAnim
        flyHoverForwardAnim: "flyFwd",                 // forward hover animation; defaults to flyAnim
        flyHoverBackAnim: "flyBack",                   // backward hover animation; defaults to flyIdleAnim
        flyHoverLeftAnim: "flyLeft",                   // left hover animation; defaults to flyIdleAnim
        flyHoverRightAnim: "flyRight",                 // right hover animation; defaults to flyIdleAnim
        flyHoverUpAnim: "flyUp",                       // upward hover animation; defaults to flyIdleAnim
        flyHoverDownAnim: "flyDown",                   // downward hover animation; defaults to flyIdleAnim
        drivingAnim: "driving",                        // driving loop animation; defaults to idleAnim

        // Physics settings (optional)
        gravity: -2400,                                // base gravity value, scaled by scale; default -2400
        jumpHeight: 600,                               // base jump-height value, scaled by scale; default 600
        speed: 200,                                    // base movement speed, scaled by scale; default 200
        runSpeed: 600,                                 // base run speed, scaled by scale; default 600
        flySpeed: 2100,                                // base flight speed, scaled by scale; default 2100
        acceleration: 30,                              // XZ acceleration response; default 30
        deceleration: 30,                              // XZ deceleration response; default 30

        // Model settings (optional)
        rotateY: 0,                                    // initial player facing direction in radians; default 0
        headBoneName: "Head",                          // head bone name used for first-person camera attachment
        firstPersonCameraOffset: [0, 40, 30],          // local first-person camera offset
        capsuleRadiusRatio: 1,                         // capsule radius multiplier; default 1
    },

    // Scene and collision (optional)
    initPos: new THREE.Vector3(0, 0, 0),                // initial spawn point; default (0, 0, 0)
    colliders: [                                        // colliders created during initialization; call addCollider() after init() if omitted
        {
            motion: "static",                           // collider motion type: static / kinematic / dynamic
            shape: {                                    // collision shape settings
                kind: "mesh",                           // Mesh collision shape
                source: world,                          // collision source; THREE.Object3D or THREE.Object3D[]
            },
            useWorker: false,                           // whether to build the BVH asynchronously in a Worker
        },
    ],

    // Camera (optional)
    minCamDistance: 100,                                // minimum third-person camera distance; default 100
    maxCamDistance: 440,                                // maximum third-person camera distance; default 440
    camLookAtHeightRatio: 0.8,                          // camera target height ratio, 0=bottom and 1=top; default 0.8
    thirdMouseMode: 1,                                  // third-person mouse mode 0-5; default 1
    enableZoom: false,                                  // whether mouse-wheel zoom is enabled; default false
    enableOverShoulderView: false,                      // whether over-shoulder view is enabled; default false
    camOverShoulderOffsetRatio: 0.2,                    // over-shoulder horizontal offset ratio; default 0.2
    isFirstPerson: false,                               // whether to start in first-person; default false
    enableSpringCamera: false,                          // whether spring camera is enabled; default false
    springCameraTime: 0.05,                             // spring-camera smoothing time in seconds; default 0.05

    // Other settings (optional)
    mouseSensitivity: 5,                                // mouse sensitivity; default 5
    timeScale: 1,                                       // time scale; <1 slow motion, >1 fast-forward; default 1

    keyMap: {                                           // custom key map; use one key, multiple keys, or null to disable
        forward: ["KeyW", "ArrowUp"],                   // move forward
        backward: ["KeyS", "ArrowDown"],                // move backward
        left: ["KeyA", "ArrowLeft"],                    // move left
        right: ["KeyD", "ArrowRight"],                  // move right
        sprint: ["ShiftLeft", "ShiftRight"],            // sprint; handbrake while driving
        jump: ["Space"],                                // jump; brake while driving
        toggleView: ["KeyV"],                           // switch first-person / third-person
        toggleFly: ["KeyF"],                            // toggle flight mode
        toggleVehicle: ["KeyE"],                        // enter / exit vehicle
    },

    isShowMobileControls: true,                         // whether to show virtual controls on mobile; default true
    mobileControls: {                                   // mobile button visibility, icons, and layout
        joystick: true,                                 // whether to show the virtual joystick; default true
        jump: {                                         // jump / brake button; pass false to hide
            icon: "/icons/custom-jump.svg",             // custom image URL for jump state
            brakeIcon: "/icons/custom-brake.svg",       // custom image URL for braking in vehicle mode
            right: 24,                                  // distance from the right edge in px
            bottom: 32,                                 // distance from the bottom edge in px
            size: 64,                                   // button diameter in px; default 56
        },
        fly: true,                                      // flight button; true uses default style, false hides it
        view: true,                                     // view-switch button; true uses default style, false hides it
        vehicle: true,                                  // enter / exit vehicle button; true uses default style, false hides it
    },
});
```


# Collision System

Uses the unified `CollisionWorld` and `addCollider()` API.

A collider is described by two core properties:

```ts
{
    motion: "static" | "kinematic" | "dynamic",
    shape: {
        kind: "mesh" | "box" | "sphere",
        // ...
    }
}
```

## Static Mesh

Suitable for terrain, buildings, walls, and other scene geometry that does not move.

```ts
const handle = player.addCollider({
    motion: "static",
    shape: {
        kind: "mesh",
        source: world,
    },
    useWorker: true,
});
```

## Kinematic Mesh

Suitable for elevators, moving platforms, rotating platforms, vehicle visuals, or other objects whose transforms are controlled by application code.

```ts
const platformCollider = player.addCollider({
    motion: "kinematic",
    shape: {
        kind: "mesh",
        source: platform,
    },
    follow: platform,
    useWorker: true,
});
```

The collider follows `follow.matrixWorld` every frame. If you only need to adjust already-baked kinematic collision geometry at runtime, the BVH does not need to be rebuilt.

## Dynamic Rigid Bodies

Dynamic `box` and `sphere` colliders automatically create built-in rigid bodies. `DynamicBodySystem` handles gravity, damping, contacts, impulses, and sleeping.

### Dynamic Box

```ts
const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
);
scene.add(box);

player.addCollider({
    motion: "dynamic",
    shape: {
        kind: "box",
        halfExtents: new THREE.Vector3(0.5, 0.5, 0.5),
        position: new THREE.Vector3(0, 5, 0),
    },
    mesh: box,
});
```

### Dynamic Sphere

```ts
const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.5),
    new THREE.MeshStandardMaterial(),
);
scene.add(sphere);

player.addCollider({
    motion: "dynamic",
    shape: {
        kind: "sphere",
        radius: 0.5,
        position: new THREE.Vector3(0, 5, 0),
    },
    mesh: sphere,
});
```

Dynamic rigid bodies can collide with static meshes, kinematic meshes, the player, vehicles, and other dynamic rigid bodies.

## Remove And Clear

```ts
const handle = player.addCollider({
    motion: "static",
    shape: { kind: "mesh", source: object },
});

player.removeCollider(handle);

// Clear only static colliders
player.clearColliders({ motion: "static" });

// Clear all colliders
player.clearColliders();
```

## Collision Groups

```ts
import { CollisionGroup } from "three-player-controller";
```

| Group | Description |
| --- | --- |
| `CollisionGroup.DEFAULT` | Default scene collision group. |
| `CollisionGroup.CHARACTER` | Player character collision group. |   
| `CollisionGroup.VEHICLE` | Vehicle collision group. |
| `CollisionGroup.DEBRIS` | Dynamic debris, pushable objects, and similar colliders. |
| `CollisionGroup.ALL` | Combination of all collision groups, allowing collision with every group. |

By default, you do not need to set these values. The appropriate collision group and mask are selected automatically based on `motion`. You can also customize collision filtering with `groups` and `mask`:

```ts
player.addCollider({
    motion: "dynamic",
    shape: {
        kind: "sphere",
        radius: 0.5,
        position: new THREE.Vector3(),
    },
    groups: CollisionGroup.DEBRIS,
    mask: CollisionGroup.DEFAULT | CollisionGroup.VEHICLE,
});
```

# Streaming 3D Tiles Collision

For 3D Tiles, it is not recommended to merge the entire Tileset into a single collider at once.

`example/3dtilesScene.js` uses a streaming strategy:

1. Listen for tile load, unload, and visibility changes.
2. Track only currently loaded tiles.
3. Create colliders only for visible tiles near the player.
4. Build BVHs asynchronously with `useWorker: true`.
5. Immediately call `removeCollider()` when a tile is hidden, unloaded, or too far away.
6. Use separate enter / exit radii to avoid frequent collider creation and destruction near the boundary.

Core pattern:

```ts
const handle = player.addCollider({
    motion: "kinematic",
    useWorker: true,
    shape: {
        kind: "mesh",
        source: tileScene,
    },
    follow: tileScene,
});

// Remove the collider when the tile unloads, becomes invisible, or is too far away
player.removeCollider(handle);
```

The example also demonstrates a local coordinate system and rebasing for globe-scale large-coordinate scenes. When the player moves too far from the local origin, the local coordinate system is updated while the player, camera, and velocity are transformed together to avoid floating-point precision issues at large coordinates.

See the full implementation in [`example/3dtilesScene.js`](https://github.com/hh-hang/three-player-controller/blob/master/example/3dtilesScene.js).

# Vehicle

```ts
const vehicleGltf = await loader.loadAsync("./glb/vehicle.glb"); // Load the vehicle model externally

const vehicle = await player.loadVehicleModel({
    // Required
    model: vehicleGltf.scene,                             // root node of the externally loaded vehicle model
    position: new THREE.Vector3(0, 0, 0),                 // initial vehicle world position
    wheelsNames: [                                       // wheel node names, order: front-left, front-right, rear-left, rear-right
        "Wheel_LF",                                      // front-left wheel node name
        "Wheel_RF",                                      // front-right wheel node name
        "Wheel_LR",                                      // rear-left wheel node name
        "Wheel_RR",                                      // rear-right wheel node name
    ],
    driverSeatPosition: new THREE.Vector3(-0.6, 0.7, 0.4), // driver-seat capsule center in chassis-local coordinates

    // Model / driving (optional)
    scale: 0.1,                                          // vehicle model scale; default 1
    driverSeatRotation: 0,                               // driver-seat horizontal rotation relative to chassis local space in radians; default 0
    modelRotation: -Math.PI / 2,                         // vehicle model Y-axis rotation in radians; default -π/2
    followVehicleDirection: true,                        // whether the camera follows vehicle heading while driving; default true

    // Debug (optional)
    debug: {                                             // vehicle physics debug visualization settings
        showPhysicsBox: false,                           // whether to show the chassis physics collision box; default false
        showWheelRays: false,                            // whether to show wheel suspension rays; default false
        showWheelTravel: false,                          // whether to show wheel Y-axis travel range; default false
        showWheelSpheres: false,                         // whether to show dynamic wheel collision spheres; default false
    },

    // Chassis (optional)
    chassis: {                                           // chassis collision box and damping settings
        density: 1,                                      // chassis density; mass is calculated from collision-box volume × density; default 1
        linearDamping: 0.05,                             // linear damping; default 0.05
        angularDamping: 0.5,                             // angular damping; default 0.5
        clearance: 0.15,                                 // height of the chassis box bottom relative to tire contact points; auto-calculated if omitted
        sizeScale: {                                     // chassis collision-box size multiplier relative to the automatic AABB
            x: 1,                                        // X-axis size multiplier; default 1
            y: 1,                                        // Y-axis size multiplier; default 1
            z: 1,                                        // Z-axis size multiplier; default 1
        },
    },

    // Suspension / tires (optional)
    suspension: {                                        // suspension and tire settings
        restLength: 0.3,                                 // suspension rest length; auto-calculated if omitted
        maxTravel: 0.35,                                 // maximum suspension travel; default 0.35
        stiffness: 18,                                   // suspension stiffness; default 18
        compression: 2.1,                                // suspension compression damping; default 2.1
        relaxation: 2.5,                                 // suspension rebound damping; default 2.5
        maxForce: 6000,                                  // maximum suspension force per wheel; default 6000
        frictionSlip: 8,                                 // longitudinal tire grip; default 8
        sideFrictionStiffness: 1,                        // lateral tire friction stiffness; default 1
        rollInfluence: 0.12,                             // effect of lateral force on body roll; default 0.12
    },

    // Steering (optional)
    steering: {                                          // steering settings
        maxSteerAngle: Math.PI / 5,                      // maximum steering angle in radians; default π/5
        steerTime: 0.45,                                 // time from center to full steering lock in seconds; default 0.45
        steerReturnTimeSlow: 0.55,                       // low-speed steering return time in seconds; default 0.55
        steerReturnTimeFast: 0.4,                        // high-speed steering return time in seconds; default 0.4
        highSpeedSteerScale: 0.3,                        // maximum steering ratio at top speed; default 0.3
    },

    // Grip / handbrake (optional)
    grip: {                                              // cornering grip and handbrake settings
        maxG: 1.2,                                       // maximum lateral acceleration in g; default 1.2
        sideFrictionIdle: 1,                             // lateral friction while driving straight; default 1
        sideFrictionFrontMin: 0.55,                      // minimum front-wheel lateral friction under high load; default 0.55
        sideFrictionRearMin: 0.45,                       // minimum rear-wheel lateral friction under high load; default 0.45
        handbrakeRearFriction: 0.35,                     // rear-wheel lateral friction while handbraking; default 0.35
        handbrakeRearDriveScale: 0.65,                   // rear-wheel drive-force ratio while handbraking; default 0.65
        handbrakeReleaseTime: 0.15,                      // recovery time after releasing the handbrake in seconds; default 0.15
        wheelbaseRatio: 0.55,                            // wheelbase relative to vehicle length; default 0.55
    },

    // Power (optional)
    power: {                                             // vehicle power settings
        maxSpeed: 100,                                   // base top speed in km/h, scaled by scale; default 100
        acceleration: 5,                                 // base acceleration in m/s², scaled by scale; default 5
        deceleration: 5,                                 // base braking deceleration in m/s², scaled by scale; default 5
    },
});
```

Runtime:

```ts
player.resetVehicle();                                  // right the currently driven vehicle and clear linear / angular velocity
player.setVehicleScale(vehicle, 0.12);                  // change the overall vehicle scale at runtime
player.setVehicleClearance(vehicle, 0.15);              // adjust chassis collision-box ground clearance
player.setVehicleChassisSizeScale(vehicle, {            // adjust chassis collision-box size multipliers relative to the automatic AABB
    x: 1,                                               // X-axis size multiplier
    y: 0.9,                                             // Y-axis size multiplier
    z: 1,                                               // Z-axis size multiplier
});
player.setVehiclePhysicsDebug(true);                    // show / hide the vehicle chassis physics collision box
```

# Foot IK Plugin

```ts
import { FootIK } from "three-player-controller/foot-ik";

const footIK = new FootIK({
    // Manually specify the player skeleton mapping; common bone names are matched automatically when omitted
    skeleton: {                                         
        hips: "mixamorigHips",                          // hips / pelvis bone name

        // Left / right leg bone configuration
        legs: {                                         
            left: {                                     
                upper: "mixamorigLeftUpLeg",            // left upper-leg bone
                lower: "mixamorigLeftLeg",              // left lower-leg bone
                foot: "mixamorigLeftFoot",              // left foot bone
                toe: "mixamorigLeftToeBase",            // left toe bone
            },
            right: {                                   
                upper: "mixamorigRightUpLeg",           // right upper-leg bone
                lower: "mixamorigRightLeg",             // right lower-leg bone
                foot: "mixamorigRightFoot",             // right foot bone
                toe: "mixamorigRightToeBase",           // right toe bone
            },
        },
    },

    soleSkinThickness: 3,                               // skin-thickness compensation from the foot bone to the shoe sole
    plantedHeightSpeed: 200,                            // planted-foot ground-follow speed (units/sec); Infinity snaps immediately
    penetrationLiftSpeed: 200,                          // swing-foot penetration-lift speed (units/sec); Infinity lifts immediately
    predictivePlacement: true,                          // enable predictive foot placement; default false keeps reactive Foot IK
    straightPoleEnabled: true,                          // point knees forward while moving; default false keeps the animation pole
});

player.use(footIK);                                     // register the Foot IK plugin with the player controller
```

Runtime:

```ts
footIK.setEnabled(false);                 // enable / disable Foot IK
footIK.setDebugEnabled(true);             // show / hide Foot IK debug helpers
player.unuse(footIK);                     // unregister the Foot IK plugin from the player controller
footIK.dispose();                         // dispose debug objects and related resources created by Foot IK
```

`player.destroy()` automatically disposes registered plugins.

See the full example in [`example/footIK.js`](https://github.com/hh-hang/three-player-controller/blob/master/example/footIK.js).

# API

## Lifecycle And Core

| Method | Description |
| --- | --- |
| `init(opts, callback?)` | Initialize the controller. |
| `update(dt?)` | Update the player, collisions, dynamic rigid bodies, vehicles, camera, and animation every frame. |
| `destroy()` | Destroy the controller and release resources. |
| `reset(pos?)` | Reset the player to the specified position or the initial position. |
| `switchPlayerModel(options)` | Switch the player model at runtime using `PlayerModelOptions`. |
| `use(plugin)` | Register a plugin. |
| `unuse(plugin)` | Unregister a plugin. |
| `getPlugins()` | Return a copy of the current plugin list. |

## Collision

| Method | Description |
| --- | --- |
| `addCollider(desc)` | Add a static / kinematic / dynamic collider and return a `ColliderHandle`. |
| `removeCollider(handle)` | Remove a collider by handle or id. |
| `clearColliders(filter?)` | Clear colliders, optionally filtered by `motion`. |
| `getColliderMeshes(options?)` | Return the Mesh colliders used by current player queries. |
| `isStaticColliderUsable()` | Whether a static Mesh with a completed BVH is available. |
| `getActiveKinematicCollider()` | Return the kinematic collider currently supporting the player. |
| `getActiveDynamicBody()` | Return the dynamic rigid body currently supporting the player. |
| `getDynamicBodies()` | Return all dynamic rigid bodies. |
| `removeDynamicBody(body)` | Remove a dynamic rigid body. |
| `clearDynamicBodies()` | Clear all dynamic rigid bodies. |
| `raycastDynamicGround(...)` | Query the surface of dynamic rigid bodies below. |

## State

| Method | Return Value |
| --- | --- |
| `getPosition()` | Current player position. |
| `getVelocity()` | Current player velocity. |
| `getIsFirstPerson()` | Whether first-person mode is active. |
| `getIsFlying()` | Whether flight mode is active. |
| `getIsOnGround()` | Whether the player is on the ground. |
| `getGroundSupport()` | Current final ground-support point and world-space normal. |
| `getCurrentDelta()` | Actual time step used by the current frame. |
| `getControllerMode()` | `0` for player, `1` for vehicle. |
| `getPlayerModel()` | Current player model. |
| `getPlayerCapsule()` | Player capsule. |
| `getActiveVehicle()` | Currently driven vehicle. |
| `getAllVehicles()` | All loaded vehicles. |
| `getCurrentPlayerAnimationName()` | Current animation clip name. |
| `getCurrentLocomotionSet()` | Current Locomotion Set. |
| `getCenterScreenRaycastHit()` | Center-screen raycast result. |

## Runtime Controls

| Method | Description |
| --- | --- |
| `setInput(input)` | Inject external input. |
| `setKeyMap(map?)` | Customize or restore default key bindings. |
| `setMouseSensitivity(v)` | Set mouse sensitivity. |
| `setPlayerScale(v)` | Change player scale at runtime. |
| `setPlayerSpeed(v)` | Set walking speed. |
| `setPlayerRunSpeed(v)` | Set running speed. |
| `setPlayerFlySpeed(v)` | Set flight speed. |
| `setJumpHeight(v)` | Set jump height. |
| `setGravity(v)` | Set gravity. |
| `setMinCamDistance(v)` | Set minimum third-person camera distance. |
| `setMaxCamDistance(v)` | Set maximum third-person camera distance. |
| `setCamLookAtHeightRatio(v)` | Set camera target height ratio. |
| `setCamOverShoulderOffsetRatio(v)` | Set over-shoulder horizontal offset ratio. |
| `setThirdMouseMode(v)` | Set third-person mouse mode. |
| `setEnableZoom(v)` | Enable / disable mouse-wheel zoom. |
| `setOverShoulderView(v)` | Enable / disable over-shoulder view. |
| `setEnableToward(v)` | Enable / disable mouse-driven facing. |
| `setSkipCapsuleCollision(v)` | Temporarily skip player capsule collision. |
| `changeView()` | Switch first-person / third-person view. |
| `setFirstPersonCamera(v?)` | Enter first-person view directly. |

## Debug

```ts
player.setColliderDebug(true);                       // show / hide static and kinematic Mesh collision wireframes
player.setPlayerCapsuleDebug(true);                  // show / hide the player capsule wireframe
player.setDynamicBodyDebug(true);                    // show / hide dynamic rigid-body collision wireframes
player.setVehiclePhysicsDebug(true);                 // show / hide the vehicle chassis physics collision box
```

## Animation

| Method | Description |
| --- | --- |
| `playPlayerAnimationByName(name, fade?)` | Play a player animation directly by clip name. |
| `registerAnimation(key, clipName, opts?)` | Register a custom animation clip. |
| `playAnimation(key, opts?)` | Play a registered custom animation. |
| `registerLocomotionSet(setName, map)` | Register a locomotion animation set to replace built-in locomotion animations. |
| `switchLocomotionSet(setName, fade?)` | Switch to the specified locomotion animation set. |

### `registerAnimation`

```ts
player.registerAnimation(key, clipName, {
    loop?: boolean,              // whether to loop; default true
    timeScale?: number,          // animation playback scale; default 1
    duration?: number,           // animation playback duration; default 0
    clampWhenFinished?: boolean, // whether to reset animation time to 0 when playback finishes; default false
    onFinished?: () => void,     // called when animation playback finishes
});
```

When both `duration` and `timeScale` are set, `duration` takes precedence.

### `playAnimation`

```ts
player.playAnimation(key, {
    fade?: number,          // transition duration in seconds; default 0.18
    force?: boolean,        // when true, restart from the beginning even if this animation is already playing
    returnToPrev?: boolean, // applies only to LoopOnce animations; automatically restore the previous animation state after playback
});
```

### `registerLocomotionSet`

Supported keys: `idle` | `walking` | `walking_backward` | `running` | `jumping` | `flyidle` | `flying`. Specified keys replace the corresponding built-in animations; omitted keys keep their existing animations.

```ts
player.registerLocomotionSet("combat", {
    idle: "CombatIdle",
    walking: "CombatWalk",
    walking_backward: "CombatBack",
    running: "CombatRun",
    jumping: "CombatJump",
    flyidle: "CombatFlyIdle",
    flying: "CombatFly",
});
```

# Default Controls

| Action | Default Key | Behavior |
| --- | --- | --- |
| Forward | `W` / `ArrowUp` | Move forward |
| Backward | `S` / `ArrowDown` | Move backward |
| Left | `A` / `ArrowLeft` | Move left |
| Right | `D` / `ArrowRight` | Move right |
| Sprint | `Shift` | Player sprint; vehicle handbrake |
| Jump | `Space` | Jump; ascend while flying; vehicle brake |
| Toggle view | `V` | First-person / third-person |
| Fly | `F` | Toggle flight mode |
| Enter / exit vehicle | `E` | Vehicle interaction |
| Look | Mouse | Control view |

# Custom Key Bindings

Use `keyMap` to rebind any action in the table above to other keys, or disable an action. Key names use [`KeyboardEvent.code`](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code) (for example `"KeyE"`, `"ArrowUp"`, and `"Space"`; note that it is `"KeyE"`, not `"e"`).

Each action supports three value forms:

- **Omitted** → use the default key
- **String / string array** → replace with the specified key(s); an array can bind multiple keys
- **`null`** → disable the action; no key will trigger it

Configure during initialization:

```ts
await player.init({
    // ...
    keyMap: {
        forward: "KeyE",          // use E to move forward instead of default W / ↑
        jump: null,               // disable jumping
        left: ["KeyA", "KeyJ"],   // bind both A and J
        // omitted actions keep their default keys
    },
});
```

Switch key-binding schemes at runtime:

```ts
player.setKeyMap({ forward: "KeyI", backward: "KeyK" }); // apply new bindings
player.setKeyMap();                                      // restore all defaults
```

# External Input

```ts
player.setInput({
    moveX: number,        // horizontal movement axis, range -1 to 1; positive moves right
    moveY: number,        // vertical movement axis, range -1 to 1; positive moves forward
    lookDeltaX: number,   // horizontal look delta, usually mousemove movementX
    lookDeltaY: number,   // vertical look delta, usually mousemove movementY
    jump: boolean,        // held state (true=pressed, false=released); jump, ascend while flying, brake while driving
    shift: boolean,       // held state (true=pressed, false=released); sprint, or handbrake while driving
    toggleView: boolean,  // trigger; pass true to switch first-person / third-person view
    toggleFly: boolean,   // trigger; pass true to toggle flight mode
    toggleVehicle: boolean, // trigger; pass true to enter / exit vehicle
});
```

# Events

```ts
player.onAnimationChange = (name, action) => {};   // triggered when the current player animation changes
player.onBeforeViewChange = (isFirstPerson) => {}; // triggered before first-person / third-person switching
player.onViewChange = (isFirstPerson) => {};       // triggered after first-person / third-person switching
player.onGroundChange = (onGround) => {};          // triggered when grounded state changes
player.onVehicleEnter = (vehicle) => {};           // triggered after entering a vehicle
player.onVehicleExit = (vehicle) => {};            // triggered after exiting a vehicle
player.onTowardChange = (dx, dy, speed) => {};     // triggered when facing / view input updates
```

# Main Options

## `PlayerControllerOptions`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scene` | `THREE.Scene` | Yes | — | three.js scene instance. |
| `camera` | `THREE.PerspectiveCamera` | Yes | — | three.js camera instance. |
| `controls` | `any` | Yes | — | External camera controller, usually `OrbitControls`. |
| `playerModelConfig` | `PlayerModelOptions` | Yes | — | Player model and parameter configuration. |
| `initPos` | `THREE.Vector3` | No | `(0, 0, 0)` | Initial spawn point. |
| `colliders` | `ColliderDesc[]` | No | — | Colliders registered in bulk during initialization. |
| `mouseSensitivity` | `number` | No | `5` | Mouse sensitivity. |
| `minCamDistance` | `number` | No | `100` | Minimum third-person camera distance. |
| `maxCamDistance` | `number` | No | `440` | Maximum third-person camera distance. |
| `isShowMobileControls` | `boolean` | No | `true` | Whether to show virtual control UI on mobile. |
| `mobileControls` | `MobileControlsOptions` | No | All shown | Mobile button visibility, icons, and layout settings. |
| `thirdMouseMode` | `0 \| 1 \| 2 \| 3 \| 4 \| 5` | No | `1` | Mouse control mode in third-person view (0: hide cursor, control facing and view; 1: hide cursor, control view only; 2: show cursor, drag to control facing and view; 3: show cursor, drag to control view only; 4: show cursor, drag to control view while player facing follows the camera's horizontal direction; 5: hide cursor, control view while player facing follows the camera's horizontal direction). |
| `enableZoom` | `boolean` | No | `false` | Whether mouse-wheel zoom is enabled. |
| `enableOverShoulderView` | `boolean` | No | `false` | Whether over-shoulder view is enabled. |
| `camOverShoulderOffsetRatio` | `number` | No | `0.2` | Third-person over-shoulder camera horizontal offset ratio. |
| `isFirstPerson` | `boolean` | No | `false` | Whether to enter first-person immediately during initialization. |
| `enableSpringCamera` | `boolean` | No | `false` | Whether spring camera is enabled (the target follows the player with spring damping). |
| `springCameraTime` | `number` | No | `0.05` | Spring smoothing time in seconds; smaller values follow more tightly. |
| `camLookAtHeightRatio` | `number` | No | `0.8` | Third-person camera target height ratio (0=capsule bottom, 1=top). |
| `timeScale` | `number` | No | `1` | Time scale; <1 slow motion, >1 fast-forward. |
| `keyMap` | `KeyMap` | No | Default bindings | Custom key mapping; see [Custom Key Bindings](#custom-key-bindings). |

## `PlayerModelOptions`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | `THREE.Object3D` | One of two | — | Root node of an already-loaded player model. Mutually exclusive with `url`. |
| `animations` | `THREE.AnimationClip[]` | With `model` | — | Player animation clips. Pass together with `model`. |
| `url` | `string` | One of two | — | Player model path (GLB/GLTF). |
| `scale` | `number` | Yes | — | Player model scale. |
| `idleAnim` | `string` | Yes | — | Idle animation name. |
| `walkAnim` | `string` | Yes | — | Walk animation name. |
| `runAnim` | `string` | Yes | — | Run animation name. |
| `jumpAnim` | `string \| [string, string, string]` | Yes | — | Jump animation name. Pass a string for one animation, or a three-element `[start, loop, land]` array for three-stage playback; locomotion resumes automatically after landing. |
| `leftWalkAnim` | `string` | No | `walkAnim` | Left-strafe animation name; defaults to `walkAnim` when omitted. |
| `rightWalkAnim` | `string` | No | `walkAnim` | Right-strafe animation name; defaults to `walkAnim` when omitted. |
| `backwardAnim` | `string` | No | `walkAnim` | Backward animation name; defaults to `walkAnim` when omitted. |
| `flyAnim` | `string` | No | `idleAnim` | Flight animation name; defaults to `idleAnim` when omitted. |
| `flyIdleAnim` | `string` | No | `idleAnim` | Fly-idle animation name; defaults to `idleAnim` when omitted. |
| `flyHoverForwardAnim` | `string` | No | `flyAnim` | Hover animation while flying forward; defaults to `flyAnim` when omitted. |
| `flyHoverBackAnim` | `string` | No | `flyIdleAnim` | Hover animation while flying backward; defaults to `flyIdleAnim` when omitted. |
| `flyHoverLeftAnim` | `string` | No | `flyIdleAnim` | Hover animation while flying left; defaults to `flyIdleAnim` when omitted. |
| `flyHoverRightAnim` | `string` | No | `flyIdleAnim` | Hover animation while flying right; defaults to `flyIdleAnim` when omitted. |
| `flyHoverUpAnim` | `string` | No | `flyIdleAnim` | Hover animation while flying upward; defaults to `flyIdleAnim` when omitted. |
| `flyHoverDownAnim` | `string` | No | `flyIdleAnim` | Hover animation while flying downward; defaults to `flyIdleAnim` when omitted. |
| `drivingAnim` | `string` | No | `idleAnim` | Driving loop animation name; defaults to `idleAnim` when omitted. |
| `gravity` | `number` | No | `-2400` | Base gravity value, scaled by `scale`. |
| `jumpHeight` | `number` | No | `600` | Base jump-height value, scaled by `scale`. |
| `speed` | `number` | No | `200` | Base movement speed, scaled by `scale`. |
| `runSpeed` | `number` | No | `600` | Base run speed, scaled by `scale`. |
| `flySpeed` | `number` | No | `2100` | Base flight speed, scaled by `scale`. |
| `rotateY` | `number` | No | `0` | Initial player facing direction in radians, used to change the model's initial facing direction. |
| `headBoneName` | `string` | No | — | Head bone or node name used for first-person camera attachment. |
| `firstPersonCameraOffset` | `[number, number, number]` | No | Built-in default | Local first-person camera offset; relative to the head bone when `headBoneName` is set, otherwise relative to the capsule. |
| `capsuleRadiusRatio` | `number` | No | `1` | Capsule radius multiplier for fine-tuning collision width. |
| `acceleration` | `number` | No | `30` | XZ acceleration response; larger values accelerate faster. |
| `deceleration` | `number` | No | `30` | XZ deceleration response; larger values stop faster. |

### `MobileControlsOptions`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `joystick` | `boolean` | No | `true` | Whether to show a joystick with continuous 360° direction input. |
| `jump` | `boolean \| JumpButtonOptions` | No | `true` | Jump / brake button; `false` hides it, or pass an object to customize image and layout. |
| `fly` | `boolean \| MobileButtonOptions` | No | `true` | Flight button; `false` hides it, or pass an object to customize image and layout. |
| `view` | `boolean \| MobileButtonOptions` | No | `true` | View-switch button; `false` hides it, or pass an object to customize image and layout. |
| `vehicle` | `boolean \| MobileButtonOptions` | No | `true` | Enter / exit vehicle button; `false` hides it, or pass an object to customize image and layout. |

### `MobileButtonOptions` / `JumpButtonOptions`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `left` / `right` | `number` | No | Built-in position | Distance from the left or right side of the screen in px. Setting `left` without `right` clears the default right positioning. |
| `top` / `bottom` | `number` | No | Built-in position | Distance from the top or bottom of the screen in px. Setting `top` without `bottom` clears the default bottom positioning. |
| `size` | `number` | No | `56` | Circular button diameter in px. |
| `icon` | `string` | No | English label | Custom image URL. |
| `brakeIcon` | `string` | No | `BRAKE` label | Used only by `JumpButtonOptions`; sets the brake image URL in vehicle mode. |


## `ColliderDesc`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `motion` | `"static" \| "kinematic" \| "dynamic"` | — | Collider motion type. |
| `shape` | `ColliderShape` | — | Collision shape configuration; supports `mesh`, `box`, and `sphere`. |
| `groups` | `number` | Set automatically based on `motion` | Collision group this collider belongs to. |
| `mask` | `number` | Set automatically based on `motion` | Collision group mask this collider is allowed to collide with. |
| `useWorker` | `boolean` | `false` | Whether to build the BVH asynchronously in a Worker for `mesh + source`. |
| `userData` | `unknown` | — | Custom application data. |
| `follow` | `THREE.Object3D` | — | Scene object followed by a `kinematic` collider. |
| `density` | `number` | `1` | `dynamic` rigid-body density used to calculate mass. |
| `restitution` | `number` | `0.2` | `dynamic` rigid-body restitution. |
| `friction` | `number` | `0.6` | `dynamic` rigid-body friction. |
| `linearDamping` | `number` | `0.4` | `dynamic` rigid-body linear damping. |
| `angularDamping` | `number` | `0.6` | `dynamic` rigid-body angular damping. |
| `gravity` | `number` | Internal default | `dynamic` rigid-body gravity. |
| `velocity` | `THREE.Vector3` | `(0,0,0)` | Initial linear velocity of a `dynamic` rigid body. |
| `angularVelocity` | `THREE.Vector3` | `(0,0,0)` | Initial angular velocity of a `dynamic` rigid body. |
| `mesh` | `THREE.Mesh` | — | Visual Mesh required when creating a built-in `dynamic box / sphere` rigid body. |
| `simulate` | `boolean` | `true` | Whether the built-in dynamic rigid-body system simulates this body. |

### `ColliderShape`

#### Mesh

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `"mesh"` | Mesh collision shape. |
| `source` | `THREE.Object3D \| THREE.Object3D[]` | Collect geometry from the object(s), merge the collision mesh, and build a BVH. |
| `mesh` | `THREE.Mesh` | Register an already-prepared collision Mesh directly. |

#### Box

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `"box"` | Box collision shape. |
| `halfExtents` | `THREE.Vector3` | Box half-extents, i.e. half of the full size. |
| `position` | `THREE.Vector3` | Initial world position, optional. |
| `quaternion` | `THREE.Quaternion` | Initial world rotation, optional. |

#### Sphere

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `"sphere"` | Sphere collision shape. |
| `radius` | `number` | Sphere radius. |
| `position` | `THREE.Vector3` | Initial world position, optional. |

## `VehicleOptions`

### Basic Parameters

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | `THREE.Object3D` | — | Root node of the externally loaded vehicle model. |
| `position` | `THREE.Vector3` | — | Initial vehicle world position. |
| `wheelsNames` | `[string, string, string, string]` | — | Array of wheel node names in front-left, front-right, rear-left, rear-right order. |
| `driverSeatPosition` | `THREE.Vector3` | — | Driver-seat capsule center in vehicle chassis-local coordinates. |
| `scale` | `number` | `1` | Vehicle model scale. |
| `driverSeatRotation` | `number` | `0` | Driver-seat horizontal rotation relative to vehicle chassis local space in radians. |
| `modelRotation` | `number` | `-Math.PI / 2` | Initial vehicle model Y-axis rotation. |
| `followVehicleDirection` | `boolean` | `true` | Whether the camera follows vehicle heading while driving. |
| `debug` | `VehicleDebugOptions` | — | Vehicle physics debug visualization settings. |
| `chassis` | `VehicleChassisOptions` | — | Chassis collision-box and damping settings. |
| `suspension` | `VehicleSuspensionOptions` | — | Suspension and tire settings. |
| `steering` | `VehicleSteeringOptions` | — | Steering settings. |
| `grip` | `VehicleGripOptions` | — | Grip and handbrake settings. |
| `power` | `VehiclePowerOptions` | — | Power settings. |

### `debug`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `showPhysicsBox` | `boolean` | `false` | Show the chassis physics collision box. |
| `showWheelRays` | `boolean` | `false` | Show wheel suspension rays. |
| `showWheelTravel` | `boolean` | `false` | Show wheel Y-axis travel range. |
| `showWheelSpheres` | `boolean` | `false` | Show dynamic wheel collision spheres. |

### `chassis`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `density` | `number` | `1` | Chassis density; mass is calculated from collision-box volume and density. |
| `linearDamping` | `number` | `0.05` | Chassis linear damping. |
| `angularDamping` | `number` | `0.5` | Chassis angular damping. |
| `clearance` | `number` | Auto-calculated | Height of the chassis box bottom relative to tire contact points. |
| `sizeScale.x` | `number` | `1` | Chassis collision-box X-axis size multiplier. |
| `sizeScale.y` | `number` | `1` | Chassis collision-box Y-axis size multiplier. |
| `sizeScale.z` | `number` | `1` | Chassis collision-box Z-axis size multiplier. |

### `suspension`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `restLength` | `number` | Auto-calculated | Suspension rest length. |
| `maxTravel` | `number` | `0.35` | Maximum suspension travel. |
| `stiffness` | `number` | `18` | Suspension stiffness. |
| `compression` | `number` | `2.1` | Suspension compression damping. |
| `relaxation` | `number` | `2.5` | Suspension rebound damping. |
| `maxForce` | `number` | `6000` | Maximum suspension force per wheel. |
| `frictionSlip` | `number` | `8` | Longitudinal tire grip. |
| `sideFrictionStiffness` | `number` | `1` | Lateral tire friction stiffness. |
| `rollInfluence` | `number` | `0.12` | Effect of lateral force on body roll. |

### `steering`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxSteerAngle` | `number` | `Math.PI / 5` | Maximum steering angle in radians. |
| `steerTime` | `number` | `0.45` | Time from center to full steering lock in seconds. |
| `steerReturnTimeSlow` | `number` | `0.55` | Low-speed steering return time in seconds. |
| `steerReturnTimeFast` | `number` | `0.4` | High-speed steering return time in seconds. |
| `highSpeedSteerScale` | `number` | `0.3` | Maximum steering ratio at top speed. |

### `grip`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxG` | `number` | `1.2` | Maximum lateral acceleration in g. |
| `sideFrictionIdle` | `number` | `1` | Lateral friction while driving straight. |
| `sideFrictionFrontMin` | `number` | `0.55` | Minimum front-wheel lateral friction under high load. |
| `sideFrictionRearMin` | `number` | `0.45` | Minimum rear-wheel lateral friction under high load. |
| `handbrakeRearFriction` | `number` | `0.35` | Rear-wheel lateral friction while handbraking. |
| `handbrakeRearDriveScale` | `number` | `0.65` | Rear-wheel drive-force ratio while handbraking. |
| `handbrakeReleaseTime` | `number` | `0.15` | Recovery time after releasing the handbrake in seconds. |
| `wheelbaseRatio` | `number` | `0.55` | Wheelbase relative to vehicle length. |

### `power`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxSpeed` | `number` | `100` | Base top speed in km/h, scaled by `scale`. |
| `acceleration` | `number` | `5` | Base acceleration in m/s², scaled by `scale`. |
| `deceleration` | `number` | `5` | Base braking deceleration in m/s², scaled by `scale`. |

# Feedback

If you have any questions or suggestions, please submit an [issue](https://github.com/hh-hang/three-player-controller/issues).

# Acknowledgements

- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
- [three.js](https://github.com/mrdoob/three.js)

[npm]: https://img.shields.io/npm/v/three-player-controller
[npm-url]: https://www.npmjs.com/package/three-player-controller
[github]: https://img.shields.io/badge/-hh--hang-181717?style=flat&logo=github&logoColor=white&labelColor=888
[github-url]: https://github.com/hh-hang
