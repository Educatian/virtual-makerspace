using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using VirtualMakerspace.Voice;

namespace VirtualMakerspace.Editor
{
    public static class MakerspacePrototypeBuilder
    {
        private const string ScenePath = "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity";

        [MenuItem("Virtual Makerspace/Build Prototype Scene")]
        public static void Build()
        {
            EnsureFolder("Assets/VirtualMakerspace", "Scenes");
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            CreatePrimitive("Floor", PrimitiveType.Cube, new Vector3(0f, -0.05f, 0f), new Vector3(6f, 0.1f, 6f), new Color(0.08f, 0.1f, 0.14f));
            CreatePrimitive("Workbench", PrimitiveType.Cube, new Vector3(0f, 0.72f, 0.4f), new Vector3(2.4f, 0.12f, 1.2f), new Color(0.36f, 0.2f, 0.08f));
            CreatePrimitive("Breadboard", PrimitiveType.Cube, new Vector3(0f, 0.81f, 0.35f), new Vector3(1.5f, 0.08f, 0.7f), new Color(0.88f, 0.88f, 0.82f));
            CreatePrimitive("PositiveRail", PrimitiveType.Cube, new Vector3(0f, 0.86f, 0.62f), new Vector3(1.3f, 0.015f, 0.025f), new Color(0.9f, 0.08f, 0.08f));
            CreatePrimitive("NegativeRail", PrimitiveType.Cube, new Vector3(0f, 0.86f, 0.08f), new Vector3(1.3f, 0.015f, 0.025f), new Color(0.08f, 0.25f, 0.9f));
            CreatePrimitive("Resistor", PrimitiveType.Cylinder, new Vector3(-0.25f, 0.91f, 0.4f), new Vector3(0.04f, 0.18f, 0.04f), new Color(0.76f, 0.6f, 0.3f), Quaternion.Euler(0f, 0f, 90f));
            GameObject led = CreatePrimitive("LED", PrimitiveType.Sphere, new Vector3(0.25f, 0.96f, 0.4f), Vector3.one * 0.12f, new Color(0.25f, 0.05f, 0.05f));

            var systems = new GameObject("AppSystems");
            systems.AddComponent<VoiceChannelController>();
            var demo = systems.AddComponent<CircuitDemoController>();
            var serializedDemo = new SerializedObject(demo);
            serializedDemo.FindProperty("ledRenderer").objectReferenceValue = led.GetComponent<Renderer>();
            serializedDemo.ApplyModifiedPropertiesWithoutUndo();

            var cameraObject = new GameObject("DesktopPreviewCamera");
            var camera = cameraObject.AddComponent<Camera>();
            cameraObject.tag = "MainCamera";
            cameraObject.transform.SetPositionAndRotation(new Vector3(0f, 1.65f, -2.2f), Quaternion.Euler(18f, 0f, 0f));
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.025f, 0.035f, 0.06f);

            var lightObject = new GameObject("KeyLight");
            var light = lightObject.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.4f;
            lightObject.transform.rotation = Quaternion.Euler(45f, -30f, 0f);

            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log($"Built Virtual Makerspace prototype scene at {ScenePath}");
        }

        private static GameObject CreatePrimitive(string name, PrimitiveType type, Vector3 position, Vector3 scale, Color color, Quaternion? rotation = null)
        {
            GameObject instance = GameObject.CreatePrimitive(type);
            instance.name = name;
            instance.transform.SetPositionAndRotation(position, rotation ?? Quaternion.identity);
            instance.transform.localScale = scale;
            instance.GetComponent<Renderer>().sharedMaterial = CreateMaterial($"M_{name}", color);
            return instance;
        }

        private static Material CreateMaterial(string name, Color color)
        {
            var material = new Material(Shader.Find("Standard"));
            material.name = name;
            material.color = color;
            return material;
        }

        private static void EnsureFolder(string parent, string child)
        {
            string path = $"{parent}/{child}";
            if (!AssetDatabase.IsValidFolder(path))
            {
                AssetDatabase.CreateFolder(parent, child);
            }
        }
    }
}