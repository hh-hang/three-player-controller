# three-player-controller

A lightweight third-person / first-person player controller, ready to use out of the box, based on three.js and three-mesh-bvh. It implements capsule-based character collision, BVH collision detection, character animations, first/third-person switching, and camera obstacle avoidance. This repository contains the library source code and example demos.

# Installation

npm install three-player-controller

# Demo

[Player Controller](https://hh-hang.github.io/three-player-controller/)

### Controls

![Controls](https://github.com/hh-hang/three-player-controller/blob/master/example/public/gif/1.gif)

### fly

![fly](https://github.com/hh-hang/three-player-controller/blob/master/example/public/gif/3.gif)

### Third-person camera obstacle avoidance

![Third-person camera obstacle avoidance](https://github.com/hh-hang/three-player-controller/blob/master/example/public/gif/2.gif)

# Usage

```js
import * as THREE from "three";
import { playerController } from "three-player-controller";

const player = playerController();

// Initialize the player controller
player.init({
  scene, // three.js scene
  camera, // three.js camera
  controls, // three.js controls
  playerModel: {
    url: "./glb/person.glb", // model path
    scale: 0.001, // model scale
    idleAnim: "Idle_2", // idle animation name
    walkAnim: "Walking_11", // walk animation name
    runAnim: "Running_9", // run animation name
    jumpAnim: "Jump_3", // jump animation name
  },
  initPos: pos, // initial position
});

// Call in the render loop
player.update();
```

# Thanks

[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)

[three](https://github.com/mrdoob/three.js)
