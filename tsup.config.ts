import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        "foot-ik": "src/foot-ik.ts",
        route: "src/route.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: [
        "three",
        "three-mesh-bvh",
        "three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js",
    ],
    target: "es2020",
    minify: false,
});
