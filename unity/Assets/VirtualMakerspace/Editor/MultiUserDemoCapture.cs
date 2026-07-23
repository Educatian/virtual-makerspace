using System.IO;
using System.Linq;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;

namespace VirtualMakerspace.Editor
{
    public static class MultiUserDemoCapture
    {
        private const string OutputPath = "Artifacts/MultiUserDemo/Staged-Two-User-Breadboard-Collaboration.png";

        public static void Capture()
        {
            EditorSceneManager.OpenScene("Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity");
            Camera camera = GameObject.Find("DesktopPreviewCamera").GetComponent<Camera>();
            GameObject hud = GameObject.Find("Wrist HUD Canvas");
            Text[] texts = hud.GetComponentsInChildren<Text>(true);
            string[] originals = texts.Select(item => item.text).ToArray();

            SetText(hud, "Room Code", "ROOM  MS42Q7");
            SetText(hud, "Relay Status", "ONLINE  |  RELAY READY");
            SetText(hud, "Voice Status", "VOICE  |  MIC ON");
            SetText(hud, "Participants", "2/2 CONNECTED  |  DEMO USER A + B");
            SetText(hud, "Handoff", "HANDOFF: USER A > USER B");
            SetText(hud, "Guidance", "STEP 04 / 05   CO-PLACE + EXPLAIN");

            var root = new GameObject("Staged Two User Demo");
            root.transform.SetParent(camera.transform, false);
            BuildGlove(root.transform, -1f, new Color(0.05f, 0.85f, 1f));
            BuildGlove(root.transform, 1f, new Color(1f, 0.48f, 0.12f));
            BuildResistor(root.transform);
            BuildBanner(root.transform);
            Canvas.ForceUpdateCanvases();

            Directory.CreateDirectory(Path.GetDirectoryName(OutputPath));
            CaptureFrame(camera, OutputPath);

            Object.DestroyImmediate(root);
            for (int index = 0; index < texts.Length; index++)
                texts[index].text = originals[index];
            Debug.Log($"MULTI_USER_DEMO_CAPTURE_READY path={OutputPath}");
        }

        private static void BuildGlove(Transform parent, float side, Color color)
        {
            var glove = new GameObject(side < 0 ? "Demo User A Hand" : "Demo User B Hand");
            glove.transform.SetParent(parent, false);
            glove.transform.localPosition = new Vector3(side * 0.28f, -0.18f, 2.08f);
            glove.transform.localRotation = Quaternion.Euler(12f, -side * 18f, side * 12f);
            Material material = MakeMaterial(color);
            Part(glove.transform, PrimitiveType.Sphere, "Palm", Vector3.zero,
                new Vector3(0.10f, 0.055f, 0.13f), Quaternion.identity, material);
            Part(glove.transform, PrimitiveType.Capsule, "Forearm",
                new Vector3(side * 0.08f, -0.08f, -0.18f),
                new Vector3(0.045f, 0.15f, 0.045f), Quaternion.Euler(72f, 0f, side * 12f), material);
            Part(glove.transform, PrimitiveType.Capsule, "Pointing Finger",
                new Vector3(-side * 0.045f, 0.015f, 0.13f),
                new Vector3(0.018f, 0.085f, 0.018f), Quaternion.Euler(90f, 0f, 0f), material);
        }

        private static void BuildResistor(Transform parent)
        {
            Material body = MakeMaterial(new Color(0.72f, 0.34f, 0.12f));
            Material lead = MakeMaterial(new Color(0.72f, 0.78f, 0.82f));
            Part(parent, PrimitiveType.Cylinder, "Shared Resistor", new Vector3(0f, -0.17f, 2.13f),
                new Vector3(0.027f, 0.075f, 0.027f), Quaternion.Euler(0f, 0f, 90f), body);
            Part(parent, PrimitiveType.Cylinder, "Left Lead", new Vector3(-0.13f, -0.17f, 2.13f),
                new Vector3(0.006f, 0.065f, 0.006f), Quaternion.Euler(0f, 0f, 90f), lead);
            Part(parent, PrimitiveType.Cylinder, "Right Lead", new Vector3(0.13f, -0.17f, 2.13f),
                new Vector3(0.006f, 0.065f, 0.006f), Quaternion.Euler(0f, 0f, 90f), lead);
        }

        private static void BuildBanner(Transform parent)
        {
            var go = new GameObject("Staged Demo Banner", typeof(RectTransform), typeof(Canvas),
                typeof(CanvasScaler), typeof(GraphicRaycaster));
            go.transform.SetParent(parent, false);
            go.GetComponent<Canvas>().renderMode = RenderMode.WorldSpace;
            RectTransform canvas = go.GetComponent<RectTransform>();
            canvas.sizeDelta = new Vector2(760f, 120f);
            canvas.localPosition = new Vector3(0f, 0.33f, 0.96f);
            canvas.localScale = Vector3.one * 0.00078f;
            HudUiFactory.Image(canvas, "Panel", new Color(0.018f, 0.035f, 0.065f, 0.97f), 0, 0, 760, 120);
            Text title = HudUiFactory.Text(canvas, "Title", "STAGED TWO-USER DEMO - NOT LIVE",
                22, FontStyle.Bold, Color.white, 20, 76, 720, 32);
            title.alignment = TextAnchor.MiddleCenter;
            HudUiFactory.Image(canvas, "A", new Color(0.03f, 0.35f, 0.48f), 20, 18, 350, 48);
            HudUiFactory.Text(canvas, "User A", "DEMO USER A | HOST | SPEAKING",
                16, FontStyle.Bold, Color.white, 34, 26, 322, 30);
            HudUiFactory.Image(canvas, "B", new Color(0.55f, 0.24f, 0.04f), 390, 18, 350, 48);
            HudUiFactory.Text(canvas, "User B", "DEMO USER B | PARTNER | MIC ON",
                16, FontStyle.Bold, Color.white, 404, 26, 322, 30);
        }

        private static GameObject Part(Transform parent, PrimitiveType type, string name,
            Vector3 position, Vector3 scale, Quaternion rotation, Material material)
        {
            GameObject part = GameObject.CreatePrimitive(type);
            part.name = name;
            part.transform.SetParent(parent, false);
            part.transform.localPosition = position;
            part.transform.localScale = scale;
            part.transform.localRotation = rotation;
            part.GetComponent<Renderer>().sharedMaterial = material;
            Object.DestroyImmediate(part.GetComponent<Collider>());
            return part;
        }

        private static Material MakeMaterial(Color color)
        {
            var material = new Material(Shader.Find("Standard"));
            material.color = color;
            material.EnableKeyword("_EMISSION");
            material.SetColor("_EmissionColor", color * 0.35f);
            return material;
        }

        private static void SetText(GameObject root, string objectName, string value)
        {
            root.GetComponentsInChildren<Transform>(true).First(item => item.name == objectName)
                .GetComponent<Text>().text = value;
        }

        private static void CaptureFrame(Camera camera, string path)
        {
            var target = new RenderTexture(1280, 720, 24);
            var texture = new Texture2D(1280, 720, TextureFormat.RGB24, false);
            camera.targetTexture = target;
            camera.Render();
            RenderTexture.active = target;
            texture.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0);
            texture.Apply();
            File.WriteAllBytes(path, texture.EncodeToPNG());
            camera.targetTexture = null;
            RenderTexture.active = null;
            Object.DestroyImmediate(texture);
            target.Release();
            Object.DestroyImmediate(target);
        }
    }
}
