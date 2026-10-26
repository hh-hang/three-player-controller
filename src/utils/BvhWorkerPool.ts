import type { BufferGeometry } from "three";
import { MeshBVH } from "three-mesh-bvh";

/** three-mesh-bvh 的 GenerateMeshBVHWorker 最小接口。 */
type GenerateMeshBVHWorkerLike = {
    generate(geometry: BufferGeometry, options?: object): Promise<MeshBVH>;
    dispose(): void;
};

/** 串行队列中的一项构建任务。 */
type QueueItem = {
    geometry: BufferGeometry;          // 待构建的几何
    resolve: (bvh: MeshBVH) => void;   // 构建成功
    reject: (error: unknown) => void;  // 构建失败
};

/**
 * 串行复用单个 GenerateMeshBVHWorker。
 * Worker 不可用或失败时回退到原几何的同步 MeshBVH。
 */
export class BvhWorkerPool {
    private worker: GenerateMeshBVHWorkerLike | null = null; // 已创建的 Worker
    private workerPromise: Promise<GenerateMeshBVHWorkerLike | null> | null = null; // 创建中的 Promise，避免重复加载
    private readonly queue: QueueItem[] = []; // 等待构建的任务
    private pumping = false; // 是否正在消费队列
    private disposed = false; // 是否已销毁
    private workerDisabled = false; // 失败后禁用 Worker，后续一律同步构建
    private workerBuildCount = 0; // Worker 构建次数
    private syncBuildCount = 0; // 同步构建次数
    private loggedWorkerReady = false; // 是否已打印 Worker 就绪日志

    /** 将几何加入队列，返回构建完成的 MeshBVH。 */
    generate(geometry: BufferGeometry): Promise<MeshBVH> {
        if (this.disposed) {
            return Promise.reject(new Error("BVH 工作池已销毁。"));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ geometry, resolve, reject });
            void this.pump();
        });
    }

    /** 销毁 Worker 并清空队列。 */
    dispose() {
        this.disposed = true;
        this.queue.length = 0;
        this.disableWorker();
        this.workerPromise = null;
    }

    /** 关闭 Worker，后续任务改走同步构建。 */
    private disableWorker() {
        if (!this.workerDisabled && !this.disposed) {
            console.warn("[BVH] worker disabled, later builds use sync MeshBVH");
        }
        this.workerDisabled = true;
        this.worker?.dispose();
        this.worker = null;
        this.workerPromise = null;
    }

    /** 按间隔打印构建次数，避免每帧刷日志。 */
    private logBuild(mode: "worker" | "sync") {
        if (mode === "worker") {
            this.workerBuildCount += 1;
            if (this.workerBuildCount === 1 || this.workerBuildCount % 20 === 0) {
                console.info(`[BVH] worker build #${this.workerBuildCount}`);
            }
            return;
        }
        this.syncBuildCount += 1;
        if (this.syncBuildCount === 1 || this.syncBuildCount % 20 === 0) {
            console.info(`[BVH] sync build #${this.syncBuildCount}`);
        }
    }

    /** 懒加载并缓存 Worker；失败则返回 null。 */
    private async ensureWorker(): Promise<GenerateMeshBVHWorkerLike | null> {
        if (this.workerDisabled) return null;
        if (this.worker) return this.worker;
        if (this.workerPromise) return this.workerPromise;

        this.workerPromise = this.loadWorkerCtor()
            .then((GenerateMeshBVHWorker) => {
                if (this.disposed || this.workerDisabled || !GenerateMeshBVHWorker) return null;
                this.worker = new GenerateMeshBVHWorker();
                if (!this.loggedWorkerReady) {
                    this.loggedWorkerReady = true;
                    console.info("[BVH] worker ready");
                }
                return this.worker;
            })
            .catch((error) => {
                console.warn("[BVH] worker create failed, sync fallback", error);
                this.workerDisabled = true;
                return null;
            });

        return this.workerPromise;
    }

    /** 动态导入 GenerateMeshBVHWorker。 */
    private async loadWorkerCtor(): Promise<(new () => GenerateMeshBVHWorkerLike) | null> {
        const mod = await import("three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js");
        return mod.GenerateMeshBVHWorker;
    }

    /** 主线程同步构建。 */
    private buildSync(geometry: BufferGeometry) {
        return new MeshBVH(geometry);
    }

    /**
     * 在克隆几何上交给 Worker 构建，避免 transfer 抽空原 buffer。
     * 构建后把 position / index 写回原几何，供后续射线与 shapecast 使用。
     */
    private async buildWithWorker(
        worker: GenerateMeshBVHWorkerLike,
        geometry: BufferGeometry
    ) {
        const clone = geometry.clone();
        const bvh = await worker.generate(clone);
        const position = clone.getAttribute("position");
        if (position?.array) {
            geometry.setAttribute("position", position);
        }
        if (clone.index) {
            geometry.setIndex(clone.index);
        }
        return bvh;
    }

    /** 让出一帧后再继续消费队列，避免连续同步构建卡住主线程。 */
    private schedulePump() {
        const resume = () => {
            void this.pump();
        };
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(resume);
            return;
        }
        setTimeout(resume, 0);
    }

    /** 串行消费队列：优先 Worker，失败则同步回退并禁用 Worker。 */
    private async pump() {
        if (this.pumping || this.disposed) return;
        this.pumping = true;

        try {
            while (this.queue.length && !this.disposed) {
                const item = this.queue.shift();
                if (!item) break;

                try {
                    const worker = await this.ensureWorker();
                    if (this.disposed) {
                        item.reject(new Error("BVH 工作池已销毁。"));
                        continue;
                    }
                    // Worker 不可用：本任务同步构建，剩余任务下一帧再跑
                    if (!worker) {
                        this.logBuild("sync");
                        item.resolve(this.buildSync(item.geometry));
                        if (this.queue.length) this.schedulePump();
                        break;
                    }
                    const bvh = await this.buildWithWorker(worker, item.geometry);
                    this.logBuild("worker");
                    item.resolve(bvh);
                } catch (error) {
                    // 本次 Worker 构建失败：禁用 Worker，本任务改同步，其余下一帧继续
                    console.warn("[BVH] worker generate failed, switch to sync", error);
                    this.disableWorker();
                    try {
                        this.logBuild("sync");
                        item.resolve(this.buildSync(item.geometry));
                    } catch (fallbackError) {
                        item.reject(fallbackError ?? error);
                    }
                    if (this.queue.length) this.schedulePump();
                    break;
                }
            }
        } finally {
            this.pumping = false;
        }
    }
}
