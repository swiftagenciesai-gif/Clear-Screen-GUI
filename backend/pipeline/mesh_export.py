"""Cleans up a raw photogrammetry mesh (COLMAP's meshed-poisson.ply or
Meshroom's texturedMesh.obj) and exports it as a web-ready .glb.

Poisson reconstruction extrapolates a watertight surface from a point cloud,
which reliably produces some floating debris/blobby extensions in areas with
sparse or noisy points (typically the object's underside, where a turntable
rig can't see). We trim those with a connected-component filter, then
decimate so the file is a reasonable size for a browser three.js viewer.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import trimesh


def _keep_largest_components(mesh: trimesh.Trimesh, keep_fraction_threshold: float = 0.02) -> trimesh.Trimesh:
    """Drop small disconnected fragments (Poisson reconstruction noise),
    keeping any component with at least `keep_fraction_threshold` of the
    total face count -- keeps main body plus reasonably sized real parts,
    drops speckle debris.
    """
    components = mesh.split(only_watertight=False)
    if len(components) <= 1:
        return mesh
    total_faces = sum(len(c.faces) for c in components)
    if total_faces == 0:
        return mesh
    kept = [c for c in components if len(c.faces) / total_faces >= keep_fraction_threshold]
    if not kept:
        kept = [max(components, key=lambda c: len(c.faces))]
    return trimesh.util.concatenate(kept)


def _decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    if len(mesh.faces) <= target_faces:
        return mesh
    try:
        return mesh.simplify_quadric_decimation(face_count=target_faces)
    except Exception:
        # Older trimesh versions expect a ratio rather than a face count, and
        # some builds lack the fast_simplification backend entirely -- fall
        # back to Open3D's implementation, which we already depend on for
        # dense point cloud handling.
        try:
            import open3d as o3d

            o3d_mesh = o3d.geometry.TriangleMesh()
            o3d_mesh.vertices = o3d.utility.Vector3dVector(mesh.vertices)
            o3d_mesh.triangles = o3d.utility.Vector3iVector(mesh.faces)
            if mesh.visual.kind == "vertex" and mesh.visual.vertex_colors is not None:
                colors = np.asarray(mesh.visual.vertex_colors)[:, :3] / 255.0
                o3d_mesh.vertex_colors = o3d.utility.Vector3dVector(colors)
            simplified = o3d_mesh.simplify_quadric_decimation(target_faces)
            vertex_colors = None
            if simplified.has_vertex_colors():
                vertex_colors = (np.asarray(simplified.vertex_colors) * 255).astype(np.uint8)
            return trimesh.Trimesh(
                vertices=np.asarray(simplified.vertices),
                faces=np.asarray(simplified.triangles),
                vertex_colors=vertex_colors,
                process=False,
            )
        except Exception:
            return mesh  # ship it un-decimated rather than fail the whole scan


def mesh_to_glb(
    input_mesh_path: Path,
    output_glb_path: Path,
    target_faces: int = 150_000,
    fill_holes: bool = True,
) -> Path:
    mesh = trimesh.load(str(input_mesh_path), process=False, force="mesh")
    if mesh.is_empty:
        raise ValueError(f"Loaded mesh from {input_mesh_path} is empty.")

    mesh.remove_infinite_values()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()

    mesh = _keep_largest_components(mesh)

    if fill_holes:
        try:
            trimesh.repair.fill_holes(mesh)
        except Exception:
            pass  # cosmetic only; a few open boundaries are fine for a viewer mesh

    mesh = _decimate(mesh, target_faces)

    # Recenter and normalize scale so the object lands predictably in the
    # three.js scene regardless of COLMAP's arbitrary reconstruction units.
    mesh.apply_translation(-mesh.centroid)
    extent = float(np.max(mesh.extents)) if mesh.extents is not None and np.max(mesh.extents) > 0 else 1.0
    mesh.apply_scale(1.0 / extent)

    output_glb_path.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(str(output_glb_path), file_type="glb")
    return output_glb_path
