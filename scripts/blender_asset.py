"""Trusted, fixed local asset workflow. Run only via the permission-gated tool."""

import json
from pathlib import Path
import re
import sys

import bpy
from mathutils import Vector


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:]
    if len(arguments) != 1:
        raise ValueError("Expected one JSON argument")
    args = json.loads(arguments[0])
    if set(args) != {"name", "primitive", "output_dir", "textures"}:
        raise ValueError("Unexpected asset arguments")
    name = args["name"]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", name):
        raise ValueError("Invalid asset name")
    primitive = args["primitive"]
    if primitive not in {"plane", "cube", "sphere"}:
        raise ValueError("Unsupported primitive")
    output_dir = Path(args["output_dir"])
    if not output_dir.is_absolute() or output_dir.resolve() != output_dir:
        raise ValueError("Output directory must be canonical and absolute")
    if not output_dir.is_dir() or any(output_dir.iterdir()):
        raise ValueError("Output directory must exist and be empty; no overwrites")
    textures = args["textures"]
    if not isinstance(textures, dict) or set(textures) - {"albedo", "roughness", "metallic", "normal"}:
        raise ValueError("Unsupported texture slots")
    for value in textures.values():
        texture = Path(value)
        if not texture.is_absolute() or texture.resolve() != texture or not texture.is_file():
            raise ValueError("Textures must be canonical local files")
        if texture.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".exr", ".hdr", ".bmp"}:
            raise ValueError("Textures must be raster images")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    if primitive == "plane":
        bpy.ops.mesh.primitive_plane_add(size=2, calc_uvs=True)
    elif primitive == "cube":
        bpy.ops.mesh.primitive_cube_add(size=2, calc_uvs=True)
    else:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1, calc_uvs=True)
    asset = bpy.context.object
    asset.name = name
    if primitive == "sphere":
        for polygon in asset.data.polygons:
            polygon.use_smooth = True

    material = bpy.data.materials.new(name=f"{name}_material")
    material.use_nodes = True
    asset.data.materials.append(material)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
    principled.inputs["Roughness"].default_value = 0.5
    principled.inputs["Metallic"].default_value = 0.0
    targets = {"albedo": "Base Color", "roughness": "Roughness", "metallic": "Metallic"}
    for slot, value in textures.items():
        node = nodes.new("ShaderNodeTexImage")
        node.label = slot
        # Separate datablocks preserve color space if one file is used in multiple slots.
        node.image = bpy.data.images.load(value, check_existing=False)
        node.image.colorspace_settings.name = "sRGB" if slot == "albedo" else "Non-Color"
        node.image.pack()
        if slot == "normal":
            normal = nodes.new("ShaderNodeNormalMap")
            normal.space = "TANGENT"
            links.new(node.outputs["Color"], normal.inputs["Color"])
            links.new(normal.outputs["Normal"], principled.inputs["Normal"])
        else:
            links.new(node.outputs["Color"], principled.inputs[targets[slot]])

    scene = bpy.context.scene
    # CPU Cycles works headlessly without requiring a display or GPU configuration.
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.08, 0.08, 0.08, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5

    bpy.ops.object.camera_add(location=(3.4, -4.5, 3.2))
    camera = bpy.context.object
    camera.rotation_euler = (-camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 4.2
    camera.data.lens = 50
    scene.camera = camera
    for location, energy, size in [((3, -4, 5), 700, 4), ((-3, -1, 2), 400, 3), ((1, 4, 4), 600, 3)]:
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = size
        light.rotation_euler = (-Vector(location)).to_track_quat("-Z", "Y").to_euler()

    outputs = {
        "blend": str(output_dir / f"{name}.blend"),
        "glb": str(output_dir / f"{name}.glb"),
        "preview": str(output_dir / "preview.png"),
        "manifest": str(output_dir / "manifest.json"),
    }
    bpy.ops.object.select_all(action="DESELECT")
    asset.select_set(True)
    bpy.context.view_layer.objects.active = asset
    bpy.ops.export_scene.gltf(filepath=outputs["glb"], export_format="GLB", use_selection=True)
    scene.render.filepath = outputs["preview"]
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=outputs["blend"], check_existing=False)
    manifest = {
        "schema_version": 1,
        "name": name,
        "primitive": primitive,
        "blender_version": bpy.app.version_string,
        "local": True,
        "billing": "free",
        "external_paid_services": False,
        "textures": {
            slot: {"path": value, "color_space": "sRGB" if slot == "albedo" else "Non-Color"}
            for slot, value in textures.items()
        },
        "normal_convention": "tangent-space OpenGL/+Y",
        "outputs": outputs,
        "limitations": [
            "UV primitive starting asset, not a production mesh.",
            "Textures are used as supplied; PBR coherence is not generated or verified.",
            "glTF export may convert or repack textures; displacement is not supported.",
        ],
    }
    with open(outputs["manifest"], "x", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    print(json.dumps({"outputs": outputs}))


if __name__ == "__main__":
    main()
