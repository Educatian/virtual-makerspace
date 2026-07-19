using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;

namespace VirtualMakerspace.Editor
{
    public static class LobbyDemoCapture
    {
        public static void Capture()
        {
            EditorSceneManager.OpenScene("Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity");
            Camera camera = GameObject.Find("DesktopPreviewCamera").GetComponent<Camera>();

            GameObject canvasObject = new GameObject("Lobby Demo Capture", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            Canvas canvas = canvasObject.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            RectTransform canvasRect = canvasObject.GetComponent<RectTransform>();
            canvasRect.sizeDelta = new Vector2(1280f, 720f);
            canvasRect.position = camera.transform.position + camera.transform.forward * 1.2f;
            canvasRect.rotation = camera.transform.rotation;
            canvasRect.localScale = Vector3.one * 0.0015f;
            CanvasScaler scaler = canvasObject.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1280, 720);

            Image panel = Image(canvasObject.transform, "Lobby Panel", new Color(0.025f, 0.055f, 0.10f, 0.96f));
            SetRect(panel.rectTransform, new Vector2(38, 38), new Vector2(610, 644));

            Text(canvasObject.transform, "DEMO PREVIEW", 22, FontStyle.Bold, new Color(0.25f, 0.95f, 0.78f), 72, 640, 550, 36);
            Text(canvasObject.transform, "VIRTUAL MAKERSPACE LOBBY", 31, FontStyle.Bold, Color.white, 72, 590, 550, 46);
            Text(canvasObject.transform, "Two-Person Breadboard Activity", 20, FontStyle.Normal, new Color(0.72f, 0.82f, 0.92f), 72, 552, 550, 34);

            Box(canvasObject.transform, "Create", "CREATE ROOM", 72, 480, 250, 56, new Color(0.04f, 0.48f, 0.72f));
            Box(canvasObject.transform, "Join", "JOIN ROOM", 340, 480, 250, 56, new Color(0.04f, 0.48f, 0.72f));

            Text(canvasObject.transform, "ROOM CODE", 16, FontStyle.Bold, new Color(0.56f, 0.73f, 0.88f), 72, 440, 200, 28);
            Box(canvasObject.transform, "Code", "MS42Q7", 72, 388, 518, 48, new Color(0.10f, 0.16f, 0.24f));

            Text(canvasObject.transform, "CONNECTION STATUS", 16, FontStyle.Bold, new Color(0.56f, 0.73f, 0.88f), 72, 346, 300, 28);
            Text(canvasObject.transform, "2/2 CONNECTED", 28, FontStyle.Bold, new Color(0.24f, 0.95f, 0.58f), 72, 304, 400, 42);

            Participant(canvasObject.transform, "Demo User A", "CONNECTED", 72, 246);
            Participant(canvasObject.transform, "Demo User B", "CONNECTED", 72, 188);

            Text(canvasObject.transform, "VOICE CHANNEL", 16, FontStyle.Bold, new Color(0.56f, 0.73f, 0.88f), 72, 146, 240, 28);
            Text(canvasObject.transform, "VIVOX READY  •  MICROPHONE ON", 18, FontStyle.Bold, new Color(0.25f, 0.95f, 0.78f), 72, 108, 500, 30);
            Text(canvasObject.transform, "Demo visualization. Run two headsets to verify a live session.", 13, FontStyle.Italic, new Color(0.70f, 0.76f, 0.83f), 72, 72, 520, 24);

            Canvas.ForceUpdateCanvases();
            var target = new RenderTexture(1280, 720, 24);
            var texture = new Texture2D(1280, 720, TextureFormat.RGB24, false);
            camera.targetTexture = target;
            camera.Render();
            RenderTexture.active = target;
            texture.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0);
            texture.Apply();
            Directory.CreateDirectory("Artifacts");
            File.WriteAllBytes("Artifacts/Milestone6-English-Lobby-Demo.png", texture.EncodeToPNG());
            camera.targetTexture = null;
            RenderTexture.active = null;
            Object.DestroyImmediate(texture);
            Object.DestroyImmediate(target);
            Object.DestroyImmediate(canvasObject);
            Debug.Log("Captured Artifacts/Milestone6-English-Lobby-Demo.png");
        }

        private static void Participant(Transform parent, string name, string state, float x, float y)
        {
            Image bg = Image(parent, name + " Row", new Color(0.08f, 0.13f, 0.20f, 1f));
            SetRect(bg.rectTransform, new Vector2(x, y), new Vector2(518, 48));
            Text(parent, "●", 23, FontStyle.Bold, new Color(0.24f, 0.95f, 0.58f), x + 16, y + 7, 30, 32);
            Text(parent, name, 19, FontStyle.Bold, Color.white, x + 54, y + 8, 230, 32);
            Text(parent, state, 17, FontStyle.Bold, new Color(0.24f, 0.95f, 0.58f), x + 330, y + 9, 170, 30);
        }

        private static void Box(Transform parent, string name, string label, float x, float y, float w, float h, Color color)
        {
            Image bg = Image(parent, name, color);
            SetRect(bg.rectTransform, new Vector2(x, y), new Vector2(w, h));
            Text(parent, label, 20, FontStyle.Bold, Color.white, x, y + 10, w, h - 12).alignment = TextAnchor.MiddleCenter;
        }

        private static Image Image(Transform parent, string name, Color color)
        {
            GameObject go = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            go.transform.SetParent(parent, false);
            Image image = go.GetComponent<Image>();
            image.color = color;
            return image;
        }

        private static Text Text(Transform parent, string value, int size, FontStyle style, Color color, float x, float y, float w, float h)
        {
            GameObject go = new GameObject(value, typeof(RectTransform), typeof(CanvasRenderer), typeof(Text));
            go.transform.SetParent(parent, false);
            Text text = go.GetComponent<Text>();
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.text = value;
            text.fontSize = size;
            text.fontStyle = style;
            text.color = color;
            text.alignment = TextAnchor.MiddleLeft;
            SetRect(text.rectTransform, new Vector2(x, y), new Vector2(w, h));
            return text;
        }

        private static void SetRect(RectTransform rect, Vector2 position, Vector2 size)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.zero;
            rect.pivot = Vector2.zero;
            rect.anchoredPosition = position;
            rect.sizeDelta = size;
        }
    }
}


