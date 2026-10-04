"""
glb_to_fbx.py — Headless Blender GLB to FBX Converter for FaceToModel
Executes inside Blender (blender -b -P glb_to_fbx.py -- <input_glb> <output_fbx>)
"""

import sys
import os
import bpy

def convert(input_path, output_path):
    if not os.path.exists(input_path):
        print(f"[Blender FBX] Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[Blender FBX] Converting: {input_path} -> {output_path}")

    # 1. Reset scene to pristine state (clear default cube, light, camera)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # 2. Import GLTF / GLB with full animation and morph targets
    bpy.ops.import_scene.gltf(filepath=input_path)

    # 3. Export FBX with baked animation, armatures, shape keys and textures
    bpy.ops.export_scene.fbx(
        filepath=output_path,
        check_existing=False,
        use_selection=False,
        global_scale=1.0,
        apply_unit_scale=True,
        apply_scale_options='FBX_SCALE_NONE',
        axis_forward='-Z',
        axis_up='Y',
        object_types={'ARMATURE', 'MESH', 'EMPTY'},
        use_mesh_modifiers=True,
        mesh_smooth_type='FACE',
        use_subsurf=False,
        use_armature_deform_only=False,
        armature_nodetype='NULL',
        bake_anim=True,
        bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=True,
        bake_anim_use_all_actions=True,
        bake_anim_force_startend_keying=True,
        bake_anim_step=1.0,
        bake_anim_simplify_factor=0.0,
        path_mode='COPY',
        embed_textures=True
    )

    if not os.path.exists(output_path):
        print(f"[Blender FBX] Failed to create output file: {output_path}", file=sys.stderr)
        sys.exit(1)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"[Blender FBX] Conversion successful! Size: {size_mb:.2f} MB")
    sys.exit(0)

if __name__ == '__main__':
    argv = sys.argv
    if '--' in argv:
        args = argv[argv.index('--') + 1:]
        if len(args) >= 2:
            convert(args[0], args[1])
        else:
            print("[Blender FBX] Usage: blender -b -P glb_to_fbx.py -- <input_glb> <output_fbx>", file=sys.stderr)
            sys.exit(1)
    else:
        print("[Blender FBX] Missing '--' argument separator.", file=sys.stderr)
        sys.exit(1)
