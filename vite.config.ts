import { resolve } from "path";
import { defineConfig } from "vite";

const example = resolve(__dirname, "example");

export default defineConfig(({ mode }) => {
    const tiles = mode === "tiles";
    const input: Record<string, string> = tiles
        ? { tiles: resolve(example, "3dtilesScene.html") }
        : {
            main: resolve(example, "index.html"),
            gltf: resolve(example, "glTF.html"),
            dgs: resolve(example, "3dgs.html"),
            shooting: resolve(example, "shooting", "shooting.html"),
            footik: resolve(example, "footIK.html"),
            showcase: resolve(example, "showcase.html"),
        };
    return {
        base: "/three-player-controller/",
        root: example,
        server: { host: true, port: tiles ? 5174 : 5173 },
        ...(tiles
            ? {
                cacheDir: resolve(__dirname, "node_modules/.vite-tiles"),
                resolve: {
                    alias: [
                        { find: /^three$/, replacement: "three184" },
                        { find: /^three\//, replacement: "three184/" },
                    ],
                },
            }
            : {}),
        optimizeDeps: {
            exclude: tiles
                ? ["three", "tellux", "three-mesh-bvh"]
                : ["tellux", "three-mesh-bvh"],
        },
        build: {
            outDir: resolve(__dirname, "docs"),
            emptyOutDir: !tiles,
            rollupOptions: { input },
        },
    };
});
