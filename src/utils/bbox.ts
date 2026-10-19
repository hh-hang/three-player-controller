import * as THREE from "three";

const _vertex = new THREE.Vector3();

function isBoundSkinnedMesh(child: THREE.Object3D): child is THREE.SkinnedMesh {
    const mesh = child as THREE.SkinnedMesh;
    return !!mesh.isSkinnedMesh
        && !!mesh.skeleton?.bones?.length
        && !!mesh.geometry?.attributes?.skinIndex
        && !!mesh.geometry?.attributes?.skinWeight;
}

/** 获取物体世界包围盒及中心、尺寸。蒙皮网格先还原到当前姿势，再变到世界坐标。 */
export function getBbox(object: THREE.Object3D) {
    object.updateMatrixWorld(true);
    const bbox = new THREE.Box3();
    object.traverse(child => {
        const mesh = child as THREE.Mesh;
        const position = mesh.geometry?.attributes?.position;
        if (!position) return;
        const skinned = isBoundSkinnedMesh(child);
        if (skinned) child.skeleton.update();
        const matrixWorld = child.matrixWorld;
        for (let i = 0, n = position.count; i < n; i++) {
            _vertex.fromBufferAttribute(position, i);
            if (skinned) child.applyBoneTransform(i, _vertex);
            _vertex.applyMatrix4(matrixWorld);
            bbox.expandByPoint(_vertex);
        }
    });
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bbox.getCenter(center);
    bbox.getSize(size);
    return { bbox, center, size };
}
