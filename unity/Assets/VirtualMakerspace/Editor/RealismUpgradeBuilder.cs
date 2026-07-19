using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace VirtualMakerspace.Editor
{
    public static class RealismUpgradeBuilder
    {
        private const string ScenePath = "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity";
        private const string AssetRoot = "Assets/VirtualMakerspace/Art/BlenderGenerated";

        [MenuItem("Virtual Makerspace/Apply Realism Upgrade")]
        public static void Apply()
        {
            var scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
            GameObject existing = GameObject.Find("Realism Upgrade");
            if (existing != null)
            {
                UnityEngine.Object.DestroyImmediate(existing);
            }

            DisableLegacy("Workbench");
            DisableLegacy("Breadboard");
            DisableLegacy("PositiveRail");
            DisableLegacy("NegativeRail");
            DisableLegacy("Resistor");
            DisableLegacy("LED");

            var root = new GameObject("Realism Upgrade");
            Dictionary<string, Material> pbrMaterials = PbrMaterialLibrary.Build();
            Place(root.transform, "Workbench", new Vector3(0f, 0f, 0.42f), Vector3.one, Quaternion.identity);
            Place(root.transform, "Breadboard", new Vector3(0f, 0.82f, 0.34f), Vector3.one * 0.32f, Quaternion.identity);
            Place(root.transform, "Resistor", new Vector3(-0.20f, 0.91f, 0.37f), Vector3.one * 0.22f, Quaternion.Euler(0f, 15f, 0f));
            Place(root.transform, "LED", new Vector3(0.16f, 0.92f, 0.37f), Vector3.one * 0.28f, Quaternion.identity);
            Place(root.transform, "Pushbutton", new Vector3(0.34f, 0.90f, 0.35f), Vector3.one * 0.35f, Quaternion.identity);
            Place(root.transform, "Multimeter", new Vector3(-0.78f, 0.83f, 0.40f), Vector3.one * 0.32f, Quaternion.Euler(72f, 0f, 0f));
            Place(root.transform, "WireCutters", new Vector3(0.72f, 0.84f, 0.28f), Vector3.one * 0.55f, Quaternion.Euler(0f, 25f, 0f));
            Place(root.transform, "NeedleNosePliers", new Vector3(0.72f, 0.84f, 0.52f), Vector3.one * 0.48f, Quaternion.Euler(0f, -18f, 0f));
            Place(root.transform, "DeskLamp", new Vector3(-0.88f, 0.82f, 0.78f), Vector3.one * 0.70f, Quaternion.Euler(0f, 18f, 0f));
            Place(root.transform, "RoomCodeTerminal", new Vector3(0.70f, 0.84f, 0.66f), Vector3.one * 2.2f, Quaternion.Euler(0f, -18f, 0f));
            Place(root.transform, "Pegboard", new Vector3(0f, 1.35f, 1.55f), Vector3.one * 1.8f, Quaternion.Euler(90f, 0f, 0f));
            Place(root.transform, "ToolRail", new Vector3(0f, 1.62f, 1.48f), Vector3.one * 1.3f, Quaternion.Euler(90f, 0f, 0f));
            Place(root.transform, "DrawerCabinet", new Vector3(-1.55f, 0f, 1.10f), Vector3.one * 0.75f, Quaternion.identity);
            Place(root.transform, "MetalShelving", new Vector3(1.75f, 0f, 1.50f), Vector3.one * 0.70f, Quaternion.identity);
            Place(root.transform, "ESDFloorTile", new Vector3(0f, 0.005f, 0.40f), new Vector3(4f, 5f, 1f), Quaternion.identity);
            Place(root.transform, "ParticipantBeacon", new Vector3(0.72f, 1.28f, 0.68f), Vector3.one * 2.5f, Quaternion.Euler(90f, 0f, 0f));
            Place(root.transform, "VoiceActivityRing", new Vector3(0.72f, 1.28f, 0.70f), Vector3.one * 0.42f, Quaternion.Euler(90f, 0f, 0f));

            Camera camera = GameObject.Find("DesktopPreviewCamera").GetComponent<Camera>();
            camera.transform.SetPositionAndRotation(new Vector3(0f, 1.62f, -2.35f), Quaternion.Euler(16f, 0f, 0f));
            camera.fieldOfView = 52f;
            camera.backgroundColor = new Color(0.012f, 0.02f, 0.035f);
            WristHudBuilder.BuildIntoScene(camera);

            Light key = GameObject.Find("KeyLight").GetComponent<Light>();
            key.intensity = 1.75f;
            key.color = new Color(1f, 0.88f, 0.72f);
            key.shadows = LightShadows.Soft;
            key.shadowStrength = 0.55f;
            key.shadowBias = 0.04f;

            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.22f, 0.29f, 0.42f);
            RenderSettings.ambientEquatorColor = new Color(0.16f, 0.13f, 0.12f);
            RenderSettings.ambientGroundColor = new Color(0.045f, 0.05f, 0.065f);
            RenderSettings.ambientIntensity = 1.15f;
            RenderSettings.reflectionIntensity = 0.7f;

            CreateFillLight(root.transform, "Cool Fill", new Vector3(1.7f, 2.2f, -0.6f), new Color(0.25f, 0.55f, 1f), 4.0f, 5f);
            CreateFillLight(root.transform, "Workbench Pool", new Vector3(-0.55f, 1.7f, 0.2f), new Color(1f, 0.58f, 0.28f), 3.0f, 2.5f);

            PbrMaterialLibrary.Apply(root.transform, pbrMaterials);
            foreach (Renderer renderer in root.GetComponentsInChildren<Renderer>(true))
            {
                bool microGeometry = renderer.name.Contains("Socket", StringComparison.OrdinalIgnoreCase) ||
                    renderer.name.Contains("Hole", StringComparison.OrdinalIgnoreCase);
                renderer.shadowCastingMode = microGeometry ? ShadowCastingMode.Off : ShadowCastingMode.On;
                renderer.receiveShadows = true;
            }

            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.SaveAssets();
            Debug.Log("REALISM_UPGRADE_APPLIED");
        }

        public static void ApplyAndCapture()
        {
            Apply();
            MakerspacePreviewCapture.Capture();
            string source = "Artifacts/MakerspacePrototype.png";
            string destination = "Artifacts/Milestone7-Blender-Realism-Upgrade.png";
            File.Copy(source, destination, true);
            Debug.Log($"REALISM_UPGRADE_CAPTURED {destination}");
        }

        private static void DisableLegacy(string name)
        {
            GameObject found = GameObject.Find(name);
            if (found != null)
            {
                found.SetActive(false);
            }
        }

        private static void Place(Transform parent, string assetName, Vector3 position, Vector3 scale, Quaternion rotation)
        {
            string path = $"{AssetRoot}/{assetName}/{assetName}.obj";
            GameObject source = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (source == null)
            {
                throw new InvalidOperationException($"Missing generated asset: {path}");
            }

            GameObject instance = UnityEngine.Object.Instantiate(source, position, rotation, parent);
            instance.name = assetName;
            instance.transform.localScale = scale;
        }

        private static void CreateFillLight(Transform parent, string name, Vector3 position, Color color, float intensity, float range)
        {
            var lightObject = new GameObject(name);
            lightObject.transform.SetParent(parent, false);
            lightObject.transform.position = position;
            Light light = lightObject.AddComponent<Light>();
            light.type = LightType.Point;
            light.color = color;
            light.intensity = intensity;
            light.range = range;
            light.shadows = LightShadows.None;
        }
    }
}


