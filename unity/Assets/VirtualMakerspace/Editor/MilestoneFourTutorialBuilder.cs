using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.Video;

namespace VirtualMakerspace.Editor
{
    public static class MilestoneFourTutorialBuilder
    {
        private const string ScenePath = "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity";
        private const string RenderTexturePath = "Assets/VirtualMakerspace/TutorialVideo.renderTexture";

        [MenuItem("Virtual Makerspace/Build Beginner Tutorial")]
        public static void Build()
        {
            EditorSceneManager.OpenScene(ScenePath);
            GameObject existing = GameObject.Find("Beginner Tutorial");
            if (existing != null)
            {
                Object.DestroyImmediate(existing);
            }

            RenderTexture videoTexture = CreateVideoTexture();
            GameObject root = new GameObject("Beginner Tutorial");
            root.transform.SetPositionAndRotation(new Vector3(0f, 1.75f, 1.65f), Quaternion.identity);

            Canvas canvas = root.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            CanvasScaler scaler = root.AddComponent<CanvasScaler>();
            scaler.dynamicPixelsPerUnit = 2f;
            RectTransform canvasRect = root.GetComponent<RectTransform>();
            canvasRect.sizeDelta = new Vector2(1100f, 700f);
            canvasRect.localScale = Vector3.one * 0.0018f;

            Image background = CreateImage(root.transform, "Tutorial Background", new Color(0.035f, 0.06f, 0.11f, 0.97f));
            SetRect(background.rectTransform, Vector2.zero, new Vector2(1100f, 700f));

            RawImage video = CreateRawImage(root.transform, videoTexture);
            SetRect(video.rectTransform, new Vector2(-260f, 55f), new Vector2(500f, 380f));

            Text counter = CreateText(root.transform, "Step Counter", 25, FontStyle.Bold, new Color(0.4f, 0.9f, 1f));
            SetRect(counter.rectTransform, new Vector2(255f, 255f), new Vector2(450f, 45f));

            Text title = CreateText(root.transform, "Step Title", 38, FontStyle.Bold, Color.white);
            SetRect(title.rectTransform, new Vector2(255f, 180f), new Vector2(450f, 100f));

            Text body = CreateText(root.transform, "Step Instructions", 27, FontStyle.Normal, new Color(0.88f, 0.92f, 1f));
            body.alignment = TextAnchor.UpperLeft;
            SetRect(body.rectTransform, new Vector2(255f, -30f), new Vector2(450f, 280f));

            Image cue = CreateImage(root.transform, "Button Cue", new Color(0.02f, 0.72f, 0.68f, 1f));
            SetRect(cue.rectTransform, new Vector2(0f, -280f), new Vector2(1000f, 82f));
            Text hint = CreateText(cue.transform, "Button Hint", 27, FontStyle.Bold, Color.white);
            hint.alignment = TextAnchor.MiddleCenter;
            SetRect(hint.rectTransform, Vector2.zero, new Vector2(970f, 72f));

            VideoPlayer player = root.AddComponent<VideoPlayer>();
            player.renderMode = VideoRenderMode.RenderTexture;
            player.targetTexture = videoTexture;
            player.audioOutputMode = VideoAudioOutputMode.None;

            BeginnerTutorialController controller = root.AddComponent<BeginnerTutorialController>();
            SerializedObject serialized = new SerializedObject(controller);
            serialized.FindProperty("stepCounter").objectReferenceValue = counter;
            serialized.FindProperty("stepTitle").objectReferenceValue = title;
            serialized.FindProperty("stepBody").objectReferenceValue = body;
            serialized.FindProperty("buttonHint").objectReferenceValue = hint;
            serialized.FindProperty("videoPlayer").objectReferenceValue = player;
            serialized.ApplyModifiedPropertiesWithoutUndo();

            EditorSceneManager.SaveOpenScenes();
            AssetDatabase.SaveAssets();
            Debug.Log("Built embedded beginner tutorial video and controller-button guidance.");
        }

        private static RenderTexture CreateVideoTexture()
        {
            RenderTexture texture = AssetDatabase.LoadAssetAtPath<RenderTexture>(RenderTexturePath);
            if (texture != null)
            {
                return texture;
            }

            texture = new RenderTexture(1280, 720, 0)
            {
                name = "TutorialVideo",
                antiAliasing = 1
            };
            AssetDatabase.CreateAsset(texture, RenderTexturePath);
            return texture;
        }

        private static Image CreateImage(Transform parent, string name, Color color)
        {
            GameObject instance = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            instance.transform.SetParent(parent, false);
            Image image = instance.GetComponent<Image>();
            image.color = color;
            return image;
        }

        private static RawImage CreateRawImage(Transform parent, Texture texture)
        {
            GameObject instance = new GameObject("Tutorial Video", typeof(RectTransform), typeof(CanvasRenderer), typeof(RawImage));
            instance.transform.SetParent(parent, false);
            RawImage image = instance.GetComponent<RawImage>();
            image.texture = texture;
            image.color = Color.white;
            return image;
        }

        private static Text CreateText(Transform parent, string name, int size, FontStyle style, Color color)
        {
            GameObject instance = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Text));
            instance.transform.SetParent(parent, false);
            Text text = instance.GetComponent<Text>();
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.fontSize = size;
            text.fontStyle = style;
            text.color = color;
            text.alignment = TextAnchor.MiddleLeft;
            text.horizontalOverflow = HorizontalWrapMode.Wrap;
            text.verticalOverflow = VerticalWrapMode.Overflow;
            return text;
        }

        private static void SetRect(RectTransform rect, Vector2 position, Vector2 size)
        {
            rect.anchorMin = new Vector2(0.5f, 0.5f);
            rect.anchorMax = new Vector2(0.5f, 0.5f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = position;
            rect.sizeDelta = size;
        }
    }
}